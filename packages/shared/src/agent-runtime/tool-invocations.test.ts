/**
 * Tool Invocations Service Tests
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Database as DatabaseType } from 'better-sqlite3';
import { initDatabase, closeDatabase } from '../db/index.js';
import { createRun } from '../runs/index.js';
import { createAgentInvocation } from './invocations.js';
import {
  generateToolInvocationId,
  createToolInvocation,
  completeToolInvocation,
  failToolInvocation,
  blockToolInvocation,
  getToolInvocation,
  listToolInvocations,
  listToolInvocationsByRun,
} from './tool-invocations.js';

let db: DatabaseType;
let runId: string;
let agentInvocationId: string;

function seedTestData(database: DatabaseType): { runId: string; agentInvocationId: string } {
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

  return { runId: run.runId, agentInvocationId: inv.agentInvocationId };
}

beforeEach(() => {
  db = initDatabase({ path: ':memory:' });
  const seed = seedTestData(db);
  runId = seed.runId;
  agentInvocationId = seed.agentInvocationId;
});

afterEach(() => {
  closeDatabase(db);
});

describe('generateToolInvocationId', () => {
  it('produces ids with ti_ prefix', () => {
    const id = generateToolInvocationId();
    expect(id).toMatch(/^ti_/);
  });

  it('produces unique ids', () => {
    const ids = new Set(Array.from({ length: 100 }, () => generateToolInvocationId()));
    expect(ids.size).toBe(100);
  });
});

describe('createToolInvocation', () => {
  it('creates invocation with started status for allow decision', () => {
    const inv = createToolInvocation(db, {
      agentInvocationId,
      runId,
      tool: 'read_file',
      target: 'src/main.ts',
      argsRedactedJson: '{"path":"src/main.ts"}',
      argsFieldsRemovedJson: '[]',
      argsSecretsDetected: false,
      argsPayloadHash: 'abc123',
      argsPayloadHashScheme: 'sha256:cjson:v1',
      policyDecision: 'allow',
    });

    expect(inv.toolInvocationId).toMatch(/^ti_/);
    expect(inv.status).toBe('started');
    expect(inv.tool).toBe('read_file');
    expect(inv.target).toBe('src/main.ts');
    expect(inv.policyDecision).toBe('allow');
  });

  it('creates invocation with blocked status for block decision', () => {
    const inv = createToolInvocation(db, {
      agentInvocationId,
      runId,
      tool: 'write_file',
      target: '.env',
      argsRedactedJson: '{"path":".env","content":"[REDACTED]"}',
      argsFieldsRemovedJson: '[]',
      argsSecretsDetected: false,
      argsPayloadHash: 'def456',
      argsPayloadHashScheme: 'sha256:cjson:v1',
      policyDecision: 'block',
      policyId: 'sensitive_file_write',
    });

    expect(inv.status).toBe('blocked');
    expect(inv.policyDecision).toBe('block');
  });
});

describe('completeToolInvocation', () => {
  it('transitions started to completed with result meta', () => {
    const inv = createToolInvocation(db, {
      agentInvocationId,
      runId,
      tool: 'read_file',
      argsRedactedJson: '{}',
      argsFieldsRemovedJson: '[]',
      argsSecretsDetected: false,
      argsPayloadHash: 'abc',
      argsPayloadHashScheme: 'sha256:cjson:v1',
      policyDecision: 'allow',
    });

    completeToolInvocation(db, inv.toolInvocationId, {
      resultMeta: { bytesRead: 1024 },
      durationMs: 50,
    });

    const fetched = getToolInvocation(db, inv.toolInvocationId);
    expect(fetched?.status).toBe('completed');
    expect(fetched?.durationMs).toBe(50);
    expect(JSON.parse(fetched!.resultMetaJson)).toEqual({ bytesRead: 1024 });
  });
});

describe('failToolInvocation', () => {
  it('transitions started to failed', () => {
    const inv = createToolInvocation(db, {
      agentInvocationId,
      runId,
      tool: 'write_file',
      argsRedactedJson: '{}',
      argsFieldsRemovedJson: '[]',
      argsSecretsDetected: false,
      argsPayloadHash: 'abc',
      argsPayloadHashScheme: 'sha256:cjson:v1',
      policyDecision: 'allow',
    });

    failToolInvocation(db, inv.toolInvocationId, {
      resultMeta: { error: 'ENOENT' },
      durationMs: 10,
    });

    const fetched = getToolInvocation(db, inv.toolInvocationId);
    expect(fetched?.status).toBe('failed');
    expect(JSON.parse(fetched!.resultMetaJson)).toEqual({ error: 'ENOENT' });
  });
});

describe('blockToolInvocation', () => {
  it('updates blocked invocation with result meta', () => {
    const inv = createToolInvocation(db, {
      agentInvocationId,
      runId,
      tool: 'write_file',
      argsRedactedJson: '{}',
      argsFieldsRemovedJson: '[]',
      argsSecretsDetected: false,
      argsPayloadHash: 'abc',
      argsPayloadHashScheme: 'sha256:cjson:v1',
      policyDecision: 'block',
    });

    blockToolInvocation(db, inv.toolInvocationId, {
      resultMeta: { reason: 'path escape' },
      durationMs: 1,
    });

    const fetched = getToolInvocation(db, inv.toolInvocationId);
    expect(fetched?.status).toBe('blocked');
    expect(JSON.parse(fetched!.resultMetaJson)).toEqual({ reason: 'path escape' });
    expect(fetched?.durationMs).toBe(1);
  });
});

describe('getToolInvocation', () => {
  it('returns null for non-existent id', () => {
    expect(getToolInvocation(db, 'ti_nonexistent')).toBeNull();
  });
});

describe('listToolInvocations', () => {
  it('lists invocations for an agent invocation ordered by created_at', () => {
    createToolInvocation(db, {
      agentInvocationId,
      runId,
      tool: 'read_file',
      argsRedactedJson: '{}',
      argsFieldsRemovedJson: '[]',
      argsSecretsDetected: false,
      argsPayloadHash: 'a',
      argsPayloadHashScheme: 'sha256:cjson:v1',
      policyDecision: 'allow',
    });
    createToolInvocation(db, {
      agentInvocationId,
      runId,
      tool: 'write_file',
      argsRedactedJson: '{}',
      argsFieldsRemovedJson: '[]',
      argsSecretsDetected: false,
      argsPayloadHash: 'b',
      argsPayloadHashScheme: 'sha256:cjson:v1',
      policyDecision: 'allow',
    });

    const invocations = listToolInvocations(db, agentInvocationId);
    expect(invocations).toHaveLength(2);
    expect(invocations[0]?.tool).toBe('read_file');
    expect(invocations[1]?.tool).toBe('write_file');
  });
});

describe('listToolInvocationsByRun', () => {
  it('lists all invocations for a run', () => {
    createToolInvocation(db, {
      agentInvocationId,
      runId,
      tool: 'list_files',
      argsRedactedJson: '{}',
      argsFieldsRemovedJson: '[]',
      argsSecretsDetected: false,
      argsPayloadHash: 'c',
      argsPayloadHashScheme: 'sha256:cjson:v1',
      policyDecision: 'allow',
    });

    const invocations = listToolInvocationsByRun(db, runId);
    expect(invocations).toHaveLength(1);
    expect(invocations[0]?.tool).toBe('list_files');
  });

  it('returns empty array for run with no tool invocations', () => {
    expect(listToolInvocationsByRun(db, 'run_nonexistent')).toHaveLength(0);
  });
});
