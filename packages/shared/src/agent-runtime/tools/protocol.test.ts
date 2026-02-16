/**
 * Protocol Helper Tests
 *
 * Unit tests for recordToolResult and flushToolResults.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Database as DatabaseType } from 'better-sqlite3';
import { initDatabase, closeDatabase } from '../../db/index.ts';
import { createRun } from '../../runs/index.ts';
import { createAgentInvocation, markAgentRunning } from '../invocations.ts';
import { listAgentMessages } from '../agent-messages.ts';
import { ensureBuiltInPolicyDefinitions } from '../policy-definitions.ts';
import { recordToolResult, flushToolResults } from './protocol.ts';
import type { ToolResultEntry } from './protocol.ts';

// =============================================================================
// Test Helpers
// =============================================================================

let db: DatabaseType;
let agentInvocationId: string;

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

  const run = createRun(database, { taskId, projectId, repoId, baseBranch: 'main' });
  const inv = createAgentInvocation(database, {
    runId: run.runId,
    agent: 'implementer',
    action: 'apply_changes',
  });
  markAgentRunning(database, inv.agentInvocationId);
  agentInvocationId = inv.agentInvocationId;
}

beforeEach(() => {
  db = initDatabase({ path: ':memory:' });
  ensureBuiltInPolicyDefinitions(db);
  seedTestData(db);
});

afterEach(() => {
  closeDatabase(db);
});

// =============================================================================
// recordToolResult
// =============================================================================

describe('recordToolResult', () => {
  it('dequeues IDs in FIFO order', () => {
    const ids: string[] = ['id_a', 'id_b'];
    const results: ToolResultEntry[] = [];

    const first = recordToolResult(ids, results, 'echo', { content: 'one' });
    const second = recordToolResult(ids, results, 'echo', { content: 'two' });

    expect(first).toBe('id_a');
    expect(second).toBe('id_b');
    expect(ids).toHaveLength(0);
  });

  it('generates synthetic ID when queue empty', () => {
    const ids: string[] = [];
    const results: ToolResultEntry[] = [];

    const id = recordToolResult(ids, results, 'echo', { content: 'hello' });
    expect(id).toMatch(/^synth_/);
  });

  it('pushes correct ToolResultEntry shape', () => {
    const ids: string[] = ['toolu_abc'];
    const results: ToolResultEntry[] = [];

    recordToolResult(ids, results, 'echo', { content: 'hello' });

    expect(results).toHaveLength(1);
    expect(results[0]).toEqual({
      type: 'tool_result',
      tool_use_id: 'toolu_abc',
      content: 'hello',
      is_error: false,
    });
  });

  it('accumulates multiple results in order', () => {
    const ids: string[] = ['id_1', 'id_2', 'id_3'];
    const results: ToolResultEntry[] = [];

    recordToolResult(ids, results, 'a', { content: 'first' });
    recordToolResult(ids, results, 'b', { content: 'second' });
    recordToolResult(ids, results, 'c', { content: 'third' });

    expect(results).toHaveLength(3);
    expect(results[0]?.content).toBe('first');
    expect(results[1]?.content).toBe('second');
    expect(results[2]?.content).toBe('third');
  });

  it('isError: true maps to is_error: true', () => {
    const ids: string[] = ['id_1'];
    const results: ToolResultEntry[] = [];

    recordToolResult(ids, results, 'fail', { content: 'oops', isError: true });

    expect(results[0]?.is_error).toBe(true);
  });

  it('isError: undefined defaults to is_error: false', () => {
    const ids: string[] = ['id_1'];
    const results: ToolResultEntry[] = [];

    recordToolResult(ids, results, 'ok', { content: 'fine' });

    expect(results[0]?.is_error).toBe(false);
  });
});

// =============================================================================
// flushToolResults
// =============================================================================

describe('flushToolResults', () => {
  it('persists one agent_message with all results', () => {
    const ids: string[] = [];
    const results: ToolResultEntry[] = [
      { type: 'tool_result', tool_use_id: 'id_a', content: 'one', is_error: false },
      { type: 'tool_result', tool_use_id: 'id_b', content: 'two', is_error: true },
    ];
    let turn = 0;

    flushToolResults(results, ids, db, agentInvocationId, () => turn++);

    const messages = listAgentMessages(db, agentInvocationId);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.role).toBe('tool_result');

    const parsed = JSON.parse(messages[0]?.contentJson ?? '[]') as ToolResultEntry[];
    expect(parsed).toHaveLength(2);
    expect(parsed[0]?.tool_use_id).toBe('id_a');
    expect(parsed[1]?.tool_use_id).toBe('id_b');
  });

  it('no-op when empty', () => {
    const ids: string[] = [];
    const results: ToolResultEntry[] = [];
    let turn = 0;

    flushToolResults(results, ids, db, agentInvocationId, () => turn++);

    const messages = listAgentMessages(db, agentInvocationId);
    expect(messages).toHaveLength(0);
    expect(turn).toBe(0);
  });

  it('drains stale pendingToolUseIds when results exist', () => {
    const ids: string[] = ['stale_1', 'stale_2'];
    const results: ToolResultEntry[] = [
      { type: 'tool_result', tool_use_id: 'id_a', content: 'data', is_error: false },
    ];
    let turn = 0;

    flushToolResults(results, ids, db, agentInvocationId, () => turn++);

    expect(ids).toHaveLength(0);
  });

  it('does NOT drain stale IDs when results are empty', () => {
    const ids: string[] = ['stale_1', 'stale_2'];
    const results: ToolResultEntry[] = [];
    let turn = 0;

    flushToolResults(results, ids, db, agentInvocationId, () => turn++);

    expect(ids).toHaveLength(2);
    expect(ids[0]).toBe('stale_1');
  });

  it('clears pendingToolResults after flush', () => {
    const ids: string[] = [];
    const results: ToolResultEntry[] = [
      { type: 'tool_result', tool_use_id: 'id_a', content: 'data', is_error: false },
    ];
    let turn = 0;

    flushToolResults(results, ids, db, agentInvocationId, () => turn++);

    expect(results).toHaveLength(0);
  });

  it('increments turnIndex exactly once', () => {
    const ids: string[] = [];
    const results: ToolResultEntry[] = [
      { type: 'tool_result', tool_use_id: 'id_a', content: 'a', is_error: false },
      { type: 'tool_result', tool_use_id: 'id_b', content: 'b', is_error: false },
    ];
    let callCount = 0;

    flushToolResults(results, ids, db, agentInvocationId, () => callCount++);

    expect(callCount).toBe(1);
  });

  it('idempotent double-call on empty buffers', () => {
    const ids: string[] = [];
    const results: ToolResultEntry[] = [
      { type: 'tool_result', tool_use_id: 'id_a', content: 'data', is_error: false },
    ];
    let turn = 0;

    flushToolResults(results, ids, db, agentInvocationId, () => turn++);
    flushToolResults(results, ids, db, agentInvocationId, () => turn++);

    const messages = listAgentMessages(db, agentInvocationId);
    expect(messages).toHaveLength(1);
  });
});
