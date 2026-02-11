import { describe, it, expect, vi } from 'vitest';
import type { QueueManager, JobQueue } from '@conductor/shared';
import {
  cleanOldJobs,
  COMPLETED_GRACE_MS,
  FAILED_GRACE_MS,
  CLEAN_BATCH_LIMIT,
} from './old-jobs-cleanup.ts';

/** Create a mock queue whose clean() returns the given batches in order. */
function mockQueue(completedBatches: string[][], failedBatches: string[][]) {
  let completedIdx = 0;
  let failedIdx = 0;

  return {
    clean: vi.fn((_grace: number, _limit: number, type: 'completed' | 'failed') => {
      if (type === 'completed') {
        const batch = completedBatches[completedIdx] ?? [];
        completedIdx++;
        return Promise.resolve(batch);
      }
      const batch = failedBatches[failedIdx] ?? [];
      failedIdx++;
      return Promise.resolve(batch);
    }),
  };
}

/** Build a fake QueueManager whose getQueue returns the provided map. */
function mockQueueManager(
  queueMap: Record<string, ReturnType<typeof mockQueue>>,
): QueueManager {
  return {
    getQueue: vi.fn((name: string) => queueMap[name]),
  } as unknown as QueueManager;
}

const QUEUES: JobQueue[] = ['webhooks', 'runs', 'agents', 'cleanup', 'github_writes'];

describe('cleanOldJobs', () => {
  it('removes completed and failed jobs across all queues', async () => {
    const queues: Record<string, ReturnType<typeof mockQueue>> = {};
    for (const name of QUEUES) {
      queues[name] = mockQueue([['j1', 'j2']], [['f1']]);
    }
    const qm = mockQueueManager(queues);

    const result = await cleanOldJobs(qm, QUEUES);

    // 2 completed * 5 queues, 1 failed * 5 queues
    expect(result.completed).toBe(10);
    expect(result.failed).toBe(5);
  });

  it('drains multiple batches when first batch is full', async () => {
    const fullBatch = Array.from({ length: CLEAN_BATCH_LIMIT }, (_, i) => `j${i}`);
    const partialBatch = ['j_extra1', 'j_extra2'];
    // completed: full batch then partial, failed: empty
    const queue = mockQueue([fullBatch, partialBatch], [[]]);
    const qm = mockQueueManager({ webhooks: queue });

    const result = await cleanOldJobs(qm, ['webhooks']);

    expect(result.completed).toBe(CLEAN_BATCH_LIMIT + 2);
    expect(result.failed).toBe(0);
    // clean() called 2 times for completed (drain loop) + 1 for failed
    expect(queue.clean).toHaveBeenCalledTimes(3);
  });

  it('returns zeros when no old jobs exist', async () => {
    const queues: Record<string, ReturnType<typeof mockQueue>> = {};
    for (const name of QUEUES) {
      queues[name] = mockQueue([[]], [[]]);
    }
    const qm = mockQueueManager(queues);

    const result = await cleanOldJobs(qm, QUEUES);

    expect(result.completed).toBe(0);
    expect(result.failed).toBe(0);
  });

  it('calls getQueue for each provided queue name', async () => {
    const queues: Record<string, ReturnType<typeof mockQueue>> = {};
    for (const name of QUEUES) {
      queues[name] = mockQueue([[]], [[]]);
    }
    const getQueueSpy = vi.fn((name: string) => queues[name]);
    const qm = { getQueue: getQueueSpy } as unknown as QueueManager;

    await cleanOldJobs(qm, QUEUES);

    for (const name of QUEUES) {
      expect(getQueueSpy).toHaveBeenCalledWith(name);
    }
    expect(getQueueSpy).toHaveBeenCalledTimes(QUEUES.length);
  });

  it('calls clean() with correct grace period and limit per type', async () => {
    const queue = mockQueue([['c1']], [['f1']]);
    const qm = mockQueueManager({ webhooks: queue });

    await cleanOldJobs(qm, ['webhooks']);

    expect(queue.clean).toHaveBeenCalledWith(COMPLETED_GRACE_MS, CLEAN_BATCH_LIMIT, 'completed');
    expect(queue.clean).toHaveBeenCalledWith(FAILED_GRACE_MS, CLEAN_BATCH_LIMIT, 'failed');
  });
});
