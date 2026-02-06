/**
 * Approvals Count API
 *
 * Lightweight endpoint that returns only the count of pending approvals.
 * Used by the nav badge to poll without fetching full approval data.
 */

import { NextResponse } from 'next/server';
import {
  listProjects,
  getRunsAwaitingGates,
} from '@conductor/shared';
import { ensureBootstrap, getDb } from '@/lib/bootstrap';
import { withAuth, type AuthenticatedRequest } from '@/lib/auth';

/**
 * GET /api/approvals/count
 *
 * Returns { count: number } for the authenticated user's pending approvals.
 */
export const GET = withAuth(async (request: AuthenticatedRequest): Promise<NextResponse> => {
  try {
    await ensureBootstrap();
    const db = await getDb();

    const projects = listProjects(db, { userId: request.user.userId });
    let count = 0;

    for (const project of projects) {
      const awaitingRuns = getRunsAwaitingGates(db, project.projectId);
      count += awaitingRuns.length;
    }

    return NextResponse.json({ count });
  } catch {
    return NextResponse.json({ count: 0 });
  }
});
