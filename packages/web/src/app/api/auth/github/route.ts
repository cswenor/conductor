/**
 * GitHub OAuth Login
 *
 * Redirects to GitHub for OAuth authentication.
 */

import { NextRequest, NextResponse } from 'next/server';
import { createLogger } from '@conductor/shared';
import { createSignedState, isValidRedirect } from '@/lib/auth/oauth-state';

const log = createLogger({ name: 'conductor:auth:github' });

/**
 * GET /api/auth/github
 *
 * Redirect to GitHub OAuth.
 * Query params:
 * - redirect: URL to redirect to after login (default: /)
 */
export function GET(request: NextRequest): NextResponse {

  // Check if GitHub OAuth is configured
  const clientId = process.env['GITHUB_CLIENT_ID'];
  if (clientId === undefined || clientId === '') {
    log.error('GitHub OAuth client ID not configured');
    return NextResponse.json(
      { error: 'GitHub OAuth not configured' },
      { status: 503 }
    );
  }

  const searchParams = request.nextUrl.searchParams;
  const redirectTo = searchParams.get('redirect') ?? '/';

  // Validate redirect URL
  const safeRedirect = isValidRedirect(redirectTo) ? redirectTo : '/';

  // Create signed state with redirect URL
  const state = createSignedState(safeRedirect);

  // Build GitHub OAuth URL
  // Scopes: read:user for profile info
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: `${request.nextUrl.origin}/api/auth/github/callback`,
    scope: 'read:user',
    state,
  });

  const githubOAuthUrl = `https://github.com/login/oauth/authorize?${params.toString()}`;

  log.info({ redirectTo: safeRedirect }, 'Redirecting to GitHub OAuth');

  return NextResponse.redirect(githubOAuthUrl);
}
