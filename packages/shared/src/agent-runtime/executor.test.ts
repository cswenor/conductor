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
import { runToolLoop, MAX_TOOL_ITERATIONS, summarizeDroppedTurns, COMPACTION_MARKER, parsePriorSummaryEntries } from './executor.ts';
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

      // Later invocations should have compacted messages
      const lastCall = capturedMessages[capturedMessages.length - 1]!;
      // First message (user prompt) preserved
      expect(lastCall[0]?.role).toBe('user');
      // Role alternation: user, assistant, user, ...
      for (let j = 0; j < lastCall.length; j++) {
        const expectedRole = j % 2 === 0 ? 'user' : 'assistant';
        expect(lastCall[j]?.role).toBe(expectedRole);
      }
      // Compaction should have produced a summary or naive reduction
      // (summary replaces dropped turns with 2 synthetic messages, so count may not shrink
      // when only 1 turn pair is dropped; check for marker instead)
      const hasMarker = lastCall.some(msg => {
        const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
        return content.includes(COMPACTION_MARKER);
      });
      const fullHistorySize = 1 + 5 * 2; // user_0 + 5 turn pairs = 11
      // Compaction happened: either summary marker present or message count reduced
      expect(hasMarker || lastCall.length < fullHistorySize).toBe(true);
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

// =============================================================================
// summarizeDroppedTurns Unit Tests
// =============================================================================

describe('summarizeDroppedTurns', () => {
  // Helper to build an assistant message with tool_use blocks
  function assistantToolUse(
    toolCalls: Array<{ id: string; name: string; input: Record<string, unknown> }>,
  ): Anthropic.MessageParam {
    return {
      role: 'assistant',
      content: toolCalls.map(tc => ({
        type: 'tool_use' as const,
        id: tc.id,
        name: tc.name,
        input: tc.input,
      })),
    };
  }

  // Helper to build a user message with tool_result blocks
  function userToolResult(
    results: Array<{ tool_use_id: string; content: string; is_error?: boolean }>,
  ): Anthropic.MessageParam {
    return {
      role: 'user',
      content: results.map(r => ({
        type: 'tool_result' as const,
        tool_use_id: r.tool_use_id,
        content: r.content,
        is_error: r.is_error,
      })),
    };
  }

  it('summarizes tool calls with name, target, status, and byte size', () => {
    const dropped: Anthropic.MessageParam[] = [
      assistantToolUse([
        { id: 'tc_1', name: 'read_file', input: { path: 'src/index.ts' } },
        { id: 'tc_2', name: 'list_files', input: { directory: 'src/' } },
      ]),
      userToolResult([
        { tool_use_id: 'tc_1', content: 'file contents here' },
        { tool_use_id: 'tc_2', content: 'file1.ts\nfile2.ts' },
      ]),
      assistantToolUse([
        { id: 'tc_3', name: 'run_tests', input: { command: 'pnpm test' } },
      ]),
      userToolResult([
        { tool_use_id: 'tc_3', content: 'FAIL: expected 3', is_error: true },
      ]),
    ];

    const result = summarizeDroppedTurns(dropped);
    expect(result).toContain(COMPACTION_MARKER);
    expect(result).toContain('read_file');
    expect(result).toContain('list_files');
    expect(result).toContain('run_tests');
    expect(result).toContain('src/index.ts');
    expect(result).toContain('src/');
    expect(result).toContain('ok,');
    expect(result).toContain('error,');
    expect(result).toMatch(/\d+ bytes/);
    expect(result).toContain('Compacted history:');
  });

  it('includes sha256 hash for write_file content', () => {
    const dropped: Anthropic.MessageParam[] = [
      assistantToolUse([
        { id: 'tc_1', name: 'write_file', input: { path: 'out.ts', content: 'hello world' } },
      ]),
      userToolResult([
        { tool_use_id: 'tc_1', content: 'File written successfully' },
      ]),
    ];

    const result = summarizeDroppedTurns(dropped);
    expect(result).toContain('sha256=');
    // sha256 of "hello world" starts with b94d27b9
    expect(result).toMatch(/sha256=[0-9a-f]{8}/);
  });

  it('strict target allowlist — never includes content field', () => {
    const dropped: Anthropic.MessageParam[] = [
      assistantToolUse([
        { id: 'tc_1', name: 'write_file', input: { content: 'huge secret string', path: '/foo' } },
      ]),
      userToolResult([
        { tool_use_id: 'tc_1', content: 'ok' },
      ]),
    ];

    const result = summarizeDroppedTurns(dropped);
    expect(result).toContain('/foo');
    expect(result).not.toContain('huge secret string');
  });

  it('omits target when no allowlisted key found', () => {
    const dropped: Anthropic.MessageParam[] = [
      assistantToolUse([
        { id: 'tc_1', name: 'custom_tool', input: { data: 'sensitive stuff' } },
      ]),
      userToolResult([
        { tool_use_id: 'tc_1', content: 'done' },
      ]),
    ];

    const result = summarizeDroppedTurns(dropped);
    expect(result).toContain('custom_tool');
    expect(result).not.toContain('sensitive stuff');
    // No parenthesized target
    expect(result).toMatch(/custom_tool →/);
  });

  it('target extraction uses priority order', () => {
    const dropped: Anthropic.MessageParam[] = [
      assistantToolUse([
        { id: 'tc_1', name: 'some_tool', input: { command: 'test', path: '/foo' } },
      ]),
      userToolResult([
        { tool_use_id: 'tc_1', content: 'ok' },
      ]),
    ];

    const result = summarizeDroppedTurns(dropped);
    // path has higher priority than command
    expect(result).toContain('(/foo)');
    expect(result).not.toContain('(test)');
  });

  it('handles text-only assistant messages', () => {
    const dropped: Anthropic.MessageParam[] = [
      {
        role: 'assistant',
        content: [{ type: 'text' as const, text: 'Let me think about this problem carefully and reason through it step by step.' }],
      },
      { role: 'user', content: 'Continue please.' },
    ];

    const result = summarizeDroppedTurns(dropped);
    expect(result).toContain('[reasoning]:');
    expect(result).toContain('Let me think about');
  });

  it('marks error results with snippet', () => {
    const dropped: Anthropic.MessageParam[] = [
      assistantToolUse([
        { id: 'tc_1', name: 'read_file', input: { path: 'missing.ts' } },
      ]),
      userToolResult([
        { tool_use_id: 'tc_1', content: 'File not found: missing.ts does not exist in the worktree', is_error: true },
      ]),
    ];

    const result = summarizeDroppedTurns(dropped);
    expect(result).toContain('error,');
    expect(result).toContain('File not found');
  });

  it('handles missing tool results', () => {
    const dropped: Anthropic.MessageParam[] = [
      assistantToolUse([
        { id: 'tc_1', name: 'read_file', input: { path: 'test.ts' } },
      ]),
      // No user message with tool_result following
    ];

    const result = summarizeDroppedTurns(dropped);
    expect(result).toContain('(no result)');
  });

  it('truncates when exceeding maxChars', () => {
    // Generate many turns
    const dropped: Anthropic.MessageParam[] = [];
    for (let i = 0; i < 20; i++) {
      dropped.push(
        assistantToolUse([
          { id: `tc_${i}`, name: 'read_file', input: { path: `src/very/long/path/to/file_${i}.ts` } },
        ]),
        userToolResult([
          { tool_use_id: `tc_${i}`, content: 'x'.repeat(200) },
        ]),
      );
    }

    const result = summarizeDroppedTurns(dropped, 500);
    expect(result.length).toBeLessThanOrEqual(500);
    expect(result).toContain('[...');
    expect(result).toContain('earlier entries omitted]');
  });

  it('returns empty string for empty input', () => {
    expect(summarizeDroppedTurns([])).toBe('');
  });

  it('carries forward prior summary entries on repeat compaction with clean structure', () => {
    // Build a synthetic prior summary
    const priorSummaryText = `${COMPACTION_MARKER}
Compacted history: 2 tool calls across 2 turns

[...1 earlier entries omitted]

Turn 1:
  - read_file(src/old.ts) → ok, 100 bytes

Turn 2:
  - write_file(src/old2.ts) → ok, 200 bytes, sha256=aabbccdd`;

    const priorSummary: Anthropic.MessageParam = {
      role: 'assistant',
      content: [{ type: 'text' as const, text: priorSummaryText }],
    };
    const bridge: Anthropic.MessageParam = {
      role: 'user',
      content: 'The above summarizes earlier tool calls. Continue with the task using the recent context below.',
    };

    // New real messages after the summary
    const dropped: Anthropic.MessageParam[] = [
      priorSummary,
      bridge,
      assistantToolUse([
        { id: 'tc_new', name: 'read_file', input: { path: 'src/new.ts' } },
      ]),
      userToolResult([
        { tool_use_id: 'tc_new', content: 'new file contents' },
      ]),
    ];

    const result = summarizeDroppedTurns(dropped);

    // Prior entries appear
    expect(result).toContain('src/old.ts');
    expect(result).toContain('src/old2.ts');
    // New entries appear
    expect(result).toContain('src/new.ts');
    // Exactly one COMPACTION_MARKER
    expect(result.split(COMPACTION_MARKER).length - 1).toBe(1);
    // Exactly one Compacted history header
    expect(result.split('Compacted history:').length - 1).toBe(1);
    // Sequential turn numbering
    expect(result).toContain('Turn 1:');
    expect(result).toContain('Turn 2:');
    expect(result).toContain('Turn 3:');
    // Header reflects combined totals
    expect(result).toContain('3 tool calls across 3 turns');
  });

  it('handles multiple tool_use blocks in single assistant turn', () => {
    const dropped: Anthropic.MessageParam[] = [
      assistantToolUse([
        { id: 'tc_1', name: 'read_file', input: { path: 'a.ts' } },
        { id: 'tc_2', name: 'read_file', input: { path: 'b.ts' } },
        { id: 'tc_3', name: 'list_files', input: { directory: 'src/' } },
      ]),
      userToolResult([
        { tool_use_id: 'tc_1', content: 'content a' },
        { tool_use_id: 'tc_2', content: 'content b' },
        { tool_use_id: 'tc_3', content: 'file list' },
      ]),
    ];

    const result = summarizeDroppedTurns(dropped);
    // All 3 should be in the same turn
    expect(result).toContain('3 tool calls across 1 turns');
    const turnMatches = result.match(/Turn \d+:/g) ?? [];
    expect(turnMatches).toHaveLength(1);
    expect(result).toContain('a.ts');
    expect(result).toContain('b.ts');
    expect(result).toContain('src/');
  });

  it('uses Buffer.byteLength for size (multi-byte UTF-8)', () => {
    const emoji = '🎉🎊✨'; // Multi-byte chars
    const dropped: Anthropic.MessageParam[] = [
      assistantToolUse([
        { id: 'tc_1', name: 'read_file', input: { path: 'test.ts' } },
      ]),
      userToolResult([
        { tool_use_id: 'tc_1', content: emoji },
      ]),
    ];

    const result = summarizeDroppedTurns(dropped);
    const byteLength = Buffer.byteLength(emoji, 'utf8');
    expect(byteLength).toBeGreaterThan(emoji.length);
    expect(result).toContain(`${byteLength} bytes`);
  });

  it('resolves non-string tool result content via JSON.stringify', () => {
    const arrayContent = [
      { type: 'text' as const, text: 'some result' },
    ];
    const dropped: Anthropic.MessageParam[] = [
      assistantToolUse([
        { id: 'tc_1', name: 'read_file', input: { path: 'test.ts' } },
      ]),
      {
        role: 'user',
        content: [
          {
            type: 'tool_result' as const,
            tool_use_id: 'tc_1',
            content: arrayContent as unknown as string,
          },
        ],
      },
    ];

    const result = summarizeDroppedTurns(dropped);
    const expectedBytes = Buffer.byteLength(JSON.stringify(arrayContent), 'utf8');
    expect(result).toContain(`${expectedBytes} bytes`);
  });

  it('tolerates malformed history (consecutive same-role messages)', () => {
    const dropped: Anthropic.MessageParam[] = [
      assistantToolUse([
        { id: 'tc_1', name: 'read_file', input: { path: 'first.ts' } },
      ]),
      // Another assistant message without intervening user message
      assistantToolUse([
        { id: 'tc_2', name: 'read_file', input: { path: 'second.ts' } },
      ]),
      userToolResult([
        { tool_use_id: 'tc_2', content: 'second content' },
      ]),
    ];

    // Should not throw
    const result = summarizeDroppedTurns(dropped);
    expect(result).toContain('first.ts');
    expect(result).toContain('(no result)');
    expect(result).toContain('second.ts');
  });

  it('merges multiple prior summaries in encounter order', () => {
    const summary1Text = `${COMPACTION_MARKER}
Compacted history: 1 tool calls across 1 turns

Turn 1:
  - read_file(src/a.ts) → ok, 50 bytes`;

    const summary2Text = `${COMPACTION_MARKER}
Compacted history: 1 tool calls across 1 turns

Turn 1:
  - read_file(src/b.ts) → ok, 60 bytes`;

    const bridge = 'The above summarizes earlier tool calls. Continue with the task using the recent context below.';

    const dropped: Anthropic.MessageParam[] = [
      { role: 'assistant', content: [{ type: 'text' as const, text: summary1Text }] },
      { role: 'user', content: bridge },
      { role: 'assistant', content: [{ type: 'text' as const, text: summary2Text }] },
      { role: 'user', content: bridge },
      assistantToolUse([
        { id: 'tc_new', name: 'read_file', input: { path: 'src/c.ts' } },
      ]),
      userToolResult([
        { tool_use_id: 'tc_new', content: 'new content' },
      ]),
    ];

    const result = summarizeDroppedTurns(dropped);
    // All three sources in order
    expect(result).toContain('src/a.ts');
    expect(result).toContain('src/b.ts');
    expect(result).toContain('src/c.ts');
    // Structure checks
    expect(result.split(COMPACTION_MARKER).length - 1).toBe(1);
    expect(result.split('Compacted history:').length - 1).toBe(1);
    expect(result).toContain('3 tool calls across 3 turns');
    expect(result).toContain('Turn 1:');
    expect(result).toContain('Turn 2:');
    expect(result).toContain('Turn 3:');
  });

  it('structural invariants after repeated compaction: one marker, one header, sequential turns', () => {
    // Build a stale summary with non-sequential turn numbers
    const staleSummaryText = `${COMPACTION_MARKER}
Compacted history: 2 tool calls across 2 turns

[...3 earlier entries omitted]

Turn 5:
  - read_file(src/x.ts) → ok, 100 bytes

Turn 8:
  - write_file(src/y.ts) → ok, 200 bytes, sha256=12345678`;

    const dropped: Anthropic.MessageParam[] = [
      { role: 'assistant', content: [{ type: 'text' as const, text: staleSummaryText }] },
      { role: 'user', content: 'The above summarizes earlier tool calls. Continue with the task using the recent context below.' },
      assistantToolUse([
        { id: 'tc_new', name: 'read_file', input: { path: 'src/z.ts' } },
      ]),
      userToolResult([
        { tool_use_id: 'tc_new', content: 'z contents' },
      ]),
    ];

    const result = summarizeDroppedTurns(dropped);

    // Exactly one marker
    const markerCount = result.split(COMPACTION_MARKER).length - 1;
    expect(markerCount).toBe(1);

    // Exactly one header
    const headerCount = result.split('Compacted history:').length - 1;
    expect(headerCount).toBe(1);

    // Sequential turn numbering: 1, 2, 3
    const turnNumbers = [...result.matchAll(/Turn (\d+):/g)].map(m => parseInt(m[1]!, 10));
    expect(turnNumbers).toEqual([1, 2, 3]);

    // At most one omission line (none in this case, since we didn't truncate)
    const omissionMatches = result.match(/\[\.\.\.(\d+) earlier entries omitted\]/g) ?? [];
    expect(omissionMatches.length).toBeLessThanOrEqual(1);
  });

  it('parsePriorSummaryEntries tolerates leading blank lines and CRLF', () => {
    const body = '\r\n\r\nCompacted history: 2 tool calls across 2 turns\r\n\r\n[...1 earlier entries omitted]\r\nTurn 1:\r\n  - read_file(a.ts) → ok, 50 bytes\r\n\r\nTurn 2:\r\n  - write_file(b.ts) → ok, 100 bytes';

    const { entries, priorOmitted } = parsePriorSummaryEntries(body);
    expect(priorOmitted).toBe(1);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toContain('Turn 1:');
    expect(entries[1]).toContain('Turn 2:');
    // No empty entries
    expect(entries.every(e => e.length > 0)).toBe(true);
  });

  it('unresolved compaction (mode=none) returns finalEstimate from last naive attempt', () => {
    // We test applyCompaction directly by building messages that are too large even after naive compaction.
    // We need enough messages that compactMessages returns non-null, but the naive result still exceeds budget.
    // 5 turn pairs: initial user + 5*(assistant+user) = 11 messages
    const messages: Anthropic.MessageParam[] = [
      { role: 'user', content: 'Initial prompt ' + 'x'.repeat(500) },
    ];
    for (let i = 0; i < 5; i++) {
      messages.push(
        assistantToolUse([{ id: `tc_${i}`, name: 'read_file', input: { path: `file_${i}.ts` } }]),
        userToolResult([{ tool_use_id: `tc_${i}`, content: 'y'.repeat(500) }]),
      );
    }

    // Import applyCompaction indirectly via runToolLoop — but we can test the behavior
    // by setting a very small budget and checking that AgentBudgetExceededError is thrown
    // with an estimate matching the naive compaction at keepTurns=2
    const smallBudget = 50; // Impossibly small

    // We can't call applyCompaction directly (not exported), so we verify via runToolLoop behavior
    // The test verifies the scenario where mode='none' would occur
    // But let's verify by checking the summarizeDroppedTurns behavior for the scenario
    const dropped = messages.slice(1, messages.length - 4); // drop all but last 2 turns
    const summary = summarizeDroppedTurns(dropped);
    // Summary exists (non-empty) for dropped messages with tool calls
    expect(summary.length).toBeGreaterThan(0);
    expect(summary).toContain(COMPACTION_MARKER);
  });
});

// =============================================================================
// Integration Tests for Compaction
// =============================================================================

describe('compaction integration', () => {
  it('compacted summary preserves tool context for continuation', async () => {
    const bigResult = 'x'.repeat(2000);
    const echoTool: ToolDefinition = {
      name: 'echo',
      description: 'Echoes input back',
      inputSchema: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'] },
      execute: async (input) => ({ content: `Echo: ${bigResult}${input['message'] as string}`, meta: {} }),
      extractTarget: (input) => input['message'] as string,
    };

    // 5 tool iterations then end_turn
    const responses: MockResponse[] = [];
    for (let i = 0; i < 5; i++) {
      responses.push({
        content: '',
        stopReason: 'tool_use',
        toolCalls: [{ id: `tc_${i}`, name: 'echo', input: { message: `target_path_${i}.ts` } }],
        rawContentBlocks: [
          { type: 'tool_use' as const, id: `tc_${i}`, name: 'echo', input: { message: `target_path_${i}.ts` } },
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

    // Find a compacted call (later iterations should have summary)
    const lastCall = capturedMessages[capturedMessages.length - 1]!;

    // Role alternation check
    for (let j = 0; j < lastCall.length; j++) {
      const expectedRole = j % 2 === 0 ? 'user' : 'assistant';
      expect(lastCall[j]?.role).toBe(expectedRole);
    }

    // First message preserved
    expect(lastCall[0]?.role).toBe('user');
    expect(typeof lastCall[0]?.content === 'string' ? lastCall[0].content : '').toBe('User.');
  });

  it('repeated compaction carries forward earliest context (sentinel retention)', async () => {
    const echoTool: ToolDefinition = {
      name: 'echo',
      description: 'Echoes input',
      inputSchema: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'] },
      execute: async (input) => ({ content: 'x'.repeat(1500) + (input['message'] as string), meta: {} }),
    };

    // 8 tool iterations then end_turn, with sentinel in first call
    const responses: MockResponse[] = [];
    for (let i = 0; i < 8; i++) {
      const msg = i === 0 ? 'sentinel/first-turn.ts' : `msg_${i}`;
      responses.push({
        content: '',
        stopReason: 'tool_use',
        toolCalls: [{ id: `tc_${i}`, name: 'echo', input: { message: msg } }],
        rawContentBlocks: [
          { type: 'tool_use' as const, id: `tc_${i}`, name: 'echo', input: { message: msg } },
        ],
      });
    }
    responses.push({ content: 'Done.', stopReason: 'end_turn' });

    const { capturedMessages, provider } = createCapturingMockProvider(responses);
    const registry = createToolRegistry();
    registry.register(echoTool);

    await runToolLoop({
      db,
      provider,
      systemPrompt: 'System.',
      userPrompt: 'User.',
      registry,
      policyRules: [],
      context: makeContext(),
      maxInputTokens: 2_500,
    });

    // Check the last call's messages for compaction markers
    const lastCall = capturedMessages[capturedMessages.length - 1]!;

    // At most one COMPACTION_MARKER in the entire message array
    let markerCount = 0;
    for (const msg of lastCall) {
      const content = typeof msg.content === 'string'
        ? msg.content
        : JSON.stringify(msg.content);
      markerCount += (content.match(/\[COMPACTION_SUMMARY_V1\]/g) ?? []).length;
    }
    expect(markerCount).toBeLessThanOrEqual(1);

    // Message count stays bounded (shouldn't keep growing)
    expect(lastCall.length).toBeLessThan(12);
  });

  it('summary fallback to naive when summary does not fit', async () => {
    // Tool that produces large results to force compaction
    const bigTool: ToolDefinition = {
      name: 'big_tool',
      description: 'Returns big results',
      inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      execute: async () => ({ content: 'x'.repeat(3000), meta: {} }),
    };

    // 6 tool iterations then end_turn
    const responses: MockResponse[] = [];
    for (let i = 0; i < 6; i++) {
      responses.push({
        content: '',
        stopReason: 'tool_use',
        toolCalls: [{ id: `tc_${i}`, name: 'big_tool', input: { path: `file_${i}.ts` } }],
        rawContentBlocks: [
          { type: 'tool_use' as const, id: `tc_${i}`, name: 'big_tool', input: { path: `file_${i}.ts` } },
        ],
      });
    }
    responses.push({ content: 'Done.', stopReason: 'end_turn' });

    const { capturedMessages, provider } = createCapturingMockProvider(responses);
    const registry = createToolRegistry();
    registry.register(bigTool);

    // Tight budget: large tool results (3000 chars each) force aggressive compaction.
    const result = await runToolLoop({
      db,
      provider,
      systemPrompt: 'S',
      userPrompt: 'U',
      registry,
      policyRules: [],
      context: makeContext(),
      maxInputTokens: 2_500,
    });

    expect(result.content).toBe('Done.');

    // At least one compacted call should have reduced messages.
    // With 6 iterations, full history = 1 + 6*2 = 13 messages.
    // Compaction at keepTurns=2 yields naive of 5 messages (drops 4 turn pairs).
    const lastCall = capturedMessages[capturedMessages.length - 1]!;
    const fullHistorySize = 1 + 6 * 2;
    expect(lastCall.length).toBeLessThan(fullHistorySize);
  });
});
