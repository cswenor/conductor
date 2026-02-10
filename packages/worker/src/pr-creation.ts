/**
 * PR creation: push the run's branch to GitHub.
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
  resolveCredentials,
  getDatabase,
  createLogger,
} from '@conductor/shared';

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
  try {
    const creds = await resolveCredentials(db, { runId, step: 'create_pr' });
    if (creds.mode !== 'github_installation') {
      markRunFailed(db, runId, 'Unexpected credential mode for create_pr step');
      return;
    }
    token = creds.token;
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

  // TODO WP10.3: Create PR via outbox, update run PR bundle, transition step to wait_pr_merge
}
