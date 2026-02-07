/**
 * OAuth Login Callback Security Tests
 *
 * Tests that the OAuth login callback properly enforces state validation.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { GET } from './route';

// Mock dependencies
vi.mock('@/lib/bootstrap', () => ({
  ensureBootstrap: vi.fn().mockResolvedValue(undefined),
  getDb: vi.fn().mockResolvedValue({
    prepare: vi.fn().mockReturnValue({
      get: vi.fn(),
      run: vi.fn(),
    }),
  }),
}));

vi.mock('@conductor/shared', () => ({
  createLogger: vi.fn().mockReturnValue({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
  createUser: vi.fn().mockReturnValue({
    userId: 'user_test123',
    githubId: 12345,
    githubLogin: 'testuser',
  }),
  getUserByGithubId: vi.fn().mockReturnValue(null),
  updateUser: vi.fn(),
  updateUserLastLogin: vi.fn(),
  createSession: vi.fn().mockReturnValue({
    sessionId: 'sess_test123',
    token: 'test-token',
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
  }),
}));

// Mock fetch for GitHub API calls
global.fetch = vi.fn();

describe('OAuth Login Callback Security', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      GITHUB_WEBHOOK_SECRET: 'test-secret-32-bytes-long-enough',
      GITHUB_CLIENT_ID: 'test-client-id',
      GITHUB_CLIENT_SECRET: 'test-client-secret',
    };
    vi.clearAllMocks();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  function createRequest(params: Record<string, string>): NextRequest {
    const url = new URL('http://localhost:3000/api/auth/github/callback');
    Object.entries(params).forEach(([key, value]) => {
      url.searchParams.set(key, value);
    });
    return new NextRequest(url, {
      headers: { 'user-agent': 'test' },
    });
  }

  describe('state validation', () => {
    it('SECURITY: rejects request with missing state parameter', async () => {
      const request = createRequest({ code: 'test-code' });
      const response = await GET(request);

      expect(response.status).toBe(307); // redirect
      const location = response.headers.get('location');
      expect(location).toContain('/login');
      expect(location).toContain('error=missing_state');
    });

    it('SECURITY: rejects request with invalid state signature', async () => {
      const request = createRequest({
        code: 'test-code',
        state: 'invalid.signature',
      });
      const response = await GET(request);

      expect(response.status).toBe(307);
      const location = response.headers.get('location');
      expect(location).toContain('/login');
      expect(location).toContain('error=invalid_state');
    });

    it('SECURITY: rejects request with tampered state payload', async () => {
      // Create a state with tampered payload but original signature format
      const tamperedPayload = Buffer.from(
        JSON.stringify({ redirect: '/admin', nonce: 'fake', timestamp: Date.now() })
      ).toString('base64url');
      const fakeSignature = 'a'.repeat(64); // fake hex signature

      const request = createRequest({
        code: 'test-code',
        state: `${tamperedPayload}.${fakeSignature}`,
      });
      const response = await GET(request);

      expect(response.status).toBe(307);
      const location = response.headers.get('location');
      expect(location).toContain('/login');
      expect(location).toContain('error=invalid_state');
    });

    it('SECURITY: rejects request with expired state', async () => {
      // Create an expired state by mocking Date.now
      const { createSignedState } = await import('@/lib/auth/oauth-state');

      // Create state 15 minutes in the past
      const pastTime = Date.now() - 15 * 60 * 1000;
      vi.spyOn(Date, 'now').mockReturnValueOnce(pastTime);
      const expiredState = createSignedState('/dashboard');
      vi.restoreAllMocks();

      const request = createRequest({
        code: 'test-code',
        state: expiredState,
      });
      const response = await GET(request);

      expect(response.status).toBe(307);
      const location = response.headers.get('location');
      expect(location).toContain('/login');
      expect(location).toContain('error=invalid_state');
    });
  });

  describe('successful flow with valid state', () => {
    it('accepts request with valid state and proceeds with login', async () => {
      const { createSignedState } = await import('@/lib/auth/oauth-state');
      const validState = createSignedState('/dashboard');

      // Mock successful GitHub API responses
      (global.fetch as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({
          json: () => Promise.resolve({ access_token: 'test-token', token_type: 'bearer' }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () =>
            Promise.resolve({
              id: 12345,
              node_id: 'node_12345',
              login: 'testuser',
              name: 'Test User',
              email: 'test@example.com',
              avatar_url: 'https://github.com/avatar.png',
            }),
        });

      const request = createRequest({
        code: 'valid-code',
        state: validState,
      });
      const response = await GET(request);

      expect(response.status).toBe(307);
      const location = response.headers.get('location');
      expect(location).toContain('/dashboard'); // redirect from state
      expect(location).not.toContain('error');

      // Should set session cookie
      const setCookie = response.headers.get('set-cookie');
      expect(setCookie).toContain('conductor_session');
    });

    it('forwards to install handler with userId-bearing state when installation_id is present', async () => {
      const { createSignedState, verifySignedState } = await import('@/lib/auth/oauth-state');
      // Original OAuth state has no userId (created before login)
      const oauthState = createSignedState('/projects');

      // Mock successful GitHub API responses
      (global.fetch as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({
          json: () => Promise.resolve({ access_token: 'test-token', token_type: 'bearer' }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () =>
            Promise.resolve({
              id: 12345,
              node_id: 'node_12345',
              login: 'testuser',
              name: 'Test User',
              email: 'test@example.com',
              avatar_url: 'https://github.com/avatar.png',
            }),
        });

      const request = createRequest({
        code: 'valid-code',
        state: oauthState,
        installation_id: '99999',
        setup_action: 'install',
      });
      const response = await GET(request);

      expect(response.status).toBe(307);
      const location = response.headers.get('location');
      expect(location).toContain('/api/github/callback');
      expect(location).toContain('installation_id=99999');
      expect(location).toContain('setup_action=install');

      // The forwarded state should include userId
      const locationUrl = new URL(location ?? '', 'http://localhost:3000');
      const forwardedState = locationUrl.searchParams.get('state');
      expect(forwardedState).not.toBeNull();
      const verified = verifySignedState(forwardedState ?? '');
      expect(verified).not.toBeNull();
      expect(verified?.userId).toBe('user_test123');
    });
  });
});
