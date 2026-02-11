import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Run, TransitionResult } from '@conductor/shared';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const {
  mockGetRunByPrNodeId,
  mockUpdateRunPrBundle,
  mockTransitionPhase,
  mockCleanupWorktree,
} = vi.hoisted(() => ({
  mockGetRunByPrNodeId: vi.fn(),
  mockUpdateRunPrBundle: vi.fn(),
  mockTransitionPhase: vi.fn(),
  mockCleanupWorktree: vi.fn(),
}));

vi.mock('@conductor/shared', () => ({
  getRunByPrNodeId: mockGetRunByPrNodeId,
  updateRunPrBundle: mockUpdateRunPrBundle,
  transitionPhase: mockTransitionPhase,
  cleanupWorktree: mockCleanupWorktree,
  getDatabase: vi.fn(),
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { handlePrMerged, handlePrStateChange } from './merge-handler.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const fakeDb = {} as ReturnType<typeof import('@conductor/shared').getDatabase>;

function makeRun(overrides: Partial<Run> = {}): Run {
  return {
    runId: 'run_1',
    taskId: 'task_1',
    projectId: 'proj_1',
    repoId: 'repo_1',
    runNumber: 1,
    phase: 'awaiting_review',
    step: 'wait_pr_merge',
    policySetId: 'ps_1',
    lastEventSequence: 0,
    nextSequence: 1,
    baseBranch: 'main',
    branch: 'conductor/run_1',
    prNumber: 42,
    prNodeId: 'PR_node1',
    prUrl: 'https://github.com/o/r/pull/42',
    prState: 'open',
    prSyncedAt: '2025-01-01T00:00:00.000Z',
    planRevisions: 0,
    testFixAttempts: 0,
    reviewRounds: 0,
    startedAt: '2025-01-01T00:00:00.000Z',
    updatedAt: '2025-01-01T00:00:00.000Z',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// handlePrMerged
// ---------------------------------------------------------------------------

describe('handlePrMerged', () => {
  const mockMirror = vi.fn();
  const mockScheduleCleanup = vi.fn<(runId: string) => Promise<void>>().mockResolvedValue(undefined);

  it('does nothing when no run found for prNodeId', async () => {
    mockGetRunByPrNodeId.mockReturnValue(null);

    await handlePrMerged(fakeDb, 'PR_unknown', mockMirror, mockScheduleCleanup);

    expect(mockUpdateRunPrBundle).not.toHaveBeenCalled();
    expect(mockTransitionPhase).not.toHaveBeenCalled();
    expect(mockCleanupWorktree).not.toHaveBeenCalled();
    expect(mockScheduleCleanup).not.toHaveBeenCalled();
  });

  it('transitions to blocked when PR bundle fields are missing', async () => {
    const run = makeRun({ prNumber: undefined, prNodeId: undefined, prUrl: undefined });
    mockGetRunByPrNodeId.mockReturnValue(run);

    await handlePrMerged(fakeDb, 'PR_node1', mockMirror, mockScheduleCleanup);

    expect(mockTransitionPhase).toHaveBeenCalledWith(fakeDb, expect.objectContaining({
      runId: 'run_1',
      toPhase: 'blocked',
      triggeredBy: 'webhook:pr.merged',
      blockedReason: 'PR bundle fields missing at merge time',
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      blockedContext: expect.objectContaining({
        prior_phase: 'awaiting_review',
        prior_step: 'wait_pr_merge',
      }),
    }));
    expect(mockUpdateRunPrBundle).not.toHaveBeenCalled();
    expect(mockScheduleCleanup).not.toHaveBeenCalled();
  });

  it('transitions to blocked when updateRunPrBundle returns false', async () => {
    const run = makeRun();
    mockGetRunByPrNodeId.mockReturnValue(run);
    mockUpdateRunPrBundle.mockReturnValue(false);

    await handlePrMerged(fakeDb, 'PR_node1', mockMirror, mockScheduleCleanup);

    expect(mockUpdateRunPrBundle).toHaveBeenCalledWith(fakeDb, expect.objectContaining({
      runId: 'run_1',
      prState: 'merged',
    }));
    expect(mockTransitionPhase).toHaveBeenCalledWith(fakeDb, expect.objectContaining({
      toPhase: 'blocked',
      blockedReason: 'Failed to update PR state to merged',
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      blockedContext: expect.objectContaining({
        prior_phase: 'awaiting_review',
        prior_step: 'wait_pr_merge',
      }),
    }));
    expect(mockScheduleCleanup).not.toHaveBeenCalled();
  });

  it('happy path: updates state, transitions to completed, schedules cleanup, mirrors, cleans up inline', async () => {
    const run = makeRun();
    mockGetRunByPrNodeId.mockReturnValue(run);
    mockUpdateRunPrBundle.mockReturnValue(true);
    mockTransitionPhase.mockReturnValue({ success: true, run, event: {} } as TransitionResult);

    await handlePrMerged(fakeDb, 'PR_node1', mockMirror, mockScheduleCleanup);

    // PR state updated to merged
    expect(mockUpdateRunPrBundle).toHaveBeenCalledWith(fakeDb, expect.objectContaining({
      runId: 'run_1',
      prNumber: 42,
      prNodeId: 'PR_node1',
      prUrl: 'https://github.com/o/r/pull/42',
      prState: 'merged',
    }));

    // Transitioned to completed/cleanup
    expect(mockTransitionPhase).toHaveBeenCalledWith(fakeDb, expect.objectContaining({
      runId: 'run_1',
      toPhase: 'completed',
      toStep: 'cleanup',
      triggeredBy: 'webhook:pr.merged',
      result: 'success',
      resultReason: 'PR merged',
    }));

    // Cleanup scheduled
    expect(mockScheduleCleanup).toHaveBeenCalledWith('run_1');

    // Mirror called
    expect(mockMirror).toHaveBeenCalledWith(
      expect.objectContaining({ runId: 'run_1', toPhase: 'completed' }),
      expect.objectContaining({ success: true }),
    );

    // Inline cleanup called
    expect(mockCleanupWorktree).toHaveBeenCalledWith(fakeDb, 'run_1');
  });

  it('does not cleanup when transitionPhase fails (optimistic lock)', async () => {
    const run = makeRun();
    mockGetRunByPrNodeId.mockReturnValue(run);
    mockUpdateRunPrBundle.mockReturnValue(true);
    mockTransitionPhase.mockReturnValue({ success: false, error: 'Stale' } as TransitionResult);

    await handlePrMerged(fakeDb, 'PR_node1', mockMirror, mockScheduleCleanup);

    expect(mockScheduleCleanup).not.toHaveBeenCalled();
    expect(mockMirror).not.toHaveBeenCalled();
    expect(mockCleanupWorktree).not.toHaveBeenCalled();
  });

  it('inline cleanup still runs when scheduleCleanup throws', async () => {
    const run = makeRun();
    mockGetRunByPrNodeId.mockReturnValue(run);
    mockUpdateRunPrBundle.mockReturnValue(true);
    mockTransitionPhase.mockReturnValue({ success: true, run, event: {} } as TransitionResult);
    mockScheduleCleanup.mockRejectedValue(new Error('Redis down'));

    await handlePrMerged(fakeDb, 'PR_node1', mockMirror, mockScheduleCleanup);

    // Inline cleanup still runs
    expect(mockCleanupWorktree).toHaveBeenCalledWith(fakeDb, 'run_1');
    // Mirror still called
    expect(mockMirror).toHaveBeenCalled();
  });

  it('does not propagate when cleanupWorktree throws', async () => {
    const run = makeRun();
    mockGetRunByPrNodeId.mockReturnValue(run);
    mockUpdateRunPrBundle.mockReturnValue(true);
    mockTransitionPhase.mockReturnValue({ success: true, run, event: {} } as TransitionResult);
    mockCleanupWorktree.mockImplementation(() => { throw new Error('rm failed'); });

    // Should not throw
    await expect(
      handlePrMerged(fakeDb, 'PR_node1', mockMirror, mockScheduleCleanup)
    ).resolves.toBeUndefined();

    expect(mockScheduleCleanup).toHaveBeenCalled();
  });

  it('does not propagate when mirror throws', async () => {
    const run = makeRun();
    mockGetRunByPrNodeId.mockReturnValue(run);
    mockUpdateRunPrBundle.mockReturnValue(true);
    mockTransitionPhase.mockReturnValue({ success: true, run, event: {} } as TransitionResult);
    mockMirror.mockImplementation(() => { throw new Error('mirror fail'); });

    await expect(
      handlePrMerged(fakeDb, 'PR_node1', mockMirror, mockScheduleCleanup)
    ).resolves.toBeUndefined();

    // Inline cleanup still runs after mirror failure
    expect(mockCleanupWorktree).toHaveBeenCalledWith(fakeDb, 'run_1');
  });
});

// ---------------------------------------------------------------------------
// handlePrStateChange
// ---------------------------------------------------------------------------

describe('handlePrStateChange', () => {
  it('does nothing when no run found', () => {
    mockGetRunByPrNodeId.mockReturnValue(null);

    handlePrStateChange(fakeDb, 'PR_unknown', 'closed');

    expect(mockUpdateRunPrBundle).not.toHaveBeenCalled();
  });

  it('updates PR state to closed', () => {
    const run = makeRun();
    mockGetRunByPrNodeId.mockReturnValue(run);
    mockUpdateRunPrBundle.mockReturnValue(true);

    handlePrStateChange(fakeDb, 'PR_node1', 'closed');

    expect(mockUpdateRunPrBundle).toHaveBeenCalledWith(fakeDb, expect.objectContaining({
      runId: 'run_1',
      prState: 'closed',
    }));
    // No phase transition
    expect(mockTransitionPhase).not.toHaveBeenCalled();
  });

  it('updates PR state to open on reopen', () => {
    const run = makeRun({ prState: 'closed' });
    mockGetRunByPrNodeId.mockReturnValue(run);
    mockUpdateRunPrBundle.mockReturnValue(true);

    handlePrStateChange(fakeDb, 'PR_node1', 'open');

    expect(mockUpdateRunPrBundle).toHaveBeenCalledWith(fakeDb, expect.objectContaining({
      runId: 'run_1',
      prState: 'open',
    }));
    expect(mockTransitionPhase).not.toHaveBeenCalled();
  });

  it('does not update when PR bundle fields are missing', () => {
    const run = makeRun({ prNumber: undefined, prNodeId: undefined, prUrl: undefined });
    mockGetRunByPrNodeId.mockReturnValue(run);

    handlePrStateChange(fakeDb, 'PR_node1', 'closed');

    expect(mockUpdateRunPrBundle).not.toHaveBeenCalled();
  });
});
