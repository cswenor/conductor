/**
 * Run Workflow API
 *
 * Mutation endpoints for workflow overlay edits and rewinds.
 * Both require the run to be paused and have no active agent invocations.
 */

import { NextResponse } from 'next/server';
import {
  createLogger,
  getRun,
  getProject,
  canAccessProject,
  applyWorkflowOverlay,
  rewindRun,
} from '@conductor/shared';
import type { RunStep } from '@conductor/shared';
import { ensureBootstrap, getDb } from '@/lib/bootstrap';
import { withAuth, type AuthenticatedRequest } from '@/lib/auth';

const log = createLogger({ name: 'conductor:api:run-workflow' });

interface RouteParams {
  params: Promise<{ id: string }>;
}

interface WorkflowBody {
  overlay?: Record<string, unknown>;
  rewindToStep?: string;
}

/**
 * PUT /api/runs/[id]/workflow
 *
 * Edit workflow overlay or rewind run step.
 * Protected: requires authentication.
 * Enforces ownership through project access.
 *
 * Body: { overlay: {...} } OR { rewindToStep: "step_name" } (mutually exclusive)
 */
export const PUT = withAuth(async (
  request: AuthenticatedRequest,
  { params }: RouteParams,
): Promise<NextResponse> => {
  try {
    await ensureBootstrap();
    const db = await getDb();
    const { id: runId } = await params;

    const run = getRun(db, runId);
    if (run === null) {
      return NextResponse.json({ error: 'Run not found' }, { status: 404 });
    }

    const project = getProject(db, run.projectId);
    if (project === null || !canAccessProject(request.user, project)) {
      return NextResponse.json({ error: 'Run not found' }, { status: 404 });
    }

    const body = await request.json() as WorkflowBody;
    const userId = request.user.userId;

    // Validate request shape: exactly one of overlay or rewindToStep
    const hasOverlay = body.overlay !== undefined;
    const hasRewind = body.rewindToStep !== undefined;

    if (hasOverlay && hasRewind) {
      return NextResponse.json(
        { error: 'Cannot specify both overlay and rewindToStep' },
        { status: 400 },
      );
    }

    if (!hasOverlay && !hasRewind) {
      return NextResponse.json(
        { error: 'Must specify either overlay or rewindToStep' },
        { status: 400 },
      );
    }

    if (hasOverlay) {
      const overlay = body.overlay ?? {};
      const result = applyWorkflowOverlay(db, runId, overlay, userId);
      if (!result.success) {
        return NextResponse.json(
          { error: result.error, details: result.details },
          { status: 409 },
        );
      }
      log.info({ runId, userId }, 'Workflow overlay applied via API');
      return NextResponse.json({ success: true, run: result.run });
    }

    // Rewind
    const result = rewindRun(db, runId, body.rewindToStep as RunStep, userId);
    if (!result.success) {
      return NextResponse.json({ error: result.error }, { status: 409 });
    }
    log.info({ runId, userId, toStep: body.rewindToStep }, 'Run rewound via API');
    return NextResponse.json({ success: true, run: result.run });
  } catch (err) {
    log.error(
      { error: err instanceof Error ? err.message : 'Unknown error' },
      'Failed to execute workflow mutation',
    );
    return NextResponse.json({ error: 'Failed to execute workflow mutation' }, { status: 500 });
  }
});
