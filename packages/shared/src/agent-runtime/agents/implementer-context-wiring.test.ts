/**
 * Wiring tests: verify that runImplementerWithTools passes budgets
 * and runImplementer (legacy) does not.
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

vi.mock('../provider.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../provider.ts')>();
  return {
    ...actual,
    executeAgent: vi.fn().mockResolvedValue({ agentInvocationId: 'ai_test', content: '' }),
  };
});

vi.mock('../executor.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../executor.ts')>();
  return {
    ...actual,
    runToolLoop: vi.fn().mockResolvedValue({
      content: '',
      iterations: 0,
      totalTokensInput: 0,
      totalTokensOutput: 0,
      totalDurationMs: 0,
    }),
  };
});

vi.mock('../artifacts.ts', () => ({
  createArtifact: vi.fn().mockReturnValue({ artifactId: 'art_1' }),
  getLatestArtifact: vi.fn().mockReturnValue(null),
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
  createToolRegistry: vi.fn().mockReturnValue({ register: vi.fn(), get: vi.fn(), list: vi.fn().mockReturnValue([]) }),
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

import { formatContextForPrompt } from '../context.ts';
import { runImplementer, runImplementerWithTools } from './implementer.ts';

// ---- Env cleanup ----

const CTX_ENV_KEYS = [
  'CONDUCTOR_CTX_BUDGET_ISSUE', 'CONDUCTOR_CTX_BUDGET_PLAN',
  'CONDUCTOR_CTX_BUDGET_REVIEW', 'CONDUCTOR_CTX_BUDGET_FILE_TREE',
  'CONDUCTOR_CTX_BUDGET_FILE_TREE_ENTRIES',
];
function cleanCtxEnv() {
  for (const key of CTX_ENV_KEYS) delete process.env[key];
}

describe('implementer context wiring', () => {
  beforeEach(() => {
    cleanCtxEnv();
    vi.clearAllMocks();
  });
  afterEach(() => cleanCtxEnv());

  it('runImplementerWithTools passes budgets to formatContextForPrompt', async () => {
    const fakeDb = {} as import('better-sqlite3').Database;
    const fakeProvider = { chat: vi.fn() } as unknown as import('../provider.ts').AgentProvider;

    await runImplementerWithTools(fakeDb, {
      runId: 'r_1',
      worktreePath: '/tmp/test',
      provider: fakeProvider,
    });

    expect(formatContextForPrompt).toHaveBeenCalledTimes(1);
    const args = (formatContextForPrompt as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(args).toHaveLength(2);
    expect(args[1]).toEqual({
      issueBody: 5_000,
      plan: 10_000,
      review: 10_000,
      fileTree: 10_000,
      fileTreeEntries: 500,
    });
  });

  it('runImplementer does not pass budgets', async () => {
    const fakeDb = {} as import('better-sqlite3').Database;

    await runImplementer(fakeDb, {
      runId: 'r_1',
      worktreePath: '/tmp/test',
    });

    expect(formatContextForPrompt).toHaveBeenCalledTimes(1);
    const args = (formatContextForPrompt as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(args).toHaveLength(1);
  });
});
