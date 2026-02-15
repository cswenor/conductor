/**
 * Shared helper to enqueue the implementer agent after plan approval.
 *
 * Used by both the server action and API route so approval always
 * dispatches the agent job.
 */

import {
  type Database,
  type QueueManager,
  generateAgentInvocationId,
  listAgentInvocations,
  getRun,
  transitionPhase,
  publishTransitionEvent,
  createLogger,
} from '@conductor/shared';

const log = createLogger({ name: 'conductor:enqueue-implementer' });

type SkipReason = 'run_missing' | 'wrong_phase' | 'wrong_step' | 'active_invocation';

export type EnqueueOutcome =
  | { outcome: 'enqueued' }
  | { outcome: 'skipped'; reason: SkipReason }
  | { outcome: 'enqueue_failed'; error: string }
  | { outcome: 'enqueue_and_block_failed'; error: string };

export async function enqueueImplementerAfterApproval(
  db: Database,
  queues: QueueManager,
  runId: string,
  projectId: string,
): Promise<EnqueueOutcome> {
  // Strict preconditions: phase + step + no active invocation
  const run = getRun(db, runId);
  if (run === null) {
    return { outcome: 'skipped', reason: 'run_missing' };
  }
  if (run.phase !== 'executing') {
    return { outcome: 'skipped', reason: 'wrong_phase' };
  }
  if (run.step !== 'implementer_apply_changes') {
    return { outcome: 'skipped', reason: 'wrong_step' };
  }

  const invocations = listAgentInvocations(db, runId);
  const hasActive = invocations.some(i => i.status === 'pending' || i.status === 'running');
  if (hasActive) {
    return { outcome: 'skipped', reason: 'active_invocation' };
  }

  const fromPhase = run.phase; // capture before any mutation
  const agentInvocationId = generateAgentInvocationId();
  // Dedupe scoped to phase episode via lastEventSequence
  const jobId = `agent-${runId}-implementer-apply_changes-seq${run.lastEventSequence}`;

  try {
    await queues.addJob('agents', jobId, {
      runId,
      agentInvocationId,
      agent: 'implementer',
      action: 'apply_changes',
      context: {},
    });
    log.info({ runId, agentInvocationId, jobId }, 'Implementer enqueued after approval');
    return { outcome: 'enqueued' };
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown enqueue error';
    log.error({ runId, error: msg }, 'Failed to enqueue implementer — blocking run');

    // Transition to blocked — only publish if transition succeeds
    const t = transitionPhase(db, {
      runId,
      toPhase: 'blocked',
      triggeredBy: 'system',
      reason: 'Failed to dispatch implementer agent after approval',
      blockedReason: 'enqueue_failed',
      blockedContext: {
        prior_phase: 'executing',
        prior_step: 'implementer_apply_changes',
        enqueue_error: msg,
      },
    });

    if (t.success) {
      publishTransitionEvent(projectId, runId, fromPhase, 'blocked', db);
      return {
        outcome: 'enqueue_failed',
        error: 'Approval recorded but agent dispatch failed — run has been blocked for retry',
      };
    }

    log.error({ runId, error: t.error }, 'Failed to block run after enqueue failure');
    return {
      outcome: 'enqueue_and_block_failed',
      error: 'Agent dispatch failed and run could not be blocked — run may be stranded in executing',
    };
  }
}
