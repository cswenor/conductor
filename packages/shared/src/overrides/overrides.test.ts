/**
 * Overrides Service Tests
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Database as DatabaseType } from 'better-sqlite3';
import { initDatabase, closeDatabase } from '../db/index.js';
import { createRun } from '../runs/index.js';
import {
  generateOverrideId,
  createOverride,
  getOverride,
  listOverrides,
  findMatchingOverride,
  isValidOverrideScope,
} from './index.js';

let db: DatabaseType;

function seedTestData(database: DatabaseType): {
  runId: string;
  projectId: string;
} {
  const now = new Date().toISOString();
  const userId = 'user_test';
  const projectId = 'proj_test';
  const repoId = 'repo_test';
  const taskId = 'task_test';

  database.prepare(`
    INSERT OR IGNORE INTO users (user_id, github_id, github_node_id, github_login, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'active', ?, ?)
  `).run(userId, 100, 'U_test', 'testuser', now, now);

  database.prepare(`
    INSERT INTO projects (
      project_id, user_id, name, github_org_id, github_org_node_id, github_org_name,
      github_installation_id, default_profile_id, default_base_branch,
      port_range_start, port_range_end, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(projectId, userId, 'Test Project', 1, 'O_test', 'testorg',
    12345, 'default', 'main', 3100, 3199, now, now);

  database.prepare(`
    INSERT INTO repos (
      repo_id, project_id, github_node_id, github_numeric_id,
      github_owner, github_name, github_full_name, github_default_branch,
      profile_id, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(repoId, projectId, 'R_test', 100,
    'testowner', 'testrepo', 'testowner/testrepo', 'main',
    'default', 'active', now, now);

  database.prepare(`
    INSERT INTO tasks (
      task_id, project_id, repo_id, github_node_id, github_issue_number,
      github_type, github_title, github_body, github_state, github_labels_json,
      github_synced_at, created_at, updated_at, last_activity_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(taskId, projectId, repoId, 'I_test', 42,
    'issue', 'Test Task', 'Body', 'open', '[]',
    now, now, now, now);

  const run = createRun(database, { taskId, projectId, repoId, baseBranch: 'main' });

  return { runId: run.runId, projectId };
}

beforeEach(() => {
  db = initDatabase({ path: ':memory:' });
});

afterEach(() => {
  closeDatabase(db);
});

describe('generateOverrideId', () => {
  it('produces ids with ov_ prefix', () => {
    const id = generateOverrideId();
    expect(id).toMatch(/^ov_/);
  });

  it('produces unique ids', () => {
    const ids = new Set(Array.from({ length: 100 }, () => generateOverrideId()));
    expect(ids.size).toBe(100);
  });
});

describe('createOverride', () => {
  it('creates override with all fields', () => {
    const { runId } = seedTestData(db);

    const override = createOverride(db, {
      runId,
      kind: 'policy_exception',
      targetId: 'worktree_boundary',
      scope: 'this_run',
      constraintKind: 'path',
      constraintValue: '/tmp/test',
      operator: 'user_test',
      justification: 'Need access for build artifacts',
    });

    expect(override.overrideId).toMatch(/^ov_/);
    expect(override.runId).toBe(runId);
    expect(override.kind).toBe('policy_exception');
    expect(override.targetId).toBe('worktree_boundary');
    expect(override.scope).toBe('this_run');
    expect(override.constraintKind).toBe('path');
    expect(override.constraintValue).toBe('/tmp/test');
    expect(override.operator).toBe('user_test');
    expect(override.justification).toBe('Need access for build artifacts');
    expect(override.createdAt).toBeTruthy();
  });

  it('creates override without optional fields', () => {
    const { runId } = seedTestData(db);

    const override = createOverride(db, {
      runId,
      kind: 'skip_tests',
      scope: 'this_run',
      operator: 'user_test',
      justification: 'Flaky tests in CI',
    });

    expect(override.targetId).toBeUndefined();
    expect(override.constraintKind).toBeUndefined();
    expect(override.expiresAt).toBeUndefined();
  });
});

describe('getOverride', () => {
  it('retrieves an override by ID', () => {
    const { runId } = seedTestData(db);

    const created = createOverride(db, {
      runId,
      kind: 'skip_tests',
      scope: 'this_run',
      operator: 'user_test',
      justification: 'Test override',
    });

    const fetched = getOverride(db, created.overrideId);
    expect(fetched).not.toBeNull();
    expect(fetched?.overrideId).toBe(created.overrideId);
    expect(fetched?.kind).toBe('skip_tests');
  });

  it('returns null for non-existent ID', () => {
    expect(getOverride(db, 'ov_nonexistent')).toBeNull();
  });
});

describe('listOverrides', () => {
  it('lists all overrides for a run', () => {
    const { runId } = seedTestData(db);

    createOverride(db, {
      runId,
      kind: 'skip_tests',
      scope: 'this_run',
      operator: 'user_test',
      justification: 'First',
    });
    createOverride(db, {
      runId,
      kind: 'policy_exception',
      targetId: 'shell_injection',
      scope: 'this_run',
      operator: 'user_test',
      justification: 'Second',
    });

    const overrides = listOverrides(db, runId);
    expect(overrides).toHaveLength(2);
  });

  it('returns empty for run with no overrides', () => {
    const { runId } = seedTestData(db);
    expect(listOverrides(db, runId)).toHaveLength(0);
  });
});

describe('findMatchingOverride', () => {
  it('finds active override by kind', () => {
    const { runId } = seedTestData(db);

    createOverride(db, {
      runId,
      kind: 'skip_tests',
      targetId: 'tests_pass',
      scope: 'this_run',
      operator: 'user_test',
      justification: 'Flaky',
    });

    const match = findMatchingOverride(db, {
      runId,
      kind: 'skip_tests',
      targetId: 'tests_pass',
    });
    expect(match).not.toBeNull();
    expect(match?.kind).toBe('skip_tests');
  });

  it('does not return expired override', () => {
    const { runId } = seedTestData(db);
    const expired = new Date(Date.now() - 86400000).toISOString();

    createOverride(db, {
      runId,
      kind: 'skip_tests',
      targetId: 'tests_pass',
      scope: 'this_run',
      operator: 'user_test',
      justification: 'Expired',
      expiresAt: expired,
    });

    const match = findMatchingOverride(db, {
      runId,
      kind: 'skip_tests',
      targetId: 'tests_pass',
    });
    expect(match).toBeNull();
  });

  it('returns broadest scope when multiple match', () => {
    const { runId } = seedTestData(db);

    createOverride(db, {
      runId,
      kind: 'skip_tests',
      targetId: 'tests_pass',
      scope: 'this_run',
      operator: 'user_test',
      justification: 'Narrow',
    });
    createOverride(db, {
      runId,
      kind: 'skip_tests',
      targetId: 'tests_pass',
      scope: 'project_wide',
      operator: 'user_test',
      justification: 'Broad',
    });

    const match = findMatchingOverride(db, {
      runId,
      kind: 'skip_tests',
      targetId: 'tests_pass',
    });
    expect(match).not.toBeNull();
    expect(match?.scope).toBe('project_wide');
    expect(match?.justification).toBe('Broad');
  });

  it('does not match wrong kind', () => {
    const { runId } = seedTestData(db);

    createOverride(db, {
      runId,
      kind: 'skip_tests',
      scope: 'this_run',
      operator: 'user_test',
      justification: 'Wrong kind',
    });

    const match = findMatchingOverride(db, {
      runId,
      kind: 'policy_exception',
    });
    expect(match).toBeNull();
  });

  it('matches override with constraint fields', () => {
    const { runId } = seedTestData(db);

    createOverride(db, {
      runId,
      kind: 'policy_exception',
      targetId: 'worktree_boundary',
      scope: 'this_run',
      constraintKind: 'path',
      constraintHash: 'abc123',
      operator: 'user_test',
      justification: 'Allow specific path',
    });

    const match = findMatchingOverride(db, {
      runId,
      kind: 'policy_exception',
      targetId: 'worktree_boundary',
      constraintKind: 'path',
      constraintHash: 'abc123',
    });
    expect(match).not.toBeNull();
    expect(match?.constraintKind).toBe('path');
    expect(match?.constraintHash).toBe('abc123');
  });

  it('does not match override with wrong constraint hash', () => {
    const { runId } = seedTestData(db);

    createOverride(db, {
      runId,
      kind: 'policy_exception',
      targetId: 'worktree_boundary',
      scope: 'this_run',
      constraintKind: 'path',
      constraintHash: 'abc123',
      operator: 'user_test',
      justification: 'Allow specific path',
    });

    const match = findMatchingOverride(db, {
      runId,
      kind: 'policy_exception',
      targetId: 'worktree_boundary',
      constraintKind: 'path',
      constraintHash: 'different_hash',
    });
    expect(match).toBeNull();
  });

  it('wildcard override (null constraints) matches any constraint', () => {
    const { runId } = seedTestData(db);

    // Override without constraint fields acts as wildcard
    createOverride(db, {
      runId,
      kind: 'policy_exception',
      targetId: 'worktree_boundary',
      scope: 'this_run',
      operator: 'user_test',
      justification: 'Blanket exception',
    });

    const match = findMatchingOverride(db, {
      runId,
      kind: 'policy_exception',
      targetId: 'worktree_boundary',
      constraintKind: 'path',
      constraintHash: 'any_hash',
    });
    expect(match).not.toBeNull();
  });
});

describe('isValidOverrideScope', () => {
  it('accepts valid scopes', () => {
    expect(isValidOverrideScope('this_run')).toBe(true);
    expect(isValidOverrideScope('this_task')).toBe(true);
    expect(isValidOverrideScope('this_repo')).toBe(true);
    expect(isValidOverrideScope('project_wide')).toBe(true);
  });

  it('rejects invalid scopes', () => {
    expect(isValidOverrideScope('global')).toBe(false);
    expect(isValidOverrideScope('')).toBe(false);
    expect(isValidOverrideScope('all')).toBe(false);
  });
});
