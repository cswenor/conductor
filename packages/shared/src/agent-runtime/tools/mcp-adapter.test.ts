/**
 * MCP Adapter Tests
 *
 * Verifies that the MCP adapter correctly delegates to executeAuditedToolCall
 * and produces the right tool_invocations records and result shapes.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Database as DatabaseType } from 'better-sqlite3';
import { initDatabase, closeDatabase } from '../../db/index.ts';
import { createRun } from '../../runs/index.ts';
import { createAgentInvocation, markAgentRunning } from '../invocations.ts';
import { createToolRegistry } from './registry.ts';
import type { ToolDefinition, ToolExecutionContext } from './types.ts';
import { DEFAULT_POLICY_RULES } from './policy.ts';
import { listToolInvocations } from '../tool-invocations.ts';
import { ensureBuiltInPolicyDefinitions } from '../policy-definitions.ts';
import { executeAuditedToolCall } from '../executor.ts';
import { createImplementerMcpServer, getAllowedToolNames, MCP_SERVER_NAME } from './mcp-adapter.ts';
import type { ToolResultEntry } from './mcp-adapter.ts';

// =============================================================================
// Test Helpers
// =============================================================================

let db: DatabaseType;
let runId: string;
let agentInvocationId: string;
let projectId: string;

function seedTestData(database: DatabaseType) {
  const now = new Date().toISOString();
  const userId = 'user_test';
  projectId = 'proj_test';
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
  runId = run.runId;
  const inv = createAgentInvocation(database, {
    runId: run.runId,
    agent: 'implementer',
    action: 'apply_changes',
  });
  markAgentRunning(database, inv.agentInvocationId);
  agentInvocationId = inv.agentInvocationId;
}

function makeEchoTool(): ToolDefinition {
  return {
    name: 'echo',
    description: 'Echoes input back',
    inputSchema: {
      type: 'object',
      properties: { message: { type: 'string' } },
      required: ['message'],
    },
    execute: async (input) => ({
      content: `Echo: ${input['message'] as string}`,
      meta: { echoed: true },
    }),
    extractTarget: (input) => input['message'] as string,
  };
}

function makeFailingTool(): ToolDefinition {
  return {
    name: 'fail_tool',
    description: 'Always fails',
    inputSchema: {
      type: 'object',
      properties: { reason: { type: 'string' } },
      required: ['reason'],
    },
    execute: async (input) => ({
      content: `Error: ${input['reason'] as string}`,
      isError: true,
      meta: { failed: true },
    }),
    extractTarget: () => undefined,
  };
}

function makeContext(): ToolExecutionContext {
  return {
    runId,
    agentInvocationId,
    worktreePath: '/tmp/worktree',
    db,
    projectId,
  };
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
// Tests
// =============================================================================

describe('executeAuditedToolCall', () => {
  it('produces tool_invocations record for successful call', async () => {
    const registry = createToolRegistry();
    registry.register(makeEchoTool());

    const result = await executeAuditedToolCall(
      'echo',
      { message: 'hello' },
      registry,
      [],
      makeContext(),
      db,
    );

    expect(result.content).toBe('Echo: hello');
    expect(result.isError).toBeUndefined();

    const invocations = listToolInvocations(db, agentInvocationId);
    expect(invocations).toHaveLength(1);
    expect(invocations[0]?.tool).toBe('echo');
    expect(invocations[0]?.status).toBe('completed');
    expect(invocations[0]?.target).toBe('hello');
  });

  it('produces tool_invocations record for failed call', async () => {
    const registry = createToolRegistry();
    registry.register(makeFailingTool());

    const result = await executeAuditedToolCall(
      'fail_tool',
      { reason: 'test failure' },
      registry,
      [],
      makeContext(),
      db,
    );

    expect(result.content).toBe('Error: test failure');
    expect(result.isError).toBe(true);

    const invocations = listToolInvocations(db, agentInvocationId);
    expect(invocations).toHaveLength(1);
    expect(invocations[0]?.status).toBe('failed');
  });

  it('records unknown tool invocation', async () => {
    const registry = createToolRegistry();

    const result = await executeAuditedToolCall(
      'nonexistent',
      {},
      registry,
      [],
      makeContext(),
      db,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain('Unknown tool');

    const invocations = listToolInvocations(db, agentInvocationId);
    expect(invocations).toHaveLength(1);
    expect(invocations[0]?.status).toBe('failed');
  });

  it('policy-blocked calls produce status=blocked records', async () => {
    const registry = createToolRegistry();
    registry.register(makeEchoTool());

    const result = await executeAuditedToolCall(
      'echo',
      { message: 'hello' },
      registry,
      [{
        policyId: 'worktree_boundary',
        description: 'Block everything',
        evaluate: () => ({ decision: 'block' as const, policyId: 'worktree_boundary', reason: 'test block' }),
      }],
      makeContext(),
      db,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain('Policy blocked');

    const invocations = listToolInvocations(db, agentInvocationId);
    expect(invocations).toHaveLength(1);
    expect(invocations[0]?.status).toBe('blocked');
  });
});

describe('createImplementerMcpServer', () => {
  it('creates MCP server with correct tool names', () => {
    const registry = createToolRegistry();
    registry.register(makeEchoTool());

    const pendingToolResults: ToolResultEntry[] = [];
    const pendingToolUseIds: string[] = [];

    const server = createImplementerMcpServer(
      registry,
      [],
      makeContext(),
      db,
      pendingToolResults,
      pendingToolUseIds,
    );

    expect(server).toBeDefined();
    expect(server.type).toBe('sdk');
    expect(server.name).toBe(MCP_SERVER_NAME);
  });
});

describe('getAllowedToolNames', () => {
  it('generates correct mcp__conductor-tools__<name> names', () => {
    const registry = createToolRegistry();
    registry.register(makeEchoTool());
    registry.register(makeFailingTool());

    const names = getAllowedToolNames(registry);
    expect(names).toEqual([
      `mcp__${MCP_SERVER_NAME}__echo`,
      `mcp__${MCP_SERVER_NAME}__fail_tool`,
    ]);
  });

  it('updates automatically when tools are added', () => {
    const registry = createToolRegistry();
    registry.register(makeEchoTool());

    expect(getAllowedToolNames(registry)).toHaveLength(1);

    registry.register(makeFailingTool());
    expect(getAllowedToolNames(registry)).toHaveLength(2);
  });
});

describe('ToolResultEntry shape', () => {
  it('matches raw executor format', () => {
    const entry: ToolResultEntry = {
      type: 'tool_result',
      tool_use_id: 'toolu_abc123',
      content: 'Echo: hello',
      is_error: false,
    };

    expect(entry.type).toBe('tool_result');
    expect(typeof entry.tool_use_id).toBe('string');
    expect(typeof entry.content).toBe('string');
    expect(typeof entry.is_error).toBe('boolean');
  });
});
