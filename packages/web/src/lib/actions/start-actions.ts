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
  listProjects,
  listProjectRepos,
  upsertTaskFromIssue,
  createGitHubClient,
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

interface SyncResult {
  success: boolean;
  error?: string;
  syncedCount?: number;
  reposSynced?: number;
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

    // Pre-generate all run IDs so we can write the final ID directly
    // in the guarded UPDATE — no placeholder state, no second UPDATE.
    const txn = db.transaction(() => {
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

        // Use repo's default branch; fall back to project default
        const repo = getRepo(db, task.repoId);
        const baseBranch = repo?.githubDefaultBranch ?? project.defaultBaseBranch;

        // Pre-generate run ID so the guarded UPDATE writes the final value
        const runId = generateRunId();
        const now = new Date().toISOString();

        // Guarded UPDATE: claim the task atomically with the real run ID
        const result = db.prepare(
          'UPDATE tasks SET active_run_id = ?, updated_at = ?, last_activity_at = ? WHERE task_id = ? AND active_run_id IS NULL'
        ).run(runId, now, now, taskId);

        if (result.changes === 0) {
          // Task already has an active run — skip
          skippedTaskIds.push(taskId);
          continue;
        }

        // Create the run with the same pre-generated ID
        createRun(db, {
          runId,
          taskId,
          projectId: task.projectId,
          repoId: task.repoId,
          baseBranch,
        });

        startedRunIds.push(runId);
      }
    });

    txn();

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

const STALE_THRESHOLD_MS = 15 * 60 * 1000; // 15 minutes

/**
 * Sync issues from stale repos via GitHub API.
 */
export async function syncRepoIssues(projectId?: string): Promise<SyncResult> {
  try {
    const user = await requireServerUser();
    const db = await getDb();

    // Gather repos to sync
    const projectSummaries = listProjects(db, { userId: user.userId });
    const reposToSync: Array<{ repo: ReturnType<typeof listProjectRepos>[number]; installationId: number }> = [];

    const now = Date.now();

    for (const summary of projectSummaries) {
      if (projectId !== undefined && summary.projectId !== projectId) continue;
      const project = getProject(db, summary.projectId);
      if (project === null) continue;
      const repos = listProjectRepos(db, project.projectId, { status: 'active' });
      for (const repo of repos) {
        const isStale =
          repo.lastFetchedAt === undefined ||
          now - new Date(repo.lastFetchedAt).getTime() > STALE_THRESHOLD_MS;
        if (isStale) {
          reposToSync.push({ repo, installationId: project.githubInstallationId });
        }
      }
    }

    let syncedCount = 0;
    let reposSynced = 0;

    for (const { repo, installationId } of reposToSync) {
      try {
        const client = createGitHubClient(installationId);
        const issues = await client.listIssues(repo.githubOwner, repo.githubName, {
          state: 'open',
          since: repo.lastFetchedAt,
        });

        for (const issue of issues) {
          upsertTaskFromIssue(db, {
            projectId: repo.projectId,
            repoId: repo.repoId,
            githubNodeId: issue.nodeId,
            githubIssueNumber: issue.number,
            githubType: 'issue',
            githubTitle: issue.title,
            githubBody: issue.body ?? '',
            githubState: issue.state,
            githubLabelsJson: JSON.stringify(issue.labels.map(l => l.name)),
          });
          syncedCount++;
        }

        // Update last_fetched_at
        db.prepare(
          'UPDATE repos SET last_fetched_at = ?, updated_at = ? WHERE repo_id = ?'
        ).run(new Date().toISOString(), new Date().toISOString(), repo.repoId);

        reposSynced++;
      } catch (err) {
        log.error(
          { repoId: repo.repoId, error: err instanceof Error ? err.message : 'Unknown' },
          'Failed to sync repo issues'
        );
        // Continue with other repos
      }
    }

    revalidatePath('/start');

    log.info({ syncedCount, reposSynced }, 'syncRepoIssues completed');

    return {
      success: true,
      syncedCount,
      reposSynced,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Failed to sync issues';
    log.error({ error: msg }, 'syncRepoIssues failed');
    return { success: false, error: msg };
  }
}
