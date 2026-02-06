/**
 * GitHub OAuth Callback
 *
 * Handles the callback from GitHub OAuth, creates/updates user, and creates session.
 */

import { NextRequest, NextResponse } from 'next/server';
import {
  createLogger,
  createUser,
  getUserByGithubId,
  updateUser,
  updateUserLastLogin,
  createSession,
} from '@conductor/shared';
import { ensureBootstrap, getDb } from '@/lib/bootstrap';
import { verifySignedState } from '@/lib/auth/oauth-state';
import { SESSION_COOKIE_NAME } from '@/lib/auth';

const log = createLogger({ name: 'conductor:auth:github:callback' });

interface GitHubTokenResponse {
  access_token: string;
  token_type: string;
  scope: string;
  error?: string;
  error_description?: string;
}

interface GitHubUser {
  id: number;
  node_id: string;
  login: string;
  name: string | null;
  email: string | null;
  avatar_url: string;
}

/**
 * GET /api/auth/github/callback
 *
 * Handle GitHub OAuth callback.
 * Query params from GitHub:
 * - code: Authorization code
 * - state: Signed state with redirect URL
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const searchParams = request.nextUrl.searchParams;
  const code = searchParams.get('code');
  const state = searchParams.get('state');
  const error = searchParams.get('error');

  // Handle OAuth errors
  if (error !== null) {
    log.warn({ error, description: searchParams.get('error_description') }, 'GitHub OAuth error');
    return NextResponse.redirect(new URL('/login?error=oauth_denied', request.url));
  }

  if (code === null) {
    log.warn('Missing authorization code');
    return NextResponse.redirect(new URL('/login?error=missing_code', request.url));
  }

  // SECURITY: Require valid signed state to prevent CSRF attacks
  if (state === null) {
    log.warn('Missing state parameter - rejecting OAuth callback');
    return NextResponse.redirect(new URL('/login?error=missing_state', request.url));
  }

  const verifiedState = verifySignedState(state);
  if (verifiedState === null) {
    log.warn('Invalid or expired state token - rejecting OAuth callback');
    return NextResponse.redirect(new URL('/login?error=invalid_state', request.url));
  }

  const redirectTo = verifiedState.redirect;

  try {
    await ensureBootstrap();
    const db = await getDb();

    // Exchange code for access token
    const clientId = process.env['GITHUB_CLIENT_ID'];
    const clientSecret = process.env['GITHUB_CLIENT_SECRET'];

    if (clientId === undefined || clientSecret === undefined) {
      log.error('GitHub OAuth credentials not configured');
      return NextResponse.redirect(new URL('/login?error=config_error', request.url));
    }

    const tokenResponse = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify({
        client_id: clientId,
        client_secret: clientSecret,
        code,
      }),
    });

    const tokenData = await tokenResponse.json() as GitHubTokenResponse;

    if (tokenData.error !== undefined) {
      log.error({ error: tokenData.error, description: tokenData.error_description }, 'Token exchange failed');
      return NextResponse.redirect(new URL('/login?error=token_error', request.url));
    }

    // Fetch user info from GitHub
    const userResponse = await fetch('https://api.github.com/user', {
      headers: {
        'Authorization': `Bearer ${tokenData.access_token}`,
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'Conductor Core',
      },
    });

    if (!userResponse.ok) {
      log.error({ status: userResponse.status }, 'Failed to fetch GitHub user');
      return NextResponse.redirect(new URL('/login?error=user_fetch_error', request.url));
    }

    const githubUser = await userResponse.json() as GitHubUser;

    // Find or create user
    let user = getUserByGithubId(db, githubUser.id);

    if (user === null) {
      // Create new user
      user = createUser(db, {
        githubId: githubUser.id,
        githubNodeId: githubUser.node_id,
        githubLogin: githubUser.login,
        githubName: githubUser.name ?? undefined,
        githubEmail: githubUser.email ?? undefined,
        githubAvatarUrl: githubUser.avatar_url,
        githubAccessToken: tokenData.access_token,
      });
      log.info({ userId: user.userId, githubLogin: user.githubLogin }, 'New user created via OAuth');
    } else {
      // Update existing user
      updateUser(db, user.userId, {
        githubLogin: githubUser.login,
        githubName: githubUser.name ?? undefined,
        githubEmail: githubUser.email ?? undefined,
        githubAvatarUrl: githubUser.avatar_url,
        githubAccessToken: tokenData.access_token,
      });
      updateUserLastLogin(db, user.userId);
      log.info({ userId: user.userId, githubLogin: user.githubLogin }, 'Existing user logged in via OAuth');
    }

    // Create session
    const session = createSession(db, user.userId, {
      userAgent: request.headers.get('user-agent') ?? undefined,
      ipAddress: request.headers.get('x-forwarded-for') ?? request.headers.get('x-real-ip') ?? undefined,
    });

    // If this is also a GitHub App installation callback (GitHub combines OAuth
    // + installation when the Setup URL points here), forward to the dedicated
    // installation handler so the installation_id gets recorded.
    const installationId = searchParams.get('installation_id');
    let finalRedirect: string;

    if (installationId !== null) {
      const installCallbackUrl = new URL('/api/github/callback', request.url);
      installCallbackUrl.searchParams.set('installation_id', installationId);
      const setupAction = searchParams.get('setup_action');
      if (setupAction !== null) {
        installCallbackUrl.searchParams.set('setup_action', setupAction);
      }
      if (state !== null) {
        installCallbackUrl.searchParams.set('state', state);
      }
      finalRedirect = installCallbackUrl.pathname + installCallbackUrl.search;
      log.info({ installationId, userId: user.userId }, 'OAuth callback includes installation_id — forwarding to installation handler');
    } else {
      finalRedirect = redirectTo;
    }

    // Redirect with session cookie
    const response = NextResponse.redirect(new URL(finalRedirect, request.url));
    response.cookies.set(SESSION_COOKIE_NAME, session.token, {
      httpOnly: true,
      secure: process.env['NODE_ENV'] === 'production',
      sameSite: 'lax',
      path: '/',
      expires: new Date(session.expiresAt),
    });

    return response;
  } catch (err) {
    log.error(
      { error: err instanceof Error ? err.message : 'Unknown error' },
      'OAuth callback processing failed'
    );
    return NextResponse.redirect(new URL('/login?error=server_error', request.url));
  }
}
