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
import { createImplementerMcpServer, createMcpToolDefinitions, getAllowedToolNames, MCP_SERVER_NAME } from './mcp-adapter.ts';
import type { ToolResultEntry } from './protocol.ts';
import { flushToolResults } from './protocol.ts';
import { listAgentMessages } from '../agent-messages.ts';

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

// =============================================================================
// MCP handler wiring and multi-turn integration
// =============================================================================

describe('MCP handler wiring and multi-turn integration', () => {
  it('Turn 1: two tool calls produce correct results and flush to one agent_message', async () => {
    const registry = createToolRegistry();
    registry.register(makeEchoTool());

    const pendingToolResults: ToolResultEntry[] = [];
    const pendingToolUseIds: string[] = [];
    let turnIndex = 0;
    const nextTurnIndex = () => turnIndex++;

    const toolDefs = createMcpToolDefinitions(
      registry,
      [],
      makeContext(),
      db,
      pendingToolResults,
      pendingToolUseIds,
    );

    expect(toolDefs).toHaveLength(1);
    const echoToolDef = toolDefs[0];
    expect(echoToolDef).toBeDefined();

    // Simulate Turn 1: SDK sends 2 tool_use blocks
    pendingToolUseIds.push('toolu_abc', 'toolu_def');

    // Call handler for first tool_use
    const result1 = await echoToolDef!.handler({ message: 'hi' }, undefined);
    expect(result1).toEqual({
      content: [{ type: 'text', text: 'Echo: hi' }],
      isError: false,
    });

    // Call handler for second tool_use
    const result2 = await echoToolDef!.handler({ message: 'bye' }, undefined);
    expect(result2).toEqual({
      content: [{ type: 'text', text: 'Echo: bye' }],
      isError: false,
    });

    // Verify pending state
    expect(pendingToolResults).toHaveLength(2);
    expect(pendingToolResults[0]?.tool_use_id).toBe('toolu_abc');
    expect(pendingToolResults[1]?.tool_use_id).toBe('toolu_def');

    // Verify tool_invocations table
    const invocations = listToolInvocations(db, agentInvocationId);
    expect(invocations).toHaveLength(2);
    expect(invocations.every(i => i.status === 'completed')).toBe(true);

    // Flush → 1 agent_message
    flushToolResults(pendingToolResults, pendingToolUseIds, db, agentInvocationId, nextTurnIndex);

    const messages = listAgentMessages(db, agentInvocationId);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.role).toBe('tool_result');

    const parsed = JSON.parse(messages[0]?.contentJson ?? '[]') as ToolResultEntry[];
    expect(parsed).toHaveLength(2);
    expect(parsed[0]?.tool_use_id).toBe('toolu_abc');
    expect(parsed[0]?.content).toBe('Echo: hi');
    expect(parsed[1]?.tool_use_id).toBe('toolu_def');
    expect(parsed[1]?.content).toBe('Echo: bye');

    // Both arrays empty after flush
    expect(pendingToolResults).toHaveLength(0);
    expect(pendingToolUseIds).toHaveLength(0);

    // Turn 2: 1 tool call
    pendingToolUseIds.push('toolu_ghi');

    await echoToolDef!.handler({ message: 'again' }, undefined);
    flushToolResults(pendingToolResults, pendingToolUseIds, db, agentInvocationId, nextTurnIndex);

    const allMessages = listAgentMessages(db, agentInvocationId);
    expect(allMessages).toHaveLength(2);

    const turn2Parsed = JSON.parse(allMessages[1]?.contentJson ?? '[]') as ToolResultEntry[];
    expect(turn2Parsed).toHaveLength(1);
    expect(turn2Parsed[0]?.tool_use_id).toBe('toolu_ghi');
    expect(turn2Parsed[0]?.content).toBe('Echo: again');

    // turnIndex strictly increasing
    expect(turnIndex).toBe(2);
  });
});
