/**
 * Detect Profile API
 *
 * Detects the profile for a repository based on its file structure.
 */

import { NextResponse } from 'next/server';
import {
  createLogger,
  getProject,
  detectProfile,
  getInstallationOctokit,
  isGitHubAppInitialized,
  initGitHubApp,
  canAccessProject,
} from '@conductor/shared';
import { ensureBootstrap, getDb } from '@/lib/bootstrap';
import { getConfig } from '@/lib/config';
import { withAuth, type AuthenticatedRequest } from '@/lib/auth';

const log = createLogger({ name: 'conductor:api:repos:detect-profile' });

interface RouteParams {
  params: Promise<{ id: string }>;
}

interface RequestBody {
  owner: string;
  repo: string;
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
 * POST /api/projects/[id]/repos/detect-profile
 *
 * Detect the profile for a GitHub repository.
 * Protected: requires authentication.
 */
export const POST = withAuth(async (
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

    const body = await request.json() as Partial<RequestBody>;

    if (body.owner === undefined || body.repo === undefined) {
      return NextResponse.json(
        { error: 'Missing required fields: owner, repo' },
        { status: 400 }
      );
    }

    // Get octokit for this installation
    const octokit = await getInstallationOctokit(project.githubInstallationId);

    // Fetch the repository's root directory contents
    const files: string[] = [];

    try {
      // Get root directory
      const { data: rootContents } = await octokit.request(
        'GET /repos/{owner}/{repo}/contents/{path}',
        {
          owner: body.owner,
          repo: body.repo,
          path: '',
        }
      );

      if (Array.isArray(rootContents)) {
        for (const item of rootContents) {
          if (item.type === 'file') {
            files.push(item.name);
          } else if (item.type === 'dir') {
            files.push(item.name + '/');
          }
        }
      }

      // Check common subdirectories for additional detection files
      const checkDirs = ['src', 'lib', 'docs', '.github', '.github/workflows'];

      for (const dir of checkDirs) {
        try {
          const { data: dirContents } = await octokit.request(
            'GET /repos/{owner}/{repo}/contents/{path}',
            {
              owner: body.owner,
              repo: body.repo,
              path: dir,
            }
          );

          if (Array.isArray(dirContents)) {
            for (const item of dirContents) {
              if (item.type === 'file') {
                files.push(`${dir}/${item.name}`);
              }
            }
          }
        } catch {
          // Directory doesn't exist, skip
        }
      }
    } catch (err) {
      log.warn(
        { owner: body.owner, repo: body.repo, error: err instanceof Error ? err.message : 'Unknown' },
        'Failed to fetch repository contents'
      );
      // Continue with empty files - will return default profile
    }

    // Detect profile based on files
    const result = detectProfile(files);

    log.info(
      {
        owner: body.owner,
        repo: body.repo,
        profileId: result.profileId,
        confidence: result.confidence,
        filesChecked: files.length,
      },
      'Profile detected for repository'
    );

    return NextResponse.json({
      profileId: result.profileId,
      profile: result.profile,
      confidence: result.confidence,
      detectedFiles: result.detectedFiles,
      reason: result.reason,
    });
  } catch (err) {
    log.error(
      { error: err instanceof Error ? err.message : 'Unknown error' },
      'Failed to detect profile'
    );
    return NextResponse.json(
      { error: 'Failed to detect profile' },
      { status: 500 }
    );
  }
});
