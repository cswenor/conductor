/**
 * Executor Tests
 *
 * Tests the multi-turn tool execution loop with mock provider.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Database as DatabaseType } from 'better-sqlite3';
import type Anthropic from '@anthropic-ai/sdk';
import { initDatabase, closeDatabase } from '../db/index.ts';
import { createRun } from '../runs/index.ts';
import { createAgentInvocation, markAgentRunning } from './invocations.ts';
import type { AgentInput, AgentOutput, AgentProvider } from './provider.ts';
import { AgentCancelledError, AgentBudgetExceededError, AgentRateLimitError } from './provider.ts';
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

function createCapturingMockProvider(responses: MockResponse[]) {
  const capturedMessages: Anthropic.MessageParam[][] = [];
  let callIndex = 0;
  return {
    capturedMessages,
    provider: {
      async invoke(input: AgentInput): Promise<AgentOutput> {
        capturedMessages.push([...(input.messages ?? [])]);
        const resp = responses[callIndex++]!;
        return {
          content: resp.content,
          tokensInput: 100,
          tokensOutput: 50,
          stopReason: resp.stopReason,
          durationMs: 100,
          toolCalls: resp.toolCalls,
          rawContentBlocks: resp.rawContentBlocks ??
            [{ type: 'text' as const, text: resp.content, citations: null }],
        };
      },
    },
  };
}

const CONDUCTOR_ENV_KEYS = [
  'CONDUCTOR_MAX_INPUT_TOKENS',
  'CONDUCTOR_CONTEXT_WINDOW',
  'CONDUCTOR_BUDGET_BACKOFF',
  'CONDUCTOR_BUDGET_RECOVERY',
  'CONDUCTOR_BUDGET_FLOOR',
  'CONDUCTOR_BUDGET_MAX_RETRIES',
];

beforeEach(() => {
  db = initDatabase({ path: ':memory:' });
  const seed = seedTestData(db);
  runId = seed.runId;
  agentInvocationId = seed.agentInvocationId;
});

afterEach(() => {
  closeDatabase(db);
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const key of CONDUCTOR_ENV_KEYS) {
    delete process.env[key];
  }
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

  describe('token budget guardrails', () => {
    it('below threshold — passes through unchanged', async () => {
      const provider = createMockProvider([
        { content: 'Hello!', stopReason: 'end_turn' },
      ]);
      const registry = createToolRegistry();
      const result = await runToolLoop({
        db,
        provider,
        systemPrompt: 'Short system prompt.',
        userPrompt: 'Short user prompt.',
        registry,
        policyRules: [],
        context: makeContext(),
        maxInputTokens: 100_000,
      });
      expect(result.content).toBe('Hello!');
      expect(result.iterations).toBe(1);
    });

    it('adaptive compaction applied mid-loop', async () => {
      const bigResult = 'x'.repeat(2000);
      const echoTool: ToolDefinition = {
        name: 'echo',
        description: 'Echoes input back',
        inputSchema: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'] },
        execute: async (input) => ({ content: `Echo: ${bigResult}${input['message'] as string}`, meta: {} }),
      };

      // 5 tool iterations then end_turn
      const responses: MockResponse[] = [];
      for (let i = 0; i < 5; i++) {
        responses.push({
          content: '',
          stopReason: 'tool_use',
          toolCalls: [{ id: `tc_${i}`, name: 'echo', input: { message: `msg_${i}` } }],
          rawContentBlocks: [
            { type: 'tool_use' as const, id: `tc_${i}`, name: 'echo', input: { message: `msg_${i}` } },
          ],
        });
      }
      responses.push({ content: 'Done.', stopReason: 'end_turn' });

      const { capturedMessages, provider } = createCapturingMockProvider(responses);
      const registry = createToolRegistry();
      registry.register(echoTool);

      const result = await runToolLoop({
        db,
        provider,
        systemPrompt: 'System.',
        userPrompt: 'User.',
        registry,
        policyRules: [],
        context: makeContext(),
        maxInputTokens: 3_000,
      });

      expect(result.content).toBe('Done.');
      expect(result.iterations).toBe(6);

      // Later invocations should have fewer messages due to compaction
      const lastCall = capturedMessages[capturedMessages.length - 1]!;
      const firstCall = capturedMessages[0]!;
      expect(lastCall.length).toBeLessThan(firstCall.length + 10); // compacted
      // First message (user prompt) preserved
      expect(lastCall[0]?.role).toBe('user');
      // Role alternation: user, assistant, user, ...
      for (let j = 0; j < lastCall.length; j++) {
        const expectedRole = j % 2 === 0 ? 'user' : 'assistant';
        expect(lastCall[j]?.role).toBe(expectedRole);
      }
    });

    it('compaction retries at lower keep when higher returns null', async () => {
      // 3 turn pairs total: initial user + 3*(assistant+user) = 7 messages
      const responses: MockResponse[] = [];
      for (let i = 0; i < 3; i++) {
        responses.push({
          content: '',
          stopReason: 'tool_use',
          toolCalls: [{ id: `tc_${i}`, name: 'echo', input: { message: 'x'.repeat(500) } }],
          rawContentBlocks: [
            { type: 'tool_use' as const, id: `tc_${i}`, name: 'echo', input: { message: 'x'.repeat(500) } },
          ],
        });
      }
      responses.push({ content: 'Done.', stopReason: 'end_turn' });

      const echoTool: ToolDefinition = {
        name: 'echo',
        description: 'Echoes input',
        inputSchema: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'] },
        execute: async () => ({ content: 'x'.repeat(500), meta: {} }),
      };

      const provider = createMockProvider(responses);
      const registry = createToolRegistry();
      registry.register(echoTool);

      // Budget tight enough to force compaction after a few iterations
      const result = await runToolLoop({
        db,
        provider,
        systemPrompt: 'S',
        userPrompt: 'U',
        registry,
        policyRules: [],
        context: makeContext(),
        maxInputTokens: 2_000,
      });

      expect(result.content).toBe('Done.');
    });

    it('no viable compaction → AgentBudgetExceededError', async () => {
      const provider = createMockProvider([
        { content: 'Should not reach', stopReason: 'end_turn' },
      ]);
      const registry = createToolRegistry();

      const err = await runToolLoop({
        db,
        provider,
        systemPrompt: 'x'.repeat(500),
        userPrompt: 'x'.repeat(500),
        registry,
        policyRules: [],
        context: makeContext(),
        maxInputTokens: 100,
      }).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(AgentBudgetExceededError);
      const budgetErr = err as AgentBudgetExceededError;
      expect(budgetErr.code).toBe('budget_exceeded');
      expect(budgetErr.estimatedTokens).toBeGreaterThan(budgetErr.tokenBudget);
    });

    it('compaction exhausted at floor → AgentBudgetExceededError', async () => {
      // Build up many turns with large tool results, then budget can't fit MIN_RECENT_TURNS
      const responses: MockResponse[] = [];
      for (let i = 0; i < 6; i++) {
        responses.push({
          content: '',
          stopReason: 'tool_use',
          toolCalls: [{ id: `tc_${i}`, name: 'echo', input: { message: 'x'.repeat(3000) } }],
          rawContentBlocks: [
            { type: 'tool_use' as const, id: `tc_${i}`, name: 'echo', input: { message: 'x'.repeat(3000) } },
          ],
        });
      }
      responses.push({ content: 'Done.', stopReason: 'end_turn' });

      const echoTool: ToolDefinition = {
        name: 'echo',
        description: 'Echoes',
        inputSchema: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'] },
        execute: async () => ({ content: 'x'.repeat(5000), meta: {} }),
      };

      const provider = createMockProvider(responses);
      const registry = createToolRegistry();
      registry.register(echoTool);

      const err = await runToolLoop({
        db,
        provider,
        systemPrompt: 'S',
        userPrompt: 'U',
        registry,
        policyRules: [],
        context: makeContext(),
        maxInputTokens: 1_500,
      }).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(AgentBudgetExceededError);
    });

    it('rate limit with fallback delay triggers inner retry and succeeds', async () => {
      vi.useFakeTimers();
      vi.spyOn(Math, 'random').mockReturnValue(0);

      let callCount = 0;
      const provider: AgentProvider = {
        async invoke(_input: AgentInput): Promise<AgentOutput> {
          callCount++;
          if (callCount === 1) {
            throw new AgentRateLimitError('rate limited');
          }
          return {
            content: 'Success after retry',
            tokensInput: 100,
            tokensOutput: 50,
            stopReason: 'end_turn',
            durationMs: 100,
            rawContentBlocks: [{ type: 'text' as const, text: 'Success after retry', citations: null }],
          };
        },
      };

      const registry = createToolRegistry();
      const resultPromise = runToolLoop({
        db,
        provider,
        systemPrompt: 'S',
        userPrompt: 'U',
        registry,
        policyRules: [],
        context: makeContext(),
        maxInputTokens: 100_000,
      });

      // Advance past the retry delay: 1000 * 2^0 + 0 (jitter) = 1000ms
      await vi.advanceTimersByTimeAsync(1000);

      const result = await resultPromise;
      expect(result.content).toBe('Success after retry');
      expect(result.iterations).toBe(1);
    });

    it('rate limit max retries exceeded → propagates AgentRateLimitError', async () => {
      vi.useFakeTimers();
      vi.spyOn(Math, 'random').mockReturnValue(0);

      const provider: AgentProvider = {
        async invoke(_input: AgentInput): Promise<AgentOutput> {
          throw new AgentRateLimitError('always rate limited');
        },
      };

      const registry = createToolRegistry();
      const errPromise = runToolLoop({
        db,
        provider,
        systemPrompt: 'S',
        userPrompt: 'U',
        registry,
        policyRules: [],
        context: makeContext(),
        maxInputTokens: 100_000,
      }).catch((e: unknown) => e);

      // Advance through 3 retry delays: 1000, 2000, 4000
      await vi.advanceTimersByTimeAsync(1000);
      await vi.advanceTimersByTimeAsync(2000);
      await vi.advanceTimersByTimeAsync(4000);

      const err = await errPromise;
      expect(err).toBeInstanceOf(AgentRateLimitError);
    });

    it('rate limit retry does not consume iteration slots', async () => {
      vi.useFakeTimers();
      vi.spyOn(Math, 'random').mockReturnValue(0);

      let callCount = 0;
      const provider: AgentProvider = {
        async invoke(_input: AgentInput): Promise<AgentOutput> {
          callCount++;
          // Rate limit on first call of first iteration
          if (callCount === 1) {
            throw new AgentRateLimitError('rate limited', 0);
          }
          // Call 2: iteration 1 success with tool_use
          if (callCount === 2) {
            return {
              content: '', tokensInput: 100, tokensOutput: 50,
              stopReason: 'tool_use', durationMs: 100,
              toolCalls: [{ id: 'tc_1', name: 'echo', input: { message: 'hi' } }],
              rawContentBlocks: [
                { type: 'tool_use' as const, id: 'tc_1', name: 'echo', input: { message: 'hi' } },
              ],
            };
          }
          // Call 3: iteration 2 end_turn
          return {
            content: 'Done.', tokensInput: 100, tokensOutput: 50,
            stopReason: 'end_turn', durationMs: 100,
            rawContentBlocks: [{ type: 'text' as const, text: 'Done.', citations: null }],
          };
        },
      };

      const registry = createToolRegistry();
      registry.register(makeEchoTool());

      const resultPromise = runToolLoop({
        db,
        provider,
        systemPrompt: 'S',
        userPrompt: 'U',
        registry,
        policyRules: [],
        context: makeContext(),
        maxInputTokens: 100_000,
      });

      await vi.advanceTimersByTimeAsync(0);

      const result = await resultPromise;
      // 2 iterations, not 3 — the rate limit retry didn't consume a slot
      expect(result.iterations).toBe(2);
    });

    it('cancellation during rate-limit retry sleep', async () => {
      vi.useFakeTimers();

      const provider: AgentProvider = {
        async invoke(_input: AgentInput): Promise<AgentOutput> {
          throw new AgentRateLimitError('rate limited', 60_000);
        },
      };

      const ac = new AbortController();
      const registry = createToolRegistry();

      const errPromise = runToolLoop({
        db,
        provider,
        systemPrompt: 'S',
        userPrompt: 'U',
        registry,
        policyRules: [],
        context: makeContext(),
        abortSignal: ac.signal,
        maxInputTokens: 100_000,
      }).catch((e: unknown) => e);

      // Abort after 10ms (before 60s sleep completes)
      await vi.advanceTimersByTimeAsync(10);
      ac.abort();
      await vi.advanceTimersByTimeAsync(60_000);

      const err = await errPromise;
      expect(err).toBeInstanceOf(AgentCancelledError);
    });

    it('env CONDUCTOR_MAX_INPUT_TOKENS overrides default', async () => {
      process.env['CONDUCTOR_MAX_INPUT_TOKENS'] = '500';

      const provider = createMockProvider([
        { content: 'Should not reach', stopReason: 'end_turn' },
      ]);
      const registry = createToolRegistry();

      // With 500 token budget, a large prompt should trigger budget exceeded
      const err = await runToolLoop({
        db,
        provider,
        systemPrompt: 'x'.repeat(2000),
        userPrompt: 'x'.repeat(2000),
        registry,
        policyRules: [],
        context: makeContext(),
      }).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(AgentBudgetExceededError);
    });

    it('env CONDUCTOR_CONTEXT_WINDOW sets window', async () => {
      process.env['CONDUCTOR_CONTEXT_WINDOW'] = '100000';

      // Budget = 100000 * 0.65 = 65000 — small prompt should pass
      const provider = createMockProvider([
        { content: 'OK', stopReason: 'end_turn' },
      ]);
      const registry = createToolRegistry();

      const result = await runToolLoop({
        db,
        provider,
        systemPrompt: 'S',
        userPrompt: 'U',
        registry,
        policyRules: [],
        context: makeContext(),
      });

      expect(result.content).toBe('OK');
    });

    it('invalid env values ignored with fallback', async () => {
      process.env['CONDUCTOR_CONTEXT_WINDOW'] = '-1';
      process.env['CONDUCTOR_BUDGET_BACKOFF'] = 'abc';
      process.env['CONDUCTOR_BUDGET_RECOVERY'] = '0';
      process.env['CONDUCTOR_BUDGET_FLOOR'] = '-5';
      process.env['CONDUCTOR_BUDGET_MAX_RETRIES'] = '-1';

      const provider = createMockProvider([
        { content: 'OK', stopReason: 'end_turn' },
      ]);
      const registry = createToolRegistry();

      // Should not throw — falls back to defaults
      const result = await runToolLoop({
        db,
        provider,
        systemPrompt: 'S',
        userPrompt: 'U',
        registry,
        policyRules: [],
        context: makeContext(),
      });

      expect(result.content).toBe('OK');
    });

    it('floor > contextCap is clamped (backoff never boosts budget)', async () => {
      vi.useFakeTimers();
      vi.spyOn(Math, 'random').mockReturnValue(0);
      process.env['CONDUCTOR_BUDGET_FLOOR'] = '999999';

      let callCount = 0;
      const provider: AgentProvider = {
        async invoke(_input: AgentInput): Promise<AgentOutput> {
          callCount++;
          if (callCount === 1) {
            throw new AgentRateLimitError('rate limited', 0);
          }
          return {
            content: 'OK', tokensInput: 100, tokensOutput: 50,
            stopReason: 'end_turn', durationMs: 100,
            rawContentBlocks: [{ type: 'text' as const, text: 'OK', citations: null }],
          };
        },
      };

      const registry = createToolRegistry();
      const resultPromise = runToolLoop({
        db,
        provider,
        systemPrompt: 'S',
        userPrompt: 'U',
        registry,
        policyRules: [],
        context: makeContext(),
        maxInputTokens: 500,
      });

      await vi.advanceTimersByTimeAsync(0);

      const result = await resultPromise;
      expect(result.content).toBe('OK');
      // Floor clamped to 500 (contextCap), so backoff = max(500, 500*0.8) = 500
    });

    it('invalid explicit maxInputTokens falls back to defaults', async () => {
      const provider = createMockProvider([
        { content: 'OK', stopReason: 'end_turn' },
      ]);
      const registry = createToolRegistry();

      // maxInputTokens: 0 — invalid, falls through to env/defaults
      const result1 = await runToolLoop({
        db,
        provider: createMockProvider([{ content: 'OK', stopReason: 'end_turn' }]),
        systemPrompt: 'S',
        userPrompt: 'U',
        registry,
        policyRules: [],
        context: makeContext(),
        maxInputTokens: 0,
      });
      expect(result1.content).toBe('OK');

      // maxInputTokens: -5 — invalid, falls through
      const result2 = await runToolLoop({
        db,
        provider,
        systemPrompt: 'S',
        userPrompt: 'U',
        registry,
        policyRules: [],
        context: makeContext(),
        maxInputTokens: -5,
      });
      expect(result2.content).toBe('OK');
    });

    it('retry near maxIterations preserves error cause', async () => {
      vi.useFakeTimers();
      vi.spyOn(Math, 'random').mockReturnValue(0);

      let callCount = 0;
      const echoTool: ToolDefinition = {
        name: 'echo',
        description: 'Echoes',
        inputSchema: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'] },
        execute: async (input) => ({ content: `Echo: ${input['message'] as string}`, meta: {} }),
      };

      const provider: AgentProvider = {
        async invoke(_input: AgentInput): Promise<AgentOutput> {
          callCount++;
          // Call 1: success with tool_use (iteration 1)
          if (callCount === 1) {
            return {
              content: '', tokensInput: 100, tokensOutput: 50,
              stopReason: 'tool_use', durationMs: 100,
              toolCalls: [{ id: 'tc_1', name: 'echo', input: { message: 'hi' } }],
              rawContentBlocks: [
                { type: 'tool_use' as const, id: 'tc_1', name: 'echo', input: { message: 'hi' } },
              ],
            };
          }
          // Call 2+: always rate limit (iteration 2 inner retry exhaustion)
          throw new AgentRateLimitError('rate limited', 0);
        },
      };

      const registry = createToolRegistry();
      registry.register(echoTool);

      const errPromise = runToolLoop({
        db,
        provider,
        systemPrompt: 'S',
        userPrompt: 'U',
        registry,
        policyRules: [],
        context: makeContext(),
        maxIterations: 2,
        maxInputTokens: 100_000,
      }).catch((e: unknown) => e);

      // Advance timers for retry delays
      for (let i = 0; i < 10; i++) {
        await vi.advanceTimersByTimeAsync(5000);
      }

      const err = await errPromise;
      expect(err).toBeInstanceOf(AgentRateLimitError);
    });

    it('small prompt + forced rate limits ends as AgentRateLimitError, not budget_exceeded', async () => {
      vi.useFakeTimers();
      vi.spyOn(Math, 'random').mockReturnValue(0);

      const provider: AgentProvider = {
        async invoke(_input: AgentInput): Promise<AgentOutput> {
          throw new AgentRateLimitError('always rate limited', 0);
        },
      };

      const registry = createToolRegistry();

      const errPromise = runToolLoop({
        db,
        provider,
        systemPrompt: 'S',
        userPrompt: 'U',
        registry,
        policyRules: [],
        context: makeContext(),
        maxInputTokens: 100_000,
      }).catch((e: unknown) => e);

      // Advance through retries
      for (let i = 0; i < 10; i++) {
        await vi.advanceTimersByTimeAsync(5000);
      }

      const err = await errPromise;
      expect(err).toBeInstanceOf(AgentRateLimitError);
      expect(err).not.toBeInstanceOf(AgentBudgetExceededError);
    });
  });
});
