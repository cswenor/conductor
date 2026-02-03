/**
 * Individual Repo API
 *
 * Get, update, and delete a specific repo.
 */

import { NextRequest, NextResponse } from 'next/server';
import {
  createLogger,
  getProject,
  getRepo,
  updateRepo,
  deleteRepo,
  type UpdateRepoInput,
} from '@conductor/shared';
import { ensureBootstrap, getDb } from '@/lib/bootstrap';

const log = createLogger({ name: 'conductor:api:repo' });

interface RouteParams {
  params: Promise<{ id: string; repoId: string }>;
}

/**
 * GET /api/projects/[id]/repos/[repoId]
 *
 * Get a specific repo.
 */
export async function GET(
  _request: NextRequest,
  { params }: RouteParams
): Promise<NextResponse> {
  try {
    await ensureBootstrap();
    const db = await getDb();
    const { id, repoId } = await params;

    // Verify project exists
    const project = getProject(db, id);
    if (project === null) {
      return NextResponse.json(
        { error: 'Project not found' },
        { status: 404 }
      );
    }

    const repo = getRepo(db, repoId);
    if (repo === null) {
      return NextResponse.json(
        { error: 'Repo not found' },
        { status: 404 }
      );
    }

    // Verify repo belongs to project
    if (repo.projectId !== id) {
      return NextResponse.json(
        { error: 'Repo not found in this project' },
        { status: 404 }
      );
    }

    return NextResponse.json({ repo });
  } catch (err) {
    log.error(
      { error: err instanceof Error ? err.message : 'Unknown error' },
      'Failed to get repo'
    );
    return NextResponse.json(
      { error: 'Failed to get repo' },
      { status: 500 }
    );
  }
}

/**
 * PATCH /api/projects/[id]/repos/[repoId]
 *
 * Update a repo.
 */
export async function PATCH(
  request: NextRequest,
  { params }: RouteParams
): Promise<NextResponse> {
  try {
    await ensureBootstrap();
    const db = await getDb();
    const { id, repoId } = await params;

    // Verify project exists
    const project = getProject(db, id);
    if (project === null) {
      return NextResponse.json(
        { error: 'Project not found' },
        { status: 404 }
      );
    }

    const existingRepo = getRepo(db, repoId);
    if (existingRepo === null) {
      return NextResponse.json(
        { error: 'Repo not found' },
        { status: 404 }
      );
    }

    // Verify repo belongs to project
    if (existingRepo.projectId !== id) {
      return NextResponse.json(
        { error: 'Repo not found in this project' },
        { status: 404 }
      );
    }

    const body = await request.json() as Partial<UpdateRepoInput>;

    const repo = updateRepo(db, repoId, {
      profileId: body.profileId,
      status: body.status,
      githubDefaultBranch: body.githubDefaultBranch,
    });

    if (repo === null) {
      return NextResponse.json(
        { error: 'Failed to update repo' },
        { status: 500 }
      );
    }

    log.info({ repoId, projectId: id }, 'Repo updated');

    return NextResponse.json({ repo });
  } catch (err) {
    log.error(
      { error: err instanceof Error ? err.message : 'Unknown error' },
      'Failed to update repo'
    );
    return NextResponse.json(
      { error: 'Failed to update repo' },
      { status: 500 }
    );
  }
}

/**
 * DELETE /api/projects/[id]/repos/[repoId]
 *
 * Remove a repo from the project.
 */
export async function DELETE(
  _request: NextRequest,
  { params }: RouteParams
): Promise<NextResponse> {
  try {
    await ensureBootstrap();
    const db = await getDb();
    const { id, repoId } = await params;

    // Verify project exists
    const project = getProject(db, id);
    if (project === null) {
      return NextResponse.json(
        { error: 'Project not found' },
        { status: 404 }
      );
    }

    const existingRepo = getRepo(db, repoId);
    if (existingRepo === null) {
      return NextResponse.json(
        { error: 'Repo not found' },
        { status: 404 }
      );
    }

    // Verify repo belongs to project
    if (existingRepo.projectId !== id) {
      return NextResponse.json(
        { error: 'Repo not found in this project' },
        { status: 404 }
      );
    }

    const deleted = deleteRepo(db, repoId);

    if (!deleted) {
      return NextResponse.json(
        { error: 'Failed to delete repo' },
        { status: 500 }
      );
    }

    log.info({ repoId, projectId: id }, 'Repo deleted');

    return NextResponse.json({ success: true });
  } catch (err) {
    log.error(
      { error: err instanceof Error ? err.message : 'Unknown error' },
      'Failed to delete repo'
    );
    return NextResponse.json(
      { error: 'Failed to delete repo' },
      { status: 500 }
    );
  }
}
