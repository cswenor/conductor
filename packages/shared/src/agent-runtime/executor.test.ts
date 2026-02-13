/**
 * Executor Tests
 *
 * Tests the multi-turn tool execution loop with mock provider.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Database as DatabaseType } from 'better-sqlite3';
import type Anthropic from '@anthropic-ai/sdk';
import { initDatabase, closeDatabase } from '../db/index.ts';
import { createRun } from '../runs/index.ts';
import { createAgentInvocation, markAgentRunning } from './invocations.ts';
import type { AgentInput, AgentOutput, AgentProvider } from './provider.ts';
import { AgentCancelledError } from './provider.ts';
import { createToolRegistry } from './tools/registry.ts';
import type { ToolDefinition, ToolExecutionContext } from './tools/types.ts';
import { DEFAULT_POLICY_RULES } from './tools/policy.ts';
import { runToolLoop, MAX_TOOL_ITERATIONS } from './executor.ts';
import { listToolInvocations } from './tool-invocations.ts';
import { listAgentMessages } from './agent-messages.ts';

// =============================================================================
// Test Helpers
// =============================================================================

let db: DatabaseType;
let runId: string;
let agentInvocationId: string;

function seedTestData(database: DatabaseType): { runId: string; agentInvocationId: string; projectId: string } {
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

  return { runId: run.runId, agentInvocationId: inv.agentInvocationId, projectId };
}

interface MockResponse {
  content: string;
  stopReason: string;
  toolCalls?: Array<{ id: string; name: string; input: Record<string, unknown> }>;
  rawContentBlocks?: Anthropic.ContentBlock[];
}

function createMockProvider(responses: MockResponse[]): AgentProvider {
  let callIndex = 0;
  return {
    async invoke(_input: AgentInput): Promise<AgentOutput> {
      const resp = responses[callIndex++];
      if (resp === undefined) {
        throw new Error('Mock provider ran out of responses');
      }
      return {
        content: resp.content,
        tokensInput: 100,
        tokensOutput: 50,
        stopReason: resp.stopReason,
        durationMs: 100,
        toolCalls: resp.toolCalls,
        rawContentBlocks: resp.rawContentBlocks ?? [
          { type: 'text' as const, text: resp.content, citations: null },
        ],
      };
    },
  };
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

function makeContext(overrides?: Partial<ToolExecutionContext>): ToolExecutionContext {
  return {
    runId,
    agentInvocationId,
    worktreePath: '/tmp/worktree',
    db,
    projectId: 'proj_test',
    ...overrides,
  };
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

// =============================================================================
// Tests
// =============================================================================

describe('runToolLoop', () => {
  it('handles single-turn response (no tool use)', async () => {
    const provider = createMockProvider([
      { content: 'Hello, world!', stopReason: 'end_turn' },
    ]);

    const registry = createToolRegistry();
    const result = await runToolLoop({
      db,
      provider,
      systemPrompt: 'You are helpful.',
      userPrompt: 'Say hello.',
      registry,
      policyRules: [],
      context: makeContext(),
    });

    expect(result.content).toBe('Hello, world!');
    expect(result.iterations).toBe(1);
    expect(result.stopReason).toBe('end_turn');
    expect(result.totalTokensInput).toBe(100);
    expect(result.totalTokensOutput).toBe(50);
  });

  it('handles multi-turn tool loop', async () => {
    const provider = createMockProvider([
      {
        content: '',
        stopReason: 'tool_use',
        toolCalls: [{ id: 'tc_1', name: 'echo', input: { message: 'ping' } }],
        rawContentBlocks: [
          { type: 'tool_use' as const, id: 'tc_1', name: 'echo', input: { message: 'ping' } },
        ],
      },
      {
        content: 'Done! The echo returned: ping',
        stopReason: 'end_turn',
      },
    ]);

    const registry = createToolRegistry();
    registry.register(makeEchoTool());

    const result = await runToolLoop({
      db,
      provider,
      systemPrompt: 'You are helpful.',
      userPrompt: 'Echo ping.',
      registry,
      policyRules: [],
      context: makeContext(),
    });

    expect(result.content).toBe('Done! The echo returned: ping');
    expect(result.iterations).toBe(2);
    expect(result.totalTokensInput).toBe(200);
    expect(result.totalTokensOutput).toBe(100);
  });

  it('logs tool invocations to database', async () => {
    const provider = createMockProvider([
      {
        content: '',
        stopReason: 'tool_use',
        toolCalls: [{ id: 'tc_1', name: 'echo', input: { message: 'test' } }],
        rawContentBlocks: [
          { type: 'tool_use' as const, id: 'tc_1', name: 'echo', input: { message: 'test' } },
        ],
      },
      { content: 'Done.', stopReason: 'end_turn' },
    ]);

    const registry = createToolRegistry();
    registry.register(makeEchoTool());

    await runToolLoop({
      db,
      provider,
      systemPrompt: 'Test',
      userPrompt: 'Test',
      registry,
      policyRules: [],
      context: makeContext(),
    });

    const invocations = listToolInvocations(db, agentInvocationId);
    expect(invocations).toHaveLength(1);
    expect(invocations[0]?.tool).toBe('echo');
    expect(invocations[0]?.status).toBe('completed');
    expect(invocations[0]?.policyDecision).toBe('allow');
  });

  it('handles policy block', async () => {
    const provider = createMockProvider([
      {
        content: '',
        stopReason: 'tool_use',
        toolCalls: [{ id: 'tc_1', name: 'echo', input: { message: 'test' } }],
        rawContentBlocks: [
          { type: 'tool_use' as const, id: 'tc_1', name: 'echo', input: { message: 'test' } },
        ],
      },
      { content: 'Policy blocked me.', stopReason: 'end_turn' },
    ]);

    const registry = createToolRegistry();
    registry.register(makeEchoTool());

    const blockAllRule = {
      policyId: 'worktree_boundary',
      description: 'Blocks everything (test)',
      evaluate: () => ({ decision: 'block' as const, policyId: 'worktree_boundary', reason: 'Test block' }),
    };

    const result = await runToolLoop({
      db,
      provider,
      systemPrompt: 'Test',
      userPrompt: 'Test',
      registry,
      policyRules: [blockAllRule],
      context: makeContext(),
    });

    expect(result.content).toBe('Policy blocked me.');

    const invocations = listToolInvocations(db, agentInvocationId);
    expect(invocations).toHaveLength(1);
    expect(invocations[0]?.status).toBe('blocked');
    expect(invocations[0]?.policyDecision).toBe('block');
    expect(invocations[0]?.policyId).toBe('worktree_boundary');
  });

  it('handles unknown tool gracefully and logs to tool_invocations', async () => {
    const provider = createMockProvider([
      {
        content: '',
        stopReason: 'tool_use',
        toolCalls: [{ id: 'tc_1', name: 'nonexistent', input: {} }],
        rawContentBlocks: [
          { type: 'tool_use' as const, id: 'tc_1', name: 'nonexistent', input: {} },
        ],
      },
      { content: 'Tool not found, giving up.', stopReason: 'end_turn' },
    ]);

    const registry = createToolRegistry();

    const result = await runToolLoop({
      db,
      provider,
      systemPrompt: 'Test',
      userPrompt: 'Test',
      registry,
      policyRules: [],
      context: makeContext(),
    });

    expect(result.content).toBe('Tool not found, giving up.');

    const invocations = listToolInvocations(db, agentInvocationId);
    expect(invocations).toHaveLength(1);
    expect(invocations[0]?.tool).toBe('nonexistent');
    expect(invocations[0]?.status).toBe('failed');
    expect(JSON.parse(invocations[0]!.resultMetaJson)).toEqual({
      errorCode: 'unknown_tool',
      toolName: 'nonexistent',
    });
  });

  it('logs unknown tool independently of policy rules', async () => {
    const provider = createMockProvider([
      {
        content: '',
        stopReason: 'tool_use',
        toolCalls: [{ id: 'tc_1', name: 'totally_unknown', input: { data: 'test' } }],
        rawContentBlocks: [
          { type: 'tool_use' as const, id: 'tc_1', name: 'totally_unknown', input: { data: 'test' } },
        ],
      },
      { content: 'Done.', stopReason: 'end_turn' },
    ]);

    const registry = createToolRegistry();

    // Even with a strict block-all policy, unknown tool should get a 'failed' record
    // (not blocked — the tool doesn't exist, so policy doesn't apply)
    const blockAllRule = {
      policyId: 'worktree_boundary',
      description: 'Blocks everything (test)',
      evaluate: () => ({ decision: 'block' as const, policyId: 'worktree_boundary', reason: 'Strict' }),
    };

    await runToolLoop({
      db,
      provider,
      systemPrompt: 'Test',
      userPrompt: 'Test',
      registry,
      policyRules: [blockAllRule],
      context: makeContext(),
    });

    const invocations = listToolInvocations(db, agentInvocationId);
    expect(invocations).toHaveLength(1);
    expect(invocations[0]?.status).toBe('failed');
    expect(JSON.parse(invocations[0]!.resultMetaJson)).toMatchObject({
      errorCode: 'unknown_tool',
    });
  });

  it('handles tool execution error', async () => {
    const failingTool: ToolDefinition = {
      name: 'fail_tool',
      description: 'Always fails',
      inputSchema: { type: 'object' },
      execute: async () => {
        throw new Error('Intentional failure');
      },
    };

    const provider = createMockProvider([
      {
        content: '',
        stopReason: 'tool_use',
        toolCalls: [{ id: 'tc_1', name: 'fail_tool', input: {} }],
        rawContentBlocks: [
          { type: 'tool_use' as const, id: 'tc_1', name: 'fail_tool', input: {} },
        ],
      },
      { content: 'Tool failed, acknowledged.', stopReason: 'end_turn' },
    ]);

    const registry = createToolRegistry();
    registry.register(failingTool);

    const result = await runToolLoop({
      db,
      provider,
      systemPrompt: 'Test',
      userPrompt: 'Test',
      registry,
      policyRules: [],
      context: makeContext(),
    });

    expect(result.content).toBe('Tool failed, acknowledged.');

    const invocations = listToolInvocations(db, agentInvocationId);
    expect(invocations).toHaveLength(1);
    expect(invocations[0]?.status).toBe('failed');
  });

  it('throws on max iterations exceeded', async () => {
    // Create a provider that always returns tool_use
    const infiniteResponses: MockResponse[] = Array.from({ length: 55 }, (_, i) => ({
      content: '',
      stopReason: 'tool_use',
      toolCalls: [{ id: `tc_${i}`, name: 'echo', input: { message: `iter_${i}` } }],
      rawContentBlocks: [
        { type: 'tool_use' as const, id: `tc_${i}`, name: 'echo', input: { message: `iter_${i}` } },
      ],
    }));

    const provider = createMockProvider(infiniteResponses);
    const registry = createToolRegistry();
    registry.register(makeEchoTool());

    await expect(
      runToolLoop({
        db,
        provider,
        systemPrompt: 'Test',
        userPrompt: 'Test',
        registry,
        policyRules: [],
        context: makeContext(),
        maxIterations: 3,
      })
    ).rejects.toThrow('maximum iterations');
  });

  it('accumulates tokens across iterations', async () => {
    const provider = createMockProvider([
      {
        content: '',
        stopReason: 'tool_use',
        toolCalls: [{ id: 'tc_1', name: 'echo', input: { message: 'a' } }],
        rawContentBlocks: [
          { type: 'tool_use' as const, id: 'tc_1', name: 'echo', input: { message: 'a' } },
        ],
      },
      {
        content: '',
        stopReason: 'tool_use',
        toolCalls: [{ id: 'tc_2', name: 'echo', input: { message: 'b' } }],
        rawContentBlocks: [
          { type: 'tool_use' as const, id: 'tc_2', name: 'echo', input: { message: 'b' } },
        ],
      },
      { content: 'All done.', stopReason: 'end_turn' },
    ]);

    const registry = createToolRegistry();
    registry.register(makeEchoTool());

    const result = await runToolLoop({
      db,
      provider,
      systemPrompt: 'Test',
      userPrompt: 'Test',
      registry,
      policyRules: [],
      context: makeContext(),
    });

    expect(result.iterations).toBe(3);
    expect(result.totalTokensInput).toBe(300);  // 100 * 3
    expect(result.totalTokensOutput).toBe(150); // 50 * 3
  });

  it('aborts when signal is pre-aborted', async () => {
    const provider = createMockProvider([
      { content: 'Should not reach', stopReason: 'end_turn' },
    ]);

    const registry = createToolRegistry();
    const abortController = new AbortController();
    abortController.abort();

    await expect(
      runToolLoop({
        db,
        provider,
        systemPrompt: 'Test',
        userPrompt: 'Test',
        registry,
        policyRules: [],
        context: makeContext(),
        abortSignal: abortController.signal,
      })
    ).rejects.toThrow(AgentCancelledError);
  });

  it('aborts between iterations when signal fires', async () => {
    const abortController = new AbortController();

    // Tool that fires abort during execution
    const abortTriggerTool: ToolDefinition = {
      name: 'trigger_abort',
      description: 'Triggers abort signal',
      inputSchema: { type: 'object' },
      execute: async () => {
        abortController.abort();
        return { content: 'done', meta: {} };
      },
    };

    const provider = createMockProvider([
      {
        content: '',
        stopReason: 'tool_use',
        toolCalls: [{ id: 'tc_1', name: 'trigger_abort', input: {} }],
        rawContentBlocks: [
          { type: 'tool_use' as const, id: 'tc_1', name: 'trigger_abort', input: {} },
        ],
      },
      // Second response should never be reached
      { content: 'Should not reach', stopReason: 'end_turn' },
    ]);

    const registry = createToolRegistry();
    registry.register(abortTriggerTool);

    await expect(
      runToolLoop({
        db,
        provider,
        systemPrompt: 'Test',
        userPrompt: 'Test',
        registry,
        policyRules: [],
        context: makeContext(),
        abortSignal: abortController.signal,
      })
    ).rejects.toThrow(AgentCancelledError);
  });

  it('aborts when DB phase is cancelled', async () => {
    // Tool that sets the run phase to cancelled in the DB
    const cancelPhaseTool: ToolDefinition = {
      name: 'cancel_in_db',
      description: 'Cancels run in DB',
      inputSchema: { type: 'object' },
      execute: async (_input, context) => {
        context.db.prepare('UPDATE runs SET phase = ? WHERE run_id = ?')
          .run('cancelled', context.runId);
        return { content: 'cancelled', meta: {} };
      },
    };

    const provider = createMockProvider([
      {
        content: '',
        stopReason: 'tool_use',
        toolCalls: [{ id: 'tc_1', name: 'cancel_in_db', input: {} }],
        rawContentBlocks: [
          { type: 'tool_use' as const, id: 'tc_1', name: 'cancel_in_db', input: {} },
        ],
      },
      // Second response should never be reached
      { content: 'Should not reach', stopReason: 'end_turn' },
    ]);

    const registry = createToolRegistry();
    registry.register(cancelPhaseTool);

    await expect(
      runToolLoop({
        db,
        provider,
        systemPrompt: 'Test',
        userPrompt: 'Test',
        registry,
        policyRules: [],
        context: makeContext(),
      })
    ).rejects.toThrow(AgentCancelledError);
  });

  describe('message persistence', () => {
    it('persists system + user + assistant for single-turn (3 messages)', async () => {
      const provider = createMockProvider([
        { content: 'Hello!', stopReason: 'end_turn' },
      ]);
      const registry = createToolRegistry();
      await runToolLoop({
        db, provider,
        systemPrompt: 'You are helpful.',
        userPrompt: 'Say hello.',
        registry, policyRules: [],
        context: makeContext(),
      });
      const msgs = listAgentMessages(db, agentInvocationId);
      expect(msgs).toHaveLength(3);
      expect(msgs[0]?.role).toBe('system');
      expect(msgs[1]?.role).toBe('user');
      expect(msgs[2]?.role).toBe('assistant');
    });

    it('persists 5 messages for multi-turn (system + user + assistant + tool_result + assistant)', async () => {
      const provider = createMockProvider([
        {
          content: '',
          stopReason: 'tool_use',
          toolCalls: [{ id: 'tc_1', name: 'echo', input: { message: 'ping' } }],
          rawContentBlocks: [
            { type: 'tool_use' as const, id: 'tc_1', name: 'echo', input: { message: 'ping' } },
          ],
        },
        { content: 'Done!', stopReason: 'end_turn' },
      ]);
      const registry = createToolRegistry();
      registry.register(makeEchoTool());
      await runToolLoop({
        db, provider,
        systemPrompt: 'System',
        userPrompt: 'User',
        registry, policyRules: [],
        context: makeContext(),
      });
      const msgs = listAgentMessages(db, agentInvocationId);
      expect(msgs).toHaveLength(5);
      expect(msgs.map(m => m.role)).toEqual(['system', 'user', 'assistant', 'tool_result', 'assistant']);
    });

    it('has sequential turn indexes', async () => {
      const provider = createMockProvider([
        {
          content: '',
          stopReason: 'tool_use',
          toolCalls: [{ id: 'tc_1', name: 'echo', input: { message: 'a' } }],
          rawContentBlocks: [
            { type: 'tool_use' as const, id: 'tc_1', name: 'echo', input: { message: 'a' } },
          ],
        },
        { content: 'Done.', stopReason: 'end_turn' },
      ]);
      const registry = createToolRegistry();
      registry.register(makeEchoTool());
      await runToolLoop({
        db, provider,
        systemPrompt: 'S',
        userPrompt: 'U',
        registry, policyRules: [],
        context: makeContext(),
      });
      const msgs = listAgentMessages(db, agentInvocationId);
      expect(msgs.map(m => m.turnIndex)).toEqual([0, 1, 2, 3, 4]);
    });

    it('includes token counts on assistant messages', async () => {
      const provider = createMockProvider([
        { content: 'Hi', stopReason: 'end_turn' },
      ]);
      const registry = createToolRegistry();
      await runToolLoop({
        db, provider,
        systemPrompt: 'S',
        userPrompt: 'U',
        registry, policyRules: [],
        context: makeContext(),
      });
      const msgs = listAgentMessages(db, agentInvocationId);
      const assistant = msgs.find(m => m.role === 'assistant');
      expect(assistant?.tokensInput).toBe(100);
      expect(assistant?.tokensOutput).toBe(50);
      expect(assistant?.stopReason).toBe('end_turn');
    });

    it('persistence failure does not break tool loop', async () => {
      // Corrupt the agent_messages table to force insert failures
      db.exec('DROP TABLE agent_messages');
      db.exec('CREATE TABLE agent_messages (agent_message_id TEXT PRIMARY KEY)');

      const provider = createMockProvider([
        { content: 'Still works!', stopReason: 'end_turn' },
      ]);
      const registry = createToolRegistry();
      const result = await runToolLoop({
        db, provider,
        systemPrompt: 'S',
        userPrompt: 'U',
        registry, policyRules: [],
        context: makeContext(),
      });
      expect(result.content).toBe('Still works!');
    });
  });
});
