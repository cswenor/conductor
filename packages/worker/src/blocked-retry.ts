/**
 * Blocked-retry handler: extracted for testability.
 *
 * Resolves prior_phase / prior_step from blocked context (or legacy fallback),
 * transitions the run out of blocked, and enqueues the correct agent job.
 */

import {
  transitionPhase,
  type Run,
  type RunPhase,
  type RunStep,
  type TransitionInput,
  type TransitionResult,
  getDatabase,
  createLogger,
  publishTransitionEvent,
} from '@conductor/shared';

const log = createLogger({ name: 'conductor:worker:blocked-retry' });

type Db = ReturnType<typeof getDatabase>;

/** Callback to enqueue an agent job. */
export type EnqueueAgentFn = (runId: string, agent: string, action: string) => Promise<void>;

/** Callback to enqueue a run job (start/resume). */
export type EnqueueRunJobFn = (
  runId: string,
  action: string,
  triggeredBy: string,
  fromPhase?: RunPhase,
  fromSequence?: number,
) => Promise<void>;

/** Callback to mirror a phase transition. */
export type MirrorFn = (input: TransitionInput, result: TransitionResult) => void;

export interface BlockedRetryResult {
  retried: boolean;
  priorPhase?: string;
  priorStep?: string;
  error?: string;
}

const RETRYABLE_PHASES = new Set<RunPhase>([
  'pending', 'planning', 'executing', 'awaiting_plan_approval', 'awaiting_review',
]);

const VALID_STEPS = new Set<RunStep>([
  'setup_worktree', 'route', 'planner_create_plan', 'reviewer_review_plan',
  'wait_plan_approval', 'implementer_apply_changes', 'tester_run_tests',
  'reviewer_review_code', 'create_pr', 'wait_pr_merge', 'cleanup',
]);

const STEP_TO_AGENT: Partial<Record<RunStep, { agent: 'planner' | 'reviewer' | 'implementer'; action: 'create_plan' | 'review_plan' | 'apply_changes' | 'review_code' }>> = {
  planner_create_plan: { agent: 'planner', action: 'create_plan' },
  reviewer_review_plan: { agent: 'reviewer', action: 'review_plan' },
  implementer_apply_changes: { agent: 'implementer', action: 'apply_changes' },
  reviewer_review_code: { agent: 'reviewer', action: 'review_code' },
};

/**
 * Resolve prior_phase from blocked context, falling back to the last
 * phase.transitioned event if the context is missing or invalid.
 */
export function resolvePriorPhase(
  db: Db,
  run: Run,
  blockedContext: Record<string, unknown>,
): RunPhase | undefined {
  const rawFromContext = blockedContext['prior_phase'];
  if (typeof rawFromContext === 'string' && RETRYABLE_PHASES.has(rawFromContext as RunPhase)) {
    return rawFromContext as RunPhase;
  }

  // Legacy fallback: read the last phase.transitioned event
  const lastBlockedEvent = db.prepare(
    `SELECT payload_json FROM events
     WHERE run_id = ? AND type = 'phase.transitioned'
     ORDER BY sequence DESC LIMIT 1`
  ).get(run.runId) as { payload_json: string } | undefined;

  if (lastBlockedEvent !== undefined) {
    try {
      const payload = JSON.parse(lastBlockedEvent.payload_json) as Record<string, unknown>;
      if (payload['to'] === 'blocked' && typeof payload['from'] === 'string') {
        const fromPhase = payload['from'];
        if (RETRYABLE_PHASES.has(fromPhase as RunPhase)) {
          log.info({ runId: run.runId, rawPhase: fromPhase }, 'Resolved prior_phase from last phase.transitioned event');
          return fromPhase as RunPhase;
        }
      }
    } catch {
      // ignore parse failures
    }
  }

  return undefined;
}

/**
 * Resolve prior_step from blocked context, falling back to run.step.
 */
export function resolvePriorStep(
  run: Run,
  blockedContext: Record<string, unknown>,
): RunStep | undefined {
  const rawStep = blockedContext['prior_step'] ?? run.step;
  if (typeof rawStep === 'string' && VALID_STEPS.has(rawStep as RunStep)) {
    return rawStep as RunStep;
  }
  return undefined;
}

/**
 * Handle retry from blocked state: transition, enqueue the correct agent,
 * and roll back on enqueue failure.
 */
export async function handleBlockedRetry(
  db: Db,
  run: Run,
  triggeredBy: string | undefined,
  deps: {
    enqueueAgent: EnqueueAgentFn;
    enqueueRunJob: EnqueueRunJobFn;
    mirror: MirrorFn;
  },
): Promise<BlockedRetryResult> {
  const { runId } = run;

  // Parse blocked context
  let blockedContext: Record<string, unknown> = {};
  if (run.blockedContextJson !== undefined) {
    try {
      blockedContext = JSON.parse(run.blockedContextJson) as Record<string, unknown>;
    } catch {
      log.warn({ runId }, 'Invalid blocked context JSON, using defaults');
    }
  }

  // Resolve prior phase
  const priorPhase = resolvePriorPhase(db, run, blockedContext);
  if (priorPhase === undefined) {
    log.error({ runId }, 'Invalid or missing prior_phase in blocked context — cannot retry');
    return { retried: false, error: 'Invalid or missing prior_phase' };
  }

  // Resolve prior step
  const priorStep = resolvePriorStep(run, blockedContext);

  log.info({ runId, triggeredBy, priorPhase, priorStep }, 'Retrying from blocked state');

  // Transition out of blocked
  const retryInput: TransitionInput = {
    runId,
    toPhase: priorPhase,
    toStep: priorStep,
    triggeredBy: triggeredBy ?? 'system',
    reason: 'Operator retry from blocked state',
  };
  const result = transitionPhase(db, retryInput);

  if (!result.success) {
    log.error({ runId, error: result.error, targetPhase: priorPhase }, 'Failed to transition from blocked');
    return { retried: false, priorPhase, priorStep, error: result.error ?? 'Transition failed' };
  }

  publishTransitionEvent(run.projectId, runId, 'blocked', priorPhase, db);

  // Mirror (non-fatal)
  try { deps.mirror(retryInput, result); } catch { /* non-fatal */ }

  // Guard follow-up run jobs to this exact post-retry episode.
  const fromSequence = result.run?.lastEventSequence ?? result.event?.sequence;

  // Enqueue the correct work
  try {
    const route = priorStep !== undefined ? STEP_TO_AGENT[priorStep] : undefined;
    if (route !== undefined) {
      await deps.enqueueAgent(runId, route.agent, route.action);
      log.info({ runId, toPhase: priorPhase, agent: route.agent, action: route.action }, 'Run retried — agent enqueued');
    } else if (priorStep === 'setup_worktree') {
      await deps.enqueueRunJob(runId, 'start', triggeredBy ?? 'system', priorPhase, fromSequence);
      log.info({ runId }, 'Run retried — re-enqueued start');
    } else if (priorStep === 'create_pr') {
      await deps.enqueueRunJob(runId, 'resume', triggeredBy ?? 'system', priorPhase, fromSequence);
      log.info({ runId }, 'Run retried — re-enqueued PR creation');
    } else {
      log.warn({ runId, priorPhase, priorStep }, 'Run retried but no agent route found for step');
    }
  } catch (enqueueErr) {
    // Revert to blocked so operator can retry again from the UI.
    log.error(
      { runId, error: enqueueErr instanceof Error ? enqueueErr.message : 'Unknown' },
      'Failed to enqueue after retry transition — reverting to blocked',
    );
    const rollback = transitionPhase(db, {
      runId,
      toPhase: 'blocked' as const,
      triggeredBy: 'system',
      blockedReason: run.blockedReason ?? 'Retry failed — agent enqueue error',
      blockedContext,
    });
    if (rollback.success) {
      publishTransitionEvent(run.projectId, runId, priorPhase, 'blocked', db);
    } else {
      log.error({ runId, error: rollback.error }, 'Rollback to blocked also failed — run may be stranded');
    }
    throw enqueueErr;
  }

  return { retried: true, priorPhase, priorStep };
}
