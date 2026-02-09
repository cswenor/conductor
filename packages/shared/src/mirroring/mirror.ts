/**
 * GitHub Issue Mirroring
 *
 * Posts structured comments on linked GitHub issues when runs progress
 * through phases. Uses the outbox pattern for reliable delivery,
 * rate limiting to avoid spam, and content redaction for safety.
 *
 * All mirror functions are non-fatal: they catch errors, log them,
 * and return a result indicating failure rather than throwing.
 */

import type { Database } from 'better-sqlite3';
import { createLogger } from '../logger/index.ts';
import { getRun } from '../runs/index.ts';
import { getTask } from '../tasks/index.ts';
import { getRepo } from '../repos/index.ts';
import { getLatestArtifact } from '../agent-runtime/artifacts.ts';
import { enqueueWrite, type EnqueueWriteResult } from '../outbox/index.ts';
import type { QueueManager } from '../queue/index.ts';
import type { TransitionInput, TransitionResult } from '../orchestrator/index.ts';
import { formatMirrorComment, truncateComment } from './formatter.ts';
import { redactContent } from './redact-content.ts';
import { checkAndMirror, type MirrorResult, type CoalesceContext } from './rate-limiter.ts';

const log = createLogger({ name: 'conductor:mirroring' });

// =============================================================================
// Types
// =============================================================================

export interface MirrorContext {
  db: Database;
  queueManager: QueueManager;
  conductorBaseUrl?: string;
}

export type { MirrorResult };

// =============================================================================
// Helpers
// =============================================================================

interface IssueTarget {
  owner: string;
  repo: string;
  issueNumber: number;
  issueNodeId: string;
  runNumber: number;
}

/**
 * Resolve the GitHub issue linked to a run.
 * Returns null if the task has no linked issue (graceful no-op).
 */
function resolveIssueTarget(db: Database, runId: string): IssueTarget | null {
  const run = getRun(db, runId);
  if (run === null) return null;

  const task = getTask(db, run.taskId);
  if (task === null) return null;

  // No issue linked — nothing to mirror
  if (task.githubIssueNumber === 0 || task.githubNodeId === '') {
    return null;
  }

  const repo = getRepo(db, run.repoId);
  if (repo === null) return null;

  return {
    owner: repo.githubOwner,
    repo: repo.githubName,
    issueNumber: task.githubIssueNumber,
    issueNodeId: task.githubNodeId,
    runNumber: run.runNumber,
  };
}

/**
 * Build coalesce context for structured coalesced comment formatting.
 */
function buildCoalesceCtx(
  runId: string,
  target: IssueTarget,
  conductorBaseUrl?: string,
): CoalesceContext {
  return { runNumber: target.runNumber, runId, conductorBaseUrl };
}

/**
 * Create an enqueue function bound to a specific run/issue target.
 */
function createEnqueueFn(
  ctx: MirrorContext,
  runId: string,
  target: IssueTarget,
): (body: string, idempotencyKey: string) => EnqueueWriteResult {
  return (body: string, idempotencyKey: string) => {
    return enqueueWrite(ctx.db, {
      runId,
      kind: 'comment',
      targetNodeId: target.issueNodeId,
      targetType: 'issue',
      payload: {
        owner: target.owner,
        repo: target.repo,
        issueNumber: target.issueNumber,
        body,
      },
      idempotencyKey,
    }, ctx.queueManager);
  };
}

// =============================================================================
// WP9.2: Phase Transition Mirror
// =============================================================================

/**
 * Mirror a phase transition to the linked GitHub issue.
 *
 * Called AFTER each successful transitionPhase() call.
 * Non-fatal: catches all errors, logs, returns result.
 */
export function mirrorPhaseTransition(
  ctx: MirrorContext,
  input: TransitionInput,
  result: TransitionResult,
): MirrorResult {
  try {
    if (!result.success) {
      return { enqueued: false, deferred: false };
    }

    const target = resolveIssueTarget(ctx.db, input.runId);
    if (target === null) {
      return { enqueued: false, deferred: false };
    }

    // The run is already in the new phase after transition, so fromPhase
    // comes from the event payload
    const eventFromPhase = result.event?.payload !== undefined
      ? result.event.payload['from'] as string | undefined
      : undefined;

    const body = input.reason ?? `${eventFromPhase ?? 'unknown'} \u{2192} ${input.toPhase}`;
    const sequence = result.event?.sequence ?? 0;

    const comment = formatMirrorComment({
      eventType: 'phase_transition',
      runId: input.runId,
      runNumber: target.runNumber,
      fromPhase: eventFromPhase,
      toPhase: input.toPhase,
      timestamp: new Date().toISOString(),
      body,
      conductorUrl: ctx.conductorBaseUrl,
    });

    const redacted = redactContent(comment);
    const truncated = truncateComment(redacted);

    return checkAndMirror(
      ctx.db,
      input.runId,
      {
        eventType: 'phase_transition',
        formattedBody: truncated,
        summary: body,
        idempotencySuffix: `${input.runId}:mirror:phase:${sequence}`,
      },
      createEnqueueFn(ctx, input.runId, target),
      buildCoalesceCtx(input.runId, target, ctx.conductorBaseUrl),
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    log.error({ runId: input.runId, error: message }, 'mirrorPhaseTransition failed (non-fatal)');
    return { enqueued: false, deferred: false, error: message };
  }
}

// =============================================================================
// WP9.3: Plan Artifact Mirror
// =============================================================================

/**
 * Mirror a plan artifact to the linked GitHub issue.
 *
 * Called when a plan moves to awaiting_plan_approval.
 * Fetches the latest plan artifact and posts it in a details section.
 */
export function mirrorPlanArtifact(
  ctx: MirrorContext,
  runId: string,
): MirrorResult {
  try {
    const target = resolveIssueTarget(ctx.db, runId);
    if (target === null) {
      return { enqueued: false, deferred: false };
    }

    const artifact = getLatestArtifact(ctx.db, runId, 'plan');
    const planContent = artifact?.contentMarkdown ?? 'No plan content available.';
    const version = artifact?.version ?? 0;

    const comment = formatMirrorComment({
      eventType: 'plan_ready',
      runId,
      runNumber: target.runNumber,
      toPhase: 'awaiting_plan_approval',
      timestamp: new Date().toISOString(),
      body: 'A plan has been generated and is ready for review.',
      detailsSummary: 'View Plan',
      detailsContent: planContent,
      conductorUrl: ctx.conductorBaseUrl,
    });

    // Redact the full formatted comment (covers plan content + any body secrets)
    const redacted = redactContent(comment);
    const truncated = truncateComment(redacted);

    return checkAndMirror(
      ctx.db,
      runId,
      {
        eventType: 'plan_ready',
        formattedBody: truncated,
        summary: 'A plan has been generated and is ready for review.',
        idempotencySuffix: `${runId}:mirror:plan:${version}`,
      },
      createEnqueueFn(ctx, runId, target),
      buildCoalesceCtx(runId, target, ctx.conductorBaseUrl),
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    log.error({ runId, error: message }, 'mirrorPlanArtifact failed (non-fatal)');
    return { enqueued: false, deferred: false, error: message };
  }
}

// =============================================================================
// WP9.4: Approval Decision Mirror
// =============================================================================

/**
 * Mirror an operator approval/rejection decision to the linked GitHub issue.
 *
 * Called after recordOperatorAction in the web API route.
 */
export function mirrorApprovalDecision(
  ctx: MirrorContext,
  input: {
    runId: string;
    operatorActionId: string;
    action: 'approve_plan' | 'revise_plan' | 'reject_run' | 'grant_policy_exception' | 'deny_policy_exception' | 'cancel';
    actorId: string;
    fromPhase: string;
    toPhase?: string;
    comment?: string;
  },
): MirrorResult {
  try {
    const target = resolveIssueTarget(ctx.db, input.runId);
    if (target === null) {
      return { enqueued: false, deferred: false };
    }

    const actionDescriptions: Record<string, string> = {
      approve_plan: `Plan approved by ${input.actorId}`,
      revise_plan: `Plan revision requested by ${input.actorId}`,
      reject_run: `Run rejected by ${input.actorId}`,
      grant_policy_exception: `Policy exception granted by ${input.actorId}`,
      deny_policy_exception: `Policy exception denied by ${input.actorId}`,
      cancel: `Run cancelled by ${input.actorId}`,
    };

    let body = actionDescriptions[input.action] ?? `Action: ${input.action} by ${input.actorId}`;

    if (input.fromPhase !== undefined) {
      const toPhase = input.toPhase ?? 'unknown';
      body += ` (${input.fromPhase} \u{2192} ${toPhase})`;
    }

    const comment = formatMirrorComment({
      eventType: 'approval_decision',
      runId: input.runId,
      runNumber: target.runNumber,
      fromPhase: input.fromPhase,
      toPhase: input.toPhase ?? input.fromPhase,
      timestamp: new Date().toISOString(),
      body,
      detailsContent: input.comment,
      detailsSummary: 'Operator Comment',
      conductorUrl: ctx.conductorBaseUrl,
    });

    const redacted = redactContent(comment);
    const truncated = truncateComment(redacted);

    return checkAndMirror(
      ctx.db,
      input.runId,
      {
        eventType: 'approval_decision',
        formattedBody: truncated,
        summary: body,
        idempotencySuffix: `${input.runId}:mirror:approval:${input.operatorActionId}`,
      },
      createEnqueueFn(ctx, input.runId, target),
      buildCoalesceCtx(input.runId, target, ctx.conductorBaseUrl),
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    log.error({ runId: input.runId, error: message }, 'mirrorApprovalDecision failed (non-fatal)');
    return { enqueued: false, deferred: false, error: message };
  }
}

// =============================================================================
// WP9.5: Failure Mirror
// =============================================================================

/**
 * Mirror a failure/blocked event to the linked GitHub issue.
 *
 * Called when transitioning to blocked.
 */
export function mirrorFailure(
  ctx: MirrorContext,
  input: {
    runId: string;
    blockedReason: string;
    blockedContext?: Record<string, unknown>;
    /** Sequence from the transition event, if available. Prevents idempotency collisions. */
    eventSequence?: number;
  },
): MirrorResult {
  try {
    const target = resolveIssueTarget(ctx.db, input.runId);
    if (target === null) {
      return { enqueued: false, deferred: false };
    }

    let body: string;
    let detailsContent: string | undefined;
    let detailsSummary: string | undefined;

    switch (input.blockedReason) {
      case 'gate_failed': {
        const gateId = (input.blockedContext?.['gate_id'] as string) ?? 'unknown';
        const gateStatus = (input.blockedContext?.['gate_status'] as string) ?? 'failed';
        body = `Run blocked: gate '${gateId}' ${gateStatus}`;

        // Check for test report artifact
        const testReport = getLatestArtifact(ctx.db, input.runId, 'test_report');
        if (testReport?.contentMarkdown !== undefined) {
          const truncatedReport = testReport.contentMarkdown.length > 2000
            ? testReport.contentMarkdown.substring(0, 2000) + '\n\n... (truncated)'
            : testReport.contentMarkdown;
          detailsContent = truncatedReport;
          detailsSummary = 'Test Results';
        }
        break;
      }
      case 'policy_exception_required': {
        const policyId = (input.blockedContext?.['policy_id'] as string) ?? 'unknown';
        body = `Run blocked: policy exception required for '${policyId}'`;
        break;
      }
      default:
        body = `Run blocked: ${input.blockedReason}`;
        break;
    }

    const comment = formatMirrorComment({
      eventType: 'failure',
      runId: input.runId,
      runNumber: target.runNumber,
      toPhase: 'blocked',
      timestamp: new Date().toISOString(),
      body,
      detailsContent,
      detailsSummary,
      conductorUrl: ctx.conductorBaseUrl,
    });

    const redacted = redactContent(comment);
    const truncated = truncateComment(redacted);

    // Use provided event sequence, or fall back to nextSequence (always unique/incrementing)
    let sequence: number;
    if (input.eventSequence !== undefined) {
      sequence = input.eventSequence;
    } else {
      const run = getRun(ctx.db, input.runId);
      sequence = run?.nextSequence ?? Date.now();
    }

    return checkAndMirror(
      ctx.db,
      input.runId,
      {
        eventType: 'failure',
        formattedBody: truncated,
        summary: body,
        idempotencySuffix: `${input.runId}:mirror:failure:${sequence}`,
      },
      createEnqueueFn(ctx, input.runId, target),
      buildCoalesceCtx(input.runId, target, ctx.conductorBaseUrl),
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    log.error({ runId: input.runId, error: message }, 'mirrorFailure failed (non-fatal)');
    return { enqueued: false, deferred: false, error: message };
  }
}
