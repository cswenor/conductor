/**
 * Shared label module for all user-facing terminology.
 *
 * Central source of truth for humanized labels displayed in the UI.
 * Consolidates duplicates from use-inbox.ts, run-detail-content.tsx,
 * and approvals-content.tsx.
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Title-case a snake_case string: "plan_approval" → "Plan Approval" */
function titleCase(s: string): string {
  return s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

// ---------------------------------------------------------------------------
// Gate names (by gateId)
// ---------------------------------------------------------------------------

const GATE_LABELS: Record<string, string> = {
  plan_approval: 'Plan Approval',
  tests_pass: 'Tests',
  code_review: 'Code Review',
  merge_wait: 'Merge',
};

export function getGateLabel(gateId: string): string {
  return GATE_LABELS[gateId] ?? titleCase(gateId);
}

// ---------------------------------------------------------------------------
// Gate status labels
// ---------------------------------------------------------------------------

const GATE_STATUS_LABELS: Record<string, string> = {
  passed: 'Passed',
  failed: 'Failed',
  pending: 'Pending',
};

export function getGateStatusLabel(status: string): string {
  return GATE_STATUS_LABELS[status] ?? titleCase(status);
}

// ---------------------------------------------------------------------------
// Agent invocation status labels
// ---------------------------------------------------------------------------

const INVOCATION_STATUS_LABELS: Record<string, string> = {
  failed: 'Failed',
  timed_out: 'Timed Out',
  pending: 'Pending',
  running: 'Running',
  completed: 'Completed',
};

export function getInvocationStatusLabel(status: string): string {
  return INVOCATION_STATUS_LABELS[status] ?? titleCase(status);
}

// ---------------------------------------------------------------------------
// Operator action labels (toast messages + history display)
// ---------------------------------------------------------------------------

const OPERATOR_ACTION_LABELS: Record<string, string> = {
  start_run: 'Started run',
  approve_plan: 'Plan approved',
  revise_plan: 'Revision requested',
  reject_run: 'Run rejected',
  retry: 'Run retried',
  pause: 'Run paused',
  resume: 'Run resumed',
  cancel: 'Run cancelled',
  grant_policy_exception: 'Policy exception granted',
  deny_policy_exception: 'Policy exception denied',
};

export function getOperatorActionLabel(action: string): string {
  return OPERATOR_ACTION_LABELS[action] ?? titleCase(action);
}

// ---------------------------------------------------------------------------
// Blocked reason labels
// ---------------------------------------------------------------------------

const BLOCKED_REASON_LABELS: Record<string, string> = {
  gate_failed: 'A required gate failed',
  policy_exception_required: 'A policy exception is required',
  retry_limit_exceeded: 'Revision limit exceeded',
  enqueue_failed: 'Failed to start run',
};

export function getBlockedReasonLabel(reason: string): string {
  return BLOCKED_REASON_LABELS[reason] ?? reason.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
}
