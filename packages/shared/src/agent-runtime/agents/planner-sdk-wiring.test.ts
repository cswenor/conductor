/**
 * Planner SDK Wiring Tests
 *
 * Verify that runPlannerWithAgentSDK correctly wires tool profiles,
 * extracts results, and handles errors.
 */

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

// ---- Mocks (must be before module imports) ----

vi.mock('../context.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../context.ts')>();
  return {
    ...actual,
    assembleContext: vi.fn().mockReturnValue({
      issue: { number: 1, title: '', body: '', type: 'issue', state: 'open', labels: [] },
      repository: { fullName: 'o/r', defaultBranch: 'main' },
      run: { runId: 'r_1', baseBranch: 'main', branch: '', planRevisions: 0, testFixAttempts: 0, reviewRounds: 0 },
    }),
    formatContextForPrompt: vi.fn().mockReturnValue('mocked-prompt'),
  };
});

const mockSdkQuery = vi.fn();
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (...args: unknown[]) => mockSdkQuery(...args),
}));

vi.mock('../../runs/index.ts', () => ({
  getRun: vi.fn().mockReturnValue({
    runId: 'r_1',
    taskId: 't_1',
    repoId: 'repo_1',
    projectId: 'proj_1',
    baseBranch: 'main',
    branch: '',
    phase: 'planning',
    planRevisions: 0,
    testFixAttempts: 0,
    reviewRounds: 0,
    implementerBackend: 'raw',
  }),
}));

vi.mock('../invocations.ts', () => ({
  createAgentInvocation: vi.fn().mockReturnValue({ agentInvocationId: 'ai_test' }),
  markAgentRunning: vi.fn(),
  completeAgentInvocation: vi.fn(),
  failAgentInvocation: vi.fn(),
}));

vi.mock('../artifacts.ts', () => ({
  createArtifact: vi.fn().mockReturnValue({ artifactId: 'art_1' }),
}));

vi.mock('../agent-messages.ts', () => ({
  createAgentMessage: vi.fn(),
}));

vi.mock('../../cancellation/index.ts', () => ({
  getAbortSignal: vi.fn().mockReturnValue(undefined),
}));

vi.mock('../../pubsub/index.ts', () => ({
  publishAgentInvocationEvent: vi.fn(),
}));

vi.mock('../tools/registry.ts', () => ({
  createToolRegistry: vi.fn().mockReturnValue({
    register: vi.fn(),
    get: vi.fn(),
    has: vi.fn().mockReturnValue(false),
    names: vi.fn().mockReturnValue([]),
  }),
}));

vi.mock('../tools/profiles.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../tools/profiles.ts')>();
  return {
    ...actual,
    registerToolsForProfile: vi.fn(),
  };
});

vi.mock('../tools/policy.ts', () => ({
  DEFAULT_POLICY_RULES: [],
}));

vi.mock('../policy-definitions.ts', () => ({
  ensureBuiltInPolicyDefinitions: vi.fn(),
}));

vi.mock('../tools/mcp-adapter.ts', () => ({
  createAgentMcpServer: vi.fn().mockReturnValue({}),
  getAllowedToolNames: vi.fn().mockReturnValue([]),
}));

vi.mock('../tools/protocol.ts', () => ({
  flushToolResults: vi.fn(),
}));

vi.mock('../provider.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../provider.ts')>();
  return { ...actual };
});

vi.mock('../retry-after.ts', () => ({
  extractRetryAfterMs: vi.fn().mockReturnValue(undefined),
}));

// ---- Imports (after mocks) ----

import { runPlannerWithAgentSDK } from './planner-sdk.ts';
import { AgentError } from '../provider.ts';

// ---- Helpers ----

function createFakeDb() {
  return {
    prepare: vi.fn().mockReturnValue({
      get: vi.fn().mockReturnValue(undefined),
      run: vi.fn(),
    }),
  } as unknown as import('better-sqlite3').Database;
}

function setupSuccessStream(planText = 'APPROVED\n\n### Approach\nDo the thing.') {
  mockSdkQuery.mockReturnValue(
    (async function* () {
      yield {
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: planText }],
          usage: { input_tokens: 100, output_tokens: 50 },
          stop_reason: 'end_turn',
        },
      };
      yield {
        type: 'result',
        subtype: 'success',
        usage: { input_tokens: 100, output_tokens: 50 },
      };
    })()
  );
}

// =============================================================================
// Tests
// =============================================================================

describe('runPlannerWithAgentSDK', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('extracts plan from last assistant text', async () => {
    setupSuccessStream('### Approach\nBuild feature X.');
    const result = await runPlannerWithAgentSDK(createFakeDb(), {
      runId: 'r_1',
      worktreePath: '/tmp/test',
      apiKey: 'sk-test',
    });
    expect(result.plan).toBe('### Approach\nBuild feature X.');
    expect(result.artifactId).toBe('art_1');
    expect(result.agentInvocationId).toBe('ai_test');
  });

  it('throws AgentError with no_output when plan text is empty', async () => {
    mockSdkQuery.mockReturnValue(
      (async function* () {
        yield {
          type: 'assistant',
          message: {
            content: [{ type: 'text', text: '' }],
            usage: { input_tokens: 10, output_tokens: 5 },
            stop_reason: 'end_turn',
          },
        };
        yield {
          type: 'result',
          subtype: 'success',
          usage: { input_tokens: 10, output_tokens: 5 },
        };
      })()
    );

    await expect(
      runPlannerWithAgentSDK(createFakeDb(), {
        runId: 'r_1',
        worktreePath: '/tmp/test',
        apiKey: 'sk-test',
      })
    ).rejects.toThrow(AgentError);

    try {
      await runPlannerWithAgentSDK(createFakeDb(), {
        runId: 'r_1',
        worktreePath: '/tmp/test',
        apiKey: 'sk-test',
      });
    } catch (e) {
      expect((e as AgentError).code).toBe('no_output');
    }
  });

  it('throws AgentError for invalid toolProfile', async () => {
    await expect(
      runPlannerWithAgentSDK(createFakeDb(), {
        runId: 'r_1',
        worktreePath: '/tmp/test',
        apiKey: 'sk-test',
        stepConfig: {
          model: 'claude-sonnet-4-20250514',
          maxTokens: 8192,
          temperature: 0.3,
          backend: 'agent_sdk',
          toolProfile: 'nonexistent',
          budgets: {},
        },
      })
    ).rejects.toThrow(AgentError);

    try {
      await runPlannerWithAgentSDK(createFakeDb(), {
        runId: 'r_1',
        worktreePath: '/tmp/test',
        apiKey: 'sk-test',
        stepConfig: {
          model: 'claude-sonnet-4-20250514',
          maxTokens: 8192,
          temperature: 0.3,
          backend: 'agent_sdk',
          toolProfile: 'nonexistent',
          budgets: {},
        },
      });
    } catch (e) {
      expect((e as AgentError).code).toBe('invalid_tool_profile');
    }
  });

  it('throws AgentError when full profile is used (planner is non-mutating)', async () => {
    await expect(
      runPlannerWithAgentSDK(createFakeDb(), {
        runId: 'r_1',
        worktreePath: '/tmp/test',
        apiKey: 'sk-test',
        stepConfig: {
          model: 'claude-sonnet-4-20250514',
          maxTokens: 8192,
          temperature: 0.3,
          backend: 'agent_sdk',
          toolProfile: 'full',
          budgets: {},
        },
      })
    ).rejects.toThrow(AgentError);

    try {
      await runPlannerWithAgentSDK(createFakeDb(), {
        runId: 'r_1',
        worktreePath: '/tmp/test',
        apiKey: 'sk-test',
        stepConfig: {
          model: 'claude-sonnet-4-20250514',
          maxTokens: 8192,
          temperature: 0.3,
          backend: 'agent_sdk',
          toolProfile: 'full',
          budgets: {},
        },
      });
    } catch (e) {
      expect((e as AgentError).code).toBe('invalid_tool_profile');
    }
  });

  it('uses readonly profile when explicitly configured', async () => {
    setupSuccessStream('Plan text here');
    await runPlannerWithAgentSDK(createFakeDb(), {
      runId: 'r_1',
      worktreePath: '/tmp/test',
      apiKey: 'sk-test',
      stepConfig: {
        model: 'claude-sonnet-4-20250514',
        maxTokens: 8192,
        temperature: 0.3,
        backend: 'agent_sdk',
        toolProfile: 'readonly',
        budgets: {},
      },
    });
    // Should not throw — readonly is allowed for planner
  });

  it('passes model to SDK options', async () => {
    setupSuccessStream('Plan text');
    await runPlannerWithAgentSDK(createFakeDb(), {
      runId: 'r_1',
      worktreePath: '/tmp/test',
      apiKey: 'sk-test',
      stepConfig: {
        model: 'claude-opus-4-20250514',
        maxTokens: 8192,
        temperature: 0.3,
        backend: 'agent_sdk',
        budgets: {},
      },
    });

    expect(mockSdkQuery).toHaveBeenCalledTimes(1);
    const callArgs = mockSdkQuery.mock.calls[0] as unknown[];
    const opts = (callArgs[0] as { options: { model: string } }).options;
    expect(opts.model).toBe('claude-opus-4-20250514');
  });
});
