/**
 * Tests for the run actions API route — verifies the retry enqueue payload
 * includes fromPhase and fromSequence for staleness guarding.
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
  mirrorApprovalDecision: vi.fn(),
  publishTransitionEvent: vi.fn(),
  publishOperatorActionEvent: vi.fn(),
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
