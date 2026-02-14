/**
 * Run Commands Module
 *
 * Shared domain commands for approve, reject, and revise operations.
 * Both server actions and API routes delegate to these commands.
 * Commands own event publishing (publishTransitionEvent + publishOperatorActionEvent).
 */

import type { Database } from 'better-sqlite3';
import { createLogger } from '../logger/index.ts';
import type { ActorType } from '../types/index.ts';
import { getRun, type Run } from '../runs/index.ts';
import { transitionPhase, evaluateGatesAndTransition } from '../orchestrator/index.ts';
import { recordOperatorAction, getOperatorActionForDecision, type OperatorAction } from '../operator-actions/index.ts';
import { recordGateDecision, getGateDecision } from '../gates/decisions.ts';
import { publishTransitionEvent, publishOperatorActionEvent } from '../pubsub/index.ts';

const log = createLogger({ name: 'conductor:run-commands' });

// =============================================================================
// Types
// =============================================================================

export type ApproveOutcome =
  | 'approved'           // decision inserted + gates pass + transitioned to executing
  | 'accepted'           // decision inserted + some gates still pending (durable intent)
  | 'already_decided'    // same decision already exists (idempotent, no new writes)
  | 'conflict'           // opposite decision exists for this cycle
  | 'wrong_phase'        // run not in awaiting_plan_approval AND no existing matching decision
  | 'stale_run'          // phase or cycle changed between client read and command execution
  | 'transition_failed'; // gates passed but transition failed (optimistic lock; decision is durable)

export type RejectOutcome =
  | 'rejected'           // decision + audit + transition to cancelled (atomic)
  | 'already_decided'    // same decision exists (idempotent)
  | 'conflict'           // opposite decision exists (approved)
  | 'wrong_phase'        // run not in awaiting_plan_approval AND no existing matching decision
  | 'stale_run'          // phase or cycle changed between client read and command execution
  | 'transition_failed'; // atomic rollback — decision + audit not persisted

export type ReviseOutcome =
  | 'revised'            // transitioned to planning (atomic)
  | 'blocked'            // revision limit exceeded, transitioned to blocked (atomic)
  | 'wrong_phase'        // run not in awaiting_plan_approval
  | 'stale_run'          // phase or cycle changed between client read and command execution
  | 'transition_failed'; // atomic rollback — audit + revision not persisted

export interface PlanCommandInput {
  db: Database;
  run: Run;
  actorId: string;
  actorType: ActorType;
  comment?: string;
}

export interface PlanCommandResult<T extends string = string> {
  outcome: T;
  success: boolean;
  error?: string;
  run?: Run;
  operatorAction?: OperatorAction;
}

class StaleRunError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StaleRunError';
  }
}

// =============================================================================
// approvePlanCommand
// =============================================================================

/**
 * Approve a plan.
 *
 * Two-phase:
 * - Phase A (db.transaction): re-validate run state + record gate decision + operator action
 * - Phase B: evaluateGatesAndTransition (owns its own transaction)
 *
 * If Phase B fails, Phase A remains committed — the decision is durable intent.
 */
export function approvePlanCommand(input: PlanCommandInput): PlanCommandResult<ApproveOutcome> {
  const { db, run, actorId, actorType, comment } = input;

  // 0. Read fresh run + cycle freshness gate
  const currentRun = getRun(db, run.runId);
  if (currentRun === null) {
    return { outcome: 'stale_run', success: false, error: 'Run not found — please refresh and retry' };
  }
  if (currentRun.approvalCycle !== run.approvalCycle) {
    return { outcome: 'stale_run', success: false, error: 'Run state changed — please refresh and retry' };
  }

  // 1. Same-cycle decision lookup — use currentRun.approvalCycle (fresh) for clarity
  const existing = getGateDecision(db, run.runId, 'plan_approval', currentRun.approvalCycle);
  if (existing !== null) {
    if (existing.decision === 'approved') {
      if (currentRun.phase !== 'awaiting_plan_approval') {
        // Run already transitioned — true double-click idempotency
        return { outcome: 'already_decided', success: true, run: currentRun };
      }
      // Decision exists but run is still awaiting approval — Phase B never succeeded
      // (e.g. prior evaluator bug, crash between Phase A and B). Retry Phase B.
      const { gateCheck, transition: txnResult } = evaluateGatesAndTransition(
        db, currentRun, 'awaiting_plan_approval',
        {
          runId: currentRun.runId, toPhase: 'executing', toStep: 'implementer_apply_changes',
          triggeredBy: actorId, reason: 'Plan approved by operator',
        },
      );

      if (!gateCheck.allPassed) {
        return { outcome: 'accepted', success: true, run: currentRun };
      }

      if (txnResult?.success !== true) {
        return {
          outcome: 'transition_failed', success: false,
          error: txnResult?.error ?? 'Failed to transition',
        };
      }

      publishTransitionEvent(run.projectId, run.runId, currentRun.phase, 'executing', db);
      // Do NOT re-publish operator action event — already published during original Phase A.
      const originalAction = getOperatorActionForDecision(
        db, run.runId, 'approve_plan', existing.actorId, existing.createdAt,
      );
      if (originalAction === null) {
        log.warn({
          runId: run.runId, decisionActorId: existing.actorId, decisionCreatedAt: existing.createdAt,
        }, 'Retry: no matching operator action found for decision');
      }
      log.info({ runId: run.runId, actorId, outcome: 'approved (retry)' }, 'Plan approved on retry');
      return { outcome: 'approved', success: true, run: txnResult.run, operatorAction: originalAction ?? undefined };
    }
    return { outcome: 'conflict', success: false, error: `Gate already has decision: ${existing.decision}` };
  }

  // 2. Phase check — use currentRun (fresh), not run (caller's stale snapshot)
  if (currentRun.phase !== 'awaiting_plan_approval') {
    return { outcome: 'wrong_phase', success: false, error: 'Run is not awaiting plan approval' };
  }

  // Phase A: record decision + audit atomically, with in-transaction freshness check
  const recordDecisionAndAudit = db.transaction(() => {
    // Re-read run inside transaction to prevent stale-state writes.
    const freshRun = getRun(db, run.runId);
    if (freshRun?.phase !== 'awaiting_plan_approval') {
      return { success: false as const, stale: true as const, error: 'Run phase changed' };
    }
    if (freshRun.approvalCycle !== run.approvalCycle) {
      return { success: false as const, stale: true as const, error: 'Approval cycle changed' };
    }

    const decisionResult = recordGateDecision(db, {
      runId: run.runId, gateId: 'plan_approval',
      cycle: freshRun.approvalCycle, decision: 'approved', actorId, comment,
    });

    // Race: another writer inserted between our check and this INSERT
    if (decisionResult.conflict) {
      return { success: false as const, error: `Gate already has decision: ${decisionResult.decision.decision}` };
    }

    // Idempotent retry (rare: another approve won the INSERT race)
    if (!decisionResult.inserted) {
      return { success: true as const, operatorAction: undefined as OperatorAction | undefined, alreadyDecided: true as const };
    }

    // Record operator action (audit trail)
    const operatorAction = recordOperatorAction(db, {
      runId: run.runId, action: 'approve_plan',
      actorId, actorType, comment,
      fromPhase: freshRun.phase, toPhase: 'executing',
    });

    return { success: true as const, operatorAction: operatorAction as OperatorAction | undefined, alreadyDecided: false as const };
  });

  const phaseA = recordDecisionAndAudit();
  if (!phaseA.success) {
    if ('stale' in phaseA && phaseA.stale) {
      return { outcome: 'stale_run', success: false, error: phaseA.error };
    }
    return { outcome: 'conflict', success: false, error: phaseA.error };
  }
  if (phaseA.alreadyDecided) {
    const latestRun = getRun(db, run.runId) ?? undefined;
    return { outcome: 'already_decided', success: true, run: latestRun };
  }

  // Re-read run AFTER Phase A commits — phase/cycle may have changed between phases.
  const freshRun = getRun(db, run.runId);
  if (freshRun?.phase !== 'awaiting_plan_approval') {
    // Phase changed between Phase A and Phase B — decision is durable, return accepted
    publishOperatorActionEvent(db, run.projectId, run.runId, 'approve_plan', actorId);
    return { outcome: 'accepted', success: true, operatorAction: phaseA.operatorAction };
  }

  // Phase B: evaluate gates + transition (evaluateGatesAndTransition owns its own transaction)
  const { gateCheck, transition: txnResult } = evaluateGatesAndTransition(
    db, freshRun, 'awaiting_plan_approval',
    {
      runId: freshRun.runId, toPhase: 'executing', toStep: 'implementer_apply_changes',
      triggeredBy: actorId, reason: 'Plan approved by operator',
    },
  );

  if (!gateCheck.allPassed) {
    // Decision is durable — gates will pass on retry when artifacts are ready
    publishOperatorActionEvent(db, run.projectId, run.runId, 'approve_plan', actorId);
    return { outcome: 'accepted', success: true, operatorAction: phaseA.operatorAction };
  }

  if (txnResult?.success !== true) {
    // Optimistic lock race — decision is durable, another process likely already transitioned
    return {
      outcome: 'transition_failed', success: false,
      error: txnResult?.error ?? 'Failed to transition', operatorAction: phaseA.operatorAction,
    };
  }

  // Publish events for successful transition — use freshRun.phase as fromPhase
  publishTransitionEvent(run.projectId, run.runId, freshRun.phase, 'executing', db);
  publishOperatorActionEvent(db, run.projectId, run.runId, 'approve_plan', actorId);

  log.info({ runId: run.runId, actorId, outcome: 'approved' }, 'Plan approved');

  return { outcome: 'approved', success: true, run: txnResult.run, operatorAction: phaseA.operatorAction };
}

// =============================================================================
// rejectRunCommand
// =============================================================================

/**
 * Reject a run (cancel it).
 *
 * Single db.transaction: re-validate + gate decision + operator action + transition to cancelled.
 * All or nothing — no dangling rejected decision without actual cancellation.
 */
export function rejectRunCommand(input: PlanCommandInput & { comment: string }): PlanCommandResult<RejectOutcome> {
  const { db, run, actorId, actorType, comment } = input;

  // 0. Read fresh run + cycle freshness gate
  const currentRun = getRun(db, run.runId);
  if (currentRun === null) {
    return { outcome: 'stale_run', success: false, error: 'Run not found — please refresh and retry' };
  }
  if (currentRun.approvalCycle !== run.approvalCycle) {
    return { outcome: 'stale_run', success: false, error: 'Run state changed — please refresh and retry' };
  }

  // 1. Same-cycle decision lookup — use currentRun.approvalCycle (fresh) for clarity
  const existing = getGateDecision(db, run.runId, 'plan_approval', currentRun.approvalCycle);
  if (existing !== null) {
    if (existing.decision === 'rejected') {
      return { outcome: 'already_decided', success: true, run: currentRun };
    }
    return { outcome: 'conflict', success: false, error: `Gate already has decision: ${existing.decision}` };
  }

  // 2. Phase check — use currentRun (fresh), not run (caller's stale snapshot)
  if (currentRun.phase !== 'awaiting_plan_approval') {
    return { outcome: 'wrong_phase', success: false, error: 'Run is not awaiting plan approval' };
  }

  // 2. Atomic: re-validate + decision + audit + transition
  const doReject = db.transaction((): PlanCommandResult<RejectOutcome> => {
    // Re-read run to prevent stale-state writes — validate BOTH phase AND cycle
    const freshRun = getRun(db, run.runId);
    if (freshRun?.phase !== 'awaiting_plan_approval'
        || freshRun.approvalCycle !== run.approvalCycle) {
      throw new StaleRunError('Run phase or cycle changed');
    }

    const decisionResult = recordGateDecision(db, {
      runId: run.runId, gateId: 'plan_approval',
      cycle: freshRun.approvalCycle, decision: 'rejected', actorId, comment,
    });
    if (decisionResult.conflict) {
      return { outcome: 'conflict', success: false, error: `Gate already has decision: ${decisionResult.decision.decision}` };
    }
    if (!decisionResult.inserted) {
      const latestRun = getRun(db, run.runId) ?? undefined;
      return { outcome: 'already_decided', success: true, run: latestRun };
    }

    const operatorAction = recordOperatorAction(db, {
      runId: run.runId, action: 'reject_run',
      actorId, actorType, comment,
      fromPhase: freshRun.phase, toPhase: 'cancelled',
    });

    // transitionPhase becomes SAVEPOINT inside this transaction
    const transition = transitionPhase(db, {
      runId: run.runId, toPhase: 'cancelled', toStep: 'cleanup',
      triggeredBy: actorId, result: 'cancelled',
      resultReason: 'Plan rejected by operator',
    });

    if (!transition.success) {
      // Throw to rollback decision + audit — reject must be atomic
      throw new Error(transition.error ?? 'Failed to transition');
    }

    return { outcome: 'rejected', success: true, run: transition.run, operatorAction };
  });

  try {
    const result = doReject();

    // Publish events only for state-changing outcomes
    if (result.outcome === 'rejected') {
      publishTransitionEvent(run.projectId, run.runId, run.phase, 'cancelled', db);
      publishOperatorActionEvent(db, run.projectId, run.runId, 'reject_run', actorId);
      log.info({ runId: run.runId, actorId, outcome: 'rejected' }, 'Run rejected');
    }

    return result;
  } catch (err) {
    // Everything rolled back (no dangling rejected decision)
    if (err instanceof StaleRunError) {
      return { outcome: 'stale_run', success: false, error: err.message };
    }
    const msg = err instanceof Error ? err.message : 'Failed to reject run';
    return { outcome: 'transition_failed', success: false, error: msg };
  }
}

// =============================================================================
// revisePlanCommand
// =============================================================================

/**
 * Request plan revision.
 *
 * Single db.transaction: re-validate + operator action + revision increment + transition.
 * All or nothing. When run re-enters awaiting_plan_approval, approval_cycle increments,
 * invalidating any prior decisions for the old cycle.
 */
export function revisePlanCommand(input: PlanCommandInput & { comment: string }): PlanCommandResult<ReviseOutcome> {
  const { db, run, actorId, actorType, comment } = input;

  // 0. Read fresh run + cycle freshness gate
  const currentRun = getRun(db, run.runId);
  if (currentRun === null) {
    return { outcome: 'stale_run', success: false, error: 'Run not found — please refresh and retry' };
  }
  if (currentRun.approvalCycle !== run.approvalCycle) {
    return { outcome: 'stale_run', success: false, error: 'Run state changed — please refresh and retry' };
  }

  // 1. Phase check — use currentRun (fresh), not run (caller's stale snapshot)
  if (currentRun.phase !== 'awaiting_plan_approval') {
    return { outcome: 'wrong_phase', success: false, error: 'Run is not awaiting plan approval' };
  }

  const doRevise = db.transaction((): { outcome: ReviseOutcome; toPhase: string; run?: Run; operatorAction?: OperatorAction } => {
    // Re-read run to prevent stale-state writes — validate BOTH phase AND cycle
    const freshRun = getRun(db, run.runId);
    if (freshRun?.phase !== 'awaiting_plan_approval'
        || freshRun.approvalCycle !== run.approvalCycle) {
      throw new StaleRunError('Run phase or cycle changed');
    }

    // 1. Record operator action (audit)
    const operatorAction = recordOperatorAction(db, {
      runId: run.runId, action: 'revise_plan',
      actorId, actorType, comment,
      fromPhase: freshRun.phase, toPhase: 'planning',
    });

    // 2. Increment plan_revisions
    db.prepare('UPDATE runs SET plan_revisions = plan_revisions + 1 WHERE run_id = ?').run(run.runId);

    // 3. Re-read, check revision limit
    const updatedRun = getRun(db, run.runId);
    const maxRevisions = 3;

    if (updatedRun !== null && updatedRun.planRevisions >= maxRevisions) {
      // Block — transitionPhase becomes SAVEPOINT
      const blockResult = transitionPhase(db, {
        runId: run.runId, toPhase: 'blocked', triggeredBy: actorId,
        reason: 'Plan revision limit exceeded',
        blockedReason: 'retry_limit_exceeded',
        blockedContext: { prior_phase: run.phase, revisions: updatedRun.planRevisions },
      });
      if (!blockResult.success) throw new Error(blockResult.error ?? 'Failed to block');
      return { outcome: 'blocked' as const, toPhase: 'blocked', run: blockResult.run, operatorAction };
    }

    // 4. Transition to planning — transitionPhase becomes SAVEPOINT
    const result = transitionPhase(db, {
      runId: run.runId, toPhase: 'planning', toStep: 'planner_create_plan',
      triggeredBy: actorId, reason: `Revision requested: ${comment}`,
    });
    if (!result.success) throw new Error(result.error ?? 'Failed to transition');
    return { outcome: 'revised' as const, toPhase: 'planning', run: result.run, operatorAction };
  });

  try {
    const result = doRevise();

    // Publish events after successful commit
    publishTransitionEvent(run.projectId, run.runId, run.phase, result.toPhase, db);
    publishOperatorActionEvent(db, run.projectId, run.runId, 'revise_plan', actorId);

    log.info({ runId: run.runId, actorId, outcome: result.outcome }, 'Plan revision processed');

    return { outcome: result.outcome, success: true, run: result.run, operatorAction: result.operatorAction };
  } catch (err) {
    if (err instanceof StaleRunError) {
      return { outcome: 'stale_run', success: false, error: err.message };
    }
    const msg = err instanceof Error ? err.message : 'Failed to revise';
    return { outcome: 'transition_failed', success: false, error: msg };
  }
}
