/**
 * Tests for GET /api/runs/:id/messages/:invocationId
 *
 * Verifies auth, access control, cursor pagination, budget truncation,
 * and the response shape for agent conversation messages.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextResponse } from 'next/server';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockGetRun = vi.fn();
const mockGetProject = vi.fn();
const mockCanAccessProject = vi.fn();
const mockGetAgentInvocation = vi.fn();
const mockListAgentMessagesPaginated = vi.fn();
const mockCountAgentMessages = vi.fn();

vi.mock('@conductor/shared', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  getRun: (...args: unknown[]) => mockGetRun(...args) as unknown,
  getProject: (...args: unknown[]) => mockGetProject(...args) as unknown,
  canAccessProject: (...args: unknown[]) => mockCanAccessProject(...args) as unknown,
  getAgentInvocation: (...args: unknown[]) => mockGetAgentInvocation(...args) as unknown,
  listAgentMessagesPaginated: (...args: unknown[]) => mockListAgentMessagesPaginated(...args) as unknown,
  countAgentMessages: (...args: unknown[]) => mockCountAgentMessages(...args) as unknown,
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
const { GET } = await import('./route.ts');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRequest(runId: string, invocationId: string, params?: Record<string, string>) {
  const searchParams = new URLSearchParams(params);
  const url = `http://localhost/api/runs/${runId}/messages/${invocationId}?${searchParams.toString()}`;
  return new Request(url, { method: 'GET' });
}

function makeContext(runId: string, invocationId: string) {
  return { params: Promise.resolve({ id: runId, invocationId }) };
}

function makeMockMessage(overrides: Record<string, unknown> = {}) {
  return {
    agentMessageId: 'am_1',
    agentInvocationId: 'ai_1',
    runId: 'run_1',
    turnIndex: 0,
    role: 'system',
    contentJson: '"You are helpful."',
    contentSizeBytes: 20,
    createdAt: '2025-01-01T00:00:00.000Z',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

/**
 * Helper: set up the paginated mock to simulate DB-backed pagination.
 * Stores messages in closure and filters/slices when called.
 */
function setupPaginatedMock(messages: ReturnType<typeof makeMockMessage>[]) {
  mockCountAgentMessages.mockReturnValue(messages.length);
  mockListAgentMessagesPaginated.mockImplementation(
    (_db: unknown, _invId: unknown, afterTurnIndex: number, limit: number) => {
      return messages
        .filter((m) => m.turnIndex > afterTurnIndex)
        .slice(0, limit);
    },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetRun.mockReturnValue({ runId: 'run_1', projectId: 'proj_1' });
  mockGetProject.mockReturnValue({ projectId: 'proj_1' });
  mockCanAccessProject.mockReturnValue(true);
  mockGetAgentInvocation.mockReturnValue({ agentInvocationId: 'ai_1', runId: 'run_1' });
  setupPaginatedMock([]);
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GET /api/runs/[id]/messages/[invocationId]', () => {
  // -------------------------------------------------------------------------
  // 404 cases
  // -------------------------------------------------------------------------

  it('returns 404 when run does not exist', async () => {
    mockGetRun.mockReturnValue(null);

    const response = await (GET as (req: unknown, ctx: unknown) => Promise<NextResponse>)(
      makeRequest('run_unknown', 'ai_1'),
      makeContext('run_unknown', 'ai_1'),
    );

    expect(response.status).toBe(404);
    const body = await response.json() as { error: string };
    expect(body.error).toBe('Run not found');
  });

  it('returns 404 when user cannot access project', async () => {
    mockCanAccessProject.mockReturnValue(false);

    const response = await (GET as (req: unknown, ctx: unknown) => Promise<NextResponse>)(
      makeRequest('run_1', 'ai_1'),
      makeContext('run_1', 'ai_1'),
    );

    expect(response.status).toBe(404);
    const body = await response.json() as { error: string };
    expect(body.error).toBe('Run not found');
  });

  it('returns 404 when project is null', async () => {
    mockGetProject.mockReturnValue(null);

    const response = await (GET as (req: unknown, ctx: unknown) => Promise<NextResponse>)(
      makeRequest('run_1', 'ai_1'),
      makeContext('run_1', 'ai_1'),
    );

    expect(response.status).toBe(404);
    const body = await response.json() as { error: string };
    expect(body.error).toBe('Run not found');
  });

  it('returns 404 when invocation does not exist', async () => {
    mockGetAgentInvocation.mockReturnValue(null);

    const response = await (GET as (req: unknown, ctx: unknown) => Promise<NextResponse>)(
      makeRequest('run_1', 'ai_unknown'),
      makeContext('run_1', 'ai_unknown'),
    );

    expect(response.status).toBe(404);
    const body = await response.json() as { error: string };
    expect(body.error).toBe('Invocation not found');
  });

  it('returns 404 when invocation belongs to a different run', async () => {
    mockGetAgentInvocation.mockReturnValue({
      agentInvocationId: 'ai_1',
      runId: 'run_other',
    });

    const response = await (GET as (req: unknown, ctx: unknown) => Promise<NextResponse>)(
      makeRequest('run_1', 'ai_1'),
      makeContext('run_1', 'ai_1'),
    );

    expect(response.status).toBe(404);
    const body = await response.json() as { error: string };
    expect(body.error).toBe('Invocation not found');
  });

  // -------------------------------------------------------------------------
  // 200 - response shape
  // -------------------------------------------------------------------------

  it('returns 200 with correct structure for messages', async () => {
    const messages = [
      makeMockMessage({ agentMessageId: 'am_1', turnIndex: 0, role: 'system' }),
      makeMockMessage({ agentMessageId: 'am_2', turnIndex: 1, role: 'user', contentJson: '"Hello"', contentSizeBytes: 7 }),
      makeMockMessage({ agentMessageId: 'am_3', turnIndex: 2, role: 'assistant', contentJson: '[{"type":"text","text":"Hi!"}]', contentSizeBytes: 30 }),
    ];
    setupPaginatedMock(messages);

    const response = await (GET as (req: unknown, ctx: unknown) => Promise<NextResponse>)(
      makeRequest('run_1', 'ai_1'),
      makeContext('run_1', 'ai_1'),
    );

    expect(response.status).toBe(200);
    const body = await response.json() as {
      messages: Array<{ agentMessageId: string; turnIndex: number; role: string }>;
      total: number;
      hasMore: boolean;
    };
    expect(body.total).toBe(3);
    expect(body.hasMore).toBe(false);
    expect(body.messages).toHaveLength(3);
    const [msg0, msg1, msg2] = body.messages;
    expect(msg0?.agentMessageId).toBe('am_1');
    expect(msg1?.role).toBe('user');
    expect(msg2?.turnIndex).toBe(2);
  });

  it('returns 200 with empty messages array when invocation has no messages', async () => {
    setupPaginatedMock([]);

    const response = await (GET as (req: unknown, ctx: unknown) => Promise<NextResponse>)(
      makeRequest('run_1', 'ai_1'),
      makeContext('run_1', 'ai_1'),
    );

    expect(response.status).toBe(200);
    const body = await response.json() as {
      messages: unknown[];
      total: number;
      hasMore: boolean;
    };
    expect(body.messages).toEqual([]);
    expect(body.total).toBe(0);
    expect(body.hasMore).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Pagination
  // -------------------------------------------------------------------------

  it('applies cursor-based pagination via afterTurnIndex', async () => {
    const messages = Array.from({ length: 10 }, (_, i) =>
      makeMockMessage({
        agentMessageId: `am_${i}`,
        turnIndex: i,
        role: i === 0 ? 'system' : 'user',
        contentSizeBytes: 20,
      }),
    );
    setupPaginatedMock(messages);

    const response = await (GET as (req: unknown, ctx: unknown) => Promise<NextResponse>)(
      makeRequest('run_1', 'ai_1', { afterTurnIndex: '5', limit: '3' }),
      makeContext('run_1', 'ai_1'),
    );

    expect(response.status).toBe(200);
    const body = await response.json() as {
      messages: Array<{ turnIndex: number }>;
      total: number;
      hasMore: boolean;
      nextCursor?: number;
    };
    // Messages with turnIndex > 5: 6, 7, 8, 9 — limit 3 → 6, 7, 8
    expect(body.messages).toHaveLength(3);
    const [p0, p1, p2] = body.messages;
    expect(p0?.turnIndex).toBe(6);
    expect(p1?.turnIndex).toBe(7);
    expect(p2?.turnIndex).toBe(8);
    expect(body.total).toBe(10);
    expect(body.hasMore).toBe(true);
    expect(body.nextCursor).toBe(8);
  });

  it('applies explicit limit parameter', async () => {
    const messages = Array.from({ length: 5 }, (_, i) =>
      makeMockMessage({
        agentMessageId: `am_${i}`,
        turnIndex: i,
        role: 'user',
        contentSizeBytes: 20,
      }),
    );
    setupPaginatedMock(messages);

    const response = await (GET as (req: unknown, ctx: unknown) => Promise<NextResponse>)(
      makeRequest('run_1', 'ai_1', { limit: '2' }),
      makeContext('run_1', 'ai_1'),
    );

    expect(response.status).toBe(200);
    const body = await response.json() as {
      messages: Array<{ turnIndex: number }>;
      total: number;
      hasMore: boolean;
      nextCursor?: number;
    };
    expect(body.messages).toHaveLength(2);
    expect(body.hasMore).toBe(true);
    expect(body.nextCursor).toBe(1);
  });

  it('defaults to limit=50 when not specified', async () => {
    // Create 60 messages so we can verify the default 50 limit applies
    const messages = Array.from({ length: 60 }, (_, i) =>
      makeMockMessage({
        agentMessageId: `am_${i}`,
        turnIndex: i,
        role: 'user',
        contentSizeBytes: 20,
      }),
    );
    setupPaginatedMock(messages);

    const response = await (GET as (req: unknown, ctx: unknown) => Promise<NextResponse>)(
      makeRequest('run_1', 'ai_1'),
      makeContext('run_1', 'ai_1'),
    );

    expect(response.status).toBe(200);
    const body = await response.json() as {
      messages: Array<{ turnIndex: number }>;
      total: number;
      hasMore: boolean;
    };
    expect(body.messages).toHaveLength(50);
    expect(body.total).toBe(60);
    expect(body.hasMore).toBe(true);
  });

  it('clamps limit to maximum of 200', async () => {
    const messages = Array.from({ length: 250 }, (_, i) =>
      makeMockMessage({
        agentMessageId: `am_${i}`,
        turnIndex: i,
        role: 'user',
        contentSizeBytes: 20,
      }),
    );
    setupPaginatedMock(messages);

    const response = await (GET as (req: unknown, ctx: unknown) => Promise<NextResponse>)(
      makeRequest('run_1', 'ai_1', { limit: '500' }),
      makeContext('run_1', 'ai_1'),
    );

    expect(response.status).toBe(200);
    const body = await response.json() as {
      messages: Array<{ turnIndex: number }>;
      total: number;
      hasMore: boolean;
    };
    expect(body.messages).toHaveLength(200);
    expect(body.total).toBe(250);
    expect(body.hasMore).toBe(true);
  });

  it('coerces invalid afterTurnIndex to -1 instead of returning empty', async () => {
    const messages = [
      makeMockMessage({ agentMessageId: 'am_1', turnIndex: 0, role: 'user', contentSizeBytes: 20 }),
      makeMockMessage({ agentMessageId: 'am_2', turnIndex: 1, role: 'assistant', contentSizeBytes: 20 }),
    ];
    setupPaginatedMock(messages);

    const response = await (GET as (req: unknown, ctx: unknown) => Promise<NextResponse>)(
      makeRequest('run_1', 'ai_1', { afterTurnIndex: 'abc' }),
      makeContext('run_1', 'ai_1'),
    );

    expect(response.status).toBe(200);
    const body = await response.json() as {
      messages: Array<{ turnIndex: number }>;
      total: number;
      hasMore: boolean;
    };
    // NaN afterTurnIndex should be coerced to -1, returning all messages
    expect(body.messages).toHaveLength(2);
    expect(body.total).toBe(2);
  });

  it('returns hasMore=false when all messages fit within limit', async () => {
    const messages = [
      makeMockMessage({ agentMessageId: 'am_1', turnIndex: 0 }),
      makeMockMessage({ agentMessageId: 'am_2', turnIndex: 1 }),
    ];
    setupPaginatedMock(messages);

    const response = await (GET as (req: unknown, ctx: unknown) => Promise<NextResponse>)(
      makeRequest('run_1', 'ai_1', { limit: '10' }),
      makeContext('run_1', 'ai_1'),
    );

    expect(response.status).toBe(200);
    const body = await response.json() as {
      messages: unknown[];
      hasMore: boolean;
      nextCursor?: number;
    };
    expect(body.messages).toHaveLength(2);
    expect(body.hasMore).toBe(false);
    expect(body.nextCursor).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // Budget cutoff
  // -------------------------------------------------------------------------

  it('truncates by budget when cumulative contentSizeBytes exceeds 2MB', async () => {
    // First message: 1MB (under budget)
    // Second message: 1.5MB (would exceed 2MB total)
    // Third message: 100 bytes (won't be reached)
    const messages = [
      makeMockMessage({
        agentMessageId: 'am_1',
        turnIndex: 0,
        role: 'user',
        contentSizeBytes: 1_048_576, // 1MB
      }),
      makeMockMessage({
        agentMessageId: 'am_2',
        turnIndex: 1,
        role: 'assistant',
        contentSizeBytes: 1_500_000, // 1.5MB
      }),
      makeMockMessage({
        agentMessageId: 'am_3',
        turnIndex: 2,
        role: 'user',
        contentSizeBytes: 100,
      }),
    ];
    setupPaginatedMock(messages);

    const response = await (GET as (req: unknown, ctx: unknown) => Promise<NextResponse>)(
      makeRequest('run_1', 'ai_1', { limit: '50' }),
      makeContext('run_1', 'ai_1'),
    );

    expect(response.status).toBe(200);
    const body = await response.json() as {
      messages: Array<{ agentMessageId: string }>;
      total: number;
      hasMore: boolean;
      truncatedByBudget?: boolean;
    };
    // First message always included (first-row guarantee), second exceeds budget
    expect(body.messages).toHaveLength(1);
    const [budgetMsg] = body.messages;
    expect(budgetMsg?.agentMessageId).toBe('am_1');
    expect(body.hasMore).toBe(true);
    expect(body.truncatedByBudget).toBe(true);
  });

  it('always includes at least one message even if it exceeds budget (first-row guarantee)', async () => {
    const messages = [
      makeMockMessage({
        agentMessageId: 'am_1',
        turnIndex: 0,
        role: 'user',
        contentSizeBytes: 3_000_000, // 3MB, exceeds 2MB budget
      }),
    ];
    setupPaginatedMock(messages);

    const response = await (GET as (req: unknown, ctx: unknown) => Promise<NextResponse>)(
      makeRequest('run_1', 'ai_1'),
      makeContext('run_1', 'ai_1'),
    );

    expect(response.status).toBe(200);
    const body = await response.json() as {
      messages: Array<{ agentMessageId: string }>;
      total: number;
      hasMore: boolean;
    };
    expect(body.messages).toHaveLength(1);
    const [guaranteeMsg] = body.messages;
    expect(guaranteeMsg?.agentMessageId).toBe('am_1');
  });

  // -------------------------------------------------------------------------
  // Large message truncation (>100KB)
  // -------------------------------------------------------------------------

  it('sets contentJson to null and truncated flag for messages over 100KB', async () => {
    const messages = [
      makeMockMessage({
        agentMessageId: 'am_1',
        turnIndex: 0,
        role: 'assistant',
        contentJson: '[{"type":"text","text":"...big..."}]',
        contentSizeBytes: 150_000, // 150KB > LARGE_MESSAGE_THRESHOLD
      }),
    ];
    setupPaginatedMock(messages);

    const response = await (GET as (req: unknown, ctx: unknown) => Promise<NextResponse>)(
      makeRequest('run_1', 'ai_1'),
      makeContext('run_1', 'ai_1'),
    );

    expect(response.status).toBe(200);
    const body = await response.json() as {
      messages: Array<{
        agentMessageId: string;
        contentJson: string | null;
        truncated?: boolean;
        contentSizeBytes: number;
      }>;
    };
    expect(body.messages).toHaveLength(1);
    const [largeMsg] = body.messages;
    expect(largeMsg?.contentJson).toBeNull();
    expect(largeMsg?.truncated).toBe(true);
    expect(largeMsg?.contentSizeBytes).toBe(150_000);
  });

  it('preserves contentJson for messages under 100KB', async () => {
    const contentJson = '"Hello world"';
    const messages = [
      makeMockMessage({
        agentMessageId: 'am_1',
        turnIndex: 0,
        role: 'user',
        contentJson,
        contentSizeBytes: 13,
      }),
    ];
    setupPaginatedMock(messages);

    const response = await (GET as (req: unknown, ctx: unknown) => Promise<NextResponse>)(
      makeRequest('run_1', 'ai_1'),
      makeContext('run_1', 'ai_1'),
    );

    expect(response.status).toBe(200);
    const body = await response.json() as {
      messages: Array<{ contentJson: string | null; truncated?: boolean }>;
    };
    const [smallMsg] = body.messages;
    expect(smallMsg?.contentJson).toBe(contentJson);
    expect(smallMsg?.truncated).toBeUndefined();
  });
});
