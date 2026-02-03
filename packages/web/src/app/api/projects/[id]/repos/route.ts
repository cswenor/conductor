/**
 * Project Repos API
 *
 * List and add repos to a project.
 */

import { NextRequest, NextResponse } from 'next/server';
import {
  createLogger,
  getProject,
  listProjectRepos,
  createRepo,
  type CreateRepoInput,
} from '@conductor/shared';
import { ensureBootstrap, getDb } from '@/lib/bootstrap';

const log = createLogger({ name: 'conductor:api:repos' });

interface RouteParams {
  params: Promise<{ id: string }>;
}

/**
 * GET /api/projects/[id]/repos
 *
 * List repos for a project.
 */
export async function GET(
  _request: NextRequest,
  { params }: RouteParams
): Promise<NextResponse> {
  try {
    await ensureBootstrap();
    const db = await getDb();
    const { id } = await params;

    // Verify project exists
    const project = getProject(db, id);
    if (project === null) {
      return NextResponse.json(
        { error: 'Project not found' },
        { status: 404 }
      );
    }

    const repos = listProjectRepos(db, id);

    return NextResponse.json({ repos });
  } catch (err) {
    log.error(
      { error: err instanceof Error ? err.message : 'Unknown error' },
      'Failed to list repos'
    );
    return NextResponse.json(
      { error: 'Failed to list repos' },
      { status: 500 }
    );
  }
}

/**
 * POST /api/projects/[id]/repos
 *
 * Add a repo to a project.
 */
export async function POST(
  request: NextRequest,
  { params }: RouteParams
): Promise<NextResponse> {
  try {
    await ensureBootstrap();
    const db = await getDb();
    const { id } = await params;

    // Verify project exists
    const project = getProject(db, id);
    if (project === null) {
      return NextResponse.json(
        { error: 'Project not found' },
        { status: 404 }
      );
    }

    const body = await request.json() as Partial<CreateRepoInput>;

    // Validate required fields
    if (
      body.githubNodeId === undefined ||
      body.githubNumericId === undefined ||
      body.githubOwner === undefined ||
      body.githubName === undefined ||
      body.githubFullName === undefined ||
      body.githubDefaultBranch === undefined
    ) {
      return NextResponse.json(
        { error: 'Missing required fields' },
        { status: 400 }
      );
    }

    const repo = createRepo(db, {
      projectId: id,
      githubNodeId: body.githubNodeId,
      githubNumericId: body.githubNumericId,
      githubOwner: body.githubOwner,
      githubName: body.githubName,
      githubFullName: body.githubFullName,
      githubDefaultBranch: body.githubDefaultBranch,
      profileId: body.profileId,
    });

    log.info({ repoId: repo.repoId, projectId: id }, 'Repo added to project');

    return NextResponse.json({ repo }, { status: 201 });
  } catch (err) {
    log.error(
      { error: err instanceof Error ? err.message : 'Unknown error' },
      'Failed to add repo'
    );
    return NextResponse.json(
      { error: 'Failed to add repo' },
      { status: 500 }
    );
  }
}
