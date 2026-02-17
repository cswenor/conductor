/**
 * Implementer Config Threading Tests
 *
 * Verifies that runImplementerWithTools passes stepConfig values
 * through to runToolLoop and executeAgent, and falls back to defaults.
 */

import { vi, describe, it, expect, beforeEach } from 'vitest';

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
    resolveImplementerBudgets: vi.fn().mockReturnValue(undefined),
  };
});

vi.mock('../provider.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../provider.ts')>();
  return {
    ...actual,
    executeAgent: vi.fn().mockResolvedValue({
      agentInvocationId: 'ai_test',
      content: '',
      tokensInput: 100,
      tokensOutput: 50,
      durationMs: 500,
    }),
  };
});

const { mockRunToolLoop } = vi.hoisted(() => {
  const mockRunToolLoop = vi.fn().mockResolvedValue({
    content: '',
    iterations: 0,
    totalTokensInput: 0,
    totalTokensOutput: 0,
    totalDurationMs: 0,
  });
  return { mockRunToolLoop };
});

vi.mock('../executor.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../executor.ts')>();
  return {
    ...actual,
    runToolLoop: mockRunToolLoop,
  };
});

vi.mock('../artifacts.ts', () => ({
  createArtifact: vi.fn().mockReturnValue({ artifactId: 'art_1' }),
}));

vi.mock('../invocations.ts', () => ({
  createAgentInvocation: vi.fn().mockReturnValue({ agentInvocationId: 'ai_test' }),
  markAgentRunning: vi.fn(),
  completeAgentInvocation: vi.fn(),
  failAgentInvocation: vi.fn(),
}));

vi.mock('../tool-invocations.ts', () => ({
  listToolInvocations: vi.fn().mockReturnValue([]),
}));

vi.mock('../../runs/index.ts', () => ({
  getRun: vi.fn().mockReturnValue({
    runId: 'r_1',
    taskId: 't_1',
    repoId: 'repo_1',
    projectId: 'proj_1',
    baseBranch: 'main',
    branch: '',
    phase: 'implementing',
    planRevisions: 0,
    testFixAttempts: 0,
    reviewRounds: 0,
  }),
  createRun: vi.fn(),
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
    list: vi.fn().mockReturnValue([]),
    toAnthropicTools: vi.fn().mockReturnValue([]),
  }),
}));

vi.mock('../tools/filesystem.ts', () => ({
  registerFilesystemTools: vi.fn(),
}));

vi.mock('../tools/test-runner.ts', () => ({
  registerTestRunnerTool: vi.fn(),
}));

vi.mock('../tools/policy.ts', () => ({
  DEFAULT_POLICY_RULES: [],
}));

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn().mockReturnValue(''),
}));

// ---- Imports (after mocks) ----

import type { Database } from 'better-sqlite3';
import type { AgentProvider } from '../provider.ts';
import { executeAgent } from '../provider.ts';
import { runImplementer, runImplementerWithTools } from './implementer.ts';

// ---- Tests ----

describe('runImplementerWithTools config threading', () => {
  let fakeDb: Database;
  let fakeProvider: AgentProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    fakeDb = {} as Database;
    fakeProvider = { invoke: vi.fn() } as unknown as AgentProvider;
  });

  it('uses stepConfig values when provided', async () => {
    await runImplementerWithTools(fakeDb, {
      runId: 'r_1',
      worktreePath: '/tmp/wt',
      provider: fakeProvider,
      stepConfig: {
        model: 'claude-opus-4-20250514',
        maxTokens: 4096,
        temperature: 0.5,
        budgets: { maxInputTokens: 50000, maxDurationMs: 120000 },
      },
    });

    expect(mockRunToolLoop).toHaveBeenCalledWith(
      expect.objectContaining({
        maxTokens: 4096,
        temperature: 0.5,
        maxInputTokens: 50000,
        totalTimeoutMs: 120000,
      }),
    );
  });

  it('falls back to defaults when stepConfig omitted', async () => {
    await runImplementerWithTools(fakeDb, {
      runId: 'r_1',
      worktreePath: '/tmp/wt',
      provider: fakeProvider,
    });

    expect(mockRunToolLoop).toHaveBeenCalledWith(
      expect.objectContaining({
        maxTokens: 8192,
        temperature: 0.2,
      }),
    );

    // No budget fields should be set
    const callArgs = mockRunToolLoop.mock.calls[0]?.[0];
    expect(callArgs.maxInputTokens).toBeUndefined();
    expect(callArgs.totalTimeoutMs).toBeUndefined();
  });

  it('passes budgets.maxInputTokens to maxInputTokens', async () => {
    await runImplementerWithTools(fakeDb, {
      runId: 'r_1',
      worktreePath: '/tmp/wt',
      provider: fakeProvider,
      stepConfig: {
        model: 'claude-sonnet-4-20250514',
        maxTokens: 8192,
        temperature: 0.2,
        budgets: { maxInputTokens: 100000 },
      },
    });

    expect(mockRunToolLoop).toHaveBeenCalledWith(
      expect.objectContaining({
        maxInputTokens: 100000,
      }),
    );
  });

  it('passes budgets.maxDurationMs to totalTimeoutMs', async () => {
    await runImplementerWithTools(fakeDb, {
      runId: 'r_1',
      worktreePath: '/tmp/wt',
      provider: fakeProvider,
      stepConfig: {
        model: 'claude-sonnet-4-20250514',
        maxTokens: 8192,
        temperature: 0.2,
        budgets: { maxDurationMs: 300000 },
      },
    });

    expect(mockRunToolLoop).toHaveBeenCalledWith(
      expect.objectContaining({
        totalTimeoutMs: 300000,
      }),
    );
  });
});

describe('runImplementer (legacy) config threading', () => {
  let fakeDb: Database;

  beforeEach(() => {
    vi.clearAllMocks();
    fakeDb = {} as Database;
  });

  it('uses stepConfig values when provided', async () => {
    await runImplementer(fakeDb, {
      runId: 'r_1',
      worktreePath: '/tmp/wt',
      stepConfig: {
        model: 'claude-opus-4-20250514',
        maxTokens: 32768,
        temperature: 0.4,
        budgets: { maxDurationMs: 600000 },
      },
    });

    expect(executeAgent).toHaveBeenCalledWith(
      fakeDb,
      expect.objectContaining({
        maxTokens: 32768,
        temperature: 0.4,
        model: 'claude-opus-4-20250514',
        timeoutMs: 600000,
      }),
    );
  });

  it('falls back to legacy defaults when stepConfig omitted', async () => {
    await runImplementer(fakeDb, {
      runId: 'r_1',
      worktreePath: '/tmp/wt',
    });

    expect(executeAgent).toHaveBeenCalledWith(
      fakeDb,
      expect.objectContaining({
        maxTokens: 16384,
        temperature: 0.2,
        model: undefined,
        timeoutMs: undefined,
      }),
    );
  });
});
