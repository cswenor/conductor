/**
 * Projects API
 *
 * List and create projects.
 */

import { NextRequest, NextResponse } from 'next/server';
import {
  createLogger,
  listProjects,
  createProject,
  getPendingInstallation,
  deletePendingInstallation,
  type CreateProjectInput,
} from '@conductor/shared';
import { ensureBootstrap, getDb } from '@/lib/bootstrap';

const log = createLogger({ name: 'conductor:api:projects' });

/**
 * GET /api/projects
 *
 * List all projects with summary statistics.
 */
export async function GET(): Promise<NextResponse> {
  try {
    await ensureBootstrap();
    const db = await getDb();
    const projects = listProjects(db);

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
}

/**
 * POST /api/projects
 *
 * Create a new project.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
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

    // If we have a pending installation, use its data
    // Otherwise, we need the GitHub org details from the request
    const pendingInstall = getPendingInstallation(db, body.githubInstallationId);

    if (
      body.githubOrgId === undefined ||
      body.githubOrgNodeId === undefined ||
      body.githubOrgName === undefined
    ) {
      // These fields are required if not coming from elsewhere
      if (pendingInstall === null) {
        return NextResponse.json(
          { error: 'Missing required GitHub organization details' },
          { status: 400 }
        );
      }
      // For now, we require the caller to provide these
      // In a full implementation, we'd fetch them from GitHub API
      return NextResponse.json(
        { error: 'Missing required fields: githubOrgId, githubOrgNodeId, githubOrgName' },
        { status: 400 }
      );
    }

    const project = createProject(db, {
      name: body.name,
      githubOrgId: body.githubOrgId,
      githubOrgNodeId: body.githubOrgNodeId,
      githubOrgName: body.githubOrgName,
      githubInstallationId: body.githubInstallationId,
      githubProjectsV2Id: body.githubProjectsV2Id,
      defaultBaseBranch: body.defaultBaseBranch,
      portRangeStart: body.portRangeStart,
      portRangeEnd: body.portRangeEnd,
    });

    // Clean up pending installation if it exists
    if (pendingInstall !== null) {
      deletePendingInstallation(db, body.githubInstallationId);
    }

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
}
