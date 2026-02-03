/**
 * OAuth State Security Tests
 *
 * Tests for signed state token generation and verification.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createSignedState, verifySignedState, isValidRedirect } from './oauth-state';

describe('oauth-state', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    // Set required environment variable for tests
    process.env = { ...originalEnv, GITHUB_WEBHOOK_SECRET: 'test-secret-32-bytes-long-enough' };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('createSignedState', () => {
    it('creates a signed state token with redirect', () => {
      const state = createSignedState('/dashboard');
      expect(state).toBeDefined();
      expect(state).toContain('.'); // payload.signature format
    });

    it('creates a signed state token with userId', () => {
      const state = createSignedState('/dashboard', 'user_123');
      expect(state).toBeDefined();

      const verified = verifySignedState(state);
      expect(verified).not.toBeNull();
      expect(verified?.userId).toBe('user_123');
      expect(verified?.redirect).toBe('/dashboard');
    });
  });

  describe('verifySignedState', () => {
    it('verifies a valid state token', () => {
      const state = createSignedState('/projects', 'user_456');
      const verified = verifySignedState(state);

      expect(verified).not.toBeNull();
      expect(verified?.redirect).toBe('/projects');
      expect(verified?.userId).toBe('user_456');
    });

    it('returns null for malformed state (no dot separator)', () => {
      const verified = verifySignedState('invalid-state-no-dot');
      expect(verified).toBeNull();
    });

    it('returns null for tampered payload', () => {
      const state = createSignedState('/dashboard', 'user_123');
      const [, signature] = state.split('.');

      // Create a tampered payload
      const tamperedPayload = Buffer.from(
        JSON.stringify({ redirect: '/admin', userId: 'hacker', nonce: 'fake', timestamp: Date.now() })
      ).toString('base64url');

      const tamperedState = `${tamperedPayload}.${signature}`;
      const verified = verifySignedState(tamperedState);

      expect(verified).toBeNull();
    });

    it('returns null for tampered signature', () => {
      const state = createSignedState('/dashboard', 'user_123');
      const [payload] = state.split('.');

      const tamperedState = `${payload}.tampered-signature`;
      const verified = verifySignedState(tamperedState);

      expect(verified).toBeNull();
    });

    it('returns null for expired state', () => {
      // Create state with mocked Date.now
      const originalDateNow = Date.now;
      const pastTime = Date.now() - 15 * 60 * 1000; // 15 minutes ago
      vi.spyOn(Date, 'now').mockReturnValueOnce(pastTime);

      const state = createSignedState('/dashboard');

      // Restore Date.now for verification
      vi.spyOn(Date, 'now').mockReturnValue(originalDateNow());

      // State should be expired (default maxAge is 10 minutes)
      const verified = verifySignedState(state);
      expect(verified).toBeNull();

      vi.restoreAllMocks();
    });

    it('returns null for empty string', () => {
      expect(verifySignedState('')).toBeNull();
    });

    it('returns null for state with wrong number of parts', () => {
      expect(verifySignedState('a.b.c')).toBeNull();
      expect(verifySignedState('a')).toBeNull();
    });
  });

  describe('getStateSecret requirement', () => {
    it('throws error when secret is not configured', () => {
      // Remove the secret
      delete process.env['OAUTH_STATE_SECRET'];
      delete process.env['GITHUB_WEBHOOK_SECRET'];

      expect(() => createSignedState('/test')).toThrow(
        'OAUTH_STATE_SECRET or GITHUB_WEBHOOK_SECRET must be set'
      );
    });

    it('throws error when secret is empty string', () => {
      process.env['GITHUB_WEBHOOK_SECRET'] = '';
      delete process.env['OAUTH_STATE_SECRET'];

      expect(() => createSignedState('/test')).toThrow(
        'OAUTH_STATE_SECRET or GITHUB_WEBHOOK_SECRET must be set'
      );
    });
  });

  describe('isValidRedirect', () => {
    it('accepts valid relative paths', () => {
      expect(isValidRedirect('/')).toBe(true);
      expect(isValidRedirect('/dashboard')).toBe(true);
      expect(isValidRedirect('/projects/123')).toBe(true);
      expect(isValidRedirect('/path?query=value')).toBe(true);
    });

    it('rejects paths not starting with /', () => {
      expect(isValidRedirect('dashboard')).toBe(false);
      expect(isValidRedirect('https://evil.com')).toBe(false);
    });

    it('rejects protocol-relative URLs', () => {
      expect(isValidRedirect('//evil.com')).toBe(false);
      expect(isValidRedirect('//evil.com/path')).toBe(false);
    });

    it('rejects URLs with protocols', () => {
      expect(isValidRedirect('javascript:alert(1)')).toBe(false);
      expect(isValidRedirect('data:text/html,<script>')).toBe(false);
    });

    it('rejects backslash URLs', () => {
      expect(isValidRedirect('/path\\evil')).toBe(false);
      expect(isValidRedirect('\\\\evil.com')).toBe(false);
    });
  });
});
