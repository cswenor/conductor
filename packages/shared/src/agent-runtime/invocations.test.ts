/**
 * Agent Invocations Service Tests
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Database as DatabaseType } from 'better-sqlite3';
import { initDatabase, closeDatabase } from '../db/index.js';
import { createRun } from '../runs/index.js';
import {
  generateAgentInvocationId,
  createAgentInvocation,
  getAgentInvocation,
  listAgentInvocations,
  markAgentRunning,
  completeAgentInvocation,
  failAgentInvocation,
} from './invocations.js';

let db: DatabaseType;

function seedTestData(db: DatabaseType): { runId: string } {
  const now = new Date().toISOString();
  const userId = 'user_test';
  const projectId = 'proj_test';
  const repoId = 'repo_test';
  const taskId = 'task_test';

  db.prepare(`
    INSERT OR IGNORE INTO users (user_id, github_id, github_node_id, github_login, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'active', ?, ?)
  `).run(userId, 100, 'U_test', 'testuser', now, now);

  db.prepare(`
    INSERT INTO projects (
      project_id, user_id, name, github_org_id, github_org_node_id, github_org_name,
      github_installation_id, default_profile_id, default_base_branch,
      port_range_start, port_range_end, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(projectId, userId, 'Test Project', 1, 'O_test', 'testorg',
    12345, 'default', 'main', 3100, 3199, now, now);

  db.prepare(`
    INSERT INTO repos (
      repo_id, project_id, github_node_id, github_numeric_id,
      github_owner, github_name, github_full_name, github_default_branch,
      profile_id, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(repoId, projectId, 'R_test', 100,
    'testowner', 'testrepo', 'testowner/testrepo', 'main',
    'default', 'active', now, now);

  db.prepare(`
    INSERT INTO tasks (
      task_id, project_id, repo_id, github_node_id, github_issue_number,
      github_type, github_title, github_body, github_state, github_labels_json,
      github_synced_at, created_at, updated_at, last_activity_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(taskId, projectId, repoId, 'I_test', 42,
    'issue', 'Test Task', 'Body', 'open', '[]',
    now, now, now, now);

  const run = createRun(db, { taskId, projectId, repoId, baseBranch: 'main' });
  return { runId: run.runId };
}

beforeEach(() => {
  db = initDatabase({ path: ':memory:' });
});

afterEach(() => {
  closeDatabase(db);
});

describe('generateAgentInvocationId', () => {
  it('produces ids with ai_ prefix', () => {
    const id = generateAgentInvocationId();
    expect(id).toMatch(/^ai_/);
  });

  it('produces unique ids', () => {
    const ids = new Set(Array.from({ length: 100 }, () => generateAgentInvocationId()));
    expect(ids.size).toBe(100);
  });
});

describe('createAgentInvocation', () => {
  it('creates invocation with pending status', () => {
    const { runId } = seedTestData(db);
    const inv = createAgentInvocation(db, {
      runId,
      agent: 'planner',
      action: 'create_plan',
    });

    expect(inv.agentInvocationId).toMatch(/^ai_/);
    expect(inv.runId).toBe(runId);
    expect(inv.agent).toBe('planner');
    expect(inv.action).toBe('create_plan');
    expect(inv.status).toBe('pending');
    expect(inv.tokensInput).toBe(0);
    expect(inv.tokensOutput).toBe(0);
  });
});

describe('getAgentInvocation', () => {
  it('retrieves created invocation', () => {
    const { runId } = seedTestData(db);
    const created = createAgentInvocation(db, {
      runId,
      agent: 'planner',
      action: 'create_plan',
      contextSummary: 'test context',
    });

    const fetched = getAgentInvocation(db, created.agentInvocationId);
    expect(fetched).not.toBeNull();
    expect(fetched?.agent).toBe('planner');
    expect(fetched?.contextSummary).toBe('test context');
  });

  it('returns null for non-existent id', () => {
    expect(getAgentInvocation(db, 'ai_nonexistent')).toBeNull();
  });
});

describe('listAgentInvocations', () => {
  it('lists invocations for a run ordered by started_at', () => {
    const { runId } = seedTestData(db);

    createAgentInvocation(db, { runId, agent: 'planner', action: 'create_plan' });
    createAgentInvocation(db, { runId, agent: 'reviewer', action: 'review_plan' });

    const invocations = listAgentInvocations(db, runId);
    expect(invocations).toHaveLength(2);
    expect(invocations[0]?.agent).toBe('planner');
    expect(invocations[1]?.agent).toBe('reviewer');
  });

  it('returns empty array for run with no invocations', () => {
    const { runId } = seedTestData(db);
    expect(listAgentInvocations(db, runId)).toHaveLength(0);
  });
});

describe('markAgentRunning', () => {
  it('transitions pending to running', () => {
    const { runId } = seedTestData(db);
    const inv = createAgentInvocation(db, { runId, agent: 'planner', action: 'create_plan' });

    markAgentRunning(db, inv.agentInvocationId);

    const fetched = getAgentInvocation(db, inv.agentInvocationId);
    expect(fetched?.status).toBe('running');
  });
});

describe('completeAgentInvocation', () => {
  it('completes with token counts and duration', () => {
    const { runId } = seedTestData(db);
    const inv = createAgentInvocation(db, { runId, agent: 'planner', action: 'create_plan' });
    markAgentRunning(db, inv.agentInvocationId);

    completeAgentInvocation(db, inv.agentInvocationId, {
      tokensInput: 1000,
      tokensOutput: 500,
      durationMs: 2500,
    });

    const fetched = getAgentInvocation(db, inv.agentInvocationId);
    expect(fetched?.status).toBe('completed');
    expect(fetched?.tokensInput).toBe(1000);
    expect(fetched?.tokensOutput).toBe(500);
    expect(fetched?.durationMs).toBe(2500);
    expect(fetched?.completedAt).toBeDefined();
  });

  it('throws when completing an already-failed invocation', () => {
    const { runId } = seedTestData(db);
    const inv = createAgentInvocation(db, { runId, agent: 'planner', action: 'create_plan' });
    markAgentRunning(db, inv.agentInvocationId);
    failAgentInvocation(db, inv.agentInvocationId, { errorCode: 'test', errorMessage: 'err' });

    expect(() =>
      completeAgentInvocation(db, inv.agentInvocationId, {
        tokensInput: 100,
        tokensOutput: 50,
        durationMs: 1000,
      })
    ).toThrow('not in pending/running state');
  });
});

describe('failAgentInvocation', () => {
  it('fails with error code and message', () => {
    const { runId } = seedTestData(db);
    const inv = createAgentInvocation(db, { runId, agent: 'planner', action: 'create_plan' });
    markAgentRunning(db, inv.agentInvocationId);

    failAgentInvocation(db, inv.agentInvocationId, {
      errorCode: 'timeout',
      errorMessage: 'Agent timed out after 300s',
      durationMs: 300000,
    });

    const fetched = getAgentInvocation(db, inv.agentInvocationId);
    expect(fetched?.status).toBe('failed');
    expect(fetched?.errorCode).toBe('timeout');
    expect(fetched?.errorMessage).toBe('Agent timed out after 300s');
    expect(fetched?.durationMs).toBe(300000);
    expect(fetched?.completedAt).toBeDefined();
  });
});
