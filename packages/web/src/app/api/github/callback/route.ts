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
 * - state: REQUIRED signed state with userId (prevents CSRF and ensures user binding)
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

  // SECURITY: Validate state FIRST before any database operations
  // This prevents unauthenticated probing of installation status
  if (state === null) {
    log.warn('Missing state parameter - rejecting callback');
    return NextResponse.redirect(
      new URL('/settings?error=missing_state', request.url)
    );
  }

  const verifiedState = verifySignedState(state);
  if (verifiedState === null) {
    log.warn('Invalid or expired state token - rejecting callback');
    return NextResponse.redirect(
      new URL('/settings?error=invalid_state', request.url)
    );
  }

  if (verifiedState.userId === undefined) {
    log.warn('State token missing userId - rejecting callback');
    return NextResponse.redirect(
      new URL('/settings?error=missing_user', request.url)
    );
  }

  const userId = verifiedState.userId;
  const verifiedRedirect = verifiedState.redirect;

  try {
    await ensureBootstrap();
    const db = await getDb();

    // Parse and validate installation ID
    const installationIdNum = parseInt(installationId, 10);
    if (isNaN(installationIdNum)) {
      throw new Error('Invalid installation_id');
    }

    // Check if we already have a project with this installation
    // (State already validated above, so this is safe)
    const existingStmt = db.prepare(
      'SELECT project_id, user_id FROM projects WHERE github_installation_id = ?'
    );
    const existing = existingStmt.get(installationIdNum) as { project_id: string; user_id: string } | undefined;

    if (existing !== undefined) {
      // Only redirect to project if the authenticated user owns it
      if (existing.user_id === userId) {
        log.info(
          { installationId: installationIdNum, projectId: existing.project_id, userId },
          'Installation already associated with user project'
        );
        return NextResponse.redirect(
          new URL(`/projects/${existing.project_id}?github_connected=true`, request.url)
        );
      } else {
        // Installation belongs to another user's project
        log.warn(
          { installationId: installationIdNum, userId, ownerUserId: existing.user_id },
          'Installation already associated with another user project'
        );
        return NextResponse.redirect(
          new URL('/settings?error=installation_owned', request.url)
        );
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
        state,
        userId,
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
