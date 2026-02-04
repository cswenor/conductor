/**
 * Runs API
 *
 * List all runs for the authenticated user across all projects.
 */

import { NextResponse } from 'next/server';
import {
  createLogger,
  listRuns,
  type RunPhase,
} from '@conductor/shared';
import { ensureBootstrap, getDb } from '@/lib/bootstrap';
import { withAuth, type AuthenticatedRequest } from '@/lib/auth';

const log = createLogger({ name: 'conductor:api:runs' });

/**
 * GET /api/runs
 *
 * List all runs for the authenticated user across all projects.
 * Protected: requires authentication.
 * Filters through project ownership.
 */
export const GET = withAuth(async (request: AuthenticatedRequest): Promise<NextResponse> => {
  try {
    await ensureBootstrap();
    const db = await getDb();

    const url = new URL(request.url);
    const phase = url.searchParams.get('phase') as RunPhase | null;
    const limit = Number.parseInt(url.searchParams.get('limit') ?? '50', 10);
    const offset = Number.parseInt(url.searchParams.get('offset') ?? '0', 10);

    const runs = listRuns(db, {
      userId: request.user.userId,
      phase: phase ?? undefined,
      limit: Math.min(limit, 100),
      offset: Math.max(offset, 0),
    });

    return NextResponse.json({ runs });
  } catch (err) {
    log.error(
      { error: err instanceof Error ? err.message : 'Unknown error' },
      'Failed to list runs'
    );
    return NextResponse.json(
      { error: 'Failed to list runs' },
      { status: 500 }
    );
  }
});
