/**
 * Tests for server actions — retryRun enqueue payload + approvePlan
 * implementer enqueue behavior.
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
const mockApprovePlanCommand = vi.fn();
const mockEnqueueImplementer = vi.fn();

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
  publishTransitionEvent: vi.fn(),
  publishOperatorActionEvent: vi.fn(),
  approvePlanCommand: (...args: unknown[]) => mockApprovePlanCommand(...args) as unknown,
  rejectRunCommand: vi.fn().mockReturnValue({ outcome: 'rejected', success: true }),
  revisePlanCommand: vi.fn().mockReturnValue({ outcome: 'revised', success: true }),
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

vi.mock('@/lib/config', () => ({
  getConfig: () => ({ redisUrl: 'redis://localhost:6379' }),
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

vi.mock('@/lib/enqueue-implementer', () => ({
  enqueueImplementerAfterApproval: (...args: unknown[]) => mockEnqueueImplementer(...args) as unknown,
}));

// Import after mocks
const { retryRun, approvePlan } = await import('./run-actions.ts');

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

function makeApprovalRun(overrides: Record<string, unknown> = {}) {
  return {
    runId: 'run_1',
    projectId: 'proj_1',
    phase: 'awaiting_plan_approval',
    step: 'planner_create_plan',
    approvalCycle: 1,
    lastEventSequence: 5,
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

// ---------------------------------------------------------------------------
// approvePlan — enqueue implementer
// ---------------------------------------------------------------------------

describe('approvePlan', () => {
  it('approved → enqueues implementer', async () => {
    mockGetRun.mockReturnValue(makeApprovalRun());
    mockApprovePlanCommand.mockReturnValue({
      outcome: 'approved', success: true, run: makeApprovalRun({ phase: 'executing' }),
    });
    mockEnqueueImplementer.mockResolvedValue({ outcome: 'enqueued' });

    const result = await approvePlan('run_1');

    expect(result.success).toBe(true);
    expect(result.outcome).toBe('approved');
    expect(mockEnqueueImplementer).toHaveBeenCalledTimes(1);
    expect(mockEnqueueImplementer).toHaveBeenCalledWith(
      expect.anything(), // db
      expect.anything(), // queues
      'run_1',
      'proj_1',
    );
  });

  it('approved + helper returns skipped → returns failure', async () => {
    mockGetRun.mockReturnValue(makeApprovalRun());
    mockApprovePlanCommand.mockReturnValue({
      outcome: 'approved', success: true, run: makeApprovalRun({ phase: 'executing' }),
    });
    mockEnqueueImplementer.mockResolvedValue({ outcome: 'skipped', reason: 'wrong_step' });

    const result = await approvePlan('run_1');

    expect(result.success).toBe(false);
    expect(result.outcome).toBe('skipped');
  });

  it('already_decided + enqueued → self-heal success', async () => {
    mockGetRun.mockReturnValue(makeApprovalRun());
    mockApprovePlanCommand.mockReturnValue({
      outcome: 'already_decided', success: true, run: makeApprovalRun({ phase: 'executing' }),
    });
    mockEnqueueImplementer.mockResolvedValue({ outcome: 'enqueued' });

    const result = await approvePlan('run_1');

    expect(result.success).toBe(true);
    expect(result.outcome).toBe('already_decided');
    expect(mockEnqueueImplementer).toHaveBeenCalledTimes(1);
  });

  it('already_decided + skipped → idempotent success', async () => {
    mockGetRun.mockReturnValue(makeApprovalRun());
    mockApprovePlanCommand.mockReturnValue({
      outcome: 'already_decided', success: true, run: makeApprovalRun({ phase: 'executing' }),
    });
    mockEnqueueImplementer.mockResolvedValue({ outcome: 'skipped', reason: 'active_invocation' });

    const result = await approvePlan('run_1');

    expect(result.success).toBe(true);
    expect(result.outcome).toBe('already_decided');
  });

  it('accepted → no enqueue', async () => {
    mockGetRun.mockReturnValue(makeApprovalRun());
    mockApprovePlanCommand.mockReturnValue({
      outcome: 'accepted', success: true,
    });

    const result = await approvePlan('run_1');

    expect(result.success).toBe(true);
    expect(mockEnqueueImplementer).not.toHaveBeenCalled();
  });

  it('enqueue failure + block success → returns failure with outcome', async () => {
    mockGetRun.mockReturnValue(makeApprovalRun());
    mockApprovePlanCommand.mockReturnValue({
      outcome: 'approved', success: true, run: makeApprovalRun({ phase: 'executing' }),
    });
    mockEnqueueImplementer.mockResolvedValue({
      outcome: 'enqueue_failed',
      error: 'Approval recorded but agent dispatch failed — run has been blocked for retry',
    });

    const result = await approvePlan('run_1');

    expect(result.success).toBe(false);
    expect(result.outcome).toBe('enqueue_failed');
    expect(result.error).toContain('blocked for retry');
  });

  it('enqueue failure + block failure → returns failure with distinct outcome', async () => {
    mockGetRun.mockReturnValue(makeApprovalRun());
    mockApprovePlanCommand.mockReturnValue({
      outcome: 'approved', success: true, run: makeApprovalRun({ phase: 'executing' }),
    });
    mockEnqueueImplementer.mockResolvedValue({
      outcome: 'enqueue_and_block_failed',
      error: 'Agent dispatch failed and run could not be blocked — run may be stranded in executing',
    });

    const result = await approvePlan('run_1');

    expect(result.success).toBe(false);
    expect(result.outcome).toBe('enqueue_and_block_failed');
    expect(result.error).toContain('stranded');
  });
});
