/**
 * OAuth State Management
 *
 * Provides signed state tokens for OAuth flows to prevent CSRF and tampering.
 */

import { createHmac, randomBytes } from 'crypto';

// Use a secret from env or generate one for the session
// In production, this MUST be set via environment variable
const STATE_SECRET = process.env['OAUTH_STATE_SECRET'] ?? process.env['GITHUB_WEBHOOK_SECRET'] ?? 'dev-secret-change-me';

interface StatePayload {
  redirect: string;
  nonce: string;
  timestamp: number;
  userId?: string;
}

export interface VerifiedState {
  redirect: string;
  userId?: string;
}

/**
 * Creates a signed state token for OAuth flows.
 * The token contains the redirect URL, optional userId, a nonce, and timestamp.
 */
export function createSignedState(redirect: string, userId?: string): string {
  const payload: StatePayload = {
    redirect,
    nonce: randomBytes(16).toString('hex'),
    timestamp: Date.now(),
    userId,
  };

  const data = JSON.stringify(payload);
  const signature = createHmac('sha256', STATE_SECRET)
    .update(data)
    .digest('hex');

  // Encode as base64url: payload.signature
  const encodedPayload = Buffer.from(data).toString('base64url');
  return `${encodedPayload}.${signature}`;
}

/**
 * Verifies and decodes a signed state token.
 * Returns the verified state with redirect URL and userId if valid, null otherwise.
 *
 * @param state - The signed state token
 * @param maxAgeMs - Maximum age of the state in milliseconds (default: 10 minutes)
 */
export function verifySignedState(state: string, maxAgeMs: number = 10 * 60 * 1000): VerifiedState | null {
  try {
    const parts = state.split('.');
    if (parts.length !== 2) {
      return null;
    }

    const [encodedPayload, signature] = parts;
    if (encodedPayload === undefined || signature === undefined) {
      return null;
    }

    // Verify signature
    const data = Buffer.from(encodedPayload, 'base64url').toString('utf-8');
    const expectedSignature = createHmac('sha256', STATE_SECRET)
      .update(data)
      .digest('hex');

    if (signature !== expectedSignature) {
      return null;
    }

    // Parse and validate payload
    const payload = JSON.parse(data) as StatePayload;

    // Check timestamp (prevent replay attacks)
    if (Date.now() - payload.timestamp > maxAgeMs) {
      return null;
    }

    return {
      redirect: payload.redirect,
      userId: payload.userId,
    };
  } catch {
    return null;
  }
}

/**
 * Validates that a redirect URL is safe (relative path only).
 * Prevents open redirect attacks.
 */
export function isValidRedirect(url: string): boolean {
  // Must start with /
  if (!url.startsWith('/')) return false;
  // Prevent protocol-relative URLs (//evil.com)
  if (url.startsWith('//')) return false;
  // Block any URL with a colon before the first slash (javascript:, data:, etc.)
  const colonIndex = url.indexOf(':');
  const slashIndex = url.indexOf('/', 1); // Skip the leading /
  if (colonIndex !== -1 && (slashIndex === -1 || colonIndex < slashIndex)) return false;
  // Block backslash (some browsers treat \\ as //)
  if (url.includes('\\')) return false;
  return true;
}
