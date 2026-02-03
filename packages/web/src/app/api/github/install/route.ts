/**
 * GitHub App Installation Initiation
 *
 * Redirects users to GitHub to install the Conductor GitHub App.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getConfig } from '@/lib/config';
import { createLogger } from '@conductor/shared';

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
  const state = searchParams.get('state');

  // Build the GitHub App installation URL
  // Format: https://github.com/apps/{app-name}/installations/new
  // Or for a specific target: https://github.com/apps/{app-name}/installations/new/permissions?target_id={id}
  const appSlug = config.githubAppSlug ?? 'conductor';
  let installUrl = `https://github.com/apps/${appSlug}/installations/new`;

  const params = new URLSearchParams();
  if (targetId !== null) {
    params.set('target_id', targetId);
  }
  if (state !== null) {
    params.set('state', state);
  }

  if (params.toString() !== '') {
    installUrl += `?${params.toString()}`;
  }

  log.info({ appSlug, targetId, hasState: state !== null }, 'Redirecting to GitHub App installation');

  return NextResponse.redirect(installUrl);
}
