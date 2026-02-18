/**
 * Worktree Restore — Baseline SHA persistence + strict restoration.
 *
 * Captures HEAD SHA on first attempt of each step episode, persists to a file
 * outside the worktree (immune to git clean -fdx), and restores to that exact
 * SHA after step completion. Handles commit leaks, untracked artifacts, and
 * retry-across-episode safety.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, readdirSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { createLogger } from '../../logger/index.ts';
import { AgentError } from '../provider.ts';

const log = createLogger({ name: 'conductor:worktree-restore' });

const SHA_PATTERN = /^[0-9a-f]{40}$/;

function baselineFilePath(
  worktreePath: string, runId: string, stepKey: string, episodeId: number,
): string {
  return join(dirname(worktreePath), `.conductor-baseline-${runId}-${stepKey}-${episodeId}`);
}

/**
 * Get the persisted baseline SHA for a step episode, or capture and persist it.
 *
 * Stored in worktree's PARENT directory (immune to git clean -fdx).
 * Keyed by runId + stepKey + episodeId to prevent:
 * - Cross-run collision (different runs in shared worktrees dir)
 * - Cross-step interference (planner vs reviewer)
 * - Stale baselines across review rounds (episodeId changes per round)
 *
 * Episode IDs are derived from run counters (planRevisions, reviewRounds).
 * Retries of the same episode reuse the persisted baseline.
 * New episodes (after implementer rewrites) capture fresh baselines.
 */
export function getOrPersistBaselineSha(
  worktreePath: string, runId: string, stepKey: string, episodeId: number,
): string {
  const filePath = baselineFilePath(worktreePath, runId, stepKey, episodeId);

  // Try reading persisted baseline first (retry path)
  try {
    const sha = readFileSync(filePath, 'utf8').trim();
    if (SHA_PATTERN.test(sha)) {
      log.debug({ runId, stepKey, episodeId, sha: sha.slice(0, 8) }, 'Using persisted baseline SHA');
      return sha;
    }
    log.warn({ runId, stepKey, episodeId }, 'Invalid persisted baseline — recapturing');
  } catch {
    // File doesn't exist — first attempt of this episode
  }

  // First attempt of this episode: capture HEAD and persist
  try {
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: worktreePath,
      encoding: 'utf8',
      timeout: 10_000,
    }).trim();
    writeFileSync(filePath, sha, 'utf8');
    log.info({ runId, stepKey, episodeId, sha: sha.slice(0, 8) }, 'Captured and persisted baseline SHA');
    return sha;
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown';
    throw new AgentError(
      `Failed to capture baseline SHA: ${msg}`,
      'worktree_dirty',
    );
  }
}

/**
 * Restore an isolated worktree to the exact state at baselineSha.
 * Strict enforcement — throws AgentError if worktree cannot be cleaned.
 *
 * Operations:
 * 1. git reset --hard <baselineSha>  (undo commits + staging + modifications)
 * 2. git clean -fdx                   (remove untracked AND ignored files/dirs)
 * 3. git status --porcelain            (verify cleanliness)
 *
 * Uses baselineSha (not HEAD) to undo any commits created during the step
 * (e.g., test scripts running git commit). This prevents commit leaks that
 * could be picked up by PR creation.
 *
 * Only safe to call on isolated worktrees (not the main repo clone).
 * Throws AgentError with code 'worktree_dirty' if restoration fails.
 */
export function restoreWorktree(worktreePath: string, baselineSha: string): void {
  // Step 0: Log if HEAD has diverged (observability for commit leaks)
  try {
    const currentHead = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: worktreePath, encoding: 'utf8', timeout: 10_000,
    }).trim();
    if (currentHead !== baselineSha) {
      log.warn(
        { worktreePath, expected: baselineSha.slice(0, 8), actual: currentHead.slice(0, 8) },
        'HEAD diverged from baseline — restoring (possible commit leak from prior attempt)',
      );
    }
  } catch {
    // If we can't even read HEAD, the reset below will also fail and throw
  }

  // Step 1: Reset to baseline SHA (undoes commits + staging + modifications)
  try {
    execFileSync('git', ['reset', '--hard', baselineSha], {
      cwd: worktreePath,
      encoding: 'utf8',
      timeout: 30_000,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown';
    log.error({ worktreePath, baselineSha, error: msg }, 'Failed to reset worktree to baseline');
    throw new AgentError(
      `Worktree restoration failed (git reset --hard ${baselineSha}): ${msg}`,
      'worktree_dirty',
    );
  }

  // Step 2: Remove untracked + ignored files
  try {
    execFileSync('git', ['clean', '-fdx'], {
      cwd: worktreePath,
      encoding: 'utf8',
      timeout: 60_000,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown';
    log.error({ worktreePath, error: msg }, 'Failed to clean untracked/ignored files');
    throw new AgentError(
      `Worktree restoration failed (git clean -fdx): ${msg}`,
      'worktree_dirty',
    );
  }

  // Step 3: Verify cleanliness + correct HEAD
  try {
    const status = execFileSync('git', ['status', '--porcelain'], {
      cwd: worktreePath,
      encoding: 'utf8',
      timeout: 10_000,
    }).trim();

    if (status.length > 0) {
      log.error({ worktreePath, status }, 'Worktree still dirty after restoration');
      throw new AgentError(
        `Worktree still dirty after restoration: ${status.slice(0, 200)}`,
        'worktree_dirty',
      );
    }

    // Verify HEAD is at baseline
    const currentSha = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: worktreePath,
      encoding: 'utf8',
      timeout: 10_000,
    }).trim();

    if (currentSha !== baselineSha) {
      log.error({ worktreePath, expected: baselineSha, actual: currentSha }, 'HEAD does not match baseline');
      throw new AgentError(
        `Worktree HEAD mismatch after restoration (expected ${baselineSha.slice(0, 8)}, got ${currentSha.slice(0, 8)})`,
        'worktree_dirty',
      );
    }
  } catch (err) {
    if (err instanceof AgentError) throw err;
    const msg = err instanceof Error ? err.message : 'Unknown';
    log.error({ worktreePath, error: msg }, 'Failed to verify worktree cleanliness');
    throw new AgentError(
      `Worktree verification failed: ${msg}`,
      'worktree_dirty',
    );
  }

  log.info({ worktreePath, baselineSha: baselineSha.slice(0, 8) }, 'Worktree restored to baseline');
}

/**
 * Remove all persisted baseline files for a run.
 * Called by:
 * - cleanupWorktree() during worktree teardown (normal terminal path)
 * - blocked-retry when resetting counters (prevents stale baseline resurrection)
 *
 * Globs for .conductor-baseline-<runId>-* in worktree parent dir.
 */
export function clearRunBaselineFiles(worktreePath: string, runId: string): void {
  const parentDir = dirname(worktreePath);
  const prefix = `.conductor-baseline-${runId}-`;
  try {
    for (const entry of readdirSync(parentDir)) {
      if (entry.startsWith(prefix)) {
        try { unlinkSync(join(parentDir, entry)); } catch { /* benign */ }
      }
    }
  } catch {
    // Parent dir may not exist — benign during cleanup
  }
}
