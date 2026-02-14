/**
 * Recent Events API
 *
 * Returns recent stream events for the authenticated user's projects.
 * Used by the inbox dropdown to show recent activity.
 */

import { NextResponse } from 'next/server';
import {
  listProjects,
  queryRecentStreamEventsEnriched,
} from '@conductor/shared';
import { ensureBootstrap, getDb } from '@/lib/bootstrap';
import { withAuth, type AuthenticatedRequest } from '@/lib/auth';

/**
 * GET /api/events/recent?limit=20
 *
 * Returns { events: Array<StreamEventV2 & { projectName?: string; taskTitle?: string }> }
 * for the authenticated user's projects.
 */
export const GET = withAuth(async (request: AuthenticatedRequest): Promise<NextResponse> => {
  try {
    await ensureBootstrap();
    const db = await getDb();

    const projects = listProjects(db, { userId: request.user.userId });
    const projectIds = projects.map(p => p.projectId);

    const rawLimit = request.nextUrl.searchParams.get('limit');
    let limit = 20;
    if (rawLimit !== null) {
      const parsed = parseInt(rawLimit, 10);
      if (!Number.isNaN(parsed)) {
        limit = Math.min(Math.max(parsed, 1), 50);
      }
    }

    const enrichedRows = queryRecentStreamEventsEnriched(db, projectIds, limit);

    const events = enrichedRows.map(({ event, projectName, taskTitle }) => ({
      ...event,
      ...(projectName !== null ? { projectName } : {}),
      ...(taskTitle !== null ? { taskTitle } : {}),
    }));

    return NextResponse.json({ events });
  } catch {
    return NextResponse.json({ events: [] });
  }
});
