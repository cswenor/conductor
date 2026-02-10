/**
 * PR creation: push the run's branch to GitHub and create a PR via outbox.
 *
 * Extracted from index.ts for testability. The auth URL and token are
 * constructed locally and never written to logs or error messages.
 */

import { execFileSync } from 'node:child_process';
import {
  type Run,
  getRun,
  getWorktreeForRun,
  getRepo,
  getTask,
  resolveCredentials,
  getDatabase,
  createLogger,
  GitHubClient,
  enqueuePullRequest,
  processSingleWrite,
  getWrite,
  resetStalledWrite,
  updateRunPrBundle,
} from '@conductor/shared';
import { casUpdateRunStep } from './run-helpers.ts';

const log = createLogger({ name: 'conductor:worker:pr-creation' });

type Db = ReturnType<typeof getDatabase>;
type MarkRunFailed = (db: Db, runId: string, reason: string) => void;

export async function handlePrCreation(
  db: Db,
  run: Run,
  markRunFailed: MarkRunFailed
): Promise<void> {
  const { runId } = run;

  // Re-read run and bail if no longer in the expected state
  const freshRun = getRun(db, runId);
  if (freshRun?.phase !== 'awaiting_review' || freshRun.step !== 'create_pr') {
    log.info(
      { runId, phase: freshRun?.phase, step: freshRun?.step },
      'Run not in awaiting_review/create_pr, skipping push'
    );
    return;
  }

  // Validate branch
  const branch = freshRun.branch;
  if (!branch) {
    markRunFailed(db, runId, 'No branch set on run');
    return;
  }

  // Get worktree
  const worktree = getWorktreeForRun(db, runId);
  if (worktree === null) {
    markRunFailed(db, runId, 'No active worktree found for run');
    return;
  }

  // Get repo
  const repo = getRepo(db, freshRun.repoId);
  if (repo === null) {
    markRunFailed(db, runId, 'Repository not found for run');
    return;
  }

  // Resolve credentials
  let token: string;
  let installationId: number;
  try {
    const creds = await resolveCredentials(db, { runId, step: 'create_pr' });
    if (creds.mode !== 'github_installation') {
      markRunFailed(db, runId, 'Unexpected credential mode for create_pr step');
      return;
    }
    token = creds.token;
    installationId = creds.installationId;
  } catch {
    markRunFailed(db, runId, 'Failed to resolve credentials for PR creation');
    return;
  }

  // Push branch — auth URL is local-only, never logged
  const authUrl = `https://x-access-token:${token}@github.com/${repo.githubOwner}/${repo.githubName}.git`;
  try {
    execFileSync('git', ['push', authUrl, branch], {
      cwd: worktree.path,
      timeout: 60_000,
    });
  } catch {
    markRunFailed(db, runId, 'Git push failed');
    return;
  }

  log.info({ runId, branch, repo: repo.githubFullName }, 'Branch pushed to GitHub');

  // --- WP10.3: Create PR via outbox ---

  // Get task info for PR title/body
  const task = getTask(db, freshRun.taskId);
  if (task === null) {
    markRunFailed(db, runId, 'Task not found for run');
    return;
  }

  // Idempotency check — look for an existing open PR on this branch
  const client = new GitHubClient(installationId);
  const existingPrs = await client.listPullRequests(
    repo.githubOwner,
    repo.githubName,
    { head: `${repo.githubOwner}:${branch}`, state: 'open' }
  );

  if (existingPrs.length > 0 && existingPrs[0] !== undefined) {
    const existingPr = existingPrs[0];
    const updated = updateRunPrBundle(db, {
      runId,
      prNumber: existingPr.number,
      prNodeId: existingPr.nodeId,
      prUrl: existingPr.htmlUrl,
      prState: existingPr.merged ? 'merged' : existingPr.state,
      prSyncedAt: new Date().toISOString(),
    });
    if (!updated) {
      markRunFailed(db, runId, 'Failed to update run PR bundle');
      return;
    }
    const stepped = casUpdateRunStep(db, runId, 'awaiting_review', 'create_pr', 'wait_pr_merge');
    if (!stepped) {
      log.info({ runId }, 'CAS step failed after backfilling existing PR (stale job)');
    }
    return;
  }

  // Enqueue PR creation (no queueManager — we process directly)
  const enqueueResult = enqueuePullRequest({
    db,
    runId,
    owner: repo.githubOwner,
    repo: repo.githubName,
    repoNodeId: repo.githubNodeId,
    title: task.githubTitle,
    body: `Closes #${task.githubIssueNumber}\n\n${task.githubTitle}`,
    head: branch,
    base: freshRun.baseBranch,
  });

  if (!enqueueResult.isNew) {
    // Deduplicated write — handle based on current status
    const write = getWrite(db, enqueueResult.githubWriteId);
    if (write === null) {
      markRunFailed(db, runId, 'Enqueued write not found');
      return;
    }

    switch (write.status) {
      case 'completed': {
        // Crash recovery: PR exists on GitHub but run wasn't updated.
        // Parse PR number from write.githubUrl (format: https://github.com/{owner}/{repo}/pull/{number})
        const prNumberMatch = write.githubUrl?.match(/\/pull\/(\d+)$/);
        const prNumberStr = prNumberMatch?.[1];
        if (prNumberStr === undefined || prNumberStr === null) {
          markRunFailed(db, runId, 'Cannot parse PR number from completed write URL');
          return;
        }
        const prNumber = parseInt(prNumberStr, 10);
        const pr = await client.getPullRequest(repo.githubOwner, repo.githubName, prNumber);
        const prState = pr.merged ? 'merged' : pr.state;
        const updated = updateRunPrBundle(db, {
          runId,
          prNumber: pr.number,
          prNodeId: pr.nodeId,
          prUrl: pr.htmlUrl,
          prState,
          prSyncedAt: new Date().toISOString(),
        });
        if (!updated) {
          markRunFailed(db, runId, 'Failed to update run PR bundle');
          return;
        }
        const stepped = casUpdateRunStep(db, runId, 'awaiting_review', 'create_pr', 'wait_pr_merge');
        if (!stepped) {
          log.info({ runId }, 'CAS step failed after crash-recovery backfill (stale job)');
        }
        return;
      }

      case 'queued':
      case 'failed': {
        // Previous attempt persisted but didn't finish — process directly
        const result = await processSingleWrite(db, write.githubWriteId, installationId);
        handleWriteResult(db, runId, result, markRunFailed);
        return;
      }

      case 'processing': {
        // Potentially stalled write
        const wasReset = resetStalledWrite(db, write.githubWriteId);
        if (wasReset) {
          const result = await processSingleWrite(db, write.githubWriteId, installationId);
          handleWriteResult(db, runId, result, markRunFailed);
        } else {
          log.info(
            { runId, githubWriteId: write.githubWriteId },
            'Write is processing and not stale, will retry later'
          );
        }
        return;
      }

      case 'cancelled': {
        log.info(
          { runId, githubWriteId: write.githubWriteId },
          'Write was cancelled, skipping (stale)'
        );
        return;
      }
    }
  }

  // New write — process directly
  const result = await processSingleWrite(db, enqueueResult.githubWriteId, installationId);
  handleWriteResult(db, runId, result, markRunFailed);
}

/**
 * Handle the result of processSingleWrite: update PR bundle and CAS step.
 */
function handleWriteResult(
  db: Db,
  runId: string,
  result: { success: boolean; githubUrl?: string; nodeId?: string; number?: number; error?: string },
  markRunFailed: MarkRunFailed
): void {
  if (!result.success) {
    markRunFailed(db, runId, `PR creation failed: ${result.error ?? 'Unknown error'}`);
    return;
  }

  const updated = updateRunPrBundle(db, {
    runId,
    prNumber: result.number ?? 0,
    prNodeId: result.nodeId ?? '',
    prUrl: result.githubUrl ?? '',
    prState: 'open',
    prSyncedAt: new Date().toISOString(),
  });

  if (!updated) {
    markRunFailed(db, runId, 'Failed to update run PR bundle');
    return;
  }

  const stepped = casUpdateRunStep(db, runId, 'awaiting_review', 'create_pr', 'wait_pr_merge');
  if (!stepped) {
    log.info({ runId }, 'CAS step failed after PR creation (stale job)');
  }
}
