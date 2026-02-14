/**
 * Plan Approval Gate Evaluator
 *
 * Evaluates whether a run's plan has been approved by an operator.
 *
 * POLICY: When an operator decision exists, it is authoritative:
 * - Approved overrides changes_requested reviewer verdict (operator is human authority).
 * - Approved requires plan + review artifacts to EXIST (any validation_status).
 * - Rejected fails immediately regardless of artifact state.
 * This is an explicit exception to the valid-only artifact gate invariant.
 *
 * When no operator decision exists, full validation applies:
 * requires validated PLAN and REVIEW artifacts, then awaits operator action.
 */

import type { Database } from 'better-sqlite3';
import type { Run } from '../../runs/index.ts';
import { getValidArtifact, getLatestArtifact } from '../../agent-runtime/artifacts.ts';
import { getToolInvocation } from '../../agent-runtime/tool-invocations.ts';
import { getGateDecision } from '../decisions.ts';
import type { GateResult } from './index.ts';

/**
 * Evaluate the plan_approval gate for a run.
 *
 * Decision-first logic:
 * 1. Check gate decision for current cycle
 *    - rejected  -> fail immediately (no artifact checks)
 *    - approved  -> check artifact EXISTENCE (not validation_status)
 * 2. No decision -> full validation checks, then await operator
 */
export function evaluatePlanApproval(db: Database, run: Run): GateResult {
  // 1. Check for gate decision for current cycle (decision-first)
  const decision = getGateDecision(db, run.runId, 'plan_approval', run.approvalCycle);

  if (decision !== null && decision.decision === 'rejected') {
    return { status: 'failed', reason: decision.comment ?? 'Plan rejected by operator' };
  }

  if (decision !== null && decision.decision === 'approved') {
    // Operator approved — require artifacts to EXIST (any validation_status).
    // Uses getLatestArtifact (not getValidArtifact) because the operator's approval
    // is authoritative and overrides validation_status checks.
    //
    // NOTE: getLatestArtifact can return prior-cycle artifacts — specifically after
    // blocked-retry (revisePlanCommand blocks -> retry -> re-enters awaiting_plan_approval
    // incrementing cycle, without new planning). This is correct behavior: the cycle
    // tracks *decision validity* (old approval doesn't carry over), not *content
    // freshness* (plan hasn't changed). Strict cycle-aware artifact checks would make
    // approval impossible after blocked-retry without a full re-plan.
    const planArtifact = getLatestArtifact(db, run.runId, 'plan');
    if (planArtifact === null) {
      return { status: 'pending', reason: 'Operator approved but plan artifact not yet created' };
    }

    const reviewArtifact = getLatestArtifact(db, run.runId, 'review');
    if (reviewArtifact === null) {
      return { status: 'pending', reason: 'Operator approved but review artifact not yet created' };
    }

    return { status: 'passed', reason: 'Plan approved by operator' };
  }

  // 2. No decision — full validation checks
  const planArtifact = getValidArtifact(db, run.runId, 'plan');
  if (planArtifact === null) {
    return {
      status: 'pending',
      reason: 'Awaiting validated plan artifact',
    };
  }

  const reviewArtifact = getValidArtifact(db, run.runId, 'review');
  if (reviewArtifact === null) {
    return {
      status: 'pending',
      reason: 'Awaiting validated review artifact',
    };
  }

  // Check review verdict via structured tool invocation metadata
  if (reviewArtifact.sourceToolInvocationId !== undefined) {
    const invocation = getToolInvocation(db, reviewArtifact.sourceToolInvocationId);
    if (invocation !== null) {
      const resultMeta = JSON.parse(invocation.resultMetaJson || '{}') as Record<string, unknown>;
      const verdict = (resultMeta['verdict'] as string) ?? '';
      if (verdict === 'changes_requested') {
        return {
          status: 'pending',
          reason: 'Review requested changes',
        };
      }
    }
  } else {
    return {
      status: 'pending',
      reason: 'Review artifact has no source tool invocation — cannot verify verdict',
    };
  }

  // No decision yet
  return {
    status: 'pending',
    reason: 'Awaiting operator approval',
  };
}
