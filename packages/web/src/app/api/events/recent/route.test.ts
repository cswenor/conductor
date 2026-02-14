/**
 * Recent Events API Route Tests
 *
 * Tests GET handler for fetching recent stream events.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

// ---- Mocks ----

const mockListProjects = vi.fn();
const mockQueryRecentStreamEventsEnriched = vi.fn();

vi.mock('@conductor/shared', () => ({
  listProjects: (...args: unknown[]) => mockListProjects(...args) as unknown,
  queryRecentStreamEventsEnriched: (...args: unknown[]) => mockQueryRecentStreamEventsEnriched(...args) as unknown,
  createLogger: vi.fn().mockReturnValue({
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
  }),
}));

vi.mock('@/lib/bootstrap', () => ({
  ensureBootstrap: vi.fn().mockResolvedValue(undefined),
  getDb: vi.fn().mockResolvedValue({}),
}));

// Mock withAuth: by default rejects (no user). Tests override as needed.
let authUser: Record<string, unknown> | null = null;

vi.mock('@/lib/auth', () => ({
  withAuth: (handler: (req: unknown) => Promise<NextResponse>) => {
    return (req: unknown) => {
      if (authUser === null) {
        return Promise.resolve(NextResponse.json({ error: 'Authentication required' }, { status: 401 }));
      }
      (req as Record<string, unknown>)['user'] = authUser;
      return handler(req as never);
    };
  },
}));

function makeRequest(params?: Record<string, string>): NextRequest {
  const url = new URL('http://localhost:3000/api/events/recent');
  if (params !== undefined) {
    for (const [k, v] of Object.entries(params)) {
      url.searchParams.set(k, v);
    }
  }
  return new NextRequest(url);
}

function setupAuth() {
  authUser = {
    id: 'user_1',
    userId: 'user_1',
    githubId: 42,
    githubLogin: 'testuser',
    githubNodeId: 'MDQ_42',
    githubName: 'Test User',
    githubAvatarUrl: null,
  };
  mockListProjects.mockReturnValue([
    { projectId: 'proj_1' },
    { projectId: 'proj_2' },
  ]);
  mockQueryRecentStreamEventsEnriched.mockReturnValue([]);
}

describe('GET /api/events/recent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authUser = null;
  });

  it('returns 401 without auth', async () => {
    const { GET } = await import('./route.ts');
    const res = await GET(makeRequest(), undefined as never);
    expect(res.status).toBe(401);
  });

  it('returns 200 with { events } array', async () => {
    setupAuth();
    const enrichedRows = [
      {
        event: { id: 1, kind: 'run.phase_changed', projectId: 'proj_1', runId: 'run_1', fromPhase: 'pending', toPhase: 'planning', timestamp: '2025-01-01T00:00:00.000Z' },
        projectName: 'My Project',
        taskTitle: 'Fix bug',
      },
    ];
    mockQueryRecentStreamEventsEnriched.mockReturnValue(enrichedRows);

    const { GET } = await import('./route.ts');
    const res = await GET(makeRequest(), undefined as never);
    expect(res.status).toBe(200);

    const data = await res.json() as { events: Array<Record<string, unknown>> };
    expect(data.events).toHaveLength(1);
    const first = data.events[0] ?? {};
    expect(first['projectName']).toBe('My Project');
    expect(first['taskTitle']).toBe('Fix bug');
    expect(first['kind']).toBe('run.phase_changed');
  });

  it('omits null enrichment fields from response', async () => {
    setupAuth();
    const enrichedRows = [
      {
        event: { id: 1, kind: 'project.updated', projectId: 'proj_1', reason: 'config', timestamp: '2025-01-01T00:00:00.000Z' },
        projectName: null,
        taskTitle: null,
      },
    ];
    mockQueryRecentStreamEventsEnriched.mockReturnValue(enrichedRows);

    const { GET } = await import('./route.ts');
    const res = await GET(makeRequest(), undefined as never);
    const data = await res.json() as { events: Array<Record<string, unknown>> };

    expect(data.events).toHaveLength(1);
    const first = data.events[0] ?? {};
    expect(first['projectName']).toBeUndefined();
    expect(first['taskTitle']).toBeUndefined();
  });

  it('uses default limit 20 when unspecified', async () => {
    setupAuth();

    const { GET } = await import('./route.ts');
    await GET(makeRequest(), undefined as never);

    expect(mockQueryRecentStreamEventsEnriched).toHaveBeenCalledWith(
      expect.anything(),
      ['proj_1', 'proj_2'],
      20,
    );
  });

  it('custom limit respected, capped at 50', async () => {
    setupAuth();

    const { GET } = await import('./route.ts');
    await GET(makeRequest({ limit: '100' }), undefined as never);

    expect(mockQueryRecentStreamEventsEnriched).toHaveBeenCalledWith(
      expect.anything(),
      ['proj_1', 'proj_2'],
      50,
    );
  });

  it('limit=0 clamped to 1', async () => {
    setupAuth();

    const { GET } = await import('./route.ts');
    await GET(makeRequest({ limit: '0' }), undefined as never);

    expect(mockQueryRecentStreamEventsEnriched).toHaveBeenCalledWith(
      expect.anything(),
      ['proj_1', 'proj_2'],
      1,
    );
  });

  it('limit=-1 clamped to 1', async () => {
    setupAuth();

    const { GET } = await import('./route.ts');
    await GET(makeRequest({ limit: '-1' }), undefined as never);

    expect(mockQueryRecentStreamEventsEnriched).toHaveBeenCalledWith(
      expect.anything(),
      ['proj_1', 'proj_2'],
      1,
    );
  });

  it('NaN limit falls back to default 20', async () => {
    setupAuth();

    const { GET } = await import('./route.ts');
    await GET(makeRequest({ limit: 'abc' }), undefined as never);

    expect(mockQueryRecentStreamEventsEnriched).toHaveBeenCalledWith(
      expect.anything(),
      ['proj_1', 'proj_2'],
      20,
    );
  });

  it('queryRecentStreamEventsEnriched called with user project IDs', async () => {
    setupAuth();

    const { GET } = await import('./route.ts');
    await GET(makeRequest({ limit: '10' }), undefined as never);

    expect(mockQueryRecentStreamEventsEnriched).toHaveBeenCalledWith(
      expect.anything(),
      ['proj_1', 'proj_2'],
      10,
    );
  });

  it('response preserves event order from query', async () => {
    setupAuth();
    const enrichedRows = [
      {
        event: { id: 3, kind: 'operator.action', projectId: 'proj_1', runId: 'run_1', action: 'approve', operator: 'alice', timestamp: '2025-01-01T00:02:00.000Z' },
        projectName: 'P1',
        taskTitle: 'T1',
      },
      {
        event: { id: 2, kind: 'gate.evaluated', projectId: 'proj_1', runId: 'run_1', gateId: 'g1', gateKind: 'approval', status: 'passed', timestamp: '2025-01-01T00:01:00.000Z' },
        projectName: 'P1',
        taskTitle: 'T1',
      },
      {
        event: { id: 1, kind: 'run.phase_changed', projectId: 'proj_1', runId: 'run_1', fromPhase: 'pending', toPhase: 'planning', timestamp: '2025-01-01T00:00:00.000Z' },
        projectName: 'P1',
        taskTitle: 'T1',
      },
    ];
    mockQueryRecentStreamEventsEnriched.mockReturnValue(enrichedRows);

    const { GET } = await import('./route.ts');
    const res = await GET(makeRequest(), undefined as never);
    const data = await res.json() as { events: Array<{ id: number }> };

    // Should be id DESC
    expect(data.events[0]?.id).toBe(3);
    expect(data.events[1]?.id).toBe(2);
    expect(data.events[2]?.id).toBe(1);
  });
});
