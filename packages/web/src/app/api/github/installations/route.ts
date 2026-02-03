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
} from '@conductor/shared';
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

    const installations: InstallationInfo[] = [];

    // Get pending installations from database filtered by user
    const pending = listPendingInstallations(db, { userId: request.user.userId });

    // If GitHub App is configured, try to get details for each pending installation
    const githubConfigured = ensureGitHubApp();

    for (const install of pending) {
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
          }
        } catch (err) {
          log.warn(
            { installationId: install.installationId, error: err instanceof Error ? err.message : 'Unknown' },
            'Failed to fetch installation details'
          );
          // Include without details
          installations.push({
            installationId: install.installationId,
            accountLogin: 'Unknown',
            accountId: 0,
            accountNodeId: '',
            accountType: 'Organization',
            isPending: true,
          });
        }
      } else {
        installations.push({
          installationId: install.installationId,
          accountLogin: 'Unknown',
          accountId: 0,
          accountNodeId: '',
          accountType: 'Organization',
          isPending: true,
        });
      }
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
