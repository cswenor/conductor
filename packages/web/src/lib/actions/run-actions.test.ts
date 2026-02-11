/**
 * Tests for retryRun server action — verifies the enqueue payload
 * includes fromPhase and fromSequence for staleness guarding.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockGetRun = vi.fn();
const mockGetProject = vi.fn();
const mockCanAccessProject = vi.fn();
const mockRecordOperatorAction = vi.fn();
const mockAddJob = vi.fn<(queue: string, jobId: string, data: Record<string, unknown>) => Promise<void>>()
  .mockResolvedValue(undefined);

vi.mock('@conductor/shared', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  getRun: (...args: unknown[]) => mockGetRun(...args) as unknown,
  getProject: (...args: unknown[]) => mockGetProject(...args) as unknown,
  canAccessProject: (...args: unknown[]) => mockCanAccessProject(...args) as unknown,
  transitionPhase: vi.fn(),
  TERMINAL_PHASES: new Set(['completed', 'cancelled']),
  recordOperatorAction: (...args: unknown[]) => { mockRecordOperatorAction(...args); },
  evaluateGatesAndTransition: vi.fn(),
  createOverride: vi.fn(),
  isValidOverrideScope: vi.fn(),
}));

vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
}));

vi.mock('@/lib/bootstrap', () => ({
  getDb: vi.fn().mockResolvedValue({}),
  getQueues: vi.fn().mockResolvedValue({
    addJob: (...args: unknown[]) => mockAddJob(...(args as [string, string, Record<string, unknown>])),
  }),
}));

vi.mock('@/lib/auth/session', () => ({
  requireServerUser: vi.fn().mockResolvedValue({
    userId: 'user_1',
    githubId: 42,
    githubLogin: 'testuser',
    githubNodeId: 'MDQ_42',
    status: 'active',
  }),
}));

// Import after mocks
const { retryRun } = await import('./run-actions.ts');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeBlockedRun(overrides: Record<string, unknown> = {}) {
  return {
    runId: 'run_1',
    projectId: 'proj_1',
    phase: 'blocked',
    step: 'planner_create_plan',
    lastEventSequence: 5,
    blockedReason: 'API key missing',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetProject.mockReturnValue({ projectId: 'proj_1', userId: 'user_1' });
  mockCanAccessProject.mockReturnValue(true);
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('retryRun', () => {
  it('enqueues resume job with fromPhase and fromSequence', async () => {
    const run = makeBlockedRun({ lastEventSequence: 7 });
    mockGetRun.mockReturnValue(run);

    const result = await retryRun('run_1');

    expect(result.success).toBe(true);
    expect(mockAddJob).toHaveBeenCalledTimes(1);

    expect(mockAddJob).toHaveBeenCalledWith(
      'runs',
      expect.stringContaining('run-retry-run_1-'),
      expect.objectContaining({
        runId: 'run_1',
        action: 'resume',
        triggeredBy: 'user_1',
        fromPhase: 'blocked',
        fromSequence: 7,
      }),
    );
  });

  it('records operator action after enqueue', async () => {
    mockGetRun.mockReturnValue(makeBlockedRun());

    await retryRun('run_1', 'retrying because fix applied');

    expect(mockRecordOperatorAction).toHaveBeenCalledTimes(1);
    expect(mockRecordOperatorAction).toHaveBeenCalledWith(
      expect.anything(), // db
      expect.objectContaining({
        runId: 'run_1',
        action: 'retry',
        actorId: 'user_1',
        actorType: 'operator',
        comment: 'retrying because fix applied',
      }),
    );
  });

  it('rejects when run is not blocked', async () => {
    mockGetRun.mockReturnValue(makeBlockedRun({ phase: 'planning' }));

    const result = await retryRun('run_1');

    expect(result.success).toBe(false);
    expect(result.error).toContain('not in blocked state');
    expect(mockAddJob).not.toHaveBeenCalled();
  });
});
