/**
 * Workflow Mutation Service
 *
 * Pause-only mutations: applyWorkflowOverlay and rewindRun.
 * Both enforce:
 * - Run must be paused (CAS guard)
 * - No active agent invocations (SQL subquery guard)
 * - Operator action recorded atomically (rolled back on CAS failure)
 *
 * Single-publisher rule: these functions own their publishOperatorActionEvent
 * calls. Callers (API routes, server actions) do NOT publish for these.
 */

import type { Database } from 'better-sqlite3';
import { createLogger } from '../logger/index.ts';
import type { RunPhase, RunStep, RewindContextMode } from '../types/index.ts';
import { isValidContextMode } from '../types/index.ts';
import { resolveCheckpoint } from './checkpoints.ts';
import { buildRewindContextSummary } from './rewind-context.ts';
import { getRun, type Run } from './index.ts';
import { recordOperatorAction, validateActionPhase } from '../operator-actions/index.ts';
import { createEvent } from '../events/index.ts';
import { validateWorkflowConfigStrict } from '../workflow-config/index.ts';
import { publishOperatorActionEvent, publishRunUpdatedEvent } from '../pubsub/index.ts';
import { CasConflictError } from '../run-commands/index.ts';

const log = createLogger({ name: 'conductor:workflow-mutations' });

// =============================================================================
// Workflow Overlay Edit
// =============================================================================

export interface ApplyOverlayResult {
  success: boolean;
  error?: string;
  details?: string[];
  run?: Run;
}

/**
 * Apply a workflow overlay to a paused run.
 *
 * Validates the overlay, records an operator action, and atomically updates
 * the overlay JSON + increments workflow_epoch. The CAS guard ensures the run
 * is paused and has no active invocations.
 */
export function applyWorkflowOverlay(
  db: Database,
  runId: string,
  overlay: Record<string, unknown>,
  triggeredBy: string,
): ApplyOverlayResult {
  // Validate overlay structure
  const errors = validateWorkflowConfigStrict(overlay);
  if (errors.length > 0) {
    return { success: false, error: 'Invalid workflow config', details: errors };
  }

  // Pre-validate paused state (structured error instead of throw)
  const run = getRun(db, runId);
  if (run === null) {
    return { success: false, error: 'Run not found' };
  }
  const phaseError = validateActionPhase('edit_workflow', run.phase, run.pausedAt);
  if (phaseError !== null) {
    return { success: false, error: phaseError };
  }

  const overlayJson = JSON.stringify(overlay);

  try {
    db.transaction(() => {
      // Record operator action FIRST (while paused_at IS NOT NULL — validates)
      recordOperatorAction(db, {
        runId,
        action: 'edit_workflow',
        actorId: triggeredBy,
        actorType: 'operator',
      });

      // Atomic CAS + active-invocation guard
      const now = new Date().toISOString();
      const result = db.prepare(`
        UPDATE runs SET workflow_overlay_json = ?, workflow_epoch = workflow_epoch + 1, updated_at = ?
        WHERE run_id = ? AND paused_at IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM agent_invocations WHERE run_id = ? AND status IN ('pending', 'running'))
      `).run(overlayJson, now, runId, runId);

      if (result.changes === 0) {
        throw new CasConflictError('edit_blocked');
      }
    })();
  } catch (err) {
    if (err instanceof CasConflictError) {
      // Distinguish cause by re-reading run state
      const run = getRun(db, runId);
      if (run?.pausedAt === undefined) {
        return { success: false, error: 'Run is not paused or does not exist' };
      }
      return { success: false, error: 'Cannot edit workflow while an agent invocation is active' };
    }
    throw err;
  }

  // After commit: publish events (single-publisher rule — callers do NOT publish)
  const updatedRun = getRun(db, runId);
  if (updatedRun !== null) {
    publishOperatorActionEvent(db, updatedRun.projectId, runId, 'edit_workflow', triggeredBy);
    publishRunUpdatedEvent(db, updatedRun.projectId, runId, ['workflowOverlayJson', 'workflowEpoch']);
  }

  log.info({ runId, triggeredBy }, 'Workflow overlay applied');
  return { success: true, run: updatedRun ?? undefined };
}

// =============================================================================
// Rewind
// =============================================================================

export interface RewindResult {
  success: boolean;
  error?: string;
  run?: Run;
}

export interface RewindOptions {
  contextMode?: RewindContextMode;
  checkpoint?: string;
  reason?: string;
  contextSummary?: string;
}

const REWIND_STEP_TO_PHASE: Partial<Record<RunStep, RunPhase>> = {
  setup_worktree: 'pending',
  planner_create_plan: 'planning',
  reviewer_review_plan: 'planning',
  wait_plan_approval: 'awaiting_plan_approval',
  implementer_apply_changes: 'executing',
  tester_run_tests: 'executing',
  reviewer_review_code: 'awaiting_review',
  create_pr: 'awaiting_review',
};

/**
 * Rewind a paused run to an earlier step.
 *
 * Bypasses the normal state machine (which doesn't allow arbitrary backward
 * transitions). Creates an audit event using the existing operator.action event
 * type, persists an operator_actions row, and manages run/event sequence fields
 * atomically. The CAS guard ensures the run is paused and has no active invocations.
 */
export function rewindRun(
  db: Database,
  runId: string,
  toStep: RunStep,
  triggeredBy: string,
  options?: RewindOptions,
): RewindResult {
  const toPhase = REWIND_STEP_TO_PHASE[toStep];
  if (toPhase === undefined) {
    return { success: false, error: `Cannot rewind to step '${toStep}'` };
  }

  // Runtime validation of contextMode (not just API boundary)
  if (options?.contextMode !== undefined && !isValidContextMode(options.contextMode)) {
    return { success: false, error: `Invalid contextMode: '${String(options.contextMode)}'` };
  }

  try {
    db.transaction(() => {
      // Re-read run for freshness
      const freshRun = getRun(db, runId);
      if (freshRun === null) {
        throw new Error('Run not found');
      }
      if (freshRun.pausedAt === undefined) {
        throw new Error('Run must be paused for rewind');
      }

      // Record operator action
      const comment = options?.reason ?? `Rewound from ${freshRun.step} to ${toStep}`;
      recordOperatorAction(db, {
        runId,
        action: 'rewind',
        actorId: triggeredBy,
        actorType: 'operator',
        fromPhase: freshRun.phase,
        toPhase,
        comment,
      });

      // Sequence-safe: allocate sequence using same formula as transitionPhase
      const maxEventSeq = (db.prepare(
        'SELECT COALESCE(MAX(sequence), 0) as max_seq FROM events WHERE run_id = ?'
      ).get(runId) as { max_seq: number }).max_seq;
      const sequence = Math.max(freshRun.nextSequence, maxEventSeq + 1);

      // Create audit event with enriched payload
      const eventPayload: Record<string, unknown> = {
        action: 'rewind',
        fromStep: freshRun.step,
        fromPhase: freshRun.phase,
        toStep,
        toPhase,
        triggeredBy,
      };
      if (options?.checkpoint !== undefined) eventPayload['checkpoint'] = options.checkpoint;
      if (options?.contextMode !== undefined) eventPayload['contextMode'] = options.contextMode;
      if (options?.reason !== undefined) eventPayload['reason'] = options.reason;

      createEvent(db, {
        projectId: freshRun.projectId,
        repoId: freshRun.repoId,
        taskId: freshRun.taskId,
        runId,
        type: 'operator.action',
        class: 'decision',
        payload: eventPayload,
        sequence,
        idempotencyKey: `rewind:${runId}:${sequence}`,
        source: 'operator',
      });

      // Atomic CAS + active-invocation guard (includes rewind context columns)
      const now = new Date().toISOString();
      const result = db.prepare(`
        UPDATE runs SET step = ?, phase = ?, workflow_epoch = workflow_epoch + 1,
          next_sequence = ?, last_event_sequence = ?,
          rewind_context_mode = ?, rewind_context_summary = ?,
          blocked_reason = NULL, blocked_context_json = NULL, updated_at = ?
        WHERE run_id = ? AND paused_at IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM agent_invocations WHERE run_id = ? AND status IN ('pending', 'running'))
      `).run(
        toStep, toPhase, sequence + 1, sequence,
        options?.contextMode ?? null, options?.contextSummary ?? null,
        now, runId, runId,
      );

      if (result.changes === 0) {
        throw new CasConflictError('rewind_blocked');
      }
    })();
  } catch (err) {
    if (err instanceof CasConflictError) {
      const run = getRun(db, runId);
      if (run?.pausedAt === undefined) {
        return { success: false, error: 'Run is not paused or does not exist' };
      }
      return { success: false, error: 'Cannot rewind while an agent invocation is active' };
    }
    if (err instanceof Error && (err.message === 'Run not found' || err.message === 'Run must be paused for rewind')) {
      return { success: false, error: err.message };
    }
    throw err;
  }

  // After commit: publish events (single-publisher rule)
  const updatedRun = getRun(db, runId);
  if (updatedRun !== null) {
    publishOperatorActionEvent(db, updatedRun.projectId, runId, 'rewind', triggeredBy);
    publishRunUpdatedEvent(db, updatedRun.projectId, runId, ['step', 'phase', 'workflowEpoch']);
  }

  log.info({ runId, toStep, toPhase, triggeredBy }, 'Run rewound');
  return { success: true, run: updatedRun ?? undefined };
}

/**
 * Rewind a paused run to a named checkpoint.
 *
 * Higher-level abstraction over rewindRun that resolves checkpoint names
 * to RunStep targets and optionally builds a context summary when
 * contextMode is 'preserve'.
 */
export function rewindToCheckpoint(
  db: Database,
  runId: string,
  checkpoint: string,
  triggeredBy: string,
  contextMode: RewindContextMode = 'truncate',
  reason?: string,
): RewindResult {
  const target = resolveCheckpoint(checkpoint);
  if (target === null) {
    return { success: false, error: `Unknown or non-rewindable checkpoint: '${checkpoint}'` };
  }

  let contextSummary: string | undefined;
  if (contextMode === 'preserve') {
    contextSummary = buildRewindContextSummary(db, runId);
  }

  return rewindRun(db, runId, target.step, triggeredBy, {
    contextMode,
    checkpoint,
    reason,
    contextSummary,
  });
}
