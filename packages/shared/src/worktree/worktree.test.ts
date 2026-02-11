/**
 * Worktree Module Tests
 *
 * Tests for configuration, branch resolution, utility functions,
 * port management, heartbeat, git integration, and janitor.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Database as DatabaseType } from 'better-sqlite3';
import { mkdirSync, rmSync, existsSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execFileSync } from 'child_process';
import { initDatabase, closeDatabase } from '../db/index.ts';
import {
  getDataDir,
  getReposDir,
  getWorktreesDir,
  getLocksDir,
  getPortRange,
  getLeaseTimeoutHours,
  resolveBaseBranch,
  generateBranchName,
  isValidBranchName,
  allocatePort,
  releasePort,
  releaseWorktreePorts,
  releaseExpiredPortLeases,
  getWorktreePorts,
  updateWorktreeHeartbeat,
  cloneOrFetchRepo,
  createWorktree,
  cleanupWorktree,
  runJanitor,
} from './index.ts';

// =============================================================================
// Test Helpers
// =============================================================================

interface SeedResult {
  userId: string;
  projectId: string;
  repoId: string;
  taskId: string;
  runId: string;
  policySetId: string;
}

function seedTestData(db: DatabaseType, suffix = ''): SeedResult {
  const s = suffix;
  const now = new Date().toISOString();
  const userId = `user_test${s}`;
  const projectId = `proj_test${s}`;
  const repoId = `repo_test${s}`;
  const taskId = `task_test${s}`;
  const runId = `run_test${s}`;
  const policySetId = `ps_test${s}`;

  db.prepare(`
    INSERT INTO users (user_id, github_id, github_node_id, github_login, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'active', ?, ?)
  `).run(userId, 100 + Number(s || 0), `U_test${s}`, `testuser${s}`, now, now);

  db.prepare(`
    INSERT INTO projects (
      project_id, user_id, name, github_org_id, github_org_node_id, github_org_name,
      github_installation_id, default_profile_id, default_base_branch,
      port_range_start, port_range_end, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(projectId, userId, `Test Project${s}`, 1 + Number(s || 0), `O_test${s}`, `testorg${s}`,
    12345 + Number(s || 0), 'default', 'main', 3100, 3199, now, now);

  db.prepare(`
    INSERT INTO policy_sets (policy_set_id, project_id, config_hash, created_by, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(policySetId, projectId, `hash${s}`, 'system', now);

  db.prepare(`
    INSERT INTO repos (
      repo_id, project_id, github_node_id, github_numeric_id,
      github_owner, github_name, github_full_name, github_default_branch,
      profile_id, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(repoId, projectId, `R_test${s}`, 100 + Number(s || 0),
    'testowner', 'testrepo', `testowner/testrepo${s}`, 'main',
    'default', 'active', now, now);

  db.prepare(`
    INSERT INTO tasks (
      task_id, project_id, repo_id, github_node_id, github_issue_number,
      github_type, github_title, github_body, github_state, github_labels_json,
      github_synced_at, created_at, updated_at, last_activity_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(taskId, projectId, repoId, `I_test${s}`, 42,
    'issue', 'Test Task', 'Body', 'open', '[]',
    now, now, now, now);

  db.prepare(`
    INSERT INTO runs (
      run_id, task_id, project_id, repo_id, phase, step,
      policy_set_id, base_branch, branch, started_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(runId, taskId, projectId, repoId, 'planning', 'init',
    policySetId, 'main', `conductor/issue-42${s}`, now, now);

  return { userId, projectId, repoId, taskId, runId, policySetId };
}

function insertWorktreeRow(
  db: DatabaseType,
  overrides: {
    worktreeId?: string;
    runId: string;
    projectId: string;
    repoId: string;
    path?: string;
    branchName?: string;
    baseCommit?: string;
    status?: string;
  }
): string {
  const now = new Date().toISOString();
  const worktreeId = overrides.worktreeId ?? `wt_test_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const path = overrides.path ?? `/tmp/fake-worktree-${worktreeId}`;

  db.prepare(`
    INSERT INTO worktrees (
      worktree_id, run_id, project_id, repo_id, path, branch_name, base_commit,
      status, last_heartbeat_at, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    worktreeId,
    overrides.runId,
    overrides.projectId,
    overrides.repoId,
    path,
    overrides.branchName ?? null,
    overrides.baseCommit ?? null,
    overrides.status ?? 'active',
    now,
    now
  );

  return worktreeId;
}

function seedAdditionalRun(
  db: DatabaseType,
  seed: SeedResult,
  runSuffix: string
): string {
  const now = new Date().toISOString();
  const runId = `run_extra_${runSuffix}`;
  const taskId = seed.taskId;

  db.prepare(`
    INSERT INTO runs (
      run_id, task_id, project_id, repo_id, phase, step,
      policy_set_id, base_branch, branch, started_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(runId, taskId, seed.projectId, seed.repoId, 'planning', 'init',
    seed.policySetId, 'main', `conductor/extra-${runSuffix}`, now, now);

  return runId;
}

interface BareRepoResult {
  bareRepoPath: string;
  commitSha: string;
}

function createLocalBareRepo(testDir: string, branchName = 'main'): BareRepoResult {
  const bareRepoPath = join(testDir, 'bare-repo.git');
  const workDir = join(testDir, 'tmp-work');

  // Create bare repo
  mkdirSync(bareRepoPath, { recursive: true });
  execFileSync('git', ['init', '--bare', bareRepoPath], { encoding: 'utf8' });

  // Create a temporary working repo, add a commit, push to bare
  mkdirSync(workDir, { recursive: true });
  execFileSync('git', ['init', workDir], { encoding: 'utf8' });
  execFileSync('git', ['checkout', '-b', branchName], { cwd: workDir, encoding: 'utf8' });
  execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: workDir, encoding: 'utf8' });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: workDir, encoding: 'utf8' });
  execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: workDir, encoding: 'utf8' });

  writeFileSync(join(workDir, 'README.md'), '# Test\n');
  execFileSync('git', ['add', '.'], { cwd: workDir, encoding: 'utf8' });
  execFileSync('git', ['commit', '-m', 'Initial commit'], { cwd: workDir, encoding: 'utf8' });
  execFileSync('git', ['remote', 'add', 'origin', bareRepoPath], { cwd: workDir, encoding: 'utf8' });
  execFileSync('git', ['push', 'origin', branchName], { cwd: workDir, encoding: 'utf8' });

  const commitSha = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: workDir,
    encoding: 'utf8',
  }).trim();

  // Clean up working dir
  rmSync(workDir, { recursive: true, force: true });

  return { bareRepoPath, commitSha };
}

// =============================================================================
// Tests
// =============================================================================

describe('Worktree Module', () => {
  let db: DatabaseType;
  let testDir: string;

  beforeEach(() => {
    db = initDatabase({ path: ':memory:' });

    testDir = join(tmpdir(), `conductor-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(testDir, { recursive: true });

    process.env['CONDUCTOR_DATA_DIR'] = testDir;
  });

  afterEach(() => {
    closeDatabase(db);
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
    delete process.env['CONDUCTOR_DATA_DIR'];
    delete process.env['CONDUCTOR_PORT_RANGE'];
    delete process.env['CONDUCTOR_LEASE_TIMEOUT_HOURS'];
  });

  // ===========================================================================
  // Configuration (existing)
  // ===========================================================================

  describe('Configuration', () => {
    it('should use CONDUCTOR_DATA_DIR when set', () => {
      process.env['CONDUCTOR_DATA_DIR'] = '/custom/path';
      expect(getDataDir()).toBe('/custom/path');
    });

    it('should default to ~/.conductor', () => {
      delete process.env['CONDUCTOR_DATA_DIR'];
      const home = process.env['HOME'] ?? '/tmp';
      expect(getDataDir()).toBe(join(home, '.conductor'));
    });

    it('should build repos dir from data dir', () => {
      expect(getReposDir()).toBe(join(testDir, 'repos'));
    });

    it('should build worktrees dir from data dir', () => {
      expect(getWorktreesDir()).toBe(join(testDir, 'worktrees'));
    });

    it('should parse port range from env', () => {
      process.env['CONDUCTOR_PORT_RANGE'] = '4000-4099';
      expect(getPortRange()).toEqual({ min: 4000, max: 4099 });
    });

    it('should use default port range', () => {
      delete process.env['CONDUCTOR_PORT_RANGE'];
      expect(getPortRange()).toEqual({ min: 3100, max: 3199 });
    });

    it('should parse lease timeout from env', () => {
      process.env['CONDUCTOR_LEASE_TIMEOUT_HOURS'] = '48';
      expect(getLeaseTimeoutHours()).toBe(48);
    });

    it('should use default lease timeout', () => {
      delete process.env['CONDUCTOR_LEASE_TIMEOUT_HOURS'];
      expect(getLeaseTimeoutHours()).toBe(24);
    });
  });

  // ===========================================================================
  // Branch Resolution (existing)
  // ===========================================================================

  describe('Branch Resolution', () => {
    beforeEach(() => {
      seedTestData(db);
    });

    it('should use configured default if provided', () => {
      expect(resolveBaseBranch(db, 'repo_test', 'custom-branch')).toBe('custom-branch');
    });

    it('should use GitHub default branch from repo', () => {
      expect(resolveBaseBranch(db, 'repo_test')).toBe('main');
    });

    it('should fallback to main if no default', () => {
      db.prepare('UPDATE repos SET github_default_branch = ? WHERE repo_id = ?').run('', 'repo_test');
      expect(resolveBaseBranch(db, 'repo_test')).toBe('main');
    });

    it('should fallback to main for non-existent repo', () => {
      expect(resolveBaseBranch(db, 'nonexistent')).toBe('main');
    });

    it('should reject invalid configured branch name', () => {
      expect(() => resolveBaseBranch(db, 'repo_test', 'branch..bad')).toThrow(/Invalid base branch name/);
    });

    it('should reject configured branch with control characters', () => {
      expect(() => resolveBaseBranch(db, 'repo_test', 'branch\x00name')).toThrow(/Invalid base branch name/);
    });
  });

  // ===========================================================================
  // Branch Resolution with Clone Path (git-verified fallback)
  // ===========================================================================

  describe('Branch Resolution with Clone Path', () => {
    beforeEach(() => {
      seedTestData(db);
    });

    it('should return main when main branch exists in clone', () => {
      const { bareRepoPath } = createLocalBareRepo(testDir, 'main');
      db.prepare('UPDATE repos SET github_default_branch = ? WHERE repo_id = ?').run('', 'repo_test');

      expect(resolveBaseBranch(db, 'repo_test', undefined, bareRepoPath)).toBe('main');
    });

    it('should fall back to master when only master exists in clone', () => {
      const masterDir = join(testDir, 'master-test');
      mkdirSync(masterDir, { recursive: true });
      const { bareRepoPath } = createLocalBareRepo(masterDir, 'master');
      db.prepare('UPDATE repos SET github_default_branch = ? WHERE repo_id = ?').run('', 'repo_test');

      expect(resolveBaseBranch(db, 'repo_test', undefined, bareRepoPath)).toBe('master');
    });

    it('should prefer main over master when both exist', () => {
      const { bareRepoPath } = createLocalBareRepo(testDir, 'main');
      // Add a master branch to the same bare repo
      const workDir = join(testDir, 'tmp-both');
      mkdirSync(workDir, { recursive: true });
      execFileSync('git', ['clone', bareRepoPath, workDir], { encoding: 'utf8' });
      execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: workDir, encoding: 'utf8' });
      execFileSync('git', ['config', 'user.name', 'Test'], { cwd: workDir, encoding: 'utf8' });
      execFileSync('git', ['checkout', '-b', 'master'], { cwd: workDir, encoding: 'utf8' });
      writeFileSync(join(workDir, 'master.txt'), 'master branch');
      execFileSync('git', ['add', '.'], { cwd: workDir, encoding: 'utf8' });
      execFileSync('git', ['commit', '-m', 'master commit'], { cwd: workDir, encoding: 'utf8' });
      execFileSync('git', ['push', 'origin', 'master'], { cwd: workDir, encoding: 'utf8' });
      rmSync(workDir, { recursive: true, force: true });

      db.prepare('UPDATE repos SET github_default_branch = ? WHERE repo_id = ?').run('', 'repo_test');

      expect(resolveBaseBranch(db, 'repo_test', undefined, bareRepoPath)).toBe('main');
    });

    it('should still use GitHub default branch regardless of clone contents', () => {
      const masterDir = join(testDir, 'gh-default-test');
      mkdirSync(masterDir, { recursive: true });
      // Clone only has master, but GitHub default says 'develop'
      createLocalBareRepo(masterDir, 'master');
      db.prepare('UPDATE repos SET github_default_branch = ? WHERE repo_id = ?').run('develop', 'repo_test');

      // GitHub default takes priority over clone inspection
      expect(resolveBaseBranch(db, 'repo_test', undefined, masterDir)).toBe('develop');
    });

    it('should return main when clone has neither main nor master', () => {
      const otherDir = join(testDir, 'no-default-test');
      mkdirSync(otherDir, { recursive: true });
      const { bareRepoPath } = createLocalBareRepo(otherDir, 'develop');
      db.prepare('UPDATE repos SET github_default_branch = ? WHERE repo_id = ?').run('', 'repo_test');

      // Neither main nor master exists — falls through to default 'main'
      expect(resolveBaseBranch(db, 'repo_test', undefined, bareRepoPath)).toBe('main');
    });

    it('should skip invalid github_default_branch and fall through to clone inspection', () => {
      const { bareRepoPath } = createLocalBareRepo(testDir, 'main');
      // Set an invalid branch name in the DB (double dots violate git ref rules)
      db.prepare('UPDATE repos SET github_default_branch = ? WHERE repo_id = ?').run('branch..bad', 'repo_test');

      // Should skip the invalid DB value and find main in the clone
      expect(resolveBaseBranch(db, 'repo_test', undefined, bareRepoPath)).toBe('main');
    });

    it('should skip invalid github_default_branch and fall back to master', () => {
      const masterDir = join(testDir, 'invalid-db-master-test');
      mkdirSync(masterDir, { recursive: true });
      const { bareRepoPath } = createLocalBareRepo(masterDir, 'master');
      // Set an invalid branch name in the DB
      db.prepare('UPDATE repos SET github_default_branch = ? WHERE repo_id = ?').run('.dotstart', 'repo_test');

      // Should skip the invalid DB value and find master in the clone
      expect(resolveBaseBranch(db, 'repo_test', undefined, bareRepoPath)).toBe('master');
    });
  });

  // ===========================================================================
  // Branch Name Generation (existing)
  // ===========================================================================

  describe('Branch Name Generation', () => {
    it('should generate deterministic branch name', () => {
      expect(generateBranchName('run_abc123')).toBe('conductor/run-run_abc123');
    });

    it('should handle different run ID formats', () => {
      expect(generateBranchName('run_ml6abc123def')).toBe('conductor/run-run_ml6abc123def');
    });
  });

  // ===========================================================================
  // Directory Structure (existing)
  // ===========================================================================

  describe('Directory Structure', () => {
    it('should create repos directory path correctly', () => {
      const reposDir = getReposDir();
      expect(reposDir).toContain('repos');
      expect(reposDir.startsWith(testDir)).toBe(true);
    });

    it('should create worktrees directory path correctly', () => {
      const worktreesDir = getWorktreesDir();
      expect(worktreesDir).toContain('worktrees');
      expect(worktreesDir.startsWith(testDir)).toBe(true);
    });
  });

  // ===========================================================================
  // isValidBranchName
  // ===========================================================================

  describe('isValidBranchName', () => {
    it('should accept simple names', () => {
      expect(isValidBranchName('main')).toBe(true);
      expect(isValidBranchName('feature')).toBe(true);
    });

    it('should accept names with slashes', () => {
      expect(isValidBranchName('feature/login')).toBe(true);
      expect(isValidBranchName('conductor/run-abc')).toBe(true);
    });

    it('should accept names with hyphens and underscores', () => {
      expect(isValidBranchName('my-branch')).toBe(true);
      expect(isValidBranchName('my_branch')).toBe(true);
    });

    it('should reject empty string', () => {
      expect(isValidBranchName('')).toBe(false);
    });

    it('should reject names longer than 250 chars', () => {
      expect(isValidBranchName('a'.repeat(251))).toBe(false);
    });

    it('should accept names exactly 250 chars', () => {
      expect(isValidBranchName('a'.repeat(250))).toBe(true);
    });

    it('should reject leading dash', () => {
      expect(isValidBranchName('-branch')).toBe(false);
    });

    it('should reject leading dot', () => {
      expect(isValidBranchName('.branch')).toBe(false);
    });

    it('should reject trailing dot', () => {
      expect(isValidBranchName('branch.')).toBe(false);
    });

    it('should reject trailing .lock', () => {
      expect(isValidBranchName('branch.lock')).toBe(false);
    });

    it('should reject double dots', () => {
      expect(isValidBranchName('branch..name')).toBe(false);
    });

    it('should reject double slashes', () => {
      expect(isValidBranchName('branch//name')).toBe(false);
    });

    it('should reject @{ sequence', () => {
      expect(isValidBranchName('branch@{0}')).toBe(false);
    });

    it('should reject tilde', () => {
      expect(isValidBranchName('branch~1')).toBe(false);
    });

    it('should reject caret', () => {
      expect(isValidBranchName('branch^1')).toBe(false);
    });

    it('should reject colon', () => {
      expect(isValidBranchName('branch:name')).toBe(false);
    });

    it('should reject question mark', () => {
      expect(isValidBranchName('branch?')).toBe(false);
    });

    it('should reject asterisk', () => {
      expect(isValidBranchName('branch*')).toBe(false);
    });

    it('should reject brackets', () => {
      expect(isValidBranchName('branch[0]')).toBe(false);
    });

    it('should reject backslash', () => {
      expect(isValidBranchName('branch\\name')).toBe(false);
    });

    it('should reject control characters', () => {
      expect(isValidBranchName('branch\x01name')).toBe(false);
      expect(isValidBranchName('branch\x00name')).toBe(false);
    });

    it('should reject DEL character', () => {
      expect(isValidBranchName('branch\x7fname')).toBe(false);
    });
  });

  // ===========================================================================
  // getLocksDir
  // ===========================================================================

  describe('getLocksDir', () => {
    it('should return locks dir under data dir', () => {
      expect(getLocksDir()).toBe(join(testDir, 'locks'));
    });
  });

  // ===========================================================================
  // Port Management
  // ===========================================================================

  describe('Port Management', () => {
    let seed: SeedResult;
    let worktreeId: string;

    beforeEach(() => {
      process.env['CONDUCTOR_PORT_RANGE'] = '5000-5002';
      seed = seedTestData(db);
      worktreeId = insertWorktreeRow(db, {
        runId: seed.runId,
        projectId: seed.projectId,
        repoId: seed.repoId,
      });
    });

    describe('allocatePort', () => {
      it('should allocate first available port', () => {
        const lease = allocatePort(db, seed.projectId, worktreeId);
        expect(lease.port).toBe(5000);
        expect(lease.isActive).toBe(true);
        expect(lease.purpose).toBe('dev_server');
        expect(lease.portLeaseId).toMatch(/^pl_/);
      });

      it('should allocate next port when first is taken', () => {
        allocatePort(db, seed.projectId, worktreeId);
        const lease2 = allocatePort(db, seed.projectId, worktreeId, 'api');
        expect(lease2.port).toBe(5001);
      });

      it('should respect purpose parameter', () => {
        const lease = allocatePort(db, seed.projectId, worktreeId, 'db');
        expect(lease.purpose).toBe('db');
      });

      it('should throw when all ports exhausted', () => {
        allocatePort(db, seed.projectId, worktreeId, 'dev_server');
        allocatePort(db, seed.projectId, worktreeId, 'api');
        allocatePort(db, seed.projectId, worktreeId, 'db');
        expect(() => allocatePort(db, seed.projectId, worktreeId, 'other')).toThrow(
          /No ports available/
        );
      });

      it('should reuse a released port', () => {
        const lease1 = allocatePort(db, seed.projectId, worktreeId);
        expect(lease1.port).toBe(5000);
        releasePort(db, lease1.portLeaseId);

        const lease2 = allocatePort(db, seed.projectId, worktreeId);
        expect(lease2.port).toBe(5000);
      });

      it('should set expiration approximately 24h in future', () => {
        const before = Date.now();
        const lease = allocatePort(db, seed.projectId, worktreeId);
        const expiresMs = new Date(lease.expiresAt).getTime();
        const expectedMs = before + 24 * 60 * 60 * 1000;
        // Allow 5 second tolerance
        expect(Math.abs(expiresMs - expectedMs)).toBeLessThan(5000);
      });

      it('should allow same port for different projects', () => {
        // Allocate port 5000 for first project
        allocatePort(db, seed.projectId, worktreeId);

        // Create second project with its own worktree
        const seed2 = seedTestData(db, '2');
        const runId2 = seedAdditionalRun(db, seed2, 'proj2');
        const wt2 = insertWorktreeRow(db, {
          runId: runId2,
          projectId: seed2.projectId,
          repoId: seed2.repoId,
        });

        const lease2 = allocatePort(db, seed2.projectId, wt2);
        // Should get 5000 since it's a different project
        expect(lease2.port).toBe(5000);
      });
    });

    describe('releasePort', () => {
      it('should release an active lease', () => {
        const lease = allocatePort(db, seed.projectId, worktreeId);
        const released = releasePort(db, lease.portLeaseId);
        expect(released).toBe(true);

        // Verify DB updated
        const row = db.prepare(
          'SELECT is_active, released_at FROM port_leases WHERE port_lease_id = ?'
        ).get(lease.portLeaseId) as { is_active: number; released_at: string | null };
        expect(row.is_active).toBe(0);
        expect(row.released_at).not.toBeNull();
      });

      it('should return false for already-released lease', () => {
        const lease = allocatePort(db, seed.projectId, worktreeId);
        releasePort(db, lease.portLeaseId);
        const secondRelease = releasePort(db, lease.portLeaseId);
        expect(secondRelease).toBe(false);
      });

      it('should return false for non-existent lease', () => {
        const result = releasePort(db, 'pl_nonexistent');
        expect(result).toBe(false);
      });
    });

    describe('releaseWorktreePorts', () => {
      it('should release all ports for a worktree', () => {
        allocatePort(db, seed.projectId, worktreeId, 'dev_server');
        allocatePort(db, seed.projectId, worktreeId, 'api');

        const count = releaseWorktreePorts(db, worktreeId);
        expect(count).toBe(2);
      });

      it('should return 0 when no active ports', () => {
        const count = releaseWorktreePorts(db, worktreeId);
        expect(count).toBe(0);
      });
    });

    describe('getWorktreePorts', () => {
      it('should return active leases and exclude released ones', () => {
        const lease1 = allocatePort(db, seed.projectId, worktreeId, 'dev_server');
        allocatePort(db, seed.projectId, worktreeId, 'api');
        releasePort(db, lease1.portLeaseId);

        const ports = getWorktreePorts(db, worktreeId);
        expect(ports).toHaveLength(1);
        expect(ports[0]!.port).toBe(5001);
        expect(ports[0]!.purpose).toBe('api');
      });
    });

    describe('releaseExpiredPortLeases', () => {
      it('should release leases whose expires_at is in the past', () => {
        const now = '2025-06-15T12:00:00.000Z';
        const pastExpiry = '2025-06-15T11:00:00.000Z';

        db.prepare(`
          INSERT INTO port_leases (
            port_lease_id, project_id, worktree_id, port, purpose, is_active, leased_at, expires_at
          ) VALUES (?, ?, ?, ?, ?, 1, ?, ?)
        `).run('pl_expired1', seed.projectId, worktreeId, 5000, 'dev_server', pastExpiry, pastExpiry);

        const released = releaseExpiredPortLeases(db, now);
        expect(released).toBe(1);

        const row = db.prepare(
          'SELECT is_active, released_at FROM port_leases WHERE port_lease_id = ?'
        ).get('pl_expired1') as { is_active: number; released_at: string | null };
        expect(row.is_active).toBe(0);
        expect(row.released_at).toBe(now);
      });

      it('should release leases whose expires_at equals now exactly', () => {
        const now = '2025-06-15T12:00:00.000Z';

        db.prepare(`
          INSERT INTO port_leases (
            port_lease_id, project_id, worktree_id, port, purpose, is_active, leased_at, expires_at
          ) VALUES (?, ?, ?, ?, ?, 1, ?, ?)
        `).run('pl_boundary', seed.projectId, worktreeId, 5000, 'dev_server', '2025-06-14T12:00:00.000Z', now);

        const released = releaseExpiredPortLeases(db, now);
        expect(released).toBe(1);
      });

      it('should not release leases whose expires_at is in the future', () => {
        const now = '2025-06-15T12:00:00.000Z';
        const futureExpiry = '2025-06-15T13:00:00.000Z';

        db.prepare(`
          INSERT INTO port_leases (
            port_lease_id, project_id, worktree_id, port, purpose, is_active, leased_at, expires_at
          ) VALUES (?, ?, ?, ?, ?, 1, ?, ?)
        `).run('pl_future', seed.projectId, worktreeId, 5000, 'dev_server', now, futureExpiry);

        const released = releaseExpiredPortLeases(db, now);
        expect(released).toBe(0);

        const row = db.prepare(
          'SELECT is_active FROM port_leases WHERE port_lease_id = ?'
        ).get('pl_future') as { is_active: number };
        expect(row.is_active).toBe(1);
      });

      it('should not release already-inactive leases even if expired', () => {
        const now = '2025-06-15T12:00:00.000Z';
        const pastExpiry = '2025-06-15T11:00:00.000Z';
        const originalReleasedAt = '2025-06-15T10:30:00.000Z';

        db.prepare(`
          INSERT INTO port_leases (
            port_lease_id, project_id, worktree_id, port, purpose, is_active, leased_at, expires_at, released_at
          ) VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)
        `).run('pl_already_inactive', seed.projectId, worktreeId, 5000, 'dev_server', pastExpiry, pastExpiry, originalReleasedAt);

        const released = releaseExpiredPortLeases(db, now);
        expect(released).toBe(0);

        const row = db.prepare(
          'SELECT released_at FROM port_leases WHERE port_lease_id = ?'
        ).get('pl_already_inactive') as { released_at: string | null };
        expect(row.released_at).toBe(originalReleasedAt);
      });

      it('should return 0 when no expired leases exist', () => {
        const released = releaseExpiredPortLeases(db, '2025-06-15T12:00:00.000Z');
        expect(released).toBe(0);
      });
    });
  });

  // ===========================================================================
  // Heartbeat
  // ===========================================================================

  describe('Heartbeat', () => {
    it('should update last_heartbeat_at timestamp', () => {
      const seed = seedTestData(db);
      const worktreeId = insertWorktreeRow(db, {
        runId: seed.runId,
        projectId: seed.projectId,
        repoId: seed.repoId,
      });

      const before = db.prepare(
        'SELECT last_heartbeat_at FROM worktrees WHERE worktree_id = ?'
      ).get(worktreeId) as { last_heartbeat_at: string };
      const beforeTime = before.last_heartbeat_at;

      // Small delay to ensure timestamps differ
      const waitEnd = Date.now() + 10;
      while (Date.now() < waitEnd) { /* busy wait */ }

      updateWorktreeHeartbeat(db, worktreeId);

      const after = db.prepare(
        'SELECT last_heartbeat_at FROM worktrees WHERE worktree_id = ?'
      ).get(worktreeId) as { last_heartbeat_at: string };

      expect(after.last_heartbeat_at).not.toBe(beforeTime);
    });

    it('should not throw for non-existent worktree', () => {
      expect(() => updateWorktreeHeartbeat(db, 'wt_nonexistent')).not.toThrow();
    });
  });

  // ===========================================================================
  // Git Integration
  // ===========================================================================

  describe('Git Integration', () => {
    let seed: SeedResult;
    let bareRepo: BareRepoResult;

    beforeEach(() => {
      seed = seedTestData(db);
      bareRepo = createLocalBareRepo(testDir);

      // Set clone_path in DB to point to the bare repo
      db.prepare('UPDATE repos SET clone_path = ?, cloned_at = ? WHERE repo_id = ?')
        .run(bareRepo.bareRepoPath, new Date().toISOString(), seed.repoId);
    });

    describe('createWorktree', () => {
      it('should create worktree with new branch', () => {
        const wt = createWorktree(db, {
          runId: seed.runId,
          projectId: seed.projectId,
          repoId: seed.repoId,
        });

        // Directory should exist
        expect(existsSync(wt.path)).toBe(true);

        // Branch should exist in bare repo
        const branchCheck = execFileSync(
          'git', ['rev-parse', '--verify', `refs/heads/${wt.branchName}`],
          { cwd: bareRepo.bareRepoPath, encoding: 'utf8' }
        ).trim();
        expect(branchCheck).toBeTruthy();

        // DB row should be correct
        expect(wt.runId).toBe(seed.runId);
        expect(wt.projectId).toBe(seed.projectId);
        expect(wt.repoId).toBe(seed.repoId);
        expect(wt.branchName).toBe(`conductor/run-${seed.runId}`);
        expect(wt.baseCommit).toBe(bareRepo.commitSha);
        expect(wt.status).toBe('active');
      });

      it('should be idempotent - second call returns same worktreeId', () => {
        const wt1 = createWorktree(db, {
          runId: seed.runId,
          projectId: seed.projectId,
          repoId: seed.repoId,
        });
        const wt2 = createWorktree(db, {
          runId: seed.runId,
          projectId: seed.projectId,
          repoId: seed.repoId,
        });

        expect(wt1.worktreeId).toBe(wt2.worktreeId);
      });

      it('should resolve base branch from DB when not specified', () => {
        // Update repo default branch to 'main' (already is, but be explicit)
        db.prepare('UPDATE repos SET github_default_branch = ? WHERE repo_id = ?')
          .run('main', seed.repoId);

        const wt = createWorktree(db, {
          runId: seed.runId,
          projectId: seed.projectId,
          repoId: seed.repoId,
        });

        expect(wt.baseCommit).toBe(bareRepo.commitSha);
      });

      it('should resolve master branch when repo has no main branch', () => {
        // Create a bare repo with only 'master'
        const masterDir = join(testDir, 'master-only');
        mkdirSync(masterDir, { recursive: true });
        const masterRepo = createLocalBareRepo(masterDir, 'master');

        // Point repo at the master-only clone, clear the default branch
        db.prepare('UPDATE repos SET clone_path = ?, github_default_branch = ? WHERE repo_id = ?')
          .run(masterRepo.bareRepoPath, '', seed.repoId);

        const wt = createWorktree(db, {
          runId: seed.runId,
          projectId: seed.projectId,
          repoId: seed.repoId,
        });

        expect(wt.baseCommit).toBe(masterRepo.commitSha);
        expect(existsSync(wt.path)).toBe(true);
      });

      it('should throw if repo not cloned (clone_path = null)', () => {
        db.prepare('UPDATE repos SET clone_path = NULL WHERE repo_id = ?')
          .run(seed.repoId);

        expect(() =>
          createWorktree(db, {
            runId: seed.runId,
            projectId: seed.projectId,
            repoId: seed.repoId,
          })
        ).toThrow(/not cloned/);
      });

      it('should throw if clone path does not exist on disk', () => {
        db.prepare('UPDATE repos SET clone_path = ? WHERE repo_id = ?')
          .run('/tmp/nonexistent-path-xyz', seed.repoId);

        expect(() =>
          createWorktree(db, {
            runId: seed.runId,
            projectId: seed.projectId,
            repoId: seed.repoId,
          })
        ).toThrow(/not cloned/);
      });
    });

    describe('cleanupWorktree', () => {
      it('should destroy worktree and update DB', () => {
        process.env['CONDUCTOR_PORT_RANGE'] = '5000-5002';

        const wt = createWorktree(db, {
          runId: seed.runId,
          projectId: seed.projectId,
          repoId: seed.repoId,
        });

        // Allocate a port
        allocatePort(db, seed.projectId, wt.worktreeId);

        const result = cleanupWorktree(db, seed.runId);
        expect(result).toBe(true);

        // Directory should be removed
        expect(existsSync(wt.path)).toBe(false);

        // DB status should be destroyed
        const row = db.prepare(
          'SELECT status, destroyed_at FROM worktrees WHERE worktree_id = ?'
        ).get(wt.worktreeId) as { status: string; destroyed_at: string | null };
        expect(row.status).toBe('destroyed');
        expect(row.destroyed_at).not.toBeNull();

        // Ports should be released
        const ports = getWorktreePorts(db, wt.worktreeId);
        expect(ports).toHaveLength(0);
      });

      it('should return false when no active worktree for run', () => {
        const result = cleanupWorktree(db, 'run_nonexistent');
        expect(result).toBe(false);
      });

      it('should handle already-deleted directory gracefully', () => {
        const wt = createWorktree(db, {
          runId: seed.runId,
          projectId: seed.projectId,
          repoId: seed.repoId,
        });

        // Remove directory manually before cleanup
        rmSync(wt.path, { recursive: true, force: true });

        // Should not throw
        const result = cleanupWorktree(db, seed.runId);
        expect(result).toBe(true);

        const row = db.prepare(
          'SELECT status FROM worktrees WHERE worktree_id = ?'
        ).get(wt.worktreeId) as { status: string };
        expect(row.status).toBe('destroyed');
      });
    });

    describe('cloneOrFetchRepo', () => {
      it('should return wasExisting: true when clone dir already exists', () => {
        // The bare repo path is already set as clone_path in the DB.
        // cloneOrFetchRepo should detect it exists and fetch.
        // We need to set up a scenario where clone_path directory exists.
        const cloneDir = join(testDir, 'repos', seed.projectId, seed.repoId);
        mkdirSync(cloneDir, { recursive: true });

        // Init a bare repo there so fetch doesn't fail hard
        execFileSync('git', ['init', '--bare'], { cwd: cloneDir, encoding: 'utf8' });

        const result = cloneOrFetchRepo(db, {
          projectId: seed.projectId,
          repoId: seed.repoId,
          githubOwner: 'testowner',
          githubName: 'testrepo',
          installationToken: 'fake-token',
        });

        expect(result.wasExisting).toBe(true);
      });

      it('should release lock after operation', () => {
        // Create the clone dir so it takes the fast "existing" path
        const cloneDir = join(testDir, 'repos', seed.projectId, seed.repoId);
        mkdirSync(cloneDir, { recursive: true });
        execFileSync('git', ['init', '--bare'], { cwd: cloneDir, encoding: 'utf8' });

        cloneOrFetchRepo(db, {
          projectId: seed.projectId,
          repoId: seed.repoId,
          githubOwner: 'testowner',
          githubName: 'testrepo',
          installationToken: 'fake-token',
        });

        // Lock directory should not exist after the operation
        const lockPath = join(testDir, 'locks', `clone-${seed.repoId}.lock`);
        expect(existsSync(lockPath)).toBe(false);
      });
    });
  });

  // ===========================================================================
  // Janitor
  // ===========================================================================

  describe('runJanitor', () => {
    let seed: SeedResult;

    beforeEach(() => {
      seed = seedTestData(db);
    });

    describe('DB→Filesystem', () => {
      it('should mark worktree destroyed when directory is missing', () => {
        process.env['CONDUCTOR_PORT_RANGE'] = '5000-5002';

        const worktreeId = insertWorktreeRow(db, {
          runId: seed.runId,
          projectId: seed.projectId,
          repoId: seed.repoId,
          path: '/tmp/nonexistent-worktree-path-xyz',
        });

        // Allocate a port to verify it gets released
        allocatePort(db, seed.projectId, worktreeId);

        const result = runJanitor(db);
        expect(result.orphanedWorktreesMarked).toBe(1);

        // Check DB
        const row = db.prepare(
          'SELECT status, destroyed_at FROM worktrees WHERE worktree_id = ?'
        ).get(worktreeId) as { status: string; destroyed_at: string | null };
        expect(row.status).toBe('destroyed');
        expect(row.destroyed_at).not.toBeNull();

        // Ports should be released
        const ports = getWorktreePorts(db, worktreeId);
        expect(ports).toHaveLength(0);
      });

      it('should NOT mark worktree destroyed when directory exists', () => {
        const wtPath = join(testDir, 'existing-worktree');
        mkdirSync(wtPath, { recursive: true });

        insertWorktreeRow(db, {
          runId: seed.runId,
          projectId: seed.projectId,
          repoId: seed.repoId,
          path: wtPath,
        });

        const result = runJanitor(db);
        expect(result.orphanedWorktreesMarked).toBe(0);
      });
    });

    describe('Filesystem→DB', () => {
      it('should remove orphaned directories without DB records', () => {
        const worktreesDir = getWorktreesDir();
        const orphanDir = join(worktreesDir, 'orphan-run-123');
        mkdirSync(orphanDir, { recursive: true });

        const result = runJanitor(db);
        expect(result.orphanedDirectoriesRemoved).toBe(1);
        expect(existsSync(orphanDir)).toBe(false);
      });

      it('should NOT remove directories with active DB records', () => {
        const worktreesDir = getWorktreesDir();
        const activeDir = join(worktreesDir, 'active-run');
        mkdirSync(activeDir, { recursive: true });

        insertWorktreeRow(db, {
          runId: seed.runId,
          projectId: seed.projectId,
          repoId: seed.repoId,
          path: activeDir,
        });

        const result = runJanitor(db);
        expect(result.orphanedDirectoriesRemoved).toBe(0);
        expect(existsSync(activeDir)).toBe(true);
      });
    });

    describe('Stale ports', () => {
      it('should release port leases older than timeout', () => {
        process.env['CONDUCTOR_PORT_RANGE'] = '5000-5010';
        process.env['CONDUCTOR_LEASE_TIMEOUT_HOURS'] = '1';

        // Path must exist on disk so janitor's DB→FS check doesn't mark
        // the worktree as orphaned (which would release ports early).
        const wtPath = join(testDir, 'wt-stale-port-test');
        mkdirSync(wtPath, { recursive: true });

        const worktreeId = insertWorktreeRow(db, {
          runId: seed.runId,
          projectId: seed.projectId,
          repoId: seed.repoId,
          path: wtPath,
        });

        // Directly insert a stale port lease (leased 2 hours ago)
        const staleTime = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
        db.prepare(`
          INSERT INTO port_leases (
            port_lease_id, project_id, worktree_id, port, purpose, is_active, leased_at, expires_at
          ) VALUES (?, ?, ?, ?, ?, 1, ?, ?)
        `).run('pl_stale', seed.projectId, worktreeId, 5005, 'dev_server', staleTime, staleTime);

        const result = runJanitor(db);
        expect(result.stalePortsReleased).toBe(1);
      });

      it('should NOT release recent leases', () => {
        process.env['CONDUCTOR_PORT_RANGE'] = '5000-5010';
        process.env['CONDUCTOR_LEASE_TIMEOUT_HOURS'] = '24';

        const worktreeId = insertWorktreeRow(db, {
          runId: seed.runId,
          projectId: seed.projectId,
          repoId: seed.repoId,
        });

        // Allocate a port (leased right now)
        allocatePort(db, seed.projectId, worktreeId);

        const result = runJanitor(db);
        expect(result.stalePortsReleased).toBe(0);
      });
    });

    describe('Edge cases', () => {
      it('should return zero counts when nothing to clean', () => {
        const result = runJanitor(db);
        expect(result.orphanedWorktreesMarked).toBe(0);
        expect(result.orphanedDirectoriesRemoved).toBe(0);
        expect(result.stalePortsReleased).toBe(0);
        expect(result.errors).toHaveLength(0);
      });
    });
  });
});
