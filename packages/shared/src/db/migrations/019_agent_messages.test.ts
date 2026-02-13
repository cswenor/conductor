/**
 * Migration 019 test: agent_messages table
 *
 * Verifies that:
 * - Table created with correct columns and types
 * - UNIQUE constraint on (agent_invocation_id, turn_index)
 * - CHECK constraint on role (valid values only)
 * - CHECK constraint on turn_index >= 0
 * - Foreign key constraints enforced
 * - All 3 indexes exist
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Database as DatabaseType } from 'better-sqlite3';
import { initDatabase, closeDatabase } from '../index.ts';
import { createRun } from '../../runs/index.ts';
import { createAgentInvocation } from '../../agent-runtime/invocations.ts';

let db: DatabaseType;

function seedTestData(database: DatabaseType): {
  runId: string;
  agentInvocationId: string;
} {
  const now = new Date().toISOString();
  const userId = 'user_test';
  const projectId = 'proj_test';
  const repoId = 'repo_test';
  const taskId = 'task_test';

  database
    .prepare(
      `
    INSERT OR IGNORE INTO users (user_id, github_id, github_node_id, github_login, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'active', ?, ?)
  `,
    )
    .run(userId, 100, 'U_test', 'testuser', now, now);

  database
    .prepare(
      `
    INSERT INTO projects (
      project_id, user_id, name, github_org_id, github_org_node_id, github_org_name,
      github_installation_id, default_profile_id, default_base_branch,
      port_range_start, port_range_end, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
    )
    .run(
      projectId,
      userId,
      'Test Project',
      1,
      'O_test',
      'testorg',
      12345,
      'default',
      'main',
      3100,
      3199,
      now,
      now,
    );

  database
    .prepare(
      `
    INSERT INTO repos (
      repo_id, project_id, github_node_id, github_numeric_id,
      github_owner, github_name, github_full_name, github_default_branch,
      profile_id, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
    )
    .run(
      repoId,
      projectId,
      'R_test',
      100,
      'testowner',
      'testrepo',
      'testowner/testrepo',
      'main',
      'default',
      'active',
      now,
      now,
    );

  database
    .prepare(
      `
    INSERT INTO tasks (
      task_id, project_id, repo_id, github_node_id, github_issue_number,
      github_type, github_title, github_body, github_state, github_labels_json,
      github_synced_at, created_at, updated_at, last_activity_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
    )
    .run(
      taskId,
      projectId,
      repoId,
      'I_test',
      42,
      'issue',
      'Test Task',
      'Body',
      'open',
      '[]',
      now,
      now,
      now,
      now,
    );

  const run = createRun(database, {
    taskId,
    projectId,
    repoId,
    baseBranch: 'main',
  });

  const inv = createAgentInvocation(database, {
    runId: run.runId,
    agent: 'planner',
    action: 'create_plan',
  });

  return { runId: run.runId, agentInvocationId: inv.agentInvocationId };
}

beforeEach(() => {
  db = initDatabase({ path: ':memory:' });
});

afterEach(() => {
  closeDatabase(db);
});

describe('migration 019: agent_messages', () => {
  it('creates agent_messages table', () => {
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='agent_messages'",
      )
      .all() as { name: string }[];

    expect(tables).toHaveLength(1);
    expect(tables[0]?.name).toBe('agent_messages');
  });

  it('has all expected columns with correct types', () => {
    const columns = db
      .prepare("PRAGMA table_info('agent_messages')")
      .all() as {
      name: string;
      type: string;
      notnull: number;
      pk: number;
    }[];

    const columnMap = new Map(columns.map((c) => [c.name, c]));

    // Primary key
    expect(columnMap.get('agent_message_id')?.pk).toBe(1);
    expect(columnMap.get('agent_message_id')?.type).toBe('TEXT');

    // NOT NULL columns
    expect(columnMap.get('agent_invocation_id')?.notnull).toBe(1);
    expect(columnMap.get('agent_invocation_id')?.type).toBe('TEXT');

    expect(columnMap.get('run_id')?.notnull).toBe(1);
    expect(columnMap.get('run_id')?.type).toBe('TEXT');

    expect(columnMap.get('turn_index')?.notnull).toBe(1);
    expect(columnMap.get('turn_index')?.type).toBe('INTEGER');

    expect(columnMap.get('role')?.notnull).toBe(1);
    expect(columnMap.get('role')?.type).toBe('TEXT');

    expect(columnMap.get('content_json')?.notnull).toBe(1);
    expect(columnMap.get('content_json')?.type).toBe('TEXT');

    expect(columnMap.get('content_size_bytes')?.notnull).toBe(1);
    expect(columnMap.get('content_size_bytes')?.type).toBe('INTEGER');

    expect(columnMap.get('created_at')?.notnull).toBe(1);
    expect(columnMap.get('created_at')?.type).toBe('TEXT');

    // Nullable columns
    expect(columnMap.get('tokens_input')?.notnull).toBe(0);
    expect(columnMap.get('tokens_input')?.type).toBe('INTEGER');

    expect(columnMap.get('tokens_output')?.notnull).toBe(0);
    expect(columnMap.get('tokens_output')?.type).toBe('INTEGER');

    expect(columnMap.get('stop_reason')?.notnull).toBe(0);
    expect(columnMap.get('stop_reason')?.type).toBe('TEXT');

    // Total column count
    expect(columns).toHaveLength(11);
  });

  it('enforces UNIQUE constraint on (agent_invocation_id, turn_index)', () => {
    const { runId, agentInvocationId } = seedTestData(db);

    // First insert succeeds
    db.prepare(
      `
      INSERT INTO agent_messages (
        agent_message_id, agent_invocation_id, run_id, turn_index, role,
        content_json, content_size_bytes, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `,
    ).run('am_1', agentInvocationId, runId, 0, 'user', '"hello"', 7);

    // Duplicate (agent_invocation_id, turn_index) throws
    expect(() => {
      db.prepare(
        `
        INSERT INTO agent_messages (
          agent_message_id, agent_invocation_id, run_id, turn_index, role,
          content_json, content_size_bytes, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
      `,
      ).run('am_2', agentInvocationId, runId, 0, 'assistant', '"hi"', 4);
    }).toThrow(/UNIQUE/);
  });

  it('enforces CHECK constraint on role — invalid role throws', () => {
    const { runId, agentInvocationId } = seedTestData(db);

    expect(() => {
      db.prepare(
        `
        INSERT INTO agent_messages (
          agent_message_id, agent_invocation_id, run_id, turn_index, role,
          content_json, content_size_bytes, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
      `,
      ).run('am_bad_role', agentInvocationId, runId, 0, 'invalid_role', '"x"', 3);
    }).toThrow(/CHECK/);
  });

  it('enforces CHECK constraint on turn_index >= 0 — negative index throws', () => {
    const { runId, agentInvocationId } = seedTestData(db);

    expect(() => {
      db.prepare(
        `
        INSERT INTO agent_messages (
          agent_message_id, agent_invocation_id, run_id, turn_index, role,
          content_json, content_size_bytes, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
      `,
      ).run('am_neg', agentInvocationId, runId, -1, 'user', '"x"', 3);
    }).toThrow(/CHECK/);
  });

  it('enforces FK constraint — invalid agent_invocation_id throws', () => {
    const { runId } = seedTestData(db);

    expect(() => {
      db.prepare(
        `
        INSERT INTO agent_messages (
          agent_message_id, agent_invocation_id, run_id, turn_index, role,
          content_json, content_size_bytes, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
      `,
      ).run('am_fk', 'ai_nonexistent', runId, 0, 'user', '"x"', 3);
    }).toThrow(/FOREIGN KEY/);
  });

  it('enforces FK constraint — invalid run_id throws', () => {
    const { agentInvocationId } = seedTestData(db);

    expect(() => {
      db.prepare(
        `
        INSERT INTO agent_messages (
          agent_message_id, agent_invocation_id, run_id, turn_index, role,
          content_json, content_size_bytes, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
      `,
      ).run(
        'am_fk_run',
        agentInvocationId,
        'run_nonexistent',
        0,
        'user',
        '"x"',
        3,
      );
    }).toThrow(/FOREIGN KEY/);
  });

  it('has all 3 indexes', () => {
    const indexes = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='agent_messages'",
      )
      .all() as { name: string }[];

    const indexNames = indexes.map((i) => i.name);
    expect(indexNames).toContain('idx_agent_messages_invocation');
    expect(indexNames).toContain('idx_agent_messages_run');
    expect(indexNames).toContain('idx_agent_messages_created_at');
  });
});
