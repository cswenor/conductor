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
  createOverride,
  isValidOverrideScope,
  type OverrideScope,
  type RunStep,
  publishTransitionEvent,
  publishOperatorActionEvent,
  approvePlanCommand,
  rejectRunCommand,
  revisePlanCommand,
  pauseRunCommand,
  resumeRunCommand,
  validateActionPhase,
  applyWorkflowOverlay,
  rewindRun,
} from '@conductor/shared';
import { getDb, getQueues } from '@/lib/bootstrap';
import { requireServerUser } from '@/lib/auth/session';
import { enqueueImplementerAfterApproval } from '@/lib/enqueue-implementer';

const log = createLogger({ name: 'conductor:actions:run' });

interface ActionResult {
  success: boolean;
  error?: string;
  outcome?: string;
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
    const result = approvePlanCommand({ db, run, actorId: user.userId, actorType: 'operator', comment });

    if (!result.success) {
      log.info({ runId, userId: user.userId, outcome: result.outcome }, 'approvePlan completed');
      revalidateRunPaths(runId);
      return { success: false, error: result.error, outcome: result.outcome };
    }

    // Enqueue implementer on approved (fresh) AND already_decided (self-heal)
    if (result.outcome === 'approved' || result.outcome === 'already_decided') {
      const queues = await getQueues();
      const enqueueResult = await enqueueImplementerAfterApproval(db, queues, runId, run.projectId);

      // approved: MUST enqueue — skipped means preconditions failed anomalously
      if (result.outcome === 'approved' && enqueueResult.outcome !== 'enqueued') {
        const skipReason = enqueueResult.outcome === 'skipped' ? enqueueResult.reason : undefined;
        log.error({ runId, helperOutcome: enqueueResult.outcome, skipReason }, 'approved but helper did not enqueue');
        const error = 'error' in enqueueResult
          ? enqueueResult.error
          : 'Approval succeeded but implementer could not be dispatched';
        revalidateRunPaths(runId);
        return { success: false, error, outcome: enqueueResult.outcome };
      }

      // already_decided: skipped is OK (idempotent), enqueued is self-heal, errors are failures
      if (enqueueResult.outcome === 'enqueue_failed' || enqueueResult.outcome === 'enqueue_and_block_failed') {
        revalidateRunPaths(runId);
        return { success: false, error: enqueueResult.error, outcome: enqueueResult.outcome };
      }

      if (enqueueResult.outcome === 'skipped') {
        log.info({ runId, commandOutcome: result.outcome, skipReason: enqueueResult.reason }, 'Enqueue skipped — preconditions not met');
      }
    }

    log.info({ runId, userId: user.userId, outcome: result.outcome }, 'approvePlan completed');
    revalidateRunPaths(runId);
    return { success: result.success, error: result.error, outcome: result.outcome };
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Failed to approve plan';
    log.error({ runId, error: msg }, 'approvePlan failed');
    return { success: false, error: msg };
  }
}

export async function revisePlan(runId: string, comment: string): Promise<ActionResult> {
  try {
    const { user, db, run } = await getAuthorizedRun(runId);

    if (comment.trim() === '') {
      return { success: false, error: 'Comment is required for plan revision' };
    }

    const result = revisePlanCommand({ db, run, actorId: user.userId, actorType: 'operator', comment });

    log.info({ runId, userId: user.userId, outcome: result.outcome }, 'revisePlan completed');
    revalidateRunPaths(runId);
    return { success: result.success, error: result.error, outcome: result.outcome };
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Failed to revise plan';
    log.error({ runId, error: msg }, 'revisePlan failed');
    return { success: false, error: msg };
  }
}

export async function rejectRun(runId: string, comment: string): Promise<ActionResult> {
  try {
    const { user, db, run } = await getAuthorizedRun(runId);

    if (comment.trim() === '') {
      return { success: false, error: 'Comment is required for rejection' };
    }

    const result = rejectRunCommand({ db, run, actorId: user.userId, actorType: 'operator', comment });

    if (result.outcome === 'rejected') {
      const queues = await getQueues();
      await queues.addJob('cleanup', `cleanup:worktree:${runId}`, {
        type: 'worktree',
        targetId: runId,
      });
    }

    log.info({ runId, userId: user.userId, outcome: result.outcome }, 'rejectRun completed');
    revalidateRunPaths(runId);
    return { success: result.success, error: result.error, outcome: result.outcome };
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Failed to reject run';
    log.error({ runId, error: msg }, 'rejectRun failed');
    return { success: false, error: msg };
  }
}

export async function retryRun(runId: string, comment?: string): Promise<ActionResult> {
  try {
    const { user, db, run } = await getAuthorizedRun(runId);

    // Validate before enqueue — rejects paused runs
    const retryError = validateActionPhase('retry', run.phase, run.pausedAt);
    if (retryError !== null) {
      return { success: false, error: retryError };
    }

    // Enqueue before recording audit — matches cancel pattern.
    const queues = await getQueues();
    await queues.addJob('runs', `run-retry-${runId}-${Date.now()}`, {
      runId,
      action: 'resume',
      triggeredBy: user.userId,
      intent: 'retry' as const,
      fromPhase: 'blocked',
      fromSequence: run.lastEventSequence,
      workflowEpoch: run.workflowEpoch,
    });

    // Post-enqueue audit (best-effort — job already dispatched)
    try {
      recordOperatorAction(db, {
        runId,
        action: 'retry',
        actorId: user.userId,
        actorType: 'operator',
        comment,
        fromPhase: run.phase,
      });
      publishOperatorActionEvent(db, run.projectId, runId, 'retry', user.userId);
    } catch (auditErr) {
      log.error(
        { runId, error: auditErr instanceof Error ? auditErr.message : 'Unknown' },
        'Retry audit failed after successful enqueue — job will still run',
      );
    }

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
    publishOperatorActionEvent(db, run.projectId, runId, 'cancel', user.userId);

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

    publishTransitionEvent(run.projectId, runId, run.phase, priorPhase, db);
    publishOperatorActionEvent(db, run.projectId, runId, 'grant_policy_exception', user.userId);

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

    publishTransitionEvent(run.projectId, runId, run.phase, 'cancelled', db);
    publishOperatorActionEvent(db, run.projectId, runId, 'deny_policy_exception', user.userId);

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

export async function pauseRun(runId: string, comment?: string): Promise<ActionResult> {
  try {
    const { user, db, run } = await getAuthorizedRun(runId);
    const result = pauseRunCommand({ db, run, actorId: user.userId, actorType: 'operator', comment });

    log.info({ runId, userId: user.userId, outcome: result.outcome }, 'pauseRun completed');
    revalidateRunPaths(runId);
    return { success: result.success, error: result.error, outcome: result.outcome };
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Failed to pause run';
    log.error({ runId, error: msg }, 'pauseRun failed');
    return { success: false, error: msg };
  }
}

export async function resumeRun(runId: string, comment?: string): Promise<ActionResult> {
  try {
    const { user, db, run } = await getAuthorizedRun(runId);
    const result = resumeRunCommand({ db, run, actorId: user.userId, actorType: 'operator', comment });

    if (!result.success) {
      log.info({ runId, userId: user.userId, outcome: result.outcome }, 'resumeRun failed');
      revalidateRunPaths(runId);
      return { success: false, error: result.error, outcome: result.outcome };
    }

    // Enqueue resume job with intent 'unpause'
    const queues = await getQueues();
    await queues.addJob('runs', `run-resume-${runId}-${Date.now()}`, {
      runId,
      action: 'resume',
      triggeredBy: user.userId,
      intent: 'unpause' as const,
      workflowEpoch: result.run?.workflowEpoch,
    });

    log.info({ runId, userId: user.userId, outcome: result.outcome }, 'resumeRun completed');
    revalidateRunPaths(runId);
    return { success: true, outcome: result.outcome };
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Failed to resume run';
    log.error({ runId, error: msg }, 'resumeRun failed');
    return { success: false, error: msg };
  }
}

export async function editWorkflow(runId: string, overlay: Record<string, unknown>): Promise<ActionResult> {
  try {
    const { user, db } = await getAuthorizedRun(runId);
    const result = applyWorkflowOverlay(db, runId, overlay, user.userId);

    log.info({ runId, userId: user.userId, success: result.success }, 'editWorkflow completed');
    revalidateRunPaths(runId);
    return { success: result.success, error: result.error };
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Failed to edit workflow';
    log.error({ runId, error: msg }, 'editWorkflow failed');
    return { success: false, error: msg };
  }
}

export async function rewindRunAction(runId: string, toStep: RunStep): Promise<ActionResult> {
  try {
    const { user, db } = await getAuthorizedRun(runId);
    const result = rewindRun(db, runId, toStep, user.userId);

    log.info({ runId, userId: user.userId, toStep, success: result.success }, 'rewindRunAction completed');
    revalidateRunPaths(runId);
    return { success: result.success, error: result.error };
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Failed to rewind run';
    log.error({ runId, error: msg }, 'rewindRunAction failed');
    return { success: false, error: msg };
  }
}
