/**
 * Installation Repos API
 *
 * List repos accessible to a GitHub App installation.
 * Used during project creation to let users pick a repo before a project exists.
 */

import { NextResponse } from 'next/server';
import {
  createLogger,
  getPendingInstallation,
  getProjectByInstallation,
  getInstallationOctokit,
  isGitHubAppInitialized,
  initGitHubApp,
  canAccessProject,
} from '@conductor/shared';
import { ensureBootstrap, getDb } from '@/lib/bootstrap';
import { getConfig } from '@/lib/config';
import { withAuth, type AuthenticatedRequest } from '@/lib/auth';

const log = createLogger({ name: 'conductor:api:installations:repos' });

interface RouteParams {
  params: Promise<{ id: string }>;
}

interface GitHubRepo {
  id: number;
  node_id: string;
  name: string;
  full_name: string;
  owner: {
    login: string;
  };
  default_branch: string;
  private: boolean;
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
 * GET /api/github/installations/[id]/repos
 *
 * List repos accessible to a GitHub App installation.
 * Validates the installation belongs to the user via pending_github_installations or projects table.
 * Protected: requires authentication.
 */
export const GET = withAuth(async (
  request: AuthenticatedRequest,
  { params }: RouteParams
): Promise<NextResponse> => {
  try {
    await ensureBootstrap();
    const db = await getDb();
    const { id } = await params;
    const installationId = parseInt(id, 10);

    if (isNaN(installationId)) {
      return NextResponse.json(
        { error: 'Invalid installation ID' },
        { status: 400 }
      );
    }

    // Verify the installation belongs to the user:
    // Check pending_github_installations first, then projects table
    const pending = getPendingInstallation(db, installationId, { userId: request.user.userId });
    if (pending === null) {
      const project = getProjectByInstallation(db, installationId);
      if (project === null || !canAccessProject(request.user, project)) {
        return NextResponse.json(
          { error: 'Installation not found' },
          { status: 404 }
        );
      }
    }

    // Check GitHub is configured
    if (!ensureGitHubApp()) {
      return NextResponse.json(
        { error: 'GitHub App not configured' },
        { status: 503 }
      );
    }

    // Fetch repos from GitHub installation
    const octokit = await getInstallationOctokit(installationId);

    const repos: GitHubRepo[] = [];
    let page = 1;
    const perPage = 100;
    let hasMore = true;

    while (hasMore) {
      const response = await octokit.request(
        'GET /installation/repositories',
        {
          per_page: perPage,
          page,
        }
      );

      const data = response.data as {
        repositories: GitHubRepo[];
        total_count: number;
      };

      repos.push(...data.repositories);

      if (repos.length >= data.total_count || data.repositories.length < perPage) {
        hasMore = false;
      } else {
        page++;
      }
    }

    const mappedRepos = repos.map((repo) => ({
      id: repo.id,
      nodeId: repo.node_id,
      name: repo.name,
      fullName: repo.full_name,
      owner: repo.owner.login,
      defaultBranch: repo.default_branch,
      isPrivate: repo.private,
    }));

    return NextResponse.json({ repos: mappedRepos });
  } catch (err) {
    log.error(
      { error: err instanceof Error ? err.message : 'Unknown error' },
      'Failed to list installation repos'
    );
    return NextResponse.json(
      { error: 'Failed to list installation repos' },
      { status: 500 }
    );
  }
});
