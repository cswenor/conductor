/**
 * Gate Evaluator Registry
 *
 * Dispatches gate evaluation to the correct evaluator by gate_id.
 * Each evaluator is a pure function: (db, run) → GateResult.
 * The registry creates a gate_evaluation record for each evaluation.
 */

import type { Database } from 'better-sqlite3';
import type { GateStatus } from '../../types/index.js';
import type { Run } from '../../runs/index.js';
import { createEvent } from '../../events/index.js';
import { createGateEvaluation } from '../gate-evaluations.js';
import { getGateDefinition } from '../gate-definitions.js';
import { evaluatePlanApproval } from './plan-approval.js';
import { evaluateTestsPass } from './tests-pass.js';

// =============================================================================
// Types
// =============================================================================

export interface GateResult {
  status: GateStatus;
  reason?: string;
  escalate?: boolean;
  details?: Record<string, unknown>;
}

export type GateEvaluatorFn = (db: Database, run: Run) => GateResult;

// =============================================================================
// Registry
// =============================================================================

const GATE_EVALUATORS: Record<string, GateEvaluatorFn> = {
  plan_approval: evaluatePlanApproval,
  tests_pass: evaluateTestsPass,
};

/**
 * Evaluate a gate for a run.
 * Dispatches to the correct evaluator, creates a gate_evaluation record,
 * and emits a gate.evaluated event.
 *
 * Returns null if the gate has no registered evaluator.
 */
export function evaluateGate(
  db: Database,
  run: Run,
  gateId: string,
): GateResult | null {
  const evaluator = GATE_EVALUATORS[gateId];
  if (evaluator === undefined) {
    return null;
  }

  const gateDef = getGateDefinition(db, gateId);
  if (gateDef === null) {
    return null;
  }

  // Run the evaluator
  const result = evaluator(db, run);

  // Emit gate.evaluated event
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
    source: 'worker',
  });

  // Record gate evaluation with causation event
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

  return result;
}
