/**
 * Auth Middleware
 *
 * Provides authentication guards for API routes.
 * Currently a placeholder that allows all requests in development mode.
 * Will be fully implemented in WP13-A.
 */

import { NextRequest, NextResponse } from 'next/server';
import { createLogger } from '@conductor/shared';

const log = createLogger({ name: 'conductor:auth' });

export interface AuthUser {
  id: string;
  githubId: number;
  githubLogin: string;
  githubNodeId: string;
}

export interface AuthenticatedRequest extends NextRequest {
  user?: AuthUser;
}

/**
 * Check if the current environment allows unauthenticated access.
 * In development mode, we allow unauthenticated access for easier testing.
 * In production, authentication is required.
 */
function allowUnauthenticated(): boolean {
  return process.env['NODE_ENV'] === 'development';
}

/**
 * Wrap an API route handler with authentication.
 * Returns 401 if not authenticated (in production).
 *
 * Usage:
 * ```ts
 * export const GET = withAuth(async (request, context) => {
 *   // request.user is available here
 *   return NextResponse.json({ ... });
 * });
 * ```
 */
export function withAuth<T extends { params: Promise<Record<string, string>> }>(
  handler: (request: AuthenticatedRequest, context: T) => Promise<NextResponse>
): (request: NextRequest, context: T) => Promise<NextResponse> {
  return async (request: NextRequest, context: T) => {
    // TODO: Implement actual session checking (WP13-A)
    // For now:
    // - In development: allow all requests
    // - In production: require authentication (currently will 401)

    const authRequest = request as AuthenticatedRequest;

    // Try to get user from session cookie
    // This is a placeholder - real implementation in WP13-A
    const sessionCookie = request.cookies.get('conductor_session');

    if (sessionCookie !== undefined) {
      // TODO: Validate session and load user from database
      // For now, this is just a placeholder
      log.debug({ hasSession: true }, 'Session cookie found (validation not yet implemented)');
    }

    // If no authenticated user
    if (authRequest.user === undefined) {
      if (allowUnauthenticated()) {
        // Development mode: allow request without auth
        log.debug('Allowing unauthenticated request in development mode');
        return handler(authRequest, context);
      }

      // Production mode: require authentication
      log.warn({ path: request.nextUrl.pathname }, 'Unauthenticated request rejected');
      return NextResponse.json(
        { error: 'Authentication required' },
        { status: 401 }
      );
    }

    return handler(authRequest, context);
  };
}

/**
 * Get the current user from a request.
 * Returns undefined if not authenticated.
 */
export function getUser(request: NextRequest): AuthUser | undefined {
  return (request as AuthenticatedRequest).user;
}

/**
 * Export index file
 */
export * from './oauth-state';
