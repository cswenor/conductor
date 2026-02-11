/**
 * PR merge handler: detect PR merge/state changes via webhook and
 * advance runs accordingly.
 *
 * WP10.4–10.6: PR state tracking, run completion, and cleanup trigger.
 */

import {
  getRunByPrNodeId,
  updateRunPrBundle,
  transitionPhase,
  type TransitionInput,
  type TransitionResult,
  cleanupWorktree,
  getDatabase,
  createLogger,
} from '@conductor/shared';

const log = createLogger({ name: 'conductor:worker:merge-handler' });

type Db = ReturnType<typeof getDatabase>;
type MirrorFn = (input: TransitionInput, result: TransitionResult) => void;
type ScheduleCleanupFn = (runId: string) => Promise<void>;

/**
 * Handle a PR merge event: update PR state, complete the run, schedule cleanup.
 *
 * Idempotent — safe to call on duplicate webhook deliveries because
 * `transitionPhase` uses an optimistic lock on the current phase.
 */
export async function handlePrMerged(
  db: Db,
  prNodeId: string,
  mirrorTransition: MirrorFn,
  scheduleCleanup: ScheduleCleanupFn,
): Promise<void> {
  const run = getRunByPrNodeId(db, prNodeId);
  if (run === null) {
    log.info({ prNodeId }, 'No run in merge-wait state for PR node ID');
    return;
  }

  const { runId } = run;

  // Validate PR bundle fields — must all be present
  if (run.prNumber === undefined || run.prNodeId === undefined || run.prUrl === undefined) {
    log.error({ runId }, 'PR bundle fields missing at merge time, transitioning to blocked');
    transitionPhase(db, {
      runId,
      toPhase: 'blocked',
      triggeredBy: 'webhook:pr.merged',
      blockedReason: 'PR bundle fields missing at merge time',
      blockedContext: { error: 'PR bundle fields missing', prior_phase: run.phase, prior_step: run.step },
    });
    return;
  }

  // Update PR state to merged
  const updated = updateRunPrBundle(db, {
    runId,
    prNumber: run.prNumber,
    prNodeId: run.prNodeId,
    prUrl: run.prUrl,
    prState: 'merged',
    prSyncedAt: new Date().toISOString(),
  });
  if (!updated) {
    log.error({ runId }, 'Failed to update PR state to merged, transitioning to blocked');
    transitionPhase(db, {
      runId,
      toPhase: 'blocked',
      triggeredBy: 'webhook:pr.merged',
      blockedReason: 'Failed to update PR state to merged',
      blockedContext: { error: 'Failed to update PR state', prior_phase: run.phase, prior_step: run.step },
    });
    return;
  }

  // Transition to completed
  const input: TransitionInput = {
    runId,
    toPhase: 'completed',
    toStep: 'cleanup',
    triggeredBy: 'webhook:pr.merged',
    result: 'success',
    resultReason: 'PR merged',
  };
  const result = transitionPhase(db, input);
  if (!result.success) {
    log.warn({ runId, error: result.error }, 'CAS transition to completed failed (stale job)');
    return;
  }

  // Schedule cleanup in BullMQ (crash-resilient)
  try {
    await scheduleCleanup(runId);
  } catch (err) {
    log.warn({ runId, error: err instanceof Error ? err.message : String(err) }, 'Failed to enqueue cleanup job');
  }

  // Mirror the transition (non-fatal)
  try {
    mirrorTransition(input, result);
  } catch {
    // non-fatal
  }

  // Inline cleanup (non-fatal, janitor fallback)
  try {
    cleanupWorktree(db, runId);
  } catch (err) {
    log.warn({ runId, error: err instanceof Error ? err.message : String(err) }, 'Inline cleanup failed, janitor will handle');
  }
}

/**
 * Handle a PR state change (closed/reopened) — update `prState` without
 * advancing the run.
 */
export function handlePrStateChange(
  db: Db,
  prNodeId: string,
  newState: string,
): void {
  const run = getRunByPrNodeId(db, prNodeId);
  if (run === null) {
    log.info({ prNodeId, newState }, 'No run in merge-wait state for PR node ID');
    return;
  }

  const { runId } = run;

  // Validate PR bundle fields
  if (run.prNumber === undefined || run.prNodeId === undefined || run.prUrl === undefined) {
    log.error({ runId, newState }, 'PR bundle fields missing for state change');
    return;
  }

  const updated = updateRunPrBundle(db, {
    runId,
    prNumber: run.prNumber,
    prNodeId: run.prNodeId,
    prUrl: run.prUrl,
    prState: newState,
    prSyncedAt: new Date().toISOString(),
  });

  if (!updated) {
    log.error({ runId, newState }, 'Failed to update PR state');
    return;
  }

  log.info({ runId, prNodeId, newState }, 'PR state updated');
}
