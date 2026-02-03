/**
 * Available Repos API
 *
 * List repos available from GitHub installation that aren't already added.
 */

import { NextResponse } from 'next/server';
import {
  createLogger,
  getProject,
  listProjectRepos,
  getInstallationOctokit,
  isGitHubAppInitialized,
  initGitHubApp,
  canAccessProject,
} from '@conductor/shared';
import { ensureBootstrap, getDb } from '@/lib/bootstrap';
import { getConfig } from '@/lib/config';
import { withAuth, type AuthenticatedRequest } from '@/lib/auth';

const log = createLogger({ name: 'conductor:api:repos:available' });

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
 * GET /api/projects/[id]/repos/available
 *
 * List repos available from GitHub that aren't already added to this project.
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

    // Verify project exists and user has access
    const project = getProject(db, id);
    if (project === null || !canAccessProject(request.user, project)) {
      return NextResponse.json(
        { error: 'Project not found' },
        { status: 404 }
      );
    }

    // Check GitHub is configured
    if (!ensureGitHubApp()) {
      return NextResponse.json(
        { error: 'GitHub App not configured' },
        { status: 503 }
      );
    }

    // Get existing repos for this project
    const existingRepos = listProjectRepos(db, id);
    const existingNodeIds = new Set(existingRepos.map((r) => r.githubNodeId));

    // Fetch repos from GitHub installation
    const octokit = await getInstallationOctokit(project.githubInstallationId);

    const repos: GitHubRepo[] = [];
    let page = 1;
    const perPage = 100;
    let hasMore = true;

    // Paginate through all repos
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

    // Filter out already-added repos
    const availableRepos = repos
      .filter((repo) => !existingNodeIds.has(repo.node_id))
      .map((repo) => ({
        id: repo.id,
        nodeId: repo.node_id,
        name: repo.name,
        fullName: repo.full_name,
        owner: repo.owner.login,
        defaultBranch: repo.default_branch,
        isPrivate: repo.private,
      }));

    return NextResponse.json({
      repos: availableRepos,
      total: availableRepos.length,
    });
  } catch (err) {
    log.error(
      { error: err instanceof Error ? err.message : 'Unknown error' },
      'Failed to list available repos'
    );
    return NextResponse.json(
      { error: 'Failed to list available repos' },
      { status: 500 }
    );
  }
});
