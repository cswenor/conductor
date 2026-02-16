/**
 * Tests for the project runs API route — verifies workflowSnapshotJson
 * is present in the POST response body.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextResponse } from 'next/server';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockGetProject = vi.fn();
const mockCanAccessProject = vi.fn();
const mockGetTask = vi.fn();
const mockCreateRun = vi.fn();
const mockUpdateTaskActiveRun = vi.fn();
const mockAddJob = vi.fn<(queue: string, jobId: string, data: Record<string, unknown>) => Promise<void>>()
  .mockResolvedValue(undefined);

vi.mock('@conductor/shared', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  getProject: (...args: unknown[]) => mockGetProject(...args) as unknown,
  canAccessProject: (...args: unknown[]) => mockCanAccessProject(...args) as unknown,
  getTask: (...args: unknown[]) => mockGetTask(...args) as unknown,
  createRun: (...args: unknown[]) => mockCreateRun(...args) as unknown,
  upsertTaskFromIssue: vi.fn(),
  updateTaskActiveRun: (...args: unknown[]) => { mockUpdateTaskActiveRun(...args); },
  getDefaultImplementerBackend: () => 'raw',
  listRuns: vi.fn().mockReturnValue([]),
}));

const mockTransaction = vi.fn((fn: () => unknown) => fn);
// Return a callable that invokes the transaction function
mockTransaction.mockImplementation((fn: () => unknown) => {
  const txFn = () => fn();
  return txFn;
});

vi.mock('@/lib/bootstrap', () => ({
  ensureBootstrap: vi.fn().mockResolvedValue(undefined),
  getDb: vi.fn().mockResolvedValue({
    transaction: (fn: () => unknown) => () => fn(),
  }),
  getQueues: vi.fn().mockResolvedValue({
    addJob: (...args: unknown[]) => mockAddJob(...(args as [string, string, Record<string, unknown>])),
  }),
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

function makeRequest(body: Record<string, unknown>) {
  return {
    json: () => Promise.resolve(body),
    url: 'http://localhost/api/projects/proj_1/runs',
    user: {
      userId: 'user_1',
      githubId: 42,
      githubLogin: 'testuser',
      githubNodeId: 'MDQ_42',
      status: 'active',
    },
  } as unknown;
}

function makeRouteParams(id: string) {
  return { params: Promise.resolve({ id }) };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('POST /api/projects/[id]/runs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetProject.mockReturnValue({
      projectId: 'proj_1',
      userId: 'user_1',
      defaultBaseBranch: 'main',
    });
    mockCanAccessProject.mockReturnValue(true);
  });

  it('response body includes workflowSnapshotJson field', async () => {
    const snapshotJson = JSON.stringify({ planner: { model: 'test' } });
    mockGetTask.mockReturnValue({ taskId: 'task_1', projectId: 'proj_1' });
    mockCreateRun.mockReturnValue({
      runId: 'run_1',
      taskId: 'task_1',
      projectId: 'proj_1',
      workflowSnapshotJson: snapshotJson,
    });

    const handler = POST as (req: unknown, ctx: unknown) => Promise<NextResponse>;
    const res = await handler(
      makeRequest({ taskId: 'task_1', repoId: 'repo_1' }),
      makeRouteParams('proj_1'),
    );

    expect(res.status).toBe(201);
    const body = await res.json() as { run: { workflowSnapshotJson?: string } };
    expect(body.run.workflowSnapshotJson).toBe(snapshotJson);
  });
});
