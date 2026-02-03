/**
 * GitHub App Installation Callback
 *
 * Handles the callback from GitHub after app installation.
 * GitHub sends an installation_id which we use to access the installed org/repos.
 */

import { NextRequest, NextResponse } from 'next/server';
import { createLogger } from '@conductor/shared';
import { ensureBootstrap, getDb } from '@/lib/bootstrap';
import { verifySignedState } from '@/lib/auth/oauth-state';

const log = createLogger({ name: 'conductor:github-callback' });

/**
 * GET /api/github/callback
 *
 * Called by GitHub after user installs the app.
 * Query params from GitHub:
 * - installation_id: The installation ID
 * - setup_action: 'install' | 'update' | 'request'
 * - state: Optional state passed through the flow
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const searchParams = request.nextUrl.searchParams;
  const installationId = searchParams.get('installation_id');
  const setupAction = searchParams.get('setup_action');
  const state = searchParams.get('state');

  log.info(
    { installationId, setupAction, hasState: state !== null },
    'GitHub App callback received'
  );

  if (installationId === null) {
    log.warn('Missing installation_id in callback');
    return NextResponse.redirect(
      new URL('/settings?error=missing_installation_id', request.url)
    );
  }

  try {
    await ensureBootstrap();
    const db = await getDb();

    // Store the installation in a pending state
    // The full org/repo details will be populated when we receive the installation webhook
    const installationIdNum = parseInt(installationId, 10);
    if (isNaN(installationIdNum)) {
      throw new Error('Invalid installation_id');
    }

    // Check if we already have a project with this installation
    const existingStmt = db.prepare(
      'SELECT project_id FROM projects WHERE github_installation_id = ?'
    );
    const existing = existingStmt.get(installationIdNum) as { project_id: string } | undefined;

    if (existing !== undefined) {
      log.info(
        { installationId: installationIdNum, projectId: existing.project_id },
        'Installation already associated with a project'
      );
      // Redirect to existing project
      return NextResponse.redirect(
        new URL(`/projects/${existing.project_id}?github_connected=true`, request.url)
      );
    }

    // Parse userId from signed state if present
    let userId: string | undefined;
    let verifiedRedirect: string | undefined;
    if (state !== null) {
      const verifiedState = verifySignedState(state);
      if (verifiedState !== null) {
        userId = verifiedState.userId;
        verifiedRedirect = verifiedState.redirect;
      } else {
        log.warn('Invalid or expired state token');
      }
    }

    // Store as pending installation for project creation flow
    // The installation details will be fetched when creating a project
    const pendingInstallationsStmt = db.prepare(`
      INSERT OR REPLACE INTO pending_github_installations (
        installation_id,
        setup_action,
        state,
        user_id,
        created_at
      ) VALUES (?, ?, ?, ?, ?)
    `);

    try {
      pendingInstallationsStmt.run(
        installationIdNum,
        setupAction ?? 'install',
        state ?? null,
        userId ?? null,
        new Date().toISOString()
      );
    } catch (err) {
      // Table might not exist yet - that's ok, we'll create it in a migration
      // For now, just log and continue
      log.warn(
        { error: err instanceof Error ? err.message : 'Unknown error' },
        'Could not store pending installation (table may not exist)'
      );
    }

    log.info(
      { installationId: installationIdNum, setupAction, userId },
      'GitHub App installation callback processed'
    );

    // Redirect to project creation with the installation ID
    // Use verified redirect path if available
    let redirectPath = `/projects/new?installation_id=${installationId}`;
    if (verifiedRedirect !== undefined) {
      // Append installation_id to the verified redirect URL
      const redirectUrl = new URL(verifiedRedirect, request.url);
      if (!redirectUrl.searchParams.has('installation_id')) {
        redirectUrl.searchParams.set('installation_id', installationId);
      }
      redirectPath = redirectUrl.pathname + redirectUrl.search;
    }

    return NextResponse.redirect(new URL(redirectPath, request.url));
  } catch (err) {
    log.error(
      { error: err instanceof Error ? err.message : 'Unknown error' },
      'GitHub callback processing failed'
    );
    return NextResponse.redirect(
      new URL('/settings?error=callback_failed', request.url)
    );
  }
}
