/**
 * Development Auth Endpoint
 *
 * Creates a session for the development user.
 * Only available in development mode.
 */

import { NextRequest, NextResponse } from 'next/server';
import { createLogger, createDevSession } from '@conductor/shared';
import { ensureBootstrap, getDb } from '@/lib/bootstrap';
import { SESSION_COOKIE_NAME } from '@/lib/auth';

const log = createLogger({ name: 'conductor:auth:dev' });

/**
 * GET /api/auth/dev
 *
 * Creates a development session and sets the session cookie.
 * Redirects to the specified redirect URL or homepage.
 * Returns 404 in production.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  // Only available in development mode
  if (process.env.NODE_ENV !== 'development') {
    return NextResponse.json(
      { error: 'Not found' },
      { status: 404 }
    );
  }

  try {
    await ensureBootstrap();
    const db = await getDb();

    // Create dev session
    const { token, expiresAt } = createDevSession(db);

    // Get redirect URL from query params (default to homepage)
    const redirect = request.nextUrl.searchParams.get('redirect') ?? '/';

    log.info({ redirect }, 'Development session created, redirecting');

    // Create redirect response with session cookie
    const response = NextResponse.redirect(new URL(redirect, request.url));

    response.cookies.set(SESSION_COOKIE_NAME, token, {
      httpOnly: true,
      secure: false, // Not needed in development
      sameSite: 'lax',
      path: '/',
      expires: new Date(expiresAt),
    });

    return response;
  } catch (err) {
    log.error(
      { error: err instanceof Error ? err.message : 'Unknown error' },
      'Failed to create development session'
    );
    return NextResponse.json(
      { error: 'Failed to create development session' },
      { status: 500 }
    );
  }
}
