/**
 * Gate Evaluator Registry
 *
 * Dispatches gate evaluation to the correct evaluator by gate_id.
 * Each evaluator is a pure function: (db, run) → GateResult.
 *
 * Per PROTOCOL.md: decision events MUST be emitted with source='orchestrator'
 * and state mutation + event creation MUST happen in the same transaction.
 *
 * evaluateGate() runs the evaluator and persists the gate_evaluation record
 * + gate.evaluated event in a single transaction with source='orchestrator'.
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
 * Evaluate a gate for a run (pure evaluation only, no persistence).
 * Use this when you only need the result without recording it.
 * Returns null if the gate has no registered evaluator.
 */
export function evaluateGatePure(
  db: Database,
  run: Run,
  gateId: string,
): GateResult | null {
  const evaluator = GATE_EVALUATORS[gateId];
  if (evaluator === undefined) {
    return null;
  }
  return evaluator(db, run);
}

/**
 * Evaluate a gate for a run and persist the result.
 *
 * Runs the evaluator, then creates a gate.evaluated event (source='orchestrator')
 * and a gate_evaluation record in a single transaction.
 *
 * Per PROTOCOL.md: decision events use source='orchestrator' and state
 * mutation + event must be in the same transaction.
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

  // Run the evaluator (pure — reads only)
  const result = evaluator(db, run);

  // Persist event + evaluation atomically
  const persistGateEvaluation = db.transaction(() => {
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
  });

  persistGateEvaluation();

  return result;
}
