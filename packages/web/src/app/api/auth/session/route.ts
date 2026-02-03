/**
 * Session API
 *
 * Get current session / logout.
 */

import { NextRequest, NextResponse } from 'next/server';
import {
  createLogger,
  validateSession,
  deleteSession,
} from '@conductor/shared';
import { getDb, ensureBootstrap } from '@/lib/bootstrap';
import { SESSION_COOKIE_NAME } from '@/lib/auth';

const log = createLogger({ name: 'conductor:api:session' });

/**
 * GET /api/auth/session
 *
 * Get the current session/user.
 * Returns null if not authenticated.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    await ensureBootstrap();

    const sessionToken = request.cookies.get(SESSION_COOKIE_NAME)?.value;

    if (sessionToken === undefined) {
      return NextResponse.json({ user: null });
    }

    const db = await getDb();
    const user = validateSession(db, sessionToken);

    if (user === null) {
      // Session invalid or expired - clear the cookie
      const response = NextResponse.json({ user: null });
      response.cookies.delete(SESSION_COOKIE_NAME);
      return response;
    }

    return NextResponse.json({
      user: {
        id: user.userId,
        githubId: user.githubId,
        githubLogin: user.githubLogin,
        githubName: user.githubName,
        githubAvatarUrl: user.githubAvatarUrl,
      },
    });
  } catch (err) {
    log.error(
      { error: err instanceof Error ? err.message : 'Unknown error' },
      'Failed to get session'
    );
    return NextResponse.json(
      { error: 'Failed to get session' },
      { status: 500 }
    );
  }
}

/**
 * DELETE /api/auth/session
 *
 * Logout - delete the current session.
 */
export async function DELETE(request: NextRequest): Promise<NextResponse> {
  try {
    await ensureBootstrap();

    const sessionToken = request.cookies.get(SESSION_COOKIE_NAME)?.value;

    if (sessionToken !== undefined) {
      const db = await getDb();
      deleteSession(db, sessionToken);
      log.info('User logged out');
    }

    // Clear the cookie
    const response = NextResponse.json({ success: true });
    response.cookies.delete(SESSION_COOKIE_NAME);
    return response;
  } catch (err) {
    log.error(
      { error: err instanceof Error ? err.message : 'Unknown error' },
      'Failed to logout'
    );
    return NextResponse.json(
      { error: 'Failed to logout' },
      { status: 500 }
    );
  }
}
