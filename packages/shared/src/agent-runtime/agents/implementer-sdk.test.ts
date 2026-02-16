/**
 * Implementer SDK Tests
 *
 * Tests for the Agent SDK backend helpers and utilities.
 * Note: Full integration tests for runImplementerWithAgentSDK require
 * the Agent SDK process, so we test the extractable units here.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Database as DatabaseType } from 'better-sqlite3';
import { initDatabase, closeDatabase } from '../../db/index.ts';
import { createRun } from '../../runs/index.ts';
import type { ImplementerBackend, Run } from '../../runs/index.ts';
import { getDefaultImplementerBackend, VALID_IMPLEMENTER_BACKENDS } from '../../runs/index.ts';
import { resolveImplementerBackend } from './implementer-sdk.ts';
import { getAllowedToolNames } from '../tools/mcp-adapter.ts';
import { createToolRegistry } from '../tools/registry.ts';

// =============================================================================
// Test Helpers
// =============================================================================

let db: DatabaseType;

function seedTestData(database: DatabaseType) {
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
}

beforeEach(() => {
  db = initDatabase({ path: ':memory:' });
  seedTestData(db);
});

afterEach(() => {
  closeDatabase(db);
  // Restore env
  delete process.env['IMPLEMENTER_RUNTIME'];
});

// =============================================================================
// resolveImplementerBackend
// =============================================================================

describe('resolveImplementerBackend', () => {
  it('returns raw for runs created with default', () => {
    const run = createRun(db, {
      taskId: 'task_test',
      projectId: 'proj_test',
      repoId: 'repo_test',
      baseBranch: 'main',
    });

    expect(resolveImplementerBackend(run)).toBe('raw');
  });

  it('returns agent_sdk when explicitly set', () => {
    const run = createRun(db, {
      taskId: 'task_test',
      projectId: 'proj_test',
      repoId: 'repo_test',
      baseBranch: 'main',
      implementerBackend: 'agent_sdk',
    });

    expect(resolveImplementerBackend(run)).toBe('agent_sdk');
  });

  it('returns correct backend through serialization round-trip', () => {
    const run = createRun(db, {
      taskId: 'task_test',
      projectId: 'proj_test',
      repoId: 'repo_test',
      baseBranch: 'main',
      implementerBackend: 'agent_sdk',
    });

    // Re-read from DB to verify round-trip
    const row = db.prepare('SELECT * FROM runs WHERE run_id = ?').get(run.runId) as Record<string, unknown>;
    expect(row['implementer_backend']).toBe('agent_sdk');
  });
});

// =============================================================================
// getDefaultImplementerBackend
// =============================================================================

describe('getDefaultImplementerBackend', () => {
  it('defaults to raw when env is not set', () => {
    delete process.env['IMPLEMENTER_RUNTIME'];
    expect(getDefaultImplementerBackend()).toBe('raw');
  });

  it('returns agent_sdk when env is set', () => {
    process.env['IMPLEMENTER_RUNTIME'] = 'agent_sdk';
    expect(getDefaultImplementerBackend()).toBe('agent_sdk');
  });

  it('returns raw when env is explicitly raw', () => {
    process.env['IMPLEMENTER_RUNTIME'] = 'raw';
    expect(getDefaultImplementerBackend()).toBe('raw');
  });

  it('throws on invalid env value', () => {
    process.env['IMPLEMENTER_RUNTIME'] = 'invalid_backend';
    expect(() => getDefaultImplementerBackend()).toThrow('Invalid IMPLEMENTER_RUNTIME');
  });

  it('returns typed ImplementerBackend', () => {
    const result = getDefaultImplementerBackend();
    const _typeCheck: ImplementerBackend = result;
    expect(VALID_IMPLEMENTER_BACKENDS.has(_typeCheck)).toBe(true);
  });
});

// =============================================================================
// DB CHECK constraint
// =============================================================================

describe('implementer_backend CHECK constraint', () => {
  it('accepts raw', () => {
    const run = createRun(db, {
      taskId: 'task_test',
      projectId: 'proj_test',
      repoId: 'repo_test',
      baseBranch: 'main',
      implementerBackend: 'raw',
    });
    expect(run.implementerBackend).toBe('raw');
  });

  it('accepts agent_sdk', () => {
    const run = createRun(db, {
      taskId: 'task_test',
      projectId: 'proj_test',
      repoId: 'repo_test',
      baseBranch: 'main',
      implementerBackend: 'agent_sdk',
    });
    expect(run.implementerBackend).toBe('agent_sdk');
  });

  it('rejects invalid value via direct SQL', () => {
    expect(() => {
      db.prepare(
        "INSERT INTO runs (run_id, task_id, project_id, repo_id, run_number, phase, step, policy_set_id, last_event_sequence, next_sequence, base_branch, branch, implementer_backend, started_at, updated_at) VALUES ('run_bad', 'task_test', 'proj_test', 'repo_test', 99, 'pending', 'setup_worktree', 'ps_1', 0, 1, 'main', '', 'invalid', ?, ?)"
      ).run(new Date().toISOString(), new Date().toISOString());
    }).toThrow();
  });
});

// =============================================================================
// getAllowedToolNames
// =============================================================================

describe('getAllowedToolNames', () => {
  it('generates correct tool names from registry', () => {
    const registry = createToolRegistry();
    registry.register({
      name: 'read_file',
      description: 'Read a file',
      inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      execute: async () => ({ content: '', meta: {} }),
    });
    registry.register({
      name: 'write_file',
      description: 'Write a file',
      inputSchema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] },
      execute: async () => ({ content: '', meta: {} }),
    });

    const names = getAllowedToolNames(registry);
    expect(names).toEqual([
      'mcp__conductor-tools__read_file',
      'mcp__conductor-tools__write_file',
    ]);
  });
});

// =============================================================================
// Run immutability
// =============================================================================

describe('run implementerBackend immutability', () => {
  it('preserves backend value across reads', () => {
    const run = createRun(db, {
      taskId: 'task_test',
      projectId: 'proj_test',
      repoId: 'repo_test',
      baseBranch: 'main',
      implementerBackend: 'agent_sdk',
    });

    // Simulate what happens during retries — re-read the run
    const row = db.prepare('SELECT implementer_backend FROM runs WHERE run_id = ?')
      .get(run.runId) as { implementer_backend: string };

    expect(row.implementer_backend).toBe('agent_sdk');
  });
});
