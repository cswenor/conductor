/**
 * Run step helpers for the worker.
 */

import { getDatabase, type Run } from '@conductor/shared';

type Db = ReturnType<typeof getDatabase>;

/**
 * Check whether a run job is stale based on expected phase and event sequence.
 *
 * Returns a reason string if stale, or undefined if the job is still valid.
 * The sequence check prevents a duplicate retry from acting on a later
 * blocked episode (same phase, different epoch).
 */
export function isStaleRunJob(
  run: Run,
  expectedPhase: string | undefined,
  expectedSequence: number | undefined,
): string | undefined {
  if (expectedPhase !== undefined && run.phase !== expectedPhase) {
    return `phase mismatch: expected ${expectedPhase}, got ${run.phase}`;
  }
  if (expectedSequence !== undefined && run.lastEventSequence !== expectedSequence) {
    return `sequence mismatch: expected ${expectedSequence}, got ${run.lastEventSequence}`;
  }
  return undefined;
}

/**
 * Compare-and-set step update.
 *
 * Only updates the step if the run is currently in the expected phase and step.
 * Returns true if the row was updated (CAS succeeded), false otherwise.
 * This is atomic at the SQLite level — no race window between read and write.
 */
export function casUpdateRunStep(
  db: Db,
  runId: string,
  expectedPhase: string,
  expectedStep: string,
  newStep: string
): boolean {
  const result = db.prepare(
    'UPDATE runs SET step = ?, updated_at = ? WHERE run_id = ? AND phase = ? AND step = ?'
  ).run(newStep, new Date().toISOString(), runId, expectedPhase, expectedStep);
  return result.changes > 0;
}
