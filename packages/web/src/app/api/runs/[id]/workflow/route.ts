/**
 * Run Workflow API
 *
 * Mutation endpoints for workflow overlay edits, step rewinds, and checkpoint rewinds.
 * All require the run to be paused and have no active agent invocations.
 */

import { NextResponse } from 'next/server';
import {
  createLogger,
  getRun,
  getProject,
  canAccessProject,
  applyWorkflowOverlay,
  rewindRun,
  rewindToCheckpoint,
  isValidContextMode,
} from '@conductor/shared';
import type { RunStep, RewindContextMode } from '@conductor/shared';
import { ensureBootstrap, getDb } from '@/lib/bootstrap';
import { withAuth, type AuthenticatedRequest } from '@/lib/auth';

const log = createLogger({ name: 'conductor:api:run-workflow' });

interface RouteParams {
  params: Promise<{ id: string }>;
}

interface WorkflowBody {
  overlay?: Record<string, unknown>;
  rewindToStep?: string;
  rewindToCheckpoint?: string;
  contextMode?: string;
  reason?: string;
}

/**
 * PUT /api/runs/[id]/workflow
 *
 * Edit workflow overlay, rewind to step, or rewind to checkpoint.
 * Protected: requires authentication.
 * Enforces ownership through project access.
 *
 * Body: { overlay: {...} } OR { rewindToStep: "step_name" } OR { rewindToCheckpoint: "checkpoint_name", contextMode?, reason? }
 * (mutually exclusive — exactly one of overlay, rewindToStep, rewindToCheckpoint)
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

    // Validate request shape: exactly one of overlay, rewindToStep, rewindToCheckpoint
    const hasOverlay = body.overlay !== undefined;
    const hasRewind = body.rewindToStep !== undefined;
    const hasCheckpoint = body.rewindToCheckpoint !== undefined;

    const opCount = [hasOverlay, hasRewind, hasCheckpoint].filter(Boolean).length;
    if (opCount !== 1) {
      return NextResponse.json(
        { error: 'Must specify exactly one of overlay, rewindToStep, or rewindToCheckpoint' },
        { status: 400 },
      );
    }

    // Reject contextMode/reason on non-checkpoint operations
    if (!hasCheckpoint && (body.contextMode !== undefined || body.reason !== undefined)) {
      return NextResponse.json(
        { error: 'contextMode and reason are only valid with rewindToCheckpoint' },
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

    if (hasRewind) {
      const result = rewindRun(db, runId, body.rewindToStep as RunStep, userId);
      if (!result.success) {
        return NextResponse.json({ error: result.error }, { status: 409 });
      }
      log.info({ runId, userId, toStep: body.rewindToStep }, 'Run rewound via API');
      return NextResponse.json({ success: true, run: result.run });
    }

    // Checkpoint rewind
    // Strict contextMode validation
    if (body.contextMode !== undefined && !isValidContextMode(body.contextMode)) {
      return NextResponse.json(
        { error: `Invalid contextMode: '${body.contextMode}'. Must be 'preserve' or 'truncate'.` },
        { status: 400 },
      );
    }

    const ctxMode: RewindContextMode = (body.contextMode as RewindContextMode) ?? 'truncate';
    const result = rewindToCheckpoint(
      db, runId, body.rewindToCheckpoint as string, userId, ctxMode, body.reason,
    );
    if (!result.success) {
      return NextResponse.json({ error: result.error }, { status: 409 });
    }
    log.info({ runId, userId, checkpoint: body.rewindToCheckpoint, ctxMode }, 'Run rewound to checkpoint via API');
    return NextResponse.json({ success: true, run: result.run });
  } catch (err) {
    log.error(
      { error: err instanceof Error ? err.message : 'Unknown error' },
      'Failed to execute workflow mutation',
    );
    return NextResponse.json({ error: 'Failed to execute workflow mutation' }, { status: 500 });
  }
});
