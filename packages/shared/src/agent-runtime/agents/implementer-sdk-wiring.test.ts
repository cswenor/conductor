/**
 * Wiring tests: verify that runImplementerWithAgentSDK passes budgets
 * to formatContextForPrompt.
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

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn().mockReturnValue(
    (async function* () {
      yield {
        type: 'result',
        subtype: 'success',
        usage: { input_tokens: 0, output_tokens: 0 },
      };
    })()
  ),
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
    implementerBackend: 'agent-sdk',
  }),
  createRun: vi.fn(),
}));

vi.mock('../invocations.ts', () => ({
  createAgentInvocation: vi.fn().mockReturnValue({ agentInvocationId: 'ai_test' }),
  markAgentRunning: vi.fn(),
  completeAgentInvocation: vi.fn(),
  failAgentInvocation: vi.fn(),
}));

vi.mock('../artifacts.ts', () => ({
  createArtifact: vi.fn().mockReturnValue({ artifactId: 'art_1' }),
  getLatestArtifact: vi.fn().mockReturnValue(null),
}));

vi.mock('../agent-messages.ts', () => ({
  createAgentMessage: vi.fn(),
}));

vi.mock('../tool-invocations.ts', () => ({
  listToolInvocations: vi.fn().mockReturnValue([]),
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

vi.mock('../policy-definitions.ts', () => ({
  ensureBuiltInPolicyDefinitions: vi.fn(),
}));

vi.mock('../tools/mcp-adapter.ts', () => ({
  createImplementerMcpServer: vi.fn().mockReturnValue({}),
  getAllowedToolNames: vi.fn().mockReturnValue([]),
}));

vi.mock('../tools/protocol.ts', () => ({
  flushToolResults: vi.fn(),
}));

vi.mock('../provider.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../provider.ts')>();
  return {
    ...actual,
  };
});

vi.mock('../retry-after.ts', () => ({
  extractRetryAfterMs: vi.fn().mockReturnValue(undefined),
}));

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn().mockReturnValue(''),
}));

// ---- Imports (after mocks) ----

import { formatContextForPrompt } from '../context.ts';
import { runImplementerWithAgentSDK } from './implementer-sdk.ts';

// ---- Env cleanup ----

const CTX_ENV_KEYS = [
  'CONDUCTOR_CTX_BUDGET_ISSUE', 'CONDUCTOR_CTX_BUDGET_PLAN',
  'CONDUCTOR_CTX_BUDGET_REVIEW', 'CONDUCTOR_CTX_BUDGET_FILE_TREE',
  'CONDUCTOR_CTX_BUDGET_FILE_TREE_ENTRIES',
];
function cleanCtxEnv() {
  for (const key of CTX_ENV_KEYS) delete process.env[key];
}

describe('implementer-sdk context wiring', () => {
  beforeEach(() => {
    cleanCtxEnv();
    vi.clearAllMocks();
  });
  afterEach(() => cleanCtxEnv());

  it('runImplementerWithAgentSDK passes budgets to formatContextForPrompt', async () => {
    const fakeDb = {
      prepare: vi.fn().mockReturnValue({ get: vi.fn().mockReturnValue(undefined) }),
    } as unknown as import('better-sqlite3').Database;

    await runImplementerWithAgentSDK(fakeDb, {
      runId: 'r_1',
      worktreePath: '/tmp/test',
      apiKey: 'sk-test',
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
});
