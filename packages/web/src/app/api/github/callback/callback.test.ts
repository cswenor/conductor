/**
 * GitHub Installation Callback Security Tests
 *
 * Tests that the installation callback properly enforces:
 * - State validation before any database access
 * - Required userId in state
 * - Cross-user installation ownership checks
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { GET } from './route';

// Mock database
const mockDb = {
  prepare: vi.fn(),
};

const mockStmt = {
  get: vi.fn(),
  run: vi.fn(),
};

vi.mock('@/lib/bootstrap', () => ({
  ensureBootstrap: vi.fn().mockResolvedValue(undefined),
  getDb: vi.fn().mockResolvedValue({
    prepare: (sql: string) => {
      mockDb.prepare(sql);
      return mockStmt;
    },
  }),
}));

vi.mock('@conductor/shared', () => ({
  createLogger: vi.fn().mockReturnValue({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

describe('GitHub Installation Callback Security', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      GITHUB_WEBHOOK_SECRET: 'test-secret-32-bytes-long-enough',
    };
    vi.clearAllMocks();
    mockStmt.get.mockReturnValue(undefined); // No existing project by default
    mockStmt.run.mockReturnValue({ changes: 1 });
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  function createRequest(params: Record<string, string>): NextRequest {
    const url = new URL('http://localhost:3000/api/github/callback');
    Object.entries(params).forEach(([key, value]) => {
      url.searchParams.set(key, value);
    });
    return new NextRequest(url);
  }

  describe('state validation (before any DB access)', () => {
    it('SECURITY: rejects request with missing state parameter', async () => {
      const request = createRequest({
        installation_id: '12345',
        setup_action: 'install',
      });
      const response = await GET(request);

      expect(response.status).toBe(307);
      const location = response.headers.get('location');
      expect(location).toContain('/settings');
      expect(location).toContain('error=missing_state');

      // Verify NO database calls were made (state validated first)
      expect(mockDb.prepare).not.toHaveBeenCalled();
    });

    it('SECURITY: rejects request with invalid state signature', async () => {
      const request = createRequest({
        installation_id: '12345',
        setup_action: 'install',
        state: 'invalid.signature',
      });
      const response = await GET(request);

      expect(response.status).toBe(307);
      const location = response.headers.get('location');
      expect(location).toContain('/settings');
      expect(location).toContain('error=invalid_state');

      // Verify NO database calls were made
      expect(mockDb.prepare).not.toHaveBeenCalled();
    });

    it('SECURITY: rejects request with state missing userId', async () => {
      // Create state without userId
      const { createSignedState } = await import('@/lib/auth/oauth-state');
      const stateWithoutUser = createSignedState('/projects/new'); // No userId passed

      const request = createRequest({
        installation_id: '12345',
        setup_action: 'install',
        state: stateWithoutUser,
      });
      const response = await GET(request);

      expect(response.status).toBe(307);
      const location = response.headers.get('location');
      expect(location).toContain('/settings');
      expect(location).toContain('error=missing_user');

      // Verify NO database calls were made
      expect(mockDb.prepare).not.toHaveBeenCalled();
    });

    it('SECURITY: rejects request with tampered state payload', async () => {
      const tamperedPayload = Buffer.from(
        JSON.stringify({
          redirect: '/projects/new',
          userId: 'hacker_user',
          nonce: 'fake',
          timestamp: Date.now(),
        })
      ).toString('base64url');
      const fakeSignature = 'a'.repeat(64);

      const request = createRequest({
        installation_id: '12345',
        setup_action: 'install',
        state: `${tamperedPayload}.${fakeSignature}`,
      });
      const response = await GET(request);

      expect(response.status).toBe(307);
      const location = response.headers.get('location');
      expect(location).toContain('error=invalid_state');

      // Verify NO database calls were made
      expect(mockDb.prepare).not.toHaveBeenCalled();
    });

    it('SECURITY: rejects expired state before database access', async () => {
      const { createSignedState } = await import('@/lib/auth/oauth-state');

      // Create state 15 minutes in the past
      const pastTime = Date.now() - 15 * 60 * 1000;
      vi.spyOn(Date, 'now').mockReturnValueOnce(pastTime);
      const expiredState = createSignedState('/projects/new', 'user_123');
      vi.restoreAllMocks();

      const request = createRequest({
        installation_id: '12345',
        setup_action: 'install',
        state: expiredState,
      });
      const response = await GET(request);

      expect(response.status).toBe(307);
      const location = response.headers.get('location');
      expect(location).toContain('error=invalid_state');

      // Verify NO database calls were made
      expect(mockDb.prepare).not.toHaveBeenCalled();
    });
  });

  describe('cross-user installation ownership', () => {
    it('SECURITY: allows redirect to own project when installation exists', async () => {
      const { createSignedState } = await import('@/lib/auth/oauth-state');
      const validState = createSignedState('/projects/new', 'user_owner');

      // Installation already belongs to this user's project
      mockStmt.get.mockReturnValue({
        project_id: 'proj_123',
        user_id: 'user_owner',
      });

      const request = createRequest({
        installation_id: '12345',
        setup_action: 'install',
        state: validState,
      });
      const response = await GET(request);

      expect(response.status).toBe(307);
      const location = response.headers.get('location');
      expect(location).toContain('/projects/proj_123');
      expect(location).toContain('github_connected=true');
      expect(location).not.toContain('error');
    });

    it('SECURITY: rejects when installation belongs to different user', async () => {
      const { createSignedState } = await import('@/lib/auth/oauth-state');
      const validState = createSignedState('/projects/new', 'user_attacker');

      // Installation belongs to a different user's project
      mockStmt.get.mockReturnValue({
        project_id: 'proj_123',
        user_id: 'user_victim', // Different user!
      });

      const request = createRequest({
        installation_id: '12345',
        setup_action: 'install',
        state: validState,
      });
      const response = await GET(request);

      expect(response.status).toBe(307);
      const location = response.headers.get('location');
      expect(location).toContain('/settings');
      expect(location).toContain('error=installation_owned');
      // Should NOT redirect to the victim's project
      expect(location).not.toContain('/projects/proj_123');
    });
  });

  describe('successful flow with valid state', () => {
    it('creates pending installation for valid state with userId', async () => {
      const { createSignedState } = await import('@/lib/auth/oauth-state');
      const validState = createSignedState('/projects/new', 'user_123');

      // No existing project
      mockStmt.get.mockReturnValue(undefined);

      const request = createRequest({
        installation_id: '12345',
        setup_action: 'install',
        state: validState,
      });
      const response = await GET(request);

      expect(response.status).toBe(307);
      const location = response.headers.get('location');
      expect(location).toContain('/projects/new');
      expect(location).toContain('installation_id=12345');
      expect(location).not.toContain('error');

      // Verify database was accessed AFTER state validation
      expect(mockDb.prepare).toHaveBeenCalled();
    });

    it('uses verified redirect from state', async () => {
      const { createSignedState } = await import('@/lib/auth/oauth-state');
      const validState = createSignedState('/custom/redirect', 'user_123');

      mockStmt.get.mockReturnValue(undefined);

      const request = createRequest({
        installation_id: '12345',
        setup_action: 'install',
        state: validState,
      });
      const response = await GET(request);

      expect(response.status).toBe(307);
      const location = response.headers.get('location');
      expect(location).toContain('/custom/redirect');
      expect(location).toContain('installation_id=12345');
    });
  });

  describe('missing installation_id', () => {
    it('rejects request with missing installation_id', async () => {
      const { createSignedState } = await import('@/lib/auth/oauth-state');
      const validState = createSignedState('/projects/new', 'user_123');

      const request = createRequest({
        setup_action: 'install',
        state: validState,
      });
      const response = await GET(request);

      expect(response.status).toBe(307);
      const location = response.headers.get('location');
      expect(location).toContain('/settings');
      expect(location).toContain('error=missing_installation_id');
    });
  });
});
