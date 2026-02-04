/**
 * Run Detail API
 *
 * Get full run detail including events timeline.
 */

import { NextResponse } from 'next/server';
import {
  createLogger,
  getRun,
  getTask,
  getProject,
  canAccessProject,
  listRunEvents,
} from '@conductor/shared';
import { ensureBootstrap, getDb } from '@/lib/bootstrap';
import { withAuth, type AuthenticatedRequest } from '@/lib/auth';

const log = createLogger({ name: 'conductor:api:run-detail' });

interface RouteParams {
  params: Promise<{ id: string }>;
}

/**
 * GET /api/runs/[id]
 *
 * Get full run detail.
 * Protected: requires authentication.
 * Enforces ownership through project access.
 */
export const GET = withAuth(async (
  request: AuthenticatedRequest,
  { params }: RouteParams
): Promise<NextResponse> => {
  try {
    await ensureBootstrap();
    const db = await getDb();
    const { id: runId } = await params;

    const run = getRun(db, runId);
    if (run === null) {
      return NextResponse.json(
        { error: 'Run not found' },
        { status: 404 }
      );
    }

    // Verify project access
    const project = getProject(db, run.projectId);
    if (project === null || !canAccessProject(request.user, project)) {
      return NextResponse.json(
        { error: 'Run not found' },
        { status: 404 }
      );
    }

    // Get task info
    const task = getTask(db, run.taskId);

    // Get events timeline
    const events = listRunEvents(db, run.runId);

    return NextResponse.json({
      run,
      task: task !== null ? {
        taskId: task.taskId,
        githubTitle: task.githubTitle,
        githubIssueNumber: task.githubIssueNumber,
        githubType: task.githubType,
        githubState: task.githubState,
      } : null,
      events,
    });
  } catch (err) {
    log.error(
      { error: err instanceof Error ? err.message : 'Unknown error' },
      'Failed to get run detail'
    );
    return NextResponse.json(
      { error: 'Failed to get run detail' },
      { status: 500 }
    );
  }
});
