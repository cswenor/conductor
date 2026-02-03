/**
 * GitHub App Installation Initiation
 *
 * Redirects users to GitHub to install the Conductor GitHub App.
 */

import { NextRequest, NextResponse } from 'next/server';

// Prevent static prerendering since this depends on runtime config
export const dynamic = 'force-dynamic';
import { getConfig } from '@/lib/config';
import { createLogger } from '@conductor/shared';
import { createSignedState, isValidRedirect } from '@/lib/auth/oauth-state';

const log = createLogger({ name: 'conductor:github-install' });

/**
 * GET /api/github/install
 *
 * Redirects to GitHub App installation page.
 * Optional query params:
 * - target_id: GitHub org/user ID to pre-select
 * - state: Optional state to pass through the flow
 */
export function GET(request: NextRequest): NextResponse {
  const config = getConfig();

  if (config.githubAppId === '') {
    log.error('GitHub App ID not configured');
    return NextResponse.json(
      { error: 'GitHub App not configured' },
      { status: 500 }
    );
  }

  const searchParams = request.nextUrl.searchParams;
  const targetId = searchParams.get('target_id');
  const redirectTo = searchParams.get('redirect') ?? '/projects/new';

  // Build the GitHub App installation URL
  // Format: https://github.com/apps/{app-name}/installations/new
  // Or for a specific target: https://github.com/apps/{app-name}/installations/new/permissions?target_id={id}
  const appSlug = config.githubAppSlug ?? 'conductor';
  let installUrl = `https://github.com/apps/${appSlug}/installations/new`;

  const params = new URLSearchParams();
  if (targetId !== null) {
    params.set('target_id', targetId);
  }

  // Create signed state token if redirect is valid
  if (isValidRedirect(redirectTo)) {
    const signedState = createSignedState(redirectTo);
    params.set('state', signedState);
  }

  if (params.toString() !== '') {
    installUrl += `?${params.toString()}`;
  }

  log.info({ appSlug, targetId, redirectTo }, 'Redirecting to GitHub App installation');

  return NextResponse.redirect(installUrl);
}
