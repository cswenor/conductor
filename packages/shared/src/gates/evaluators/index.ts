/**
 * Gate Evaluator Registry
 *
 * Dispatches gate evaluation to the correct evaluator by gate_id.
 * Each evaluator is a pure function: (db, run) → GateResult.
 *
 * Per PROTOCOL.md: decision events MUST be emitted with source='orchestrator'
 * and state mutation + event creation MUST happen in the same transaction.
 *
 * Gate persistence is handled exclusively by the orchestrator module
 * (persistGateResult / evaluateGatesAndTransition) to enforce the
 * invariant that all decision events originate from the orchestrator boundary.
 */

import type { Database } from 'better-sqlite3';
import type { GateStatus } from '../../types/index.ts';
import type { Run } from '../../runs/index.ts';
import { evaluatePlanApproval } from './plan-approval.ts';
import { evaluateTestsPass } from './tests-pass.ts';

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

