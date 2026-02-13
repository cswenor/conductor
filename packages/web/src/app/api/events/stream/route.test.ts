/**
 * Tests for the SSE stream route.
 *
 * Covers auth, SSE headers, replay (buildReplayFrames), and fan-out
 * duplicate-delivery regression (the core Phase A fix).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// ---------------------------------------------------------------------------
// Mocks — must be before route module is imported
// ---------------------------------------------------------------------------

const mockValidateSession = vi.fn();
const mockListProjects = vi.fn();
const mockQueryStreamEventsForReplay = vi.fn();
const mockRowToStreamEventV2 = vi.fn();

let capturedSetHandler: ((event: Record<string, unknown>) => void) | undefined;
const mockSetHandler = vi.fn((handler: (event: Record<string, unknown>) => void) => {
  capturedSetHandler = handler;
});
const mockAddChannels = vi.fn().mockResolvedValue(undefined);
const mockClose = vi.fn().mockResolvedValue(undefined);
const mockUnsubscribe = vi.fn().mockResolvedValue(undefined);
const mockCreateSubscriber = vi.fn(() => ({
  setHandler: mockSetHandler,
  addChannels: mockAddChannels,
  unsubscribe: mockUnsubscribe,
  close: mockClose,
}));

vi.mock('@conductor/shared', () => ({
  validateSession: (...args: unknown[]): unknown => mockValidateSession(...args),
  listProjects: (...args: unknown[]): unknown => mockListProjects(...args),
  createSubscriber: () => mockCreateSubscriber(),
  queryStreamEventsForReplay: (...args: unknown[]): unknown => mockQueryStreamEventsForReplay(...args),
  rowToStreamEventV2: (row: unknown): unknown => mockRowToStreamEventV2(row),
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

vi.mock('@/lib/bootstrap', () => ({
  ensureBootstrap: vi.fn().mockResolvedValue(undefined),
  getDb: vi.fn().mockResolvedValue({}),
}));

vi.mock('@/lib/config', () => ({
  getConfig: () => ({ redisUrl: 'redis://test' }),
}));

vi.mock('@/lib/auth/middleware', () => ({
  SESSION_COOKIE_NAME: 'conductor_session',
  userToAuthUser: (u: Record<string, unknown>) => ({
    userId: u['user_id'] ?? 'user_1',
    githubId: u['github_id'] ?? 42,
    githubLogin: u['github_login'] ?? 'testuser',
    githubNodeId: u['github_node_id'] ?? 'MDQ_42',
    status: u['status'] ?? 'active',
  }),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRequest(opts?: { cookie?: string; lastEventId?: string }): NextRequest {
  const headers = new Headers();
  if (opts?.lastEventId !== undefined) {
    headers.set('Last-Event-ID', opts.lastEventId);
  }
  if (opts?.cookie !== undefined) {
    headers.set('Cookie', `conductor_session=${opts.cookie}`);
  }
  const url = 'http://localhost:3000/api/events/stream';
  return new NextRequest(url, { headers });
}

function setupAuth() {
  mockValidateSession.mockReturnValue({ user_id: 'user_1', github_login: 'testuser', status: 'active' });
  mockListProjects.mockReturnValue([
    { projectId: 'proj_1' },
    { projectId: 'proj_2' },
  ]);
  mockQueryStreamEventsForReplay.mockReturnValue([]);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SSE stream route', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    capturedSetHandler = undefined;
    // Reset module state — import dynamically after mocks
    const { _resetForTest } = await import('./route.ts');
    await _resetForTest();
  });

  // -------------------------------------------------------------------------
  // Auth
  // -------------------------------------------------------------------------

  describe('auth', () => {
    it('returns 401 when no session cookie', async () => {
      const { GET } = await import('./route.ts');
      const response = await GET(makeRequest());

      expect(response.status).toBe(401);
    });

    it('returns 401 when validateSession returns null', async () => {
      mockValidateSession.mockReturnValue(null);

      const { GET } = await import('./route.ts');
      const response = await GET(makeRequest({ cookie: 'bad_token' }));

      expect(response.status).toBe(401);
    });
  });

  // -------------------------------------------------------------------------
  // SSE headers
  // -------------------------------------------------------------------------

  describe('SSE headers', () => {
    it('returns 200 with correct SSE headers', async () => {
      setupAuth();

      const { GET } = await import('./route.ts');
      const response = await GET(makeRequest({ cookie: 'good_token' }));

      expect(response.status).toBe(200);
      expect(response.headers.get('Content-Type')).toBe('text/event-stream');
      expect(response.headers.get('Cache-Control')).toBe('no-cache, no-transform');
      expect(response.headers.get('X-Accel-Buffering')).toBe('no');
    });
  });

  // -------------------------------------------------------------------------
  // buildReplayFrames (exported pure function tests)
  // -------------------------------------------------------------------------

  describe('buildReplayFrames', () => {
    it('returns null for no rows', async () => {
      mockQueryStreamEventsForReplay.mockReturnValue([]);

      const { buildReplayFrames } = await import('./route.ts');
      const result = buildReplayFrames({} as never, 1, ['proj_1']);

      expect(result).toBeNull();
    });

    it('returns refresh_required for >100 rows', async () => {
      const rows = Array.from({ length: 101 }, (_, i) => ({
        id: i + 1,
        kind: 'run.phase_changed',
        project_id: 'proj_1',
        run_id: 'run_1',
        payload_json: '{}',
        created_at: new Date().toISOString(),
      }));
      mockQueryStreamEventsForReplay.mockReturnValue(rows);

      const { buildReplayFrames } = await import('./route.ts');
      const result = buildReplayFrames({} as never, 0, ['proj_1']);

      expect(result).toBe('refresh_required');
    });

    it('returns refresh_required for events >5min old', async () => {
      const oldTime = new Date(Date.now() - 6 * 60 * 1000).toISOString();
      mockQueryStreamEventsForReplay.mockReturnValue([{
        id: 1,
        kind: 'run.phase_changed',
        project_id: 'proj_1',
        run_id: 'run_1',
        payload_json: '{}',
        created_at: oldTime,
      }]);

      const { buildReplayFrames } = await import('./route.ts');
      const result = buildReplayFrames({} as never, 0, ['proj_1']);

      expect(result).toBe('refresh_required');
    });

    it('returns correct SSE frame format for normal replay', async () => {
      const now = new Date().toISOString();
      mockQueryStreamEventsForReplay.mockReturnValue([
        { id: 5, kind: 'run.phase_changed', project_id: 'proj_1', run_id: 'run_1', payload_json: '{"fromPhase":"pending","toPhase":"planning"}', created_at: now },
        { id: 6, kind: 'gate.evaluated', project_id: 'proj_1', run_id: 'run_1', payload_json: '{"gateId":"plan_approval","gateKind":"plan_review","status":"passed"}', created_at: now },
      ]);

      const event1 = { id: 5, kind: 'run.phase_changed', projectId: 'proj_1', runId: 'run_1', fromPhase: 'pending', toPhase: 'planning', timestamp: now };
      const event2 = { id: 6, kind: 'gate.evaluated', projectId: 'proj_1', runId: 'run_1', gateId: 'plan_approval', gateKind: 'plan_review', status: 'passed', timestamp: now };
      mockRowToStreamEventV2.mockReturnValueOnce(event1).mockReturnValueOnce(event2);

      const { buildReplayFrames } = await import('./route.ts');
      const result = buildReplayFrames({} as never, 4, ['proj_1']);

      expect(result).not.toBeNull();
      expect(result).toContain('id: 5\n');
      expect(result).toContain('id: 6\n');
      expect(result).toContain(`data: ${JSON.stringify(event1)}\n\n`);
      expect(result).toContain(`data: ${JSON.stringify(event2)}\n\n`);
    });
  });

  // -------------------------------------------------------------------------
  // Channel subscription retry after transient failure
  // -------------------------------------------------------------------------

  describe('channel subscription retry', () => {
    it('retries channels on next connection when addChannels fails', async () => {
      setupAuth();

      // First call to addChannels will reject
      mockAddChannels.mockRejectedValueOnce(new Error('Redis transient'));

      const { GET } = await import('./route.ts');

      // First connection — addChannels fails, but GET still returns 200 (caught)
      const response1 = await GET(makeRequest({ cookie: 'good_token' }));
      expect(response1.status).toBe(200);
      expect(mockAddChannels).toHaveBeenCalledTimes(1);

      // Second connection — addChannels should be retried because the
      // channels were NOT committed to subscribedChannels on failure
      mockAddChannels.mockResolvedValueOnce(undefined);
      const response2 = await GET(makeRequest({ cookie: 'good_token' }));
      expect(response2.status).toBe(200);

      // addChannels should have been called again with the same channels
      expect(mockAddChannels).toHaveBeenCalledTimes(2);
      // Both calls should carry the same project IDs
      expect(mockAddChannels).toHaveBeenNthCalledWith(1, ['proj_1', 'proj_2']);
      expect(mockAddChannels).toHaveBeenNthCalledWith(2, ['proj_1', 'proj_2']);
    });
  });

  // -------------------------------------------------------------------------
  // _resetForTest disposes active connections
  // -------------------------------------------------------------------------

  describe('_resetForTest teardown', () => {
    it('disposes active connections so heartbeat timers are cleared', async () => {
      setupAuth();
      const { GET, _resetForTest } = await import('./route.ts');

      // Establish a connection (starts heartbeat timer internally)
      const response = await GET(makeRequest({ cookie: 'good_token' }));
      expect(response.status).toBe(200);

      // Kick the stream's async start() by reading — this ensures the
      // heartbeat setInterval has been registered before we reset.
      const body = response.body ?? undefined;
      expect(body).toBeDefined();
      const reader = body?.getReader();
      // Trigger event so there's something to read
      if (capturedSetHandler !== undefined) {
        capturedSetHandler({ kind: 'run.phase_changed', projectId: 'proj_1', timestamp: '' });
      }
      await new Promise(resolve => setTimeout(resolve, 10));
      if (reader !== undefined) {
        await reader.read();
        reader.releaseLock();
      }

      // Spy on clearInterval to verify timer cleanup
      const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');

      await _resetForTest();

      // dispose() should have triggered cleanup → clearInterval
      expect(clearIntervalSpy).toHaveBeenCalled();

      clearIntervalSpy.mockRestore();
    });
  });

  // -------------------------------------------------------------------------
  // Fan-out duplicate-delivery regression
  // -------------------------------------------------------------------------

  describe('fan-out duplicate-delivery regression', () => {
    it('each connection receives exactly 1 copy of an event for an overlapping project', async () => {
      // Setup: user has proj_1, proj_2. Two requests come in.
      setupAuth();

      const { GET } = await import('./route.ts');

      // First connection
      const response1 = await GET(makeRequest({ cookie: 'good_token' }));
      expect(response1.status).toBe(200);

      // Second connection (same user, same projects)
      const response2 = await GET(makeRequest({ cookie: 'good_token' }));
      expect(response2.status).toBe(200);

      // setHandler should have been called exactly once (subscriber is shared)
      expect(mockSetHandler).toHaveBeenCalledTimes(1);

      // Simulate an event arriving for proj_1
      expect(capturedSetHandler).toBeDefined();

      // Collect output from both streams
      const collected1: string[] = [];
      const collected2: string[] = [];

      // Read first chunk from each stream to get past the start()
      const body1 = response1.body ?? undefined;
      const body2 = response2.body ?? undefined;
      expect(body1).toBeDefined();
      expect(body2).toBeDefined();
      const reader1 = body1?.getReader();
      const reader2 = body2?.getReader();

      // Trigger event via the captured handler
      if (capturedSetHandler === undefined) throw new Error('setHandler not captured');
      capturedSetHandler({
        id: 42,
        kind: 'run.phase_changed',
        projectId: 'proj_1',
        runId: 'run_1',
        fromPhase: 'pending',
        toPhase: 'planning',
        timestamp: '2025-01-01T00:00:00.000Z',
      });

      // Give the stream a tick to enqueue
      await new Promise(resolve => setTimeout(resolve, 50));

      // Read from both streams
      if (reader1 !== undefined) {
        const chunk1 = await reader1.read();
        if (!chunk1.done && chunk1.value !== undefined) {
          collected1.push(new TextDecoder().decode(chunk1.value));
        }
        reader1.releaseLock();
      }
      if (reader2 !== undefined) {
        const chunk2 = await reader2.read();
        if (!chunk2.done && chunk2.value !== undefined) {
          collected2.push(new TextDecoder().decode(chunk2.value));
        }
        reader2.releaseLock();
      }

      // Each connection should have received exactly 1 copy.
      // Count actual occurrences of the frame pattern, not just chunks —
      // if duplicates arrive in a single chunk we still catch them.
      const eventFrame = /id: 42\ndata: /g;
      const allConn1 = collected1.join('');
      const allConn2 = collected2.join('');
      const conn1Events = (allConn1.match(eventFrame) ?? []).length;
      const conn2Events = (allConn2.match(eventFrame) ?? []).length;

      expect(conn1Events).toBe(1);
      expect(conn2Events).toBe(1);
    });
  });
});
