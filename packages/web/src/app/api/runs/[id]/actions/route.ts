/**
 * Run Actions API
 *
 * Operator actions: approve_plan, revise_plan, reject_run, retry,
 * grant_policy_exception, deny_policy_exception, cancel.
 */

import { NextResponse } from 'next/server';
import {
  createLogger,
  getRun,
  getProject,
  canAccessProject,
  transitionPhase,
  TERMINAL_PHASES,
  recordOperatorAction,
  evaluateGatesAndTransition,
  createOverride,
  isValidOverrideScope,
  mirrorApprovalDecision,
} from '@conductor/shared';
import type { OverrideScope } from '@conductor/shared';
import { ensureBootstrap, getDb, getQueues } from '@/lib/bootstrap';
import { withAuth, type AuthenticatedRequest } from '@/lib/auth';

const log = createLogger({ name: 'conductor:api:run-actions' });

interface RouteParams {
  params: Promise<{ id: string }>;
}

interface ActionBody {
  action?: string;
  comment?: string;
  justification?: string;
  scope?: string;
}

/**
 * POST /api/runs/[id]/actions
 *
 * Execute an operator action on a run.
 * Protected: requires authentication.
 * Enforces ownership through project access.
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

    const body = await request.json() as ActionBody;

    if (body.action === undefined) {
      return NextResponse.json(
        { error: 'Missing required field: action' },
        { status: 400 }
      );
    }

    const userId = request.user.userId;

    switch (body.action) {
      // =====================================================================
      // approve_plan
      // =====================================================================
      case 'approve_plan': {
        if (run.phase !== 'awaiting_plan_approval') {
          return NextResponse.json(
            { error: 'Run is not awaiting plan approval' },
            { status: 400 }
          );
        }

        // Evaluate gate + transition atomically via orchestrator.
        // This ensures: gate passes before transition, events persist atomically.
        // Record the operator action AFTER the gate check passes to avoid
        // recording an approval action when artifacts are incomplete.
        const { gateCheck, transition: txnResult } = evaluateGatesAndTransition(
          db, run, 'awaiting_plan_approval',
          {
            runId,
            toPhase: 'executing',
            toStep: 'implementer_apply_changes',
            triggeredBy: userId,
            reason: 'Plan approved by operator',
          },
        );

        if (!gateCheck.allPassed) {
          log.warn({ runId, blockedBy: gateCheck.blockedBy }, 'Approve blocked — gate not passed');
          return NextResponse.json(
            { error: `Gate '${gateCheck.blockedBy ?? 'unknown'}' is not passed — cannot approve` },
            { status: 409 }
          );
        }

        if (txnResult?.success !== true) {
          log.error({ runId, error: txnResult?.error }, 'Approve transition failed');
          return NextResponse.json(
            { error: txnResult?.error ?? 'Failed to approve plan' },
            { status: 409 }
          );
        }

        // Record operator action only after successful gate check + transition
        const approveAction = recordOperatorAction(db, {
          runId,
          action: 'approve_plan',
          actorId: userId,
          actorType: 'operator',
          comment: body.comment,
          fromPhase: run.phase,
          toPhase: 'executing',
        });

        try {
          mirrorApprovalDecision(
            { db, queueManager: queues, conductorBaseUrl: process.env['CONDUCTOR_BASE_URL'] },
            { runId, operatorActionId: approveAction.operatorActionId, action: 'approve_plan', actorId: userId, fromPhase: run.phase, toPhase: 'executing', comment: body.comment },
          );
        } catch { /* non-fatal */ }

        log.info({ runId, userId }, 'Plan approved by operator');
        return NextResponse.json({ success: true, run: txnResult.run });
      }

      // =====================================================================
      // revise_plan
      // =====================================================================
      case 'revise_plan': {
        if (run.phase !== 'awaiting_plan_approval') {
          return NextResponse.json(
            { error: 'Run is not awaiting plan approval' },
            { status: 400 }
          );
        }

        if (body.comment === undefined || body.comment.trim() === '') {
          return NextResponse.json(
            { error: 'Comment is required for plan revision' },
            { status: 400 }
          );
        }

        const reviseAction = recordOperatorAction(db, {
          runId,
          action: 'revise_plan',
          actorId: userId,
          actorType: 'operator',
          comment: body.comment,
          fromPhase: run.phase,
          toPhase: 'planning',
        });

        try {
          mirrorApprovalDecision(
            { db, queueManager: queues, conductorBaseUrl: process.env['CONDUCTOR_BASE_URL'] },
            { runId, operatorActionId: reviseAction.operatorActionId, action: 'revise_plan', actorId: userId, fromPhase: run.phase, toPhase: 'planning', comment: body.comment },
          );
        } catch { /* non-fatal */ }

        // Increment plan revisions
        db.prepare(
          'UPDATE runs SET plan_revisions = plan_revisions + 1 WHERE run_id = ?'
        ).run(runId);

        // Check plan revision limit (default 3)
        const updatedRun = getRun(db, runId);
        const maxRevisions = 3;
        if (updatedRun !== null && updatedRun.planRevisions >= maxRevisions) {
          const blockResult = transitionPhase(db, {
            runId,
            toPhase: 'blocked',
            triggeredBy: userId,
            reason: 'Plan revision limit exceeded',
            blockedReason: 'retry_limit_exceeded',
            blockedContext: { prior_phase: run.phase, revisions: updatedRun.planRevisions },
          });

          log.info({ runId, userId, revisions: updatedRun.planRevisions }, 'Plan revision limit exceeded');
          return NextResponse.json({ success: true, run: blockResult.run });
        }

        const result = transitionPhase(db, {
          runId,
          toPhase: 'planning',
          toStep: 'planner_create_plan',
          triggeredBy: userId,
          reason: `Revision requested: ${body.comment}`,
        });

        if (!result.success) {
          log.error({ runId, error: result.error }, 'Revise transition failed');
          return NextResponse.json(
            { error: result.error ?? 'Failed to revise plan' },
            { status: 409 }
          );
        }

        log.info({ runId, userId }, 'Plan revision requested');
        return NextResponse.json({ success: true, run: result.run });
      }

      // =====================================================================
      // reject_run
      // =====================================================================
      case 'reject_run': {
        if (run.phase !== 'awaiting_plan_approval') {
          return NextResponse.json(
            { error: 'Run is not awaiting plan approval' },
            { status: 400 }
          );
        }

        if (body.comment === undefined || body.comment.trim() === '') {
          return NextResponse.json(
            { error: 'Comment is required for rejection' },
            { status: 400 }
          );
        }

        const rejectAction = recordOperatorAction(db, {
          runId,
          action: 'reject_run',
          actorId: userId,
          actorType: 'operator',
          comment: body.comment,
          fromPhase: run.phase,
          toPhase: 'cancelled',
        });

        try {
          mirrorApprovalDecision(
            { db, queueManager: queues, conductorBaseUrl: process.env['CONDUCTOR_BASE_URL'] },
            { runId, operatorActionId: rejectAction.operatorActionId, action: 'reject_run', actorId: userId, fromPhase: run.phase, toPhase: 'cancelled', comment: body.comment },
          );
        } catch { /* non-fatal */ }

        // No gate evaluation needed — rejection goes straight to cancelled.
        // The operator action record above is the audit trail for this decision.

        const result = transitionPhase(db, {
          runId,
          toPhase: 'cancelled',
          toStep: 'cleanup',
          triggeredBy: userId,
          result: 'cancelled',
          resultReason: 'Plan rejected by operator',
        });

        if (!result.success) {
          log.error({ runId, error: result.error }, 'Reject transition failed');
          return NextResponse.json(
            { error: result.error ?? 'Failed to reject run' },
            { status: 409 }
          );
        }

        await queues.addJob('cleanup', `cleanup:worktree:${runId}`, {
          type: 'worktree',
          targetId: runId,
        });

        log.info({ runId, userId }, 'Run rejected by operator');
        return NextResponse.json({ success: true, run: result.run });
      }

      // =====================================================================
      // retry
      // =====================================================================
      case 'retry': {
        if (run.phase !== 'blocked') {
          return NextResponse.json(
            { error: 'Run is not in blocked state' },
            { status: 400 }
          );
        }

        recordOperatorAction(db, {
          runId,
          action: 'retry',
          actorId: userId,
          actorType: 'operator',
          comment: body.comment,
          fromPhase: run.phase,
        });

        // Determine prior phase from blocked context
        let priorPhase: string = 'executing';
        if (run.blockedContextJson !== undefined) {
          const ctx = JSON.parse(run.blockedContextJson) as Record<string, unknown>;
          if (typeof ctx['prior_phase'] === 'string') {
            priorPhase = ctx['prior_phase'];
          }
        }

        const result = transitionPhase(db, {
          runId,
          toPhase: priorPhase as 'executing',
          triggeredBy: userId,
          reason: 'Retried by operator',
        });

        if (!result.success) {
          log.error({ runId, error: result.error }, 'Retry transition failed');
          return NextResponse.json(
            { error: result.error ?? 'Failed to retry run' },
            { status: 409 }
          );
        }

        // Clear blocked state
        db.prepare(
          'UPDATE runs SET blocked_reason = NULL, blocked_context_json = NULL WHERE run_id = ?'
        ).run(runId);

        log.info({ runId, userId, priorPhase }, 'Run retried by operator');
        return NextResponse.json({ success: true, run: getRun(db, runId) });
      }

      // =====================================================================
      // grant_policy_exception
      // =====================================================================
      case 'grant_policy_exception': {
        if (run.phase !== 'blocked') {
          return NextResponse.json(
            { error: 'Run is not in blocked state' },
            { status: 400 }
          );
        }

        if (run.blockedReason !== 'policy_exception_required') {
          return NextResponse.json(
            { error: 'Run is not blocked for a policy exception' },
            { status: 400 }
          );
        }

        if (body.justification === undefined || body.justification.trim() === '') {
          return NextResponse.json(
            { error: 'Justification is required for policy exceptions' },
            { status: 400 }
          );
        }

        const grantAction = recordOperatorAction(db, {
          runId,
          action: 'grant_policy_exception',
          actorId: userId,
          actorType: 'operator',
          comment: body.justification,
          fromPhase: run.phase,
        });

        try {
          mirrorApprovalDecision(
            { db, queueManager: queues, conductorBaseUrl: process.env['CONDUCTOR_BASE_URL'] },
            { runId, operatorActionId: grantAction.operatorActionId, action: 'grant_policy_exception', actorId: userId, fromPhase: run.phase, comment: body.justification },
          );
        } catch { /* non-fatal */ }

        // Finding 12: Validate scope against allowed enum
        const rawScope = body.scope ?? 'this_run';
        if (!isValidOverrideScope(rawScope)) {
          return NextResponse.json(
            { error: `Invalid scope: ${rawScope}. Must be one of: this_run, this_task, this_repo, project_wide` },
            { status: 400 }
          );
        }
        const scope: OverrideScope = rawScope;

        // Read blocked context for target and constraint info
        let targetId: string | undefined;
        let priorPhase = 'executing';
        let constraintKind: string | undefined;
        let constraintValue: string | undefined;
        let constraintHash: string | undefined;
        let violationId: string | undefined;

        if (run.blockedContextJson !== undefined) {
          const ctx = JSON.parse(run.blockedContextJson) as Record<string, unknown>;
          targetId = (ctx['policy_id'] as string) ?? undefined;
          constraintKind = (ctx['constraint_kind'] as string) ?? undefined;
          constraintValue = (ctx['constraint_value'] as string) ?? undefined;
          constraintHash = (ctx['constraint_hash'] as string) ?? undefined;
          violationId = (ctx['violation_id'] as string) ?? undefined;
          if (typeof ctx['prior_phase'] === 'string') {
            priorPhase = ctx['prior_phase'];
          }
        }

        // Enforce that constraint fields are present from blocked context.
        // Overrides without targetId or constraintKind are overly permissive —
        // they must be scoped to the specific policy/constraint that caused the block.
        if (targetId === undefined || constraintKind === undefined) {
          log.warn({ runId, targetId, constraintKind }, 'Grant exception: blocked context missing required fields');
          return NextResponse.json(
            { error: 'Cannot grant exception — blocked context is missing policy or constraint details. Try retrying instead.' },
            { status: 400 }
          );
        }

        // Create override via shared service (includes all constraint fields)
        const override = createOverride(db, {
          runId,
          kind: 'policy_exception',
          targetId,
          scope,
          constraintKind,
          constraintValue,
          constraintHash,
          policySetId: run.policySetId,
          operator: userId,
          justification: body.justification,
        });

        // Resolve the violation that caused the block
        if (violationId !== undefined) {
          db.prepare(
            'UPDATE policy_violations SET resolved_by_override_id = ? WHERE violation_id = ?'
          ).run(override.overrideId, violationId);
        }

        // Resume from prior phase
        const result = transitionPhase(db, {
          runId,
          toPhase: priorPhase as 'executing',
          triggeredBy: userId,
          reason: 'Policy exception granted',
        });

        if (!result.success) {
          log.error({ runId, error: result.error }, 'Grant exception transition failed');
          return NextResponse.json(
            { error: result.error ?? 'Failed to grant exception' },
            { status: 409 }
          );
        }

        // Clear blocked state
        db.prepare(
          'UPDATE runs SET blocked_reason = NULL, blocked_context_json = NULL WHERE run_id = ?'
        ).run(runId);

        log.info({ runId, userId, overrideId: override.overrideId }, 'Policy exception granted');
        return NextResponse.json({ success: true, run: getRun(db, runId) });
      }

      // =====================================================================
      // deny_policy_exception
      // =====================================================================
      case 'deny_policy_exception': {
        if (run.phase !== 'blocked') {
          return NextResponse.json(
            { error: 'Run is not in blocked state' },
            { status: 400 }
          );
        }

        if (run.blockedReason !== 'policy_exception_required') {
          return NextResponse.json(
            { error: 'Run is not blocked for a policy exception' },
            { status: 400 }
          );
        }

        if (body.comment === undefined || body.comment.trim() === '') {
          return NextResponse.json(
            { error: 'Comment is required for denial' },
            { status: 400 }
          );
        }

        const denyAction = recordOperatorAction(db, {
          runId,
          action: 'deny_policy_exception',
          actorId: userId,
          actorType: 'operator',
          comment: body.comment,
          fromPhase: run.phase,
          toPhase: 'cancelled',
        });

        try {
          mirrorApprovalDecision(
            { db, queueManager: queues, conductorBaseUrl: process.env['CONDUCTOR_BASE_URL'] },
            { runId, operatorActionId: denyAction.operatorActionId, action: 'deny_policy_exception', actorId: userId, fromPhase: run.phase, toPhase: 'cancelled', comment: body.comment },
          );
        } catch { /* non-fatal */ }

        const result = transitionPhase(db, {
          runId,
          toPhase: 'cancelled',
          toStep: 'cleanup',
          triggeredBy: userId,
          result: 'cancelled',
          resultReason: 'Policy exception denied',
        });

        if (!result.success) {
          log.error({ runId, error: result.error }, 'Deny exception transition failed');
          return NextResponse.json(
            { error: result.error ?? 'Failed to deny exception' },
            { status: 409 }
          );
        }

        await queues.addJob('cleanup', `cleanup:worktree:${runId}`, {
          type: 'worktree',
          targetId: runId,
        });

        log.info({ runId, userId }, 'Policy exception denied');
        return NextResponse.json({ success: true, run: result.run });
      }

      // =====================================================================
      // cancel (refactored to use shared service)
      // =====================================================================
      case 'cancel': {
        if (TERMINAL_PHASES.has(run.phase)) {
          return NextResponse.json(
            { error: 'Run is already in a terminal state' },
            { status: 409 }
          );
        }

        // Enqueue cancel job first — worker owns transition + signal + cleanup.
        // Stable job ID ensures repeated clicks are idempotent (BullMQ deduplicates).
        // Audit + mirror are written only after enqueue succeeds to avoid
        // recording a cancellation that was never actually queued.
        await queues.addJob('runs', `run-cancel-${runId}`, {
          runId,
          action: 'cancel',
          triggeredBy: userId,
        });

        const cancelAction = recordOperatorAction(db, {
          runId,
          action: 'cancel',
          actorId: userId,
          actorType: 'operator',
          comment: body.comment,
          fromPhase: run.phase,
          toPhase: 'cancelled',
        });

        try {
          mirrorApprovalDecision(
            { db, queueManager: queues, conductorBaseUrl: process.env['CONDUCTOR_BASE_URL'] },
            { runId, operatorActionId: cancelAction.operatorActionId, action: 'cancel', actorId: userId, fromPhase: run.phase, toPhase: 'cancelled', comment: body.comment },
          );
        } catch { /* non-fatal */ }

        log.info({ runId, userId }, 'Run cancel enqueued');
        return NextResponse.json({ success: true, status: 'cancel_enqueued' });
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
