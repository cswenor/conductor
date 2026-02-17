/**
 * Checkpoint Registry
 *
 * Maps named checkpoints (e.g. 'planning:start') to their corresponding
 * RunStep and RunPhase. Two-level typing:
 * - CheckpointName (internal): all registry keys including 'completed'
 * - RewindCheckpoint (public): only rewindable checkpoints, used in API contracts
 */

import type { RunStep, RunPhase, RewindCheckpoint } from '../types/index.ts';

export interface CheckpointTarget {
  step: RunStep;
  phase: RunPhase;
  rewindable: boolean;
}

/** Internal type: all checkpoint names including non-rewindable */
type CheckpointName = RewindCheckpoint | 'completed';

export const CHECKPOINT_REGISTRY: Record<CheckpointName, CheckpointTarget> = {
  'planning:start':         { step: 'planner_create_plan',       phase: 'planning',               rewindable: true },
  'awaiting_plan_approval': { step: 'wait_plan_approval',        phase: 'awaiting_plan_approval', rewindable: true },
  'executing:start':        { step: 'implementer_apply_changes', phase: 'executing',              rewindable: true },
  'awaiting_review':        { step: 'reviewer_review_code',      phase: 'awaiting_review',        rewindable: true },
  'completed':              { step: 'cleanup',                   phase: 'completed',              rewindable: false },
};

/**
 * Resolve a checkpoint string to its target.
 * Returns null for non-rewindable or unknown checkpoints.
 */
export function resolveCheckpoint(checkpoint: string): CheckpointTarget | null {
  const entry = CHECKPOINT_REGISTRY[checkpoint as CheckpointName] as CheckpointTarget | undefined;
  if (entry?.rewindable !== true) return null;
  return entry;
}
