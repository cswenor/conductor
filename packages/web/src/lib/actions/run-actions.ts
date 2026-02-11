'use server';

import { revalidatePath } from 'next/cache';
import {
  createLogger,
  getRun,
  getProject,
  canAccessProject,
  transitionPhase,
  TERMINAL_PHASES,
  recordOperatorAction,
  evaluateGatesAndTransition,
  createOverride,
  isValidOverrideScope,
  type OverrideScope,
} from '@conductor/shared';
import { getDb, getQueues } from '@/lib/bootstrap';
import { requireServerUser } from '@/lib/auth/session';

const log = createLogger({ name: 'conductor:actions:run' });

interface ActionResult {
  success: boolean;
  error?: string;
}

function revalidateRunPaths(runId: string) {
  revalidatePath('/dashboard');
  revalidatePath('/work');
  revalidatePath('/approvals');
  revalidatePath(`/runs/${runId}`);
}

async function getAuthorizedRun(runId: string) {
  const user = await requireServerUser();
  const db = await getDb();
  const run = getRun(db, runId);
  if (run === null) throw new Error('Run not found');
  const project = getProject(db, run.projectId);
  if (project === null || !canAccessProject(user, project)) {
    throw new Error('Run not found');
  }
  return { user, db, run };
}

export async function approvePlan(runId: string, comment?: string): Promise<ActionResult> {
  try {
    const { user, db, run } = await getAuthorizedRun(runId);

    if (run.phase !== 'awaiting_plan_approval') {
      return { success: false, error: 'Run is not awaiting plan approval' };
    }

    const { gateCheck, transition: txnResult } = evaluateGatesAndTransition(
      db, run, 'awaiting_plan_approval',
      {
        runId,
        toPhase: 'executing',
        toStep: 'implementer_apply_changes',
        triggeredBy: user.userId,
        reason: 'Plan approved by operator',
      },
    );

    if (!gateCheck.allPassed) {
      return { success: false, error: `Gate '${gateCheck.blockedBy ?? 'unknown'}' is not passed — cannot approve` };
    }

    if (txnResult?.success !== true) {
      return { success: false, error: txnResult?.error ?? 'Failed to approve plan' };
    }

    recordOperatorAction(db, {
      runId,
      action: 'approve_plan',
      actorId: user.userId,
      actorType: 'operator',
      comment,
      fromPhase: run.phase,
      toPhase: 'executing',
    });

    log.info({ runId, userId: user.userId }, 'Plan approved by operator');
    revalidateRunPaths(runId);
    return { success: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Failed to approve plan';
    log.error({ runId, error: msg }, 'approvePlan failed');
    return { success: false, error: msg };
  }
}

export async function revisePlan(runId: string, comment: string): Promise<ActionResult> {
  try {
    const { user, db, run } = await getAuthorizedRun(runId);

    if (run.phase !== 'awaiting_plan_approval') {
      return { success: false, error: 'Run is not awaiting plan approval' };
    }

    if (comment.trim() === '') {
      return { success: false, error: 'Comment is required for plan revision' };
    }

    recordOperatorAction(db, {
      runId,
      action: 'revise_plan',
      actorId: user.userId,
      actorType: 'operator',
      comment,
      fromPhase: run.phase,
      toPhase: 'planning',
    });

    db.prepare(
      'UPDATE runs SET plan_revisions = plan_revisions + 1 WHERE run_id = ?'
    ).run(runId);

    const updatedRun = getRun(db, runId);
    const maxRevisions = 3;
    if (updatedRun !== null && updatedRun.planRevisions >= maxRevisions) {
      transitionPhase(db, {
        runId,
        toPhase: 'blocked',
        triggeredBy: user.userId,
        reason: 'Plan revision limit exceeded',
        blockedReason: 'retry_limit_exceeded',
        blockedContext: { prior_phase: run.phase, revisions: updatedRun.planRevisions },
      });

      log.info({ runId, userId: user.userId, revisions: updatedRun.planRevisions }, 'Plan revision limit exceeded');
      revalidateRunPaths(runId);
      return { success: true };
    }

    const result = transitionPhase(db, {
      runId,
      toPhase: 'planning',
      toStep: 'planner_create_plan',
      triggeredBy: user.userId,
      reason: `Revision requested: ${comment}`,
    });

    if (!result.success) {
      return { success: false, error: result.error ?? 'Failed to revise plan' };
    }

    log.info({ runId, userId: user.userId }, 'Plan revision requested');
    revalidateRunPaths(runId);
    return { success: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Failed to revise plan';
    log.error({ runId, error: msg }, 'revisePlan failed');
    return { success: false, error: msg };
  }
}

export async function rejectRun(runId: string, comment: string): Promise<ActionResult> {
  try {
    const { user, db, run } = await getAuthorizedRun(runId);

    if (run.phase !== 'awaiting_plan_approval') {
      return { success: false, error: 'Run is not awaiting plan approval' };
    }

    if (comment.trim() === '') {
      return { success: false, error: 'Comment is required for rejection' };
    }

    recordOperatorAction(db, {
      runId,
      action: 'reject_run',
      actorId: user.userId,
      actorType: 'operator',
      comment,
      fromPhase: run.phase,
      toPhase: 'cancelled',
    });

    const result = transitionPhase(db, {
      runId,
      toPhase: 'cancelled',
      toStep: 'cleanup',
      triggeredBy: user.userId,
      result: 'cancelled',
      resultReason: 'Plan rejected by operator',
    });

    if (!result.success) {
      return { success: false, error: result.error ?? 'Failed to reject run' };
    }

    const queues = await getQueues();
    await queues.addJob('cleanup', `cleanup:worktree:${runId}`, {
      type: 'worktree',
      targetId: runId,
    });

    log.info({ runId, userId: user.userId }, 'Run rejected by operator');
    revalidateRunPaths(runId);
    return { success: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Failed to reject run';
    log.error({ runId, error: msg }, 'rejectRun failed');
    return { success: false, error: msg };
  }
}

export async function retryRun(runId: string, comment?: string): Promise<ActionResult> {
  try {
    const { user, db, run } = await getAuthorizedRun(runId);

    if (run.phase !== 'blocked') {
      return { success: false, error: 'Run is not in blocked state' };
    }

    // Enqueue before recording audit — matches cancel pattern.
    const queues = await getQueues();
    await queues.addJob('runs', `run-retry-${runId}-${Date.now()}`, {
      runId,
      action: 'resume',
      triggeredBy: user.userId,
      fromPhase: 'blocked',
      fromSequence: run.lastEventSequence,
    });

    recordOperatorAction(db, {
      runId,
      action: 'retry',
      actorId: user.userId,
      actorType: 'operator',
      comment,
      fromPhase: run.phase,
    });

    log.info({ runId, userId: user.userId }, 'Run retry enqueued');
    revalidateRunPaths(runId);
    return { success: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Failed to retry run';
    log.error({ runId, error: msg }, 'retryRun failed');
    return { success: false, error: msg };
  }
}

export async function cancelRun(runId: string, comment?: string): Promise<ActionResult> {
  try {
    const { user, db, run } = await getAuthorizedRun(runId);

    if (TERMINAL_PHASES.has(run.phase)) {
      return { success: false, error: 'Run is already in a terminal state' };
    }

    // Enqueue cancel job first — worker owns transition + signal + cleanup.
    // Stable job ID ensures repeated clicks are idempotent (BullMQ deduplicates).
    // Audit record is written only after enqueue succeeds to avoid recording
    // a cancellation that was never actually queued.
    const queues = await getQueues();
    await queues.addJob('runs', `run-cancel-${runId}`, {
      runId,
      action: 'cancel',
      triggeredBy: user.userId,
    });

    recordOperatorAction(db, {
      runId,
      action: 'cancel',
      actorId: user.userId,
      actorType: 'operator',
      comment,
      fromPhase: run.phase,
      toPhase: 'cancelled',
    });

    log.info({ runId, userId: user.userId }, 'Run cancel enqueued');
    revalidateRunPaths(runId);
    return { success: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Failed to cancel run';
    log.error({ runId, error: msg }, 'cancelRun failed');
    return { success: false, error: msg };
  }
}

export async function grantPolicyException(
  runId: string,
  justification: string,
  scope?: string,
): Promise<ActionResult> {
  try {
    const { user, db, run } = await getAuthorizedRun(runId);

    if (run.phase !== 'blocked') {
      return { success: false, error: 'Run is not in blocked state' };
    }

    if (run.blockedReason !== 'policy_exception_required') {
      return { success: false, error: 'Run is not blocked for a policy exception' };
    }

    if (justification.trim() === '') {
      return { success: false, error: 'Justification is required for policy exceptions' };
    }

    recordOperatorAction(db, {
      runId,
      action: 'grant_policy_exception',
      actorId: user.userId,
      actorType: 'operator',
      comment: justification,
      fromPhase: run.phase,
    });

    const rawScope = scope ?? 'this_run';
    if (!isValidOverrideScope(rawScope)) {
      return { success: false, error: `Invalid scope: ${rawScope}. Must be one of: this_run, this_task, this_repo, project_wide` };
    }
    const validatedScope: OverrideScope = rawScope;

    let targetId: string | undefined;
    let priorPhase = 'executing';
    let constraintKind: string | undefined;
    let constraintValue: string | undefined;
    let constraintHash: string | undefined;
    let violationId: string | undefined;

    if (run.blockedContextJson !== undefined) {
      const ctx = JSON.parse(run.blockedContextJson) as Record<string, unknown>;
      targetId = (ctx['policy_id'] as string) ?? undefined;
      constraintKind = (ctx['constraint_kind'] as string) ?? undefined;
      constraintValue = (ctx['constraint_value'] as string) ?? undefined;
      constraintHash = (ctx['constraint_hash'] as string) ?? undefined;
      violationId = (ctx['violation_id'] as string) ?? undefined;
      if (typeof ctx['prior_phase'] === 'string') {
        priorPhase = ctx['prior_phase'];
      }
    }

    if (targetId === undefined || constraintKind === undefined) {
      return { success: false, error: 'Cannot grant exception — blocked context is missing policy or constraint details. Try retrying instead.' };
    }

    const override = createOverride(db, {
      runId,
      kind: 'policy_exception',
      targetId,
      scope: validatedScope,
      constraintKind,
      constraintValue,
      constraintHash,
      policySetId: run.policySetId,
      operator: user.userId,
      justification,
    });

    if (violationId !== undefined) {
      db.prepare(
        'UPDATE policy_violations SET resolved_by_override_id = ? WHERE violation_id = ?'
      ).run(override.overrideId, violationId);
    }

    const result = transitionPhase(db, {
      runId,
      toPhase: priorPhase as 'executing',
      triggeredBy: user.userId,
      reason: 'Policy exception granted',
    });

    if (!result.success) {
      return { success: false, error: result.error ?? 'Failed to grant exception' };
    }

    db.prepare(
      'UPDATE runs SET blocked_reason = NULL, blocked_context_json = NULL WHERE run_id = ?'
    ).run(runId);

    log.info({ runId, userId: user.userId, overrideId: override.overrideId }, 'Policy exception granted');
    revalidateRunPaths(runId);
    return { success: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Failed to grant exception';
    log.error({ runId, error: msg }, 'grantPolicyException failed');
    return { success: false, error: msg };
  }
}

export async function denyPolicyException(runId: string, comment: string): Promise<ActionResult> {
  try {
    const { user, db, run } = await getAuthorizedRun(runId);

    if (run.phase !== 'blocked') {
      return { success: false, error: 'Run is not in blocked state' };
    }

    if (run.blockedReason !== 'policy_exception_required') {
      return { success: false, error: 'Run is not blocked for a policy exception' };
    }

    if (comment.trim() === '') {
      return { success: false, error: 'Comment is required for denial' };
    }

    recordOperatorAction(db, {
      runId,
      action: 'deny_policy_exception',
      actorId: user.userId,
      actorType: 'operator',
      comment,
      fromPhase: run.phase,
      toPhase: 'cancelled',
    });

    const result = transitionPhase(db, {
      runId,
      toPhase: 'cancelled',
      toStep: 'cleanup',
      triggeredBy: user.userId,
      result: 'cancelled',
      resultReason: 'Policy exception denied',
    });

    if (!result.success) {
      return { success: false, error: result.error ?? 'Failed to deny exception' };
    }

    const queues = await getQueues();
    await queues.addJob('cleanup', `cleanup:worktree:${runId}`, {
      type: 'worktree',
      targetId: runId,
    });

    log.info({ runId, userId: user.userId }, 'Policy exception denied');
    revalidateRunPaths(runId);
    return { success: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Failed to deny exception';
    log.error({ runId, error: msg }, 'denyPolicyException failed');
    return { success: false, error: msg };
  }
}
