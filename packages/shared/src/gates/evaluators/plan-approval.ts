/**
 * Plan Approval Gate Evaluator
 *
 * Evaluates whether a run's plan has been approved by an operator.
 * Per ROUTING_AND_GATES.md: requires validated PLAN and REVIEW artifacts,
 * then checks for operator approve/reject action.
 *
 * Gates MUST only read artifacts with validation_status = 'valid'.
 */

import type { Database } from 'better-sqlite3';
import type { Run } from '../../runs/index.js';
import { getValidArtifact } from '../../agent-runtime/artifacts.js';
import { getToolInvocation } from '../../agent-runtime/tool-invocations.js';
import { getOperatorAction } from '../../operator-actions/index.js';
import type { GateResult } from './index.js';

/**
 * Evaluate the plan_approval gate for a run.
 *
 * Logic from ROUTING_AND_GATES.md:
 * 1. Check for validated PLAN artifact
 * 2. Check for validated REVIEW artifact
 * 3. If either missing → pending
 * 4. If review verdict is CHANGES_REQUESTED → pending
 * 5. Check for approve_plan action → passed
 * 6. Check for reject_run action → failed
 * 7. No action → pending (awaiting operator)
 */
export function evaluatePlanApproval(db: Database, run: Run): GateResult {
  // 1. Check for validated PLAN artifact
  const planArtifact = getValidArtifact(db, run.runId, 'plan');
  if (planArtifact === null) {
    return {
      status: 'pending',
      reason: 'Awaiting validated plan artifact',
    };
  }

  // 2. Check for validated REVIEW artifact
  const reviewArtifact = getValidArtifact(db, run.runId, 'review');
  if (reviewArtifact === null) {
    return {
      status: 'pending',
      reason: 'Awaiting validated review artifact',
    };
  }

  // 3. Check review verdict via structured tool invocation metadata
  // Per ROUTING_AND_GATES.md: use source tool invocation for truth guarantee,
  // not brittle text search on contentMarkdown.
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
    // No source tool invocation — cannot verify review verdict
    return {
      status: 'pending',
      reason: 'Review artifact has no source tool invocation — cannot verify verdict',
    };
  }

  // 4. Check for reject_run action (check before approve to respect operator intent)
  const rejectAction = getOperatorAction(db, run.runId, 'reject_run');
  if (rejectAction !== null) {
    return {
      status: 'failed',
      reason: rejectAction.comment ?? 'Plan rejected by operator',
    };
  }

  // 5. Check for approve_plan action
  const approveAction = getOperatorAction(db, run.runId, 'approve_plan');
  if (approveAction !== null) {
    return {
      status: 'passed',
      reason: 'Plan approved by operator',
    };
  }

  // 6. No action yet — awaiting operator
  return {
    status: 'pending',
    reason: 'Awaiting operator approval',
  };
}
