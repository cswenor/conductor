/**
 * Projects API
 *
 * List and create projects.
 */

import { NextResponse } from 'next/server';
import {
  createLogger,
  listProjects,
  createProject,
  getPendingInstallation,
  deletePendingInstallation,
  type CreateProjectInput,
} from '@conductor/shared';
import { ensureBootstrap, getDb } from '@/lib/bootstrap';
import { withAuth, type AuthenticatedRequest } from '@/lib/auth';

const log = createLogger({ name: 'conductor:api:projects' });

/**
 * GET /api/projects
 *
 * List all projects with summary statistics.
 * Protected: requires authentication.
 * Returns only projects owned by the authenticated user.
 */
export const GET = withAuth(async (request: AuthenticatedRequest): Promise<NextResponse> => {
  try {
    await ensureBootstrap();
    const db = await getDb();

    // Filter by user_id (user is always defined with withAuth)
    const projects = listProjects(db, { userId: request.user.userId });

    return NextResponse.json({ projects });
  } catch (err) {
    log.error(
      { error: err instanceof Error ? err.message : 'Unknown error' },
      'Failed to list projects'
    );
    return NextResponse.json(
      { error: 'Failed to list projects' },
      { status: 500 }
    );
  }
});

/**
 * POST /api/projects
 *
 * Create a new project.
 * Protected: requires authentication.
 */
export const POST = withAuth(async (request: AuthenticatedRequest): Promise<NextResponse> => {
  try {
    await ensureBootstrap();
    const db = await getDb();

    const body = await request.json() as Partial<CreateProjectInput>;

    // Validate required fields
    if (
      body.name === undefined ||
      body.githubInstallationId === undefined
    ) {
      return NextResponse.json(
        { error: 'Missing required fields: name, githubInstallationId' },
        { status: 400 }
      );
    }

    // SECURITY: REQUIRE a pending installation owned by this user
    // This prevents users from binding projects to installations they don't own
    const pendingInstall = getPendingInstallation(db, body.githubInstallationId, {
      userId: request.user.userId,
    });

    if (pendingInstall === null) {
      log.warn(
        { userId: request.user.userId, installationId: body.githubInstallationId },
        'Project creation rejected: no pending installation for user'
      );
      return NextResponse.json(
        { error: 'No pending GitHub installation found. Please install the GitHub App first.' },
        { status: 403 }
      );
    }

    // Require org fields (in the future, we could fetch these from GitHub API using the installation)
    if (
      body.githubOrgId === undefined ||
      body.githubOrgNodeId === undefined ||
      body.githubOrgName === undefined
    ) {
      return NextResponse.json(
        { error: 'Missing required fields: githubOrgId, githubOrgNodeId, githubOrgName' },
        { status: 400 }
      );
    }

    const project = createProject(db, {
      name: body.name,
      userId: request.user.userId,
      githubOrgId: body.githubOrgId,
      githubOrgNodeId: body.githubOrgNodeId,
      githubOrgName: body.githubOrgName,
      githubInstallationId: body.githubInstallationId,
      githubProjectsV2Id: body.githubProjectsV2Id,
      defaultBaseBranch: body.defaultBaseBranch,
      portRangeStart: body.portRangeStart,
      portRangeEnd: body.portRangeEnd,
    });

    // Clean up the pending installation (we verified it exists above)
    deletePendingInstallation(db, body.githubInstallationId);

    log.info({ projectId: project.projectId, name: project.name }, 'Project created via API');

    return NextResponse.json({ project }, { status: 201 });
  } catch (err) {
    log.error(
      { error: err instanceof Error ? err.message : 'Unknown error' },
      'Failed to create project'
    );
    return NextResponse.json(
      { error: 'Failed to create project' },
      { status: 500 }
    );
  }
});
