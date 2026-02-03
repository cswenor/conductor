/**
 * Worktree Module Tests
 *
 * Tests for configuration, branch resolution, and utility functions.
 * Integration tests for clone/worktree creation require actual git repos.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Database as DatabaseType } from 'better-sqlite3';
import { mkdirSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { initDatabase, closeDatabase } from '../db/index';
import {
  getDataDir,
  getReposDir,
  getWorktreesDir,
  getPortRange,
  getLeaseTimeoutHours,
  resolveBaseBranch,
  generateBranchName,
} from './index';

describe('Worktree Module', () => {
  let db: DatabaseType;
  let testDir: string;

  beforeEach(() => {
    // Create in-memory database with migrations
    db = initDatabase({ path: ':memory:' });

    // Create test directory
    testDir = join(tmpdir(), `conductor-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });

    // Set test data dir
    process.env['CONDUCTOR_DATA_DIR'] = testDir;
  });

  afterEach(() => {
    closeDatabase(db);
    // Clean up test directory
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
    delete process.env['CONDUCTOR_DATA_DIR'];
    delete process.env['CONDUCTOR_PORT_RANGE'];
    delete process.env['CONDUCTOR_LEASE_TIMEOUT_HOURS'];
  });

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

  describe('Branch Resolution', () => {
    beforeEach(() => {
      // Create a test user
      db.prepare(`
        INSERT INTO users (user_id, github_id, github_node_id, github_login, status, created_at, updated_at)
        VALUES ('user_test', 123, 'U_test', 'testuser', 'active', datetime('now'), datetime('now'))
      `).run();

      // Create a test project (using correct schema)
      db.prepare(`
        INSERT INTO projects (project_id, user_id, name, github_org_id, github_org_node_id, github_org_name, github_installation_id, default_profile_id, default_base_branch, port_range_start, port_range_end, created_at, updated_at)
        VALUES ('proj_test', 'user_test', 'Test Project', 1, 'O_test', 'testorg', 12345, 'default', 'main', 3100, 3199, datetime('now'), datetime('now'))
      `).run();

      // Create a test repo
      db.prepare(`
        INSERT INTO repos (repo_id, project_id, github_node_id, github_numeric_id, github_owner, github_name, github_full_name, github_default_branch, profile_id, status, created_at, updated_at)
        VALUES ('repo_test', 'proj_test', 'R_test', 1, 'owner', 'repo', 'owner/repo', 'develop', 'default', 'active', datetime('now'), datetime('now'))
      `).run();
    });

    it('should use configured default if provided', () => {
      expect(resolveBaseBranch(db, 'repo_test', 'custom-branch')).toBe('custom-branch');
    });

    it('should use GitHub default branch from repo', () => {
      expect(resolveBaseBranch(db, 'repo_test')).toBe('develop');
    });

    it('should fallback to main if no default', () => {
      // Update repo to have empty default branch
      db.prepare('UPDATE repos SET github_default_branch = ? WHERE repo_id = ?').run('', 'repo_test');
      expect(resolveBaseBranch(db, 'repo_test')).toBe('main');
    });

    it('should fallback to main for non-existent repo', () => {
      expect(resolveBaseBranch(db, 'nonexistent')).toBe('main');
    });
  });

  describe('Branch Name Generation', () => {
    it('should generate deterministic branch name', () => {
      expect(generateBranchName('run_abc123')).toBe('conductor/run-run_abc123');
    });

    it('should handle different run ID formats', () => {
      expect(generateBranchName('run_ml6abc123def')).toBe('conductor/run-run_ml6abc123def');
    });
  });

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
});
