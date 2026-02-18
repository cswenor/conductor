/**
 * Worktree Restore Tests
 *
 * Tests for baseline SHA persistence, strict worktree restoration,
 * and baseline file cleanup.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  getOrPersistBaselineSha,
  restoreWorktree,
  clearRunBaselineFiles,
} from './worktree-restore.ts';

// =============================================================================
// Helpers
// =============================================================================

function initTempRepo(): { repoPath: string; parentDir: string } {
  const parentDir = mkdtempSync(join(tmpdir(), 'conductor-wt-restore-'));
  const repoPath = join(parentDir, 'repo');
  execFileSync('git', ['init', repoPath], { encoding: 'utf8' });
  execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: repoPath });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repoPath });
  execFileSync('git', ['config', 'commit.gpgSign', 'false'], { cwd: repoPath });
  writeFileSync(join(repoPath, 'file.txt'), 'initial');
  execFileSync('git', ['add', '.'], { cwd: repoPath });
  execFileSync('git', ['commit', '-m', 'initial'], { cwd: repoPath });
  return { repoPath, parentDir };
}

function getHead(repoPath: string): string {
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoPath, encoding: 'utf8' }).trim();
}

// =============================================================================
// Test state
// =============================================================================

const cleanupDirs: string[] = [];

afterEach(() => {
  for (const dir of cleanupDirs) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  cleanupDirs.length = 0;
});

// =============================================================================
// getOrPersistBaselineSha
// =============================================================================

describe('getOrPersistBaselineSha', () => {
  it('captures HEAD SHA and persists to file on first call', () => {
    const { repoPath, parentDir } = initTempRepo();
    cleanupDirs.push(parentDir);

    const sha = getOrPersistBaselineSha(repoPath, 'run_1', 'planner', 0);
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    expect(sha).toBe(getHead(repoPath));

    // Verify file was created in parent dir
    const files = readdirSync(parentDir).filter(f => f.startsWith('.conductor-baseline-'));
    expect(files).toHaveLength(1);
    expect(files[0]).toBe('.conductor-baseline-run_1-planner-0');
  });

  it('returns persisted SHA on subsequent calls (retry path)', () => {
    const { repoPath, parentDir } = initTempRepo();
    cleanupDirs.push(parentDir);

    const sha1 = getOrPersistBaselineSha(repoPath, 'run_1', 'planner', 0);

    // Advance HEAD with a new commit
    writeFileSync(join(repoPath, 'extra.txt'), 'extra');
    execFileSync('git', ['add', '.'], { cwd: repoPath });
    execFileSync('git', ['commit', '-m', 'extra'], { cwd: repoPath });
    const newHead = getHead(repoPath);
    expect(newHead).not.toBe(sha1);

    // Second call should return the persisted baseline, not the new HEAD
    const sha2 = getOrPersistBaselineSha(repoPath, 'run_1', 'planner', 0);
    expect(sha2).toBe(sha1);
  });

  it('captures new baseline for different episodeId', () => {
    const { repoPath, parentDir } = initTempRepo();
    cleanupDirs.push(parentDir);

    const sha0 = getOrPersistBaselineSha(repoPath, 'run_1', 'planner', 0);

    // Advance HEAD
    writeFileSync(join(repoPath, 'extra.txt'), 'extra');
    execFileSync('git', ['add', '.'], { cwd: repoPath });
    execFileSync('git', ['commit', '-m', 'extra'], { cwd: repoPath });

    // Episode 1 should capture new HEAD
    const sha1 = getOrPersistBaselineSha(repoPath, 'run_1', 'planner', 1);
    expect(sha1).not.toBe(sha0);
    expect(sha1).toBe(getHead(repoPath));
  });

  it('isolates baselines by runId', () => {
    const { repoPath, parentDir } = initTempRepo();
    cleanupDirs.push(parentDir);

    const shaA = getOrPersistBaselineSha(repoPath, 'run_A', 'planner', 0);
    const shaB = getOrPersistBaselineSha(repoPath, 'run_B', 'planner', 0);

    // Same HEAD, but separate files
    expect(shaA).toBe(shaB);
    const files = readdirSync(parentDir).filter(f => f.startsWith('.conductor-baseline-'));
    expect(files).toHaveLength(2);
  });

  it('isolates baselines by stepKey', () => {
    const { repoPath, parentDir } = initTempRepo();
    cleanupDirs.push(parentDir);

    getOrPersistBaselineSha(repoPath, 'run_1', 'planner', 0);
    getOrPersistBaselineSha(repoPath, 'run_1', 'reviewerPlan', 0);

    const files = readdirSync(parentDir).filter(f => f.startsWith('.conductor-baseline-'));
    expect(files).toHaveLength(2);
  });
});

// =============================================================================
// restoreWorktree
// =============================================================================

describe('restoreWorktree', () => {
  it('restores to baseline when worktree is clean', () => {
    const { repoPath, parentDir } = initTempRepo();
    cleanupDirs.push(parentDir);

    const baselineSha = getHead(repoPath);
    restoreWorktree(repoPath, baselineSha);

    // HEAD should still be at baseline
    expect(getHead(repoPath)).toBe(baselineSha);
  });

  it('removes untracked files', () => {
    const { repoPath, parentDir } = initTempRepo();
    cleanupDirs.push(parentDir);

    const baselineSha = getHead(repoPath);

    // Create untracked file
    writeFileSync(join(repoPath, 'untracked.txt'), 'garbage');
    expect(existsSync(join(repoPath, 'untracked.txt'))).toBe(true);

    restoreWorktree(repoPath, baselineSha);

    expect(existsSync(join(repoPath, 'untracked.txt'))).toBe(false);
    expect(getHead(repoPath)).toBe(baselineSha);
  });

  it('reverts modified files', () => {
    const { repoPath, parentDir } = initTempRepo();
    cleanupDirs.push(parentDir);

    const baselineSha = getHead(repoPath);

    // Modify tracked file
    writeFileSync(join(repoPath, 'file.txt'), 'modified');

    restoreWorktree(repoPath, baselineSha);

    expect(readFileSync(join(repoPath, 'file.txt'), 'utf8')).toBe('initial');
  });

  it('undoes commits created during step (commit leak prevention)', () => {
    const { repoPath, parentDir } = initTempRepo();
    cleanupDirs.push(parentDir);

    const baselineSha = getHead(repoPath);

    // Simulate commit leak: agent or test script creates a commit
    writeFileSync(join(repoPath, 'leaked.txt'), 'leaked');
    execFileSync('git', ['add', '.'], { cwd: repoPath });
    execFileSync('git', ['commit', '-m', 'leaked commit'], { cwd: repoPath });
    const leakedHead = getHead(repoPath);
    expect(leakedHead).not.toBe(baselineSha);

    restoreWorktree(repoPath, baselineSha);

    expect(getHead(repoPath)).toBe(baselineSha);
    expect(existsSync(join(repoPath, 'leaked.txt'))).toBe(false);
  });

  it('throws AgentError for invalid baseline SHA', () => {
    const { repoPath, parentDir } = initTempRepo();
    cleanupDirs.push(parentDir);

    expect(() => restoreWorktree(repoPath, 'deadbeef'.repeat(5))).toThrow('Worktree restoration failed');
  });
});

// =============================================================================
// clearRunBaselineFiles
// =============================================================================

describe('clearRunBaselineFiles', () => {
  it('removes all baseline files for a run', () => {
    const { repoPath, parentDir } = initTempRepo();
    cleanupDirs.push(parentDir);

    // Create multiple baseline files
    getOrPersistBaselineSha(repoPath, 'run_1', 'planner', 0);
    getOrPersistBaselineSha(repoPath, 'run_1', 'planner', 1);
    getOrPersistBaselineSha(repoPath, 'run_1', 'reviewerPlan', 0);

    const beforeFiles = readdirSync(parentDir).filter(f => f.startsWith('.conductor-baseline-run_1-'));
    expect(beforeFiles).toHaveLength(3);

    clearRunBaselineFiles(repoPath, 'run_1');

    const afterFiles = readdirSync(parentDir).filter(f => f.startsWith('.conductor-baseline-run_1-'));
    expect(afterFiles).toHaveLength(0);
  });

  it('does not remove baseline files for other runs', () => {
    const { repoPath, parentDir } = initTempRepo();
    cleanupDirs.push(parentDir);

    getOrPersistBaselineSha(repoPath, 'run_A', 'planner', 0);
    getOrPersistBaselineSha(repoPath, 'run_B', 'planner', 0);

    clearRunBaselineFiles(repoPath, 'run_A');

    const remaining = readdirSync(parentDir).filter(f => f.startsWith('.conductor-baseline-'));
    expect(remaining).toHaveLength(1);
    expect(remaining[0]).toContain('run_B');
  });

  it('handles missing parent directory gracefully', () => {
    // Should not throw
    clearRunBaselineFiles('/nonexistent/path/worktree', 'run_1');
  });
});
