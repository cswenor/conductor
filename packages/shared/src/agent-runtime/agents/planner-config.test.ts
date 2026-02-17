/**
 * Planner Config Threading Tests
 *
 * Verifies that runPlanner passes stepConfig values (model, maxTokens,
 * temperature, budgets) through to executeAgent, and falls back to
 * hardcoded defaults when stepConfig is omitted.
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
  };
});

vi.mock('../provider.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../provider.ts')>();
  return {
    ...actual,
    executeAgent: vi.fn().mockResolvedValue({
      agentInvocationId: 'ai_test',
      content: '### Approach\nTest plan',
      tokensInput: 100,
      tokensOutput: 50,
      durationMs: 500,
    }),
  };
});

vi.mock('../artifacts.ts', () => ({
  createArtifact: vi.fn().mockReturnValue({ artifactId: 'art_1' }),
}));

vi.mock('../../runs/index.ts', () => ({
  getRun: vi.fn().mockReturnValue({
    runId: 'r_1',
    projectId: 'proj_1',
    phase: 'planning',
    planRevisions: 0,
  }),
}));

vi.mock('../../cancellation/index.ts', () => ({
  getAbortSignal: vi.fn().mockReturnValue(undefined),
}));

// ---- Imports (after mocks) ----

import type { Database } from 'better-sqlite3';
import { executeAgent } from '../provider.ts';
import { runPlanner } from './planner.ts';

// ---- Tests ----

describe('runPlanner config threading', () => {
  let fakeDb: Database;

  beforeEach(() => {
    vi.clearAllMocks();
    fakeDb = {
      prepare: vi.fn().mockReturnValue({ run: vi.fn() }),
    } as unknown as Database;
  });

  it('uses stepConfig values when provided', async () => {
    await runPlanner(fakeDb, {
      runId: 'r_1',
      worktreePath: '/tmp/wt',
      stepConfig: {
        model: 'claude-opus-4-20250514',
        maxTokens: 4096,
        temperature: 0.5,
        budgets: { maxDurationMs: 30000 },
      },
    });

    expect(executeAgent).toHaveBeenCalledWith(
      fakeDb,
      expect.objectContaining({
        maxTokens: 4096,
        temperature: 0.5,
        model: 'claude-opus-4-20250514',
        timeoutMs: 30000,
      }),
    );
  });

  it('falls back to hardcoded defaults when stepConfig omitted', async () => {
    await runPlanner(fakeDb, { runId: 'r_1', worktreePath: '/tmp/wt' });

    expect(executeAgent).toHaveBeenCalledWith(
      fakeDb,
      expect.objectContaining({
        maxTokens: 8192,
        temperature: 0.3,
        model: undefined,
        timeoutMs: undefined,
      }),
    );
  });

  it('passes budgets.maxDurationMs as timeoutMs', async () => {
    await runPlanner(fakeDb, {
      runId: 'r_1',
      worktreePath: '/tmp/wt',
      stepConfig: {
        model: 'claude-sonnet-4-20250514',
        maxTokens: 8192,
        temperature: 0.3,
        budgets: { maxDurationMs: 60000 },
      },
    });

    expect(executeAgent).toHaveBeenCalledWith(
      fakeDb,
      expect.objectContaining({
        timeoutMs: 60000,
      }),
    );
  });

  it('handles empty budgets gracefully', async () => {
    await runPlanner(fakeDb, {
      runId: 'r_1',
      worktreePath: '/tmp/wt',
      stepConfig: {
        model: 'claude-sonnet-4-20250514',
        maxTokens: 8192,
        temperature: 0.3,
        budgets: {},
      },
    });

    expect(executeAgent).toHaveBeenCalledWith(
      fakeDb,
      expect.objectContaining({
        timeoutMs: undefined,
      }),
    );
  });
});
