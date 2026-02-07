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
  countRuns,
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
    const phasesParam = url.searchParams.get('phases');
    const projectId = url.searchParams.get('projectId');
    const countOnly = url.searchParams.get('countOnly') === '1';
    const includePaused = url.searchParams.get('includePaused') === '1';
    const completedAfter = url.searchParams.get('completedAfter');
    const limit = Number.parseInt(url.searchParams.get('limit') ?? '50', 10);
    const offset = Number.parseInt(url.searchParams.get('offset') ?? '0', 10);

    const validPhases: RunPhase[] = [
      'pending',
      'planning',
      'awaiting_plan_approval',
      'executing',
      'awaiting_review',
      'blocked',
      'completed',
      'cancelled',
    ];

    // Support multi-phase filtering via comma-separated `phases` param
    const phases = phasesParam !== null
      ? phasesParam
        .split(',')
        .map((p) => p.trim())
        .filter((p): p is RunPhase => validPhases.includes(p as RunPhase))
      : undefined;

    const total = countRuns(db, {
      userId: request.user.userId,
      projectId: projectId ?? undefined,
      phase: phase ?? undefined,
      phases,
      includePaused: includePaused || undefined,
      completedAfter: completedAfter ?? undefined,
    });

    if (countOnly) {
      return NextResponse.json({ total, runs: [] });
    }

    const runs = listRuns(db, {
      userId: request.user.userId,
      projectId: projectId ?? undefined,
      phase: phase ?? undefined,
      phases,
      includePaused: includePaused || undefined,
      limit: Math.min(limit, 100),
      offset: Math.max(offset, 0),
    });

    return NextResponse.json({ runs, total });
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
