'use server';

import { revalidatePath } from 'next/cache';
import {
  createLogger,
  getTask,
  getProject,
  getRepo,
  canAccessProject,
  createRun,
  generateRunId,
} from '@conductor/shared';
import { getDb, getQueues } from '@/lib/bootstrap';
import { requireServerUser } from '@/lib/auth/session';

const log = createLogger({ name: 'conductor:actions:start' });

interface StartWorkResult {
  success: boolean;
  error?: string;
  startedCount?: number;
  skippedCount?: number;
  skippedTaskIds?: string[];
}

/**
 * Batch-create runs for selected tasks with race-condition protection.
 */
export async function startWork(taskIds: string[]): Promise<StartWorkResult> {
  try {
    const user = await requireServerUser();
    const db = await getDb();
    const queues = await getQueues();

    if (taskIds.length === 0) {
      return { success: false, error: 'No tasks selected' };
    }

    const startedRunIds: string[] = [];
    const skippedTaskIds: string[] = [];

    const claimAndCreate = db.transaction((input: {
      taskId: string;
      runId: string;
      projectId: string;
      repoId: string;
      baseBranch: string;
    }) => {
      const now = new Date().toISOString();
      const result = db.prepare(
        'UPDATE tasks SET active_run_id = ?, updated_at = ?, last_activity_at = ? WHERE task_id = ? AND active_run_id IS NULL'
      ).run(input.runId, now, now, input.taskId);

      if (result.changes === 0) {
        return false;
      }

      createRun(db, {
        runId: input.runId,
        taskId: input.taskId,
        projectId: input.projectId,
        repoId: input.repoId,
        baseBranch: input.baseBranch,
      });

      return true;
    });

    for (const taskId of taskIds) {
      const task = getTask(db, taskId);
      if (task === null) {
        skippedTaskIds.push(taskId);
        continue;
      }

      const project = getProject(db, task.projectId);
      if (project === null || !canAccessProject(user, project)) {
        skippedTaskIds.push(taskId);
        continue;
      }

      const repo = getRepo(db, task.repoId);
      const baseBranch = repo?.githubDefaultBranch ?? project.defaultBaseBranch;
      const runId = generateRunId();

      const created = claimAndCreate({
        taskId,
        runId,
        projectId: task.projectId,
        repoId: task.repoId,
        baseBranch,
      });

      if (!created) {
        skippedTaskIds.push(taskId);
        continue;
      }

      startedRunIds.push(runId);
    }

    // Enqueue run:start jobs after transaction
    for (const runId of startedRunIds) {
      try {
        await queues.addJob('runs', `run:start:${runId}`, {
          runId,
          action: 'start',
        });
      } catch (err) {
        log.error({ runId, error: err instanceof Error ? err.message : 'Unknown' }, 'Failed to enqueue run start');
        // Mark run as blocked
        db.prepare(
          "UPDATE runs SET phase = 'blocked', blocked_reason = 'enqueue_failed', updated_at = ? WHERE run_id = ?"
        ).run(new Date().toISOString(), runId);
      }
    }

    revalidatePath('/start');
    revalidatePath('/work');
    revalidatePath('/dashboard');

    log.info({ startedCount: startedRunIds.length, skippedCount: skippedTaskIds.length }, 'startWork completed');

    return {
      success: true,
      startedCount: startedRunIds.length,
      skippedCount: skippedTaskIds.length,
      skippedTaskIds: skippedTaskIds.length > 0 ? skippedTaskIds : undefined,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Failed to start work';
    log.error({ error: msg }, 'startWork failed');
    return { success: false, error: msg };
  }
}
