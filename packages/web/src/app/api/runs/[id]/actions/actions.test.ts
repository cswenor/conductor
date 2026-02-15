/**
 * Tests for the run actions API route — verifies retry enqueue payload,
 * approve_plan implementer enqueue + mirror ordering, and failure scenarios.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextResponse } from 'next/server';

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
const mockRejectRunCommand = vi.fn();
const mockRevisePlanCommand = vi.fn();
const mockMirrorApprovalDecision = vi.fn();
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
  mirrorApprovalDecision: (...args: unknown[]) => mockMirrorApprovalDecision(...args) as unknown,
  publishTransitionEvent: vi.fn(),
  publishOperatorActionEvent: vi.fn(),
  approvePlanCommand: (...args: unknown[]) => mockApprovePlanCommand(...args) as unknown,
  rejectRunCommand: (...args: unknown[]) => mockRejectRunCommand(...args) as unknown,
  revisePlanCommand: (...args: unknown[]) => mockRevisePlanCommand(...args) as unknown,
}));

vi.mock('@/lib/bootstrap', () => ({
  ensureBootstrap: vi.fn().mockResolvedValue(undefined),
  getDb: vi.fn().mockResolvedValue({}),
  getQueues: vi.fn().mockResolvedValue({
    addJob: (...args: unknown[]) => mockAddJob(...(args as [string, string, Record<string, unknown>])),
  }),
}));

vi.mock('@/lib/config', () => ({
  getConfig: () => ({ redisUrl: 'redis://localhost:6379' }),
}));

vi.mock('@/lib/auth', () => ({
  withAuth: (handler: (req: unknown, ctx: unknown) => Promise<NextResponse>) => {
    return (req: unknown, ctx: unknown) => {
      (req as Record<string, unknown>)['user'] = {
        userId: 'user_1',
        githubId: 42,
        githubLogin: 'testuser',
        githubNodeId: 'MDQ_42',
        status: 'active',
      };
      return handler(req as never, ctx as never);
    };
  },
}));

vi.mock('@/lib/enqueue-implementer', () => ({
  enqueueImplementerAfterApproval: (...args: unknown[]) => mockEnqueueImplementer(...args) as unknown,
}));

// Import after mocks
const { POST } = await import('./route.ts');

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

function makeRequest(body: Record<string, unknown>) {
  return {
    json: () => Promise.resolve(body),
    user: {
      userId: 'user_1',
      githubId: 42,
      githubLogin: 'testuser',
      githubNodeId: 'MDQ_42',
      status: 'active',
    },
  } as unknown;
}

function makeRouteContext(runId: string) {
  return { params: Promise.resolve({ id: runId }) };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetProject.mockReturnValue({ projectId: 'proj_1', userId: 'user_1' });
  mockCanAccessProject.mockReturnValue(true);
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('POST /api/runs/[id]/actions — retry', () => {
  it('enqueues resume job with fromPhase and fromSequence', async () => {
    const run = makeBlockedRun({ lastEventSequence: 12 });
    mockGetRun.mockReturnValue(run);

    const response = await (POST as (req: unknown, ctx: unknown) => Promise<NextResponse>)(
      makeRequest({ action: 'retry' }),
      makeRouteContext('run_1'),
    );

    const body = await response.json() as { success: boolean };
    expect(body.success).toBe(true);

    expect(mockAddJob).toHaveBeenCalledWith(
      'runs',
      expect.stringContaining('run-retry-run_1-'),
      expect.objectContaining({
        runId: 'run_1',
        action: 'resume',
        triggeredBy: 'user_1',
        fromPhase: 'blocked',
        fromSequence: 12,
      }),
    );
  });

  it('rejects when run is not blocked', async () => {
    mockGetRun.mockReturnValue(makeBlockedRun({ phase: 'planning' }));

    const response = await (POST as (req: unknown, ctx: unknown) => Promise<NextResponse>)(
      makeRequest({ action: 'retry' }),
      makeRouteContext('run_1'),
    );

    expect(response.status).toBe(400);
    expect(mockAddJob).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// approve_plan
// ---------------------------------------------------------------------------

describe('POST /api/runs/[id]/actions — approve_plan', () => {
  it('wrong_phase → HTTP 400', async () => {
    mockGetRun.mockReturnValue(makeApprovalRun());
    mockApprovePlanCommand.mockReturnValue({
      outcome: 'wrong_phase', success: false, error: 'Run is not awaiting plan approval',
    });

    const response = await (POST as (req: unknown, ctx: unknown) => Promise<NextResponse>)(
      makeRequest({ action: 'approve_plan' }),
      makeRouteContext('run_1'),
    );

    expect(response.status).toBe(400);
    const body = await response.json() as { outcome: string };
    expect(body.outcome).toBe('wrong_phase');
  });

  it('conflict → HTTP 409', async () => {
    mockGetRun.mockReturnValue(makeApprovalRun());
    mockApprovePlanCommand.mockReturnValue({
      outcome: 'conflict', success: false, error: 'Gate already has decision: rejected',
    });

    const response = await (POST as (req: unknown, ctx: unknown) => Promise<NextResponse>)(
      makeRequest({ action: 'approve_plan' }),
      makeRouteContext('run_1'),
    );

    expect(response.status).toBe(409);
    const body = await response.json() as { outcome: string };
    expect(body.outcome).toBe('conflict');
  });

  it('stale_run → HTTP 409', async () => {
    mockGetRun.mockReturnValue(makeApprovalRun());
    mockApprovePlanCommand.mockReturnValue({
      outcome: 'stale_run', success: false, error: 'Run state changed — please refresh and retry',
    });

    const response = await (POST as (req: unknown, ctx: unknown) => Promise<NextResponse>)(
      makeRequest({ action: 'approve_plan' }),
      makeRouteContext('run_1'),
    );

    expect(response.status).toBe(409);
    const body = await response.json() as { outcome: string };
    expect(body.outcome).toBe('stale_run');
  });

  it('approved → enqueues implementer + mirror called AFTER', async () => {
    const opAction = { operatorActionId: 'oa_1' };
    mockGetRun.mockReturnValue(makeApprovalRun());
    mockApprovePlanCommand.mockReturnValue({
      outcome: 'approved', success: true, run: makeApprovalRun({ phase: 'executing' }), operatorAction: opAction,
    });
    mockEnqueueImplementer.mockResolvedValue({ outcome: 'enqueued' });

    const response = await (POST as (req: unknown, ctx: unknown) => Promise<NextResponse>)(
      makeRequest({ action: 'approve_plan' }),
      makeRouteContext('run_1'),
    );

    expect(response.status).toBe(200);
    expect(mockEnqueueImplementer).toHaveBeenCalledTimes(1);
    expect(mockMirrorApprovalDecision).toHaveBeenCalledTimes(1);

    // Verify enqueue was called before mirror (by call order)
    const enqueueOrder = mockEnqueueImplementer.mock.invocationCallOrder[0] ?? 0;
    const mirrorOrder = mockMirrorApprovalDecision.mock.invocationCallOrder[0] ?? 0;
    expect(enqueueOrder).toBeLessThan(mirrorOrder);
  });

  it('accepted → no enqueue, no mirror', async () => {
    mockGetRun.mockReturnValue(makeApprovalRun());
    mockApprovePlanCommand.mockReturnValue({
      outcome: 'accepted', success: true, operatorAction: { operatorActionId: 'oa_1' },
    });

    const response = await (POST as (req: unknown, ctx: unknown) => Promise<NextResponse>)(
      makeRequest({ action: 'approve_plan' }),
      makeRouteContext('run_1'),
    );

    expect(response.status).toBe(200);
    expect(mockEnqueueImplementer).not.toHaveBeenCalled();
    expect(mockMirrorApprovalDecision).not.toHaveBeenCalled();
  });

  it('already_decided → HTTP 200 + mirrorApprovalDecision NOT called', async () => {
    mockGetRun.mockReturnValue(makeApprovalRun());
    mockApprovePlanCommand.mockReturnValue({
      outcome: 'already_decided', success: true, run: makeApprovalRun({ phase: 'executing' }),
    });
    mockEnqueueImplementer.mockResolvedValue({ outcome: 'skipped', reason: 'active_invocation' });

    const response = await (POST as (req: unknown, ctx: unknown) => Promise<NextResponse>)(
      makeRequest({ action: 'approve_plan' }),
      makeRouteContext('run_1'),
    );

    expect(response.status).toBe(200);
    expect(mockMirrorApprovalDecision).not.toHaveBeenCalled();
  });

  it('already_decided + enqueued → self-heal success', async () => {
    mockGetRun.mockReturnValue(makeApprovalRun());
    mockApprovePlanCommand.mockReturnValue({
      outcome: 'already_decided', success: true, run: makeApprovalRun({ phase: 'executing' }),
    });
    mockEnqueueImplementer.mockResolvedValue({ outcome: 'enqueued' });

    const response = await (POST as (req: unknown, ctx: unknown) => Promise<NextResponse>)(
      makeRequest({ action: 'approve_plan' }),
      makeRouteContext('run_1'),
    );

    expect(response.status).toBe(200);
    const body = await response.json() as { success: boolean; outcome: string };
    expect(body.success).toBe(true);
    expect(body.outcome).toBe('already_decided');
    expect(mockEnqueueImplementer).toHaveBeenCalledTimes(1);
  });

  it('approved with operatorAction undefined (retry no-match) → still enqueues implementer', async () => {
    mockGetRun.mockReturnValue(makeApprovalRun());
    mockApprovePlanCommand.mockReturnValue({
      outcome: 'approved', success: true, run: makeApprovalRun({ phase: 'executing' }),
      operatorAction: undefined,
    });
    mockEnqueueImplementer.mockResolvedValue({ outcome: 'enqueued' });

    const response = await (POST as (req: unknown, ctx: unknown) => Promise<NextResponse>)(
      makeRequest({ action: 'approve_plan' }),
      makeRouteContext('run_1'),
    );

    expect(response.status).toBe(200);
    const body = await response.json() as { success: boolean; outcome: string };
    expect(body.outcome).toBe('approved');
    expect(mockEnqueueImplementer).toHaveBeenCalledTimes(1);
    expect(mockMirrorApprovalDecision).not.toHaveBeenCalled();
  });

  it('approved + helper returns skipped → HTTP 409, no mirror', async () => {
    mockGetRun.mockReturnValue(makeApprovalRun());
    mockApprovePlanCommand.mockReturnValue({
      outcome: 'approved', success: true, run: makeApprovalRun({ phase: 'executing' }),
      operatorAction: { operatorActionId: 'oa_1' },
    });
    mockEnqueueImplementer.mockResolvedValue({ outcome: 'skipped', reason: 'wrong_step' });

    const response = await (POST as (req: unknown, ctx: unknown) => Promise<NextResponse>)(
      makeRequest({ action: 'approve_plan' }),
      makeRouteContext('run_1'),
    );

    expect(response.status).toBe(409);
    expect(mockMirrorApprovalDecision).not.toHaveBeenCalled();
  });

  it('enqueue failure + block success → HTTP 409, mirror NOT called', async () => {
    mockGetRun.mockReturnValue(makeApprovalRun());
    mockApprovePlanCommand.mockReturnValue({
      outcome: 'approved', success: true, run: makeApprovalRun({ phase: 'executing' }),
      operatorAction: { operatorActionId: 'oa_1' },
    });
    mockEnqueueImplementer.mockResolvedValue({
      outcome: 'enqueue_failed',
      error: 'Approval recorded but agent dispatch failed — run has been blocked for retry',
    });

    const response = await (POST as (req: unknown, ctx: unknown) => Promise<NextResponse>)(
      makeRequest({ action: 'approve_plan' }),
      makeRouteContext('run_1'),
    );

    expect(response.status).toBe(409);
    const body = await response.json() as { outcome: string; error: string };
    expect(body.outcome).toBe('enqueue_failed');
    expect(body.error).toContain('blocked for retry');
    expect(mockMirrorApprovalDecision).not.toHaveBeenCalled();
  });

  it('enqueue failure + block failure → HTTP 409, mirror NOT called', async () => {
    mockGetRun.mockReturnValue(makeApprovalRun());
    mockApprovePlanCommand.mockReturnValue({
      outcome: 'approved', success: true, run: makeApprovalRun({ phase: 'executing' }),
      operatorAction: { operatorActionId: 'oa_1' },
    });
    mockEnqueueImplementer.mockResolvedValue({
      outcome: 'enqueue_and_block_failed',
      error: 'Agent dispatch failed and run could not be blocked — run may be stranded in executing',
    });

    const response = await (POST as (req: unknown, ctx: unknown) => Promise<NextResponse>)(
      makeRequest({ action: 'approve_plan' }),
      makeRouteContext('run_1'),
    );

    expect(response.status).toBe(409);
    const body = await response.json() as { outcome: string };
    expect(body.outcome).toBe('enqueue_and_block_failed');
    expect(mockMirrorApprovalDecision).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// revise_plan
// ---------------------------------------------------------------------------

describe('POST /api/runs/[id]/actions — revise_plan', () => {
  it('blocked outcome → mirror toPhase: blocked', async () => {
    const opAction = { operatorActionId: 'oa_2' };
    mockGetRun.mockReturnValue(makeApprovalRun());
    mockRevisePlanCommand.mockReturnValue({
      outcome: 'blocked', success: true, run: makeApprovalRun({ phase: 'blocked' }), operatorAction: opAction,
    });

    const response = await (POST as (req: unknown, ctx: unknown) => Promise<NextResponse>)(
      makeRequest({ action: 'revise_plan', comment: 'Fix it' }),
      makeRouteContext('run_1'),
    );

    expect(response.status).toBe(200);
    expect(mockMirrorApprovalDecision).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ toPhase: 'blocked' }),
    );
  });

  it('revised outcome → mirror toPhase: planning', async () => {
    const opAction = { operatorActionId: 'oa_3' };
    mockGetRun.mockReturnValue(makeApprovalRun());
    mockRevisePlanCommand.mockReturnValue({
      outcome: 'revised', success: true, run: makeApprovalRun({ phase: 'planning' }), operatorAction: opAction,
    });

    const response = await (POST as (req: unknown, ctx: unknown) => Promise<NextResponse>)(
      makeRequest({ action: 'revise_plan', comment: 'More detail' }),
      makeRouteContext('run_1'),
    );

    expect(response.status).toBe(200);
    expect(mockMirrorApprovalDecision).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ toPhase: 'planning' }),
    );
  });

  it('wrong_phase → HTTP 400', async () => {
    mockGetRun.mockReturnValue(makeApprovalRun());
    mockRevisePlanCommand.mockReturnValue({
      outcome: 'wrong_phase', success: false, error: 'Run is not awaiting plan approval',
    });

    const response = await (POST as (req: unknown, ctx: unknown) => Promise<NextResponse>)(
      makeRequest({ action: 'revise_plan', comment: 'Detail' }),
      makeRouteContext('run_1'),
    );

    expect(response.status).toBe(400);
    const body = await response.json() as { outcome: string };
    expect(body.outcome).toBe('wrong_phase');
  });
});

// ---------------------------------------------------------------------------
// reject_run
// ---------------------------------------------------------------------------

describe('POST /api/runs/[id]/actions — reject_run', () => {
  it('rejected → HTTP 200 + mirror + cleanup enqueued', async () => {
    const opAction = { operatorActionId: 'oa_4' };
    mockGetRun.mockReturnValue(makeApprovalRun());
    mockRejectRunCommand.mockReturnValue({
      outcome: 'rejected', success: true, run: makeApprovalRun({ phase: 'cancelled' }), operatorAction: opAction,
    });

    const response = await (POST as (req: unknown, ctx: unknown) => Promise<NextResponse>)(
      makeRequest({ action: 'reject_run', comment: 'No good' }),
      makeRouteContext('run_1'),
    );

    expect(response.status).toBe(200);
    expect(mockMirrorApprovalDecision).toHaveBeenCalledTimes(1);
    expect(mockAddJob).toHaveBeenCalledWith(
      'cleanup',
      'cleanup:worktree:run_1',
      expect.objectContaining({ type: 'worktree', targetId: 'run_1' }),
    );
  });

  it('wrong_phase → HTTP 400', async () => {
    mockGetRun.mockReturnValue(makeApprovalRun());
    mockRejectRunCommand.mockReturnValue({
      outcome: 'wrong_phase', success: false, error: 'Run is not awaiting plan approval',
    });

    const response = await (POST as (req: unknown, ctx: unknown) => Promise<NextResponse>)(
      makeRequest({ action: 'reject_run', comment: 'No' }),
      makeRouteContext('run_1'),
    );

    expect(response.status).toBe(400);
    const body = await response.json() as { outcome: string };
    expect(body.outcome).toBe('wrong_phase');
  });
});
