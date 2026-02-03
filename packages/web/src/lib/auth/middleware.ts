/**
 * Auth Middleware
 *
 * Provides authentication guards for API routes.
 */

import { NextRequest, NextResponse } from 'next/server';
import { createLogger, validateSession, type User } from '@conductor/shared';
import { getDb } from '@/lib/bootstrap';

const log = createLogger({ name: 'conductor:auth' });

/** Cookie name for session token */
export const SESSION_COOKIE_NAME = 'conductor_session';

export interface AuthUser {
  id: string;
  githubId: number;
  githubLogin: string;
  githubNodeId: string;
  githubName: string | null;
  githubAvatarUrl: string | null;
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
 * Convert shared User type to AuthUser
 */
function userToAuthUser(user: User): AuthUser {
  return {
    id: user.userId,
    githubId: user.githubId,
    githubLogin: user.githubLogin,
    githubNodeId: user.githubNodeId,
    githubName: user.githubName,
    githubAvatarUrl: user.githubAvatarUrl,
  };
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
    const authRequest = request as AuthenticatedRequest;

    // Try to get user from session cookie
    const sessionToken = request.cookies.get(SESSION_COOKIE_NAME)?.value;

    if (sessionToken !== undefined) {
      try {
        const db = await getDb();
        const user = validateSession(db, sessionToken);

        if (user !== null) {
          authRequest.user = userToAuthUser(user);
          log.debug({ userId: user.userId }, 'Request authenticated via session');
        }
      } catch (err) {
        log.error(
          { error: err instanceof Error ? err.message : 'Unknown error' },
          'Session validation failed'
        );
      }
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
