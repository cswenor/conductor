/**
 * GitHub Installations API
 *
 * List pending GitHub App installations and get installation details.
 */

import { NextResponse } from 'next/server';
import {
  createLogger,
  listPendingInstallations,
  getInstallationOctokit,
  isGitHubAppInitialized,
  initGitHubApp,
  getUserAccessToken,
  syncUserInstallations,
  type DiscoveredInstallation,
} from '@conductor/shared';
import { Octokit as OctokitRest } from '@octokit/rest';
import { ensureBootstrap, getDb } from '@/lib/bootstrap';
import { getConfig } from '@/lib/config';
import { withAuth, type AuthenticatedRequest } from '@/lib/auth';

const log = createLogger({ name: 'conductor:api:installations' });

interface InstallationInfo {
  installationId: number;
  accountLogin: string;
  accountId: number;
  accountNodeId: string;
  accountType: 'User' | 'Organization';
  isPending: boolean;
}

/**
 * Ensure GitHub App is initialized
 */
function ensureGitHubApp(): boolean {
  if (isGitHubAppInitialized()) {
    return true;
  }

  const config = getConfig();

  if (
    config.githubAppId === '' ||
    config.githubPrivateKey === '' ||
    config.githubWebhookSecret === ''
  ) {
    return false;
  }

  try {
    initGitHubApp({
      appId: config.githubAppId,
      privateKey: config.githubPrivateKey,
      webhookSecret: config.githubWebhookSecret,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * GET /api/github/installations
 *
 * List available GitHub installations (pending and from API).
 * Protected: requires authentication.
 * Only returns installations belonging to the authenticated user.
 */
export const GET = withAuth(async (request: AuthenticatedRequest): Promise<NextResponse> => {
  try {
    await ensureBootstrap();
    const db = await getDb();

    // If GitHub App is configured, try to get details for each pending installation
    const githubConfigured = ensureGitHubApp();

    // Try to discover installations via user-scoped GitHub API
    let mergedPending = listPendingInstallations(db, { userId: request.user.userId });

    if (githubConfigured) {
      try {
        const token = getUserAccessToken(db, request.user.userId);
        if (token !== null) {
          const userOctokit = new OctokitRest({ auth: token });
          const allInstallations = await userOctokit.paginate('GET /user/installations', {
            per_page: 100,
          });

          const discovered: DiscoveredInstallation[] = allInstallations.map((inst) => {
            const account = inst.account;
            const login = (account !== null && 'login' in account) ? account.login : 'unknown';
            const id = account?.id ?? 0;
            const nodeId = account?.node_id ?? '';
            const type = (account !== null && 'type' in account) ? (account.type as 'User' | 'Organization') : 'Organization';
            return {
              installationId: inst.id,
              accountLogin: login,
              accountId: id,
              accountNodeId: nodeId,
              accountType: type,
            };
          });

          mergedPending = syncUserInstallations(db, request.user.userId, discovered);
        }
      } catch (err) {
        const status = (err as { status?: number }).status;
        if (status === 403) {
          log.warn(
            'GitHub returned 403 for /user/installations — the OAuth token may lack read:org scope. See GitHub App permissions.'
          );
        } else {
          log.warn(
            { error: err instanceof Error ? err.message : 'Unknown' },
            'Failed to discover user installations from GitHub API'
          );
        }
        // Fall through: use pending-only list
      }
    }

    // Build response with installation details
    const installations: InstallationInfo[] = [];

    for (const install of mergedPending) {
      if (githubConfigured) {
        try {
          const octokit = await getInstallationOctokit(install.installationId);
          const { data: installation } = await octokit.request('GET /app/installations/{installation_id}', {
            installation_id: install.installationId,
          });

          const account = installation.account;
          if (account !== null && account !== undefined && 'login' in account) {
            installations.push({
              installationId: install.installationId,
              accountLogin: (account as { login?: string }).login ?? 'unknown',
              accountId: (account as { id?: number }).id ?? 0,
              accountNodeId: (account as { node_id?: string }).node_id ?? '',
              accountType: ((account as { type?: string }).type as 'User' | 'Organization') ?? 'Organization',
              isPending: true,
            });
            continue;
          }
        } catch (err) {
          log.warn(
            { installationId: install.installationId, error: err instanceof Error ? err.message : 'Unknown' },
            'Failed to fetch installation details'
          );
        }
      }

      // Fallback: include without details
      installations.push({
        installationId: install.installationId,
        accountLogin: 'Unknown',
        accountId: 0,
        accountNodeId: '',
        accountType: 'Organization',
        isPending: true,
      });
    }

    return NextResponse.json({
      installations,
      githubConfigured,
    });
  } catch (err) {
    log.error(
      { error: err instanceof Error ? err.message : 'Unknown error' },
      'Failed to list installations'
    );
    return NextResponse.json(
      { error: 'Failed to list installations' },
      { status: 500 }
    );
  }
});
