/**
 * Reviewer Config Threading Tests
 *
 * Verifies that runPlanReviewer and runCodeReviewer pass stepConfig values
 * through to executeAgent, and fall back to hardcoded defaults when omitted.
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
      content: 'APPROVED\n\nLooks good.',
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
    reviewRounds: 0,
  }),
}));

vi.mock('../../cancellation/index.ts', () => ({
  getAbortSignal: vi.fn().mockReturnValue(undefined),
}));

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn().mockReturnValue(''),
}));

// ---- Imports (after mocks) ----

import type { Database } from 'better-sqlite3';
import { executeAgent } from '../provider.ts';
import { runPlanReviewer, runCodeReviewer } from './reviewer.ts';

// ---- Tests ----

describe('runPlanReviewer config threading', () => {
  let fakeDb: Database;

  beforeEach(() => {
    vi.clearAllMocks();
    fakeDb = {
      prepare: vi.fn().mockReturnValue({ run: vi.fn() }),
    } as unknown as Database;
  });

  it('uses stepConfig values when provided', async () => {
    await runPlanReviewer(fakeDb, {
      runId: 'r_1',
      worktreePath: '/tmp/wt',
      stepConfig: {
        model: 'claude-opus-4-20250514',
        maxTokens: 2048,
        temperature: 0.1,
        budgets: { maxDurationMs: 45000 },
      },
    });

    expect(executeAgent).toHaveBeenCalledWith(
      fakeDb,
      expect.objectContaining({
        maxTokens: 2048,
        temperature: 0.1,
        model: 'claude-opus-4-20250514',
        timeoutMs: 45000,
      }),
    );
  });

  it('falls back to hardcoded defaults when stepConfig omitted', async () => {
    await runPlanReviewer(fakeDb, { runId: 'r_1', worktreePath: '/tmp/wt' });

    expect(executeAgent).toHaveBeenCalledWith(
      fakeDb,
      expect.objectContaining({
        maxTokens: 4096,
        temperature: 0.2,
        model: undefined,
        timeoutMs: undefined,
      }),
    );
  });
});

describe('runCodeReviewer config threading', () => {
  let fakeDb: Database;

  beforeEach(() => {
    vi.clearAllMocks();
    fakeDb = {
      prepare: vi.fn().mockReturnValue({ run: vi.fn() }),
    } as unknown as Database;
  });

  it('uses stepConfig values when provided', async () => {
    await runCodeReviewer(fakeDb, {
      runId: 'r_1',
      worktreePath: '/tmp/wt',
      stepConfig: {
        model: 'claude-opus-4-20250514',
        maxTokens: 8192,
        temperature: 0.4,
        budgets: { maxDurationMs: 90000 },
      },
    });

    expect(executeAgent).toHaveBeenCalledWith(
      fakeDb,
      expect.objectContaining({
        maxTokens: 8192,
        temperature: 0.4,
        model: 'claude-opus-4-20250514',
        timeoutMs: 90000,
      }),
    );
  });

  it('falls back to hardcoded defaults when stepConfig omitted', async () => {
    await runCodeReviewer(fakeDb, { runId: 'r_1', worktreePath: '/tmp/wt' });

    expect(executeAgent).toHaveBeenCalledWith(
      fakeDb,
      expect.objectContaining({
        maxTokens: 4096,
        temperature: 0.2,
        model: undefined,
        timeoutMs: undefined,
      }),
    );
  });
});
