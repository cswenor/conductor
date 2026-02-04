/**
 * Orchestrator Module
 *
 * Enforces the protocol invariant: event + state mutation in same transaction.
 * This is the ONLY code path that may create `phase.transitioned` events.
 */

import type { Database } from 'better-sqlite3';
import { createLogger } from '../logger/index';
import type { RunPhase, RunStep } from '../types/index';
import { getRun, clearActiveRunIfTerminal, type Run } from '../runs/index';
import { createEvent, type EventRecord } from '../events/index';

const log = createLogger({ name: 'conductor:orchestrator' });

// =============================================================================
// Types
// =============================================================================

export interface TransitionInput {
  runId: string;
  toPhase: RunPhase;
  toStep?: RunStep;
  triggeredBy: string;
  reason?: string;
  result?: string;
  resultReason?: string;
  blockedReason?: string;
  blockedContext?: Record<string, unknown>;
}

export interface TransitionResult {
  success: boolean;
  run?: Run;
  event?: EventRecord;
  error?: string;
}

// =============================================================================
// Phase State Machine
// =============================================================================

export const VALID_TRANSITIONS: Record<RunPhase, ReadonlyArray<RunPhase>> = {
  pending: ['planning', 'blocked', 'cancelled'],
  planning: ['awaiting_plan_approval', 'blocked', 'cancelled'],
  awaiting_plan_approval: ['planning', 'executing', 'blocked', 'cancelled'],
  executing: ['awaiting_review', 'blocked', 'cancelled'],
  awaiting_review: ['executing', 'completed', 'blocked', 'cancelled'],
  blocked: ['cancelled'],
  completed: [],
  cancelled: [],
};

export const TERMINAL_PHASES: ReadonlySet<RunPhase> = new Set(['completed', 'cancelled']);

export function isValidTransition(from: RunPhase, to: RunPhase): boolean {
  return VALID_TRANSITIONS[from].includes(to);
}

// =============================================================================
// Core Transition Function
// =============================================================================

/**
 * Atomically transition a run's phase and create a `phase.transitioned` event.
 *
 * This is the ONLY code path that may move a run between phases.
 * Uses optimistic locking (WHERE phase = currentPhase) to prevent races.
 */
export function transitionPhase(db: Database, input: TransitionInput): TransitionResult {
  const doTransition = db.transaction((): TransitionResult => {
    // 1. Read current run
    const run = getRun(db, input.runId);
    if (run === null) {
      return { success: false, error: `Run ${input.runId} not found` };
    }

    const fromPhase = run.phase;
    const toPhase = input.toPhase;

    // 2. Validate transition
    if (!isValidTransition(fromPhase, toPhase)) {
      return {
        success: false,
        error: `Invalid transition: ${fromPhase} → ${toPhase}`,
      };
    }

    // 3. Allocate sequence from runs.next_sequence
    const sequence = run.nextSequence;

    // 4. INSERT phase.transitioned event
    const now = new Date().toISOString();

    const payload: Record<string, unknown> = {
      from: fromPhase,
      to: toPhase,
      triggeredBy: input.triggeredBy,
    };
    if (input.reason !== undefined) payload['reason'] = input.reason;
    if (input.toStep !== undefined) payload['step'] = input.toStep;
    if (input.result !== undefined) payload['result'] = input.result;
    if (input.resultReason !== undefined) payload['resultReason'] = input.resultReason;
    if (input.blockedReason !== undefined) payload['blockedReason'] = input.blockedReason;

    // Insert event directly (we're inside the transaction, using createEvent for validation)
    const event = createEvent(db, {
      projectId: run.projectId,
      repoId: run.repoId,
      taskId: run.taskId,
      runId: run.runId,
      type: 'phase.transitioned',
      class: 'decision',
      payload,
      sequence,
      idempotencyKey: `phase:${run.runId}:${sequence}`,
      source: 'orchestrator',
    });

    // 5. UPDATE run record with optimistic lock
    const toStep = input.toStep ?? run.step;
    const completedAt = TERMINAL_PHASES.has(toPhase) ? now : null;

    const updateResult = db.prepare(`
      UPDATE runs SET
        phase = ?,
        step = ?,
        next_sequence = ?,
        last_event_sequence = ?,
        updated_at = ?,
        completed_at = COALESCE(?, completed_at),
        result = COALESCE(?, result),
        result_reason = COALESCE(?, result_reason),
        blocked_reason = ?,
        blocked_context_json = ?
      WHERE run_id = ? AND phase = ?
    `).run(
      toPhase,
      toStep,
      sequence + 1,
      sequence,
      now,
      completedAt,
      input.result ?? null,
      input.resultReason ?? null,
      input.blockedReason ?? null,
      input.blockedContext !== undefined ? JSON.stringify(input.blockedContext) : null,
      run.runId,
      fromPhase  // optimistic lock
    );

    // 6. Check optimistic lock
    if (updateResult.changes === 0) {
      // Another process already transitioned this run
      return {
        success: false,
        error: `Optimistic lock failed: run ${run.runId} phase changed from ${fromPhase}`,
      };
    }

    // 7. If terminal, clear task active_run_id
    if (TERMINAL_PHASES.has(toPhase)) {
      clearActiveRunIfTerminal(db, run.runId);
    }

    log.info(
      { runId: run.runId, from: fromPhase, to: toPhase, sequence, triggeredBy: input.triggeredBy },
      'Phase transitioned'
    );

    // Re-read the updated run
    const updatedRun = getRun(db, run.runId);

    return {
      success: true,
      run: updatedRun ?? undefined,
      event: event ?? undefined,
    };
  });

  return doTransition();
}
