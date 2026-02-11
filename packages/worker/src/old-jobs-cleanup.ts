/**
 * Old job cleanup — time-based retention for BullMQ queues.
 *
 * Complements the count-based auto-removal (removeOnComplete/removeOnFail)
 * configured per queue by ensuring jobs older than a grace period are purged
 * regardless of count.
 */

import type { QueueManager, JobQueue } from '@conductor/shared';

/** Completed jobs older than 7 days are removed. */
export const COMPLETED_GRACE_MS = 7 * 24 * 60 * 60 * 1000;

/** Failed jobs older than 30 days are removed. */
export const FAILED_GRACE_MS = 30 * 24 * 60 * 60 * 1000;

/** Max job IDs returned per Queue.clean() call. */
export const CLEAN_BATCH_LIMIT = 1000;

/**
 * Drain a single queue/type combination by looping Queue.clean() until
 * fewer than CLEAN_BATCH_LIMIT IDs are returned (meaning all qualifying
 * jobs have been removed).
 */
async function drainClean(
  queue: { clean(grace: number, limit: number, type: 'completed' | 'failed'): Promise<string[]> },
  grace: number,
  type: 'completed' | 'failed',
): Promise<number> {
  let total = 0;
  let batch: string[];
  do {
    batch = await queue.clean(grace, CLEAN_BATCH_LIMIT, type);
    total += batch.length;
  } while (batch.length >= CLEAN_BATCH_LIMIT);
  return total;
}

/**
 * Remove old completed and failed jobs from all provided queues.
 *
 * Returns aggregate counts of removed jobs across every queue.
 */
export async function cleanOldJobs(
  qm: QueueManager,
  queueNames: readonly JobQueue[],
): Promise<{ completed: number; failed: number }> {
  let completed = 0;
  let failed = 0;

  for (const name of queueNames) {
    const queue = qm.getQueue(name);
    completed += await drainClean(queue, COMPLETED_GRACE_MS, 'completed');
    failed += await drainClean(queue, FAILED_GRACE_MS, 'failed');
  }

  return { completed, failed };
}
