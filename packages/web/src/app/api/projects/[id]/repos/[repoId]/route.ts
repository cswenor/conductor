/**
 * Individual Repo API
 *
 * Get, update, and delete a specific repo.
 */

import { NextResponse } from 'next/server';
import {
  createLogger,
  getProject,
  getRepo,
  updateRepo,
  deleteRepo,
  type UpdateRepoInput,
} from '@conductor/shared';
import { ensureBootstrap, getDb } from '@/lib/bootstrap';
import { withAuth, type AuthenticatedRequest } from '@/lib/auth';

const log = createLogger({ name: 'conductor:api:repo' });

// Valid repo status values
const VALID_STATUSES = ['active', 'inactive', 'syncing', 'error'] as const;
type RepoStatus = (typeof VALID_STATUSES)[number];

function isValidStatus(value: unknown): value is RepoStatus {
  return typeof value === 'string' && VALID_STATUSES.includes(value as RepoStatus);
}

interface ValidationError {
  field: string;
  message: string;
}

function validateUpdateRepoInput(body: unknown): { valid: true; data: Partial<UpdateRepoInput> } | { valid: false; errors: ValidationError[] } {
  const errors: ValidationError[] = [];

  if (typeof body !== 'object' || body === null) {
    return { valid: false, errors: [{ field: 'body', message: 'Request body must be an object' }] };
  }

  const input = body as Record<string, unknown>;
  const data: Partial<UpdateRepoInput> = {};

  // Validate profileId
  if ('profileId' in input) {
    const profileId = input['profileId'];
    if (typeof profileId !== 'string') {
      errors.push({ field: 'profileId', message: 'profileId must be a string' });
    } else if (profileId.trim() === '') {
      errors.push({ field: 'profileId', message: 'profileId cannot be empty' });
    } else {
      data.profileId = profileId;
    }
  }

  // Validate status
  if ('status' in input) {
    const status = input['status'];
    if (!isValidStatus(status)) {
      errors.push({ field: 'status', message: `status must be one of: ${VALID_STATUSES.join(', ')}` });
    } else {
      data.status = status;
    }
  }

  // Validate githubDefaultBranch
  if ('githubDefaultBranch' in input) {
    const branch = input['githubDefaultBranch'];
    if (typeof branch !== 'string') {
      errors.push({ field: 'githubDefaultBranch', message: 'githubDefaultBranch must be a string' });
    } else if (branch.trim() === '') {
      errors.push({ field: 'githubDefaultBranch', message: 'githubDefaultBranch cannot be empty' });
    } else {
      data.githubDefaultBranch = branch;
    }
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  return { valid: true, data };
}

interface RouteParams {
  params: Promise<{ id: string; repoId: string }>;
}

/**
 * GET /api/projects/[id]/repos/[repoId]
 *
 * Get a specific repo.
 * Protected: requires authentication.
 */
export const GET = withAuth(async (
  request: AuthenticatedRequest,
  { params }: RouteParams
): Promise<NextResponse> => {
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

    // Enforce ownership
    if (project.userId !== request.user.userId) {
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
});

/**
 * PATCH /api/projects/[id]/repos/[repoId]
 *
 * Update a repo.
 * Protected: requires authentication.
 */
export const PATCH = withAuth(async (
  request: AuthenticatedRequest,
  { params }: RouteParams
): Promise<NextResponse> => {
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

    // Enforce ownership
    if (project.userId !== request.user.userId) {
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

    const body: unknown = await request.json();

    // Validate input
    const validation = validateUpdateRepoInput(body);
    if (!validation.valid) {
      return NextResponse.json(
        { error: 'Invalid input', details: validation.errors },
        { status: 400 }
      );
    }

    const repo = updateRepo(db, repoId, validation.data);

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
});

/**
 * DELETE /api/projects/[id]/repos/[repoId]
 *
 * Remove a repo from the project.
 * Protected: requires authentication.
 */
export const DELETE = withAuth(async (
  request: AuthenticatedRequest,
  { params }: RouteParams
): Promise<NextResponse> => {
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

    // Enforce ownership
    if (project.userId !== request.user.userId) {
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
});
