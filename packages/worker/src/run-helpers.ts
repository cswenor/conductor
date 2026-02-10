/**
 * Run step helpers for the worker.
 */

import { getDatabase } from '@conductor/shared';

type Db = ReturnType<typeof getDatabase>;

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
