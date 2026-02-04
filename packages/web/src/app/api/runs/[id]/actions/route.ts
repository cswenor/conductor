/**
 * Run Actions API
 *
 * Operator actions: cancel. (Pause/resume deferred to WP11.)
 */

import { NextResponse } from 'next/server';
import {
  createLogger,
  getRun,
  getProject,
  canAccessProject,
  transitionPhase,
  TERMINAL_PHASES,
} from '@conductor/shared';
import { ensureBootstrap, getDb, getQueues } from '@/lib/bootstrap';
import { withAuth, type AuthenticatedRequest } from '@/lib/auth';

const log = createLogger({ name: 'conductor:api:run-actions' });

interface RouteParams {
  params: Promise<{ id: string }>;
}

/**
 * POST /api/runs/[id]/actions
 *
 * Execute an operator action on a run.
 * Protected: requires authentication.
 * Enforces ownership through project access.
 *
 * Body:
 *   - action: 'cancel'
 *   - comment?: string (optional reason for the action)
 */
export const POST = withAuth(async (
  request: AuthenticatedRequest,
  { params }: RouteParams
): Promise<NextResponse> => {
  try {
    await ensureBootstrap();
    const db = await getDb();
    const queues = await getQueues();
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

    const body = await request.json() as { action?: string; comment?: string };

    if (body.action === undefined) {
      return NextResponse.json(
        { error: 'Missing required field: action' },
        { status: 400 }
      );
    }

    switch (body.action) {
      case 'cancel': {
        if (TERMINAL_PHASES.has(run.phase)) {
          return NextResponse.json(
            { error: 'Run is already in a terminal state' },
            { status: 409 }
          );
        }

        const result = transitionPhase(db, {
          runId,
          toPhase: 'cancelled',
          toStep: 'cleanup',
          triggeredBy: request.user.userId,
          result: 'cancelled',
          reason: body.comment ?? undefined,
        });

        if (!result.success) {
          log.error({ runId, error: result.error }, 'Cancel transition failed');
          return NextResponse.json(
            { error: result.error ?? 'Failed to cancel run' },
            { status: 409 }
          );
        }

        // Record operator action for audit
        const now = new Date().toISOString();
        db.prepare(`
          INSERT INTO operator_actions (
            operator_action_id, run_id, operator, action, comment, from_phase, to_phase, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          `oa_${Date.now().toString(36)}${Math.random().toString(36).substring(2, 8)}`,
          runId,
          request.user.userId,
          'cancel',
          body.comment ?? null,
          run.phase,
          'cancelled',
          now
        );

        // Enqueue cleanup job
        await queues.addJob('cleanup', `cleanup:worktree:${runId}`, {
          type: 'worktree',
          targetId: runId,
        });

        log.info(
          { runId, userId: request.user.userId },
          'Run cancelled by operator'
        );

        return NextResponse.json({
          success: true,
          run: result.run,
        });
      }
      default:
        return NextResponse.json(
          { error: `Unknown action: ${body.action}` },
          { status: 400 }
        );
    }
  } catch (err) {
    log.error(
      { error: err instanceof Error ? err.message : 'Unknown error' },
      'Failed to execute run action'
    );
    return NextResponse.json(
      { error: 'Failed to execute run action' },
      { status: 500 }
    );
  }
});
