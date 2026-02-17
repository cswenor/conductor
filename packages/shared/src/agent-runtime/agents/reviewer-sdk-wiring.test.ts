/**
 * Reviewer SDK Wiring Tests
 *
 * Verify that runPlanReviewerWithAgentSDK and runCodeReviewerWithAgentSDK
 * correctly wire tool profiles, extract verdicts, and handle errors.
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

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn().mockReturnValue(''),
}));

// ---- Imports (after mocks) ----

import { runPlanReviewerWithAgentSDK, runCodeReviewerWithAgentSDK } from './reviewer-sdk.ts';
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

function setupSuccessStream(reviewText: string) {
  mockSdkQuery.mockReturnValue(
    (async function* () {
      yield {
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: reviewText }],
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
// Plan Reviewer Tests
// =============================================================================

describe('runPlanReviewerWithAgentSDK', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.clearAllMocks());

  it('extracts APPROVED verdict from review text', async () => {
    setupSuccessStream('APPROVED\n\n### Strengths\n- Good plan');
    const result = await runPlanReviewerWithAgentSDK(createFakeDb(), {
      runId: 'r_1',
      worktreePath: '/tmp/test',
      apiKey: 'sk-test',
    });
    expect(result.approved).toBe(true);
    expect(result.review).toContain('APPROVED');
    expect(result.artifactId).toBe('art_1');
  });

  it('extracts CHANGES_REQUESTED verdict from review text', async () => {
    setupSuccessStream('CHANGES_REQUESTED\n\n### Issues\n- Missing tests');
    const result = await runPlanReviewerWithAgentSDK(createFakeDb(), {
      runId: 'r_1',
      worktreePath: '/tmp/test',
      apiKey: 'sk-test',
    });
    expect(result.approved).toBe(false);
    expect(result.review).toContain('CHANGES_REQUESTED');
  });

  it('throws AgentError with no_output when review text is empty', async () => {
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
      runPlanReviewerWithAgentSDK(createFakeDb(), {
        runId: 'r_1',
        worktreePath: '/tmp/test',
        apiKey: 'sk-test',
      })
    ).rejects.toThrow(AgentError);
  });

  it('throws AgentError for full toolProfile (non-mutating step)', async () => {
    await expect(
      runPlanReviewerWithAgentSDK(createFakeDb(), {
        runId: 'r_1',
        worktreePath: '/tmp/test',
        apiKey: 'sk-test',
        stepConfig: {
          model: 'claude-sonnet-4-20250514',
          maxTokens: 4096,
          temperature: 0.2,
          backend: 'agent_sdk',
          toolProfile: 'full',
          budgets: {},
        },
      })
    ).rejects.toThrow(AgentError);
  });
});

// =============================================================================
// Code Reviewer Tests
// =============================================================================

describe('runCodeReviewerWithAgentSDK', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.clearAllMocks());

  it('extracts APPROVED verdict from code review', async () => {
    setupSuccessStream('APPROVED\n\n### Correctness\n- All good');
    const result = await runCodeReviewerWithAgentSDK(createFakeDb(), {
      runId: 'r_1',
      worktreePath: '/tmp/test',
      apiKey: 'sk-test',
    });
    expect(result.approved).toBe(true);
    expect(result.review).toContain('APPROVED');
  });

  it('extracts CHANGES_REQUESTED from code review', async () => {
    setupSuccessStream('CHANGES_REQUESTED\n\n### Issues\n- Missing error handling');
    const result = await runCodeReviewerWithAgentSDK(createFakeDb(), {
      runId: 'r_1',
      worktreePath: '/tmp/test',
      apiKey: 'sk-test',
    });
    expect(result.approved).toBe(false);
  });

  it('throws AgentError for invalid toolProfile', async () => {
    await expect(
      runCodeReviewerWithAgentSDK(createFakeDb(), {
        runId: 'r_1',
        worktreePath: '/tmp/test',
        apiKey: 'sk-test',
        stepConfig: {
          model: 'claude-sonnet-4-20250514',
          maxTokens: 4096,
          temperature: 0.2,
          backend: 'agent_sdk',
          toolProfile: 'invalid',
          budgets: {},
        },
      })
    ).rejects.toThrow(AgentError);
  });
});
