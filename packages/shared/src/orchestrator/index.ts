/**
 * Orchestrator Module
 *
 * Enforces the protocol invariant: event + state mutation in same transaction.
 * This is the ONLY code path that may create `phase.transitioned` events.
 */

import type { Database } from 'better-sqlite3';
import { createLogger } from '../logger/index';
import type { RunPhase, RunStep, GateStatus } from '../types/index';
import { getRun, clearActiveRunIfTerminal, type Run } from '../runs/index';
import { createEvent, type EventRecord } from '../events/index';
import { createGateEvaluation, deriveGateState } from '../gates/gate-evaluations';
import { getGateDefinition } from '../gates/gate-definitions';
import { evaluateGatePure, type GateResult } from '../gates/evaluators/index';

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
  blocked: ['pending', 'planning', 'awaiting_plan_approval', 'executing', 'awaiting_review', 'cancelled'],
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

// =============================================================================
// Default Gate Configuration
// =============================================================================

/**
 * Default required gates for runs without a RoutingDecision.
 * Maps phase → gates that must pass before leaving that phase.
 * Per ROUTING_AND_GATES.md: v0.1 uses a default set; future routing
 * engine will provide per-run gate lists via RoutingDecision.
 */
const DEFAULT_PHASE_GATES: Record<string, string[]> = {
  awaiting_plan_approval: ['plan_approval'],
  // tests_pass is checked after implementation completes (before awaiting_review)
  executing: ['tests_pass'],
};

const DEFAULT_REQUIRED_GATES = ['plan_approval', 'tests_pass', 'code_review', 'merge_wait'];
const DEFAULT_OPTIONAL_GATES: string[] = [];

/**
 * Get the required and optional gate lists for a run.
 * Uses RoutingDecision if available, otherwise default set.
 */
export function getRunGateConfig(
  db: Database,
  runId: string,
): { requiredGates: string[]; optionalGates: string[] } {
  // Check for a RoutingDecision in the routing_decisions table
  const row = db.prepare(`
    SELECT required_gates_json, optional_gates_json
    FROM routing_decisions
    WHERE run_id = ?
    ORDER BY decided_at DESC
    LIMIT 1
  `).get(runId) as {
    required_gates_json: string | null;
    optional_gates_json: string | null;
  } | undefined;

  if (row?.required_gates_json !== undefined && row.required_gates_json !== null) {
    try {
      const required = JSON.parse(row.required_gates_json) as string[];
      const optional = row.optional_gates_json !== null
        ? JSON.parse(row.optional_gates_json) as string[]
        : [];
      return { requiredGates: required, optionalGates: optional };
    } catch {
      log.warn({ runId }, 'Invalid RoutingDecision JSON, using defaults');
    }
  }

  return {
    requiredGates: DEFAULT_REQUIRED_GATES,
    optionalGates: DEFAULT_OPTIONAL_GATES,
  };
}

// =============================================================================
// Gate Persistence (within caller's transaction)
// =============================================================================

/**
 * Persist a gate evaluation result (event + record) without creating
 * its own transaction. Must be called from within an existing transaction.
 *
 * This is the ONLY code path that creates gate.evaluated events,
 * ensuring all decision events come from the orchestrator boundary.
 */
function persistGateResult(
  db: Database,
  run: Run,
  gateId: string,
  result: GateResult,
): void {
  const gateDef = getGateDefinition(db, gateId);
  if (gateDef === null) return;

  const event = createEvent(db, {
    projectId: run.projectId,
    runId: run.runId,
    type: 'gate.evaluated',
    class: 'decision',
    payload: {
      gateId,
      status: result.status,
      reason: result.reason,
      escalate: result.escalate,
    },
    idempotencyKey: `gate:${run.runId}:${gateId}:${Date.now()}`,
    source: 'orchestrator',
  });

  if (event !== null) {
    createGateEvaluation(db, {
      runId: run.runId,
      gateId,
      kind: gateDef.kind,
      status: result.status,
      reason: result.reason,
      details: result.details,
      causationEventId: event.eventId,
    });
  }
}

// =============================================================================
// Gate-Aware Phase Evaluation
// =============================================================================

export interface GateCheckResult {
  allPassed: boolean;
  results: Record<string, GateResult>;
  blockedBy?: string;
}

/**
 * Evaluate gates required before leaving a phase.
 * Consults the run's RoutingDecision (or default) to determine which
 * gates apply, then evaluates each via the evaluator registry.
 *
 * Uses pure evaluation (no persistence). Callers that need to persist
 * gate results should use persistAndTransition() or call persistGateResult()
 * within their own transaction.
 *
 * Returns the evaluation results and whether all required gates passed.
 */
export function evaluateGatesForPhase(
  db: Database,
  run: Run,
  phase: string,
): GateCheckResult {
  const { requiredGates } = getRunGateConfig(db, run.runId);
  const phaseGateIds = DEFAULT_PHASE_GATES[phase] ?? [];

  // Only evaluate gates that are both required for this phase and in the run's required list
  const applicableGates = phaseGateIds.filter(g => requiredGates.includes(g));

  const results: Record<string, GateResult> = {};
  let allPassed = true;
  let blockedBy: string | undefined;

  for (const gateId of applicableGates) {
    const result = evaluateGatePure(db, run, gateId);
    if (result !== null) {
      results[gateId] = result;
      if (result.status !== 'passed') {
        allPassed = false;
        blockedBy ??= gateId;
      }
    }
  }

  return { allPassed, results, blockedBy };
}

/**
 * Check if all required gates for a phase are currently passed.
 * Uses the derived gate state (latest evaluations) rather than
 * re-evaluating. Useful for pre-transition validation.
 */
export function areGatesPassed(
  db: Database,
  runId: string,
  phase: string,
): { passed: boolean; blockedBy?: string } {
  const { requiredGates } = getRunGateConfig(db, runId);
  const phaseGateIds = DEFAULT_PHASE_GATES[phase] ?? [];
  const applicableGates = phaseGateIds.filter(g => requiredGates.includes(g));

  if (applicableGates.length === 0) {
    return { passed: true };
  }

  const gateState = deriveGateState(db, runId);

  for (const gateId of applicableGates) {
    const status: GateStatus | undefined = gateState[gateId];
    if (status !== 'passed') {
      return { passed: false, blockedBy: gateId };
    }
  }

  return { passed: true };
}

// =============================================================================
// Atomic Gate-Aware Transitions (orchestrator boundary)
// =============================================================================

/**
 * Evaluate gates for a phase, persist results, and optionally transition —
 * all in a single transaction.
 *
 * This is the correct entry point for gate-guarded transitions. It ensures:
 * 1. Gate evaluation events are emitted with source='orchestrator'
 * 2. Gate evaluation + phase transition happen atomically
 * 3. No "decision events without state change" or vice versa
 *
 * If gates pass, transitions to toPhase. If they don't, returns the gate
 * results without transitioning.
 */
export function evaluateGatesAndTransition(
  db: Database,
  run: Run,
  phase: string,
  transition: TransitionInput,
): { gateCheck: GateCheckResult; transition?: TransitionResult } {
  const { requiredGates } = getRunGateConfig(db, run.runId);
  const phaseGateIds = DEFAULT_PHASE_GATES[phase] ?? [];
  const applicableGates = phaseGateIds.filter(g => requiredGates.includes(g));

  // Pure evaluation first (reads only)
  const results: Record<string, GateResult> = {};
  let allPassed = true;
  let blockedBy: string | undefined;

  for (const gateId of applicableGates) {
    const result = evaluateGatePure(db, run, gateId);
    if (result !== null) {
      results[gateId] = result;
      if (result.status !== 'passed') {
        allPassed = false;
        blockedBy ??= gateId;
      }
    }
  }

  const gateCheck: GateCheckResult = { allPassed, results, blockedBy };

  // Persist gate evaluations + conditional phase transition atomically
  const doAtomicTransition = db.transaction((): TransitionResult | undefined => {
    // Persist all gate evaluation results
    for (const gateId of applicableGates) {
      const result = results[gateId];
      if (result !== undefined) {
        persistGateResult(db, run, gateId, result);
      }
    }

    // Only transition if gates passed
    if (!allPassed) {
      return undefined;
    }

    // Perform the phase transition (inline, not via transitionPhase which has its own txn)
    const currentRun = getRun(db, transition.runId);
    if (currentRun === null) {
      return { success: false, error: `Run ${transition.runId} not found` };
    }

    const fromPhase = currentRun.phase;
    const toPhase = transition.toPhase;

    if (!isValidTransition(fromPhase, toPhase)) {
      return { success: false, error: `Invalid transition: ${fromPhase} → ${toPhase}` };
    }

    const sequence = currentRun.nextSequence;
    const now = new Date().toISOString();

    const payload: Record<string, unknown> = {
      from: fromPhase,
      to: toPhase,
      triggeredBy: transition.triggeredBy,
    };
    if (transition.reason !== undefined) payload['reason'] = transition.reason;
    if (transition.toStep !== undefined) payload['step'] = transition.toStep;
    if (transition.result !== undefined) payload['result'] = transition.result;
    if (transition.resultReason !== undefined) payload['resultReason'] = transition.resultReason;

    const event = createEvent(db, {
      projectId: currentRun.projectId,
      repoId: currentRun.repoId,
      taskId: currentRun.taskId,
      runId: currentRun.runId,
      type: 'phase.transitioned',
      class: 'decision',
      payload,
      sequence,
      idempotencyKey: `phase:${currentRun.runId}:${sequence}`,
      source: 'orchestrator',
    });

    const toStep = transition.toStep ?? currentRun.step;
    const completedAt = TERMINAL_PHASES.has(toPhase) ? now : null;

    const updateResult = db.prepare(`
      UPDATE runs SET
        phase = ?, step = ?, next_sequence = ?, last_event_sequence = ?,
        updated_at = ?, completed_at = COALESCE(?, completed_at),
        result = COALESCE(?, result), result_reason = COALESCE(?, result_reason),
        blocked_reason = ?, blocked_context_json = ?
      WHERE run_id = ? AND phase = ?
    `).run(
      toPhase, toStep, sequence + 1, sequence, now,
      completedAt, transition.result ?? null, transition.resultReason ?? null,
      transition.blockedReason ?? null,
      transition.blockedContext !== undefined ? JSON.stringify(transition.blockedContext) : null,
      currentRun.runId, fromPhase,
    );

    if (updateResult.changes === 0) {
      return { success: false, error: `Optimistic lock failed: run ${currentRun.runId}` };
    }

    if (TERMINAL_PHASES.has(toPhase)) {
      clearActiveRunIfTerminal(db, currentRun.runId);
    }

    log.info(
      { runId: currentRun.runId, from: fromPhase, to: toPhase, sequence, triggeredBy: transition.triggeredBy },
      'Phase transitioned (atomic with gate evaluation)',
    );

    return {
      success: true,
      run: getRun(db, currentRun.runId) ?? undefined,
      event: event ?? undefined,
    };
  });

  const transitionResult = doAtomicTransition();
  return { gateCheck, transition: transitionResult };
}

/**
 * Persist gate evaluation results for a run without transitioning.
 * Wraps all gate results in a single transaction.
 * Used when gates don't pass but results still need to be recorded.
 */
export function persistGateEvaluations(
  db: Database,
  run: Run,
  results: Record<string, GateResult>,
): void {
  const doPersist = db.transaction(() => {
    for (const [gateId, result] of Object.entries(results)) {
      persistGateResult(db, run, gateId, result);
    }
  });
  doPersist();
}
