/**
 * Project Detail API
 *
 * Get, update, delete a single project.
 */

import { NextResponse } from 'next/server';
import {
  createLogger,
  getProject,
  updateProject,
  deleteProject,
  type UpdateProjectInput,
} from '@conductor/shared';
import { ensureBootstrap, getDb } from '@/lib/bootstrap';
import { withAuth, type AuthenticatedRequest } from '@/lib/auth';

const log = createLogger({ name: 'conductor:api:project' });

interface RouteParams {
  params: Promise<{ id: string }>;
}

/**
 * GET /api/projects/[id]
 *
 * Get a single project by ID.
 * Protected: requires authentication.
 * Enforces ownership: user can only access their own projects.
 */
export const GET = withAuth(async (
  request: AuthenticatedRequest,
  { params }: RouteParams
): Promise<NextResponse> => {
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

    // Enforce ownership
    if (project.userId !== request.user.userId) {
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
});

/**
 * PATCH /api/projects/[id]
 *
 * Update a project.
 * Protected: requires authentication.
 * Enforces ownership: user can only update their own projects.
 */
export const PATCH = withAuth(async (
  request: AuthenticatedRequest,
  { params }: RouteParams
): Promise<NextResponse> => {
  try {
    await ensureBootstrap();
    const db = await getDb();
    const { id } = await params;

    // Check ownership before updating
    const existing = getProject(db, id);
    if (existing === null) {
      return NextResponse.json(
        { error: 'Project not found' },
        { status: 404 }
      );
    }

    // Enforce ownership
    if (existing.userId !== request.user.userId) {
      return NextResponse.json(
        { error: 'Project not found' },
        { status: 404 }
      );
    }

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
});

/**
 * DELETE /api/projects/[id]
 *
 * Delete a project.
 * Protected: requires authentication.
 * Enforces ownership: user can only delete their own projects.
 */
export const DELETE = withAuth(async (
  request: AuthenticatedRequest,
  { params }: RouteParams
): Promise<NextResponse> => {
  try {
    await ensureBootstrap();
    const db = await getDb();
    const { id } = await params;

    // Check ownership before deleting
    const existing = getProject(db, id);
    if (existing === null) {
      return NextResponse.json(
        { error: 'Project not found' },
        { status: 404 }
      );
    }

    // Enforce ownership
    if (existing.userId !== request.user.userId) {
      return NextResponse.json(
        { error: 'Project not found' },
        { status: 404 }
      );
    }

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
});
