/**
 * Project Detail API
 *
 * Get, update, delete a single project.
 */

import { NextRequest, NextResponse } from 'next/server';
import {
  createLogger,
  getProject,
  updateProject,
  deleteProject,
  type UpdateProjectInput,
} from '@conductor/shared';
import { ensureBootstrap, getDb } from '@/lib/bootstrap';

const log = createLogger({ name: 'conductor:api:project' });

interface RouteParams {
  params: Promise<{ id: string }>;
}

/**
 * GET /api/projects/[id]
 *
 * Get a single project by ID.
 */
export async function GET(
  _request: NextRequest,
  { params }: RouteParams
): Promise<NextResponse> {
  try {
    await ensureBootstrap();
    const db = await getDb();
    const { id } = await params;

    const project = getProject(db, id);

    if (project === null) {
      return NextResponse.json(
        { error: 'Project not found' },
        { status: 404 }
      );
    }

    return NextResponse.json({ project });
  } catch (err) {
    log.error(
      { error: err instanceof Error ? err.message : 'Unknown error' },
      'Failed to get project'
    );
    return NextResponse.json(
      { error: 'Failed to get project' },
      { status: 500 }
    );
  }
}

/**
 * PATCH /api/projects/[id]
 *
 * Update a project.
 */
export async function PATCH(
  request: NextRequest,
  { params }: RouteParams
): Promise<NextResponse> {
  try {
    await ensureBootstrap();
    const db = await getDb();
    const { id } = await params;

    const body = await request.json() as UpdateProjectInput;

    const project = updateProject(db, id, body);

    if (project === null) {
      return NextResponse.json(
        { error: 'Project not found' },
        { status: 404 }
      );
    }

    return NextResponse.json({ project });
  } catch (err) {
    log.error(
      { error: err instanceof Error ? err.message : 'Unknown error' },
      'Failed to update project'
    );
    return NextResponse.json(
      { error: 'Failed to update project' },
      { status: 500 }
    );
  }
}

/**
 * DELETE /api/projects/[id]
 *
 * Delete a project.
 */
export async function DELETE(
  _request: NextRequest,
  { params }: RouteParams
): Promise<NextResponse> {
  try {
    await ensureBootstrap();
    const db = await getDb();
    const { id } = await params;

    const deleted = deleteProject(db, id);

    if (!deleted) {
      return NextResponse.json(
        { error: 'Project not found' },
        { status: 404 }
      );
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    log.error(
      { error: err instanceof Error ? err.message : 'Unknown error' },
      'Failed to delete project'
    );
    return NextResponse.json(
      { error: 'Failed to delete project' },
      { status: 500 }
    );
  }
}
