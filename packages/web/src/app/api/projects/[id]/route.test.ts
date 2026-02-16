/**
 * Tests for the project detail API route — verifies WorkflowConfigError handling.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextResponse } from 'next/server';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockGetProject = vi.fn();
const mockUpdateProject = vi.fn();
const mockDeleteProject = vi.fn();
const mockCanAccessProject = vi.fn();

vi.mock('@conductor/shared', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  getProject: (...args: unknown[]) => mockGetProject(...args) as unknown,
  updateProject: (...args: unknown[]) => mockUpdateProject(...args) as unknown,
  deleteProject: (...args: unknown[]) => mockDeleteProject(...args) as unknown,
  canAccessProject: (...args: unknown[]) => mockCanAccessProject(...args) as unknown,
  WorkflowConfigError: class WorkflowConfigError extends Error {
    readonly code = 'INVALID_WORKFLOW_CONFIG' as const;
    constructor(message: string) {
      super(message);
      this.name = 'WorkflowConfigError';
    }
  },
}));

vi.mock('@/lib/bootstrap', () => ({
  ensureBootstrap: vi.fn().mockResolvedValue(undefined),
  getDb: vi.fn().mockResolvedValue({}),
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
const { PATCH } = await import('./route.ts');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

function makeRouteParams(id: string) {
  return { params: Promise.resolve({ id }) };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PATCH /api/projects/[id]', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetProject.mockReturnValue({ projectId: 'proj_1', userId: 'user_1' });
    mockCanAccessProject.mockReturnValue(true);
  });

  it('returns 400 for invalid workflowConfigJson (instanceof path)', async () => {
    const { WorkflowConfigError } = await import('@conductor/shared');
    mockUpdateProject.mockImplementation(() => {
      throw new WorkflowConfigError('bad config');
    });

    const handler = PATCH as (req: unknown, ctx: unknown) => Promise<NextResponse>;
    const res = await handler(
      makeRequest({ workflowConfigJson: '{"bad": true}' }),
      makeRouteParams('proj_1'),
    );

    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('bad config');
  });

  it('returns 400 for code-path fallback (plain Error with code)', async () => {
    mockUpdateProject.mockImplementation(() => {
      throw Object.assign(new Error('bad config via code'), {
        code: 'INVALID_WORKFLOW_CONFIG',
      });
    });

    const handler = PATCH as (req: unknown, ctx: unknown) => Promise<NextResponse>;
    const res = await handler(
      makeRequest({ workflowConfigJson: '{"bad": true}' }),
      makeRouteParams('proj_1'),
    );

    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('bad config via code');
  });

  it('returns 500 for other errors', async () => {
    mockUpdateProject.mockImplementation(() => {
      throw new Error('unexpected error');
    });

    const handler = PATCH as (req: unknown, ctx: unknown) => Promise<NextResponse>;
    const res = await handler(
      makeRequest({ name: 'New Name' }),
      makeRouteParams('proj_1'),
    );

    expect(res.status).toBe(500);
  });
});
