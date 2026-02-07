/**
 * Analytics API
 *
 * Aggregate metrics for the authenticated user's projects.
 */

import { NextResponse } from 'next/server';
import { createLogger, getAnalyticsMetrics } from '@conductor/shared';
import { ensureBootstrap, getDb } from '@/lib/bootstrap';
import { withAuth, type AuthenticatedRequest } from '@/lib/auth';

const log = createLogger({ name: 'conductor:api:analytics' });

/**
 * GET /api/analytics
 *
 * Returns aggregate metrics across all user projects.
 * Optional query param: projectId — scope to a single project.
 */
export const GET = withAuth(async (request: AuthenticatedRequest): Promise<NextResponse> => {
  try {
    await ensureBootstrap();
    const db = await getDb();

    const url = new URL(request.url);
    const projectId = url.searchParams.get('projectId');

    const metrics = getAnalyticsMetrics(db, {
      userId: request.user.userId,
      projectId: projectId ?? undefined,
    });

    return NextResponse.json(metrics);
  } catch (err) {
    log.error(
      { error: err instanceof Error ? err.message : 'Unknown error' },
      'Failed to compute analytics'
    );
    return NextResponse.json(
      { error: 'Failed to compute analytics' },
      { status: 500 }
    );
  }
});
