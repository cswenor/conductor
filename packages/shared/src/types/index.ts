/**
 * Core type definitions for Conductor
 *
 * These types are derived from DATA_MODEL.md and should be kept in sync.
 */

// =============================================================================
// Run Lifecycle Types
// =============================================================================

export type RunPhase =
  | 'pending'
  | 'planning'
  | 'awaiting_plan_approval'
  | 'executing'
  | 'awaiting_review'
  | 'blocked'
  | 'completed'
  | 'cancelled';

export type RunStep =
  | 'setup_worktree'
  | 'route'
  | 'planner_create_plan'
  | 'reviewer_review_plan'
  | 'wait_plan_approval'
  | 'implementer_apply_changes'
  | 'tester_run_tests'
  | 'reviewer_review_code'
  | 'create_pr'
  | 'wait_pr_merge'
  | 'cleanup';

export type RunStatus = 'active' | 'paused' | 'blocked' | 'finished';

export function deriveRunStatus(
  phase: RunPhase,
  pausedAt?: string | null
): RunStatus {
  if (phase === 'completed' || phase === 'cancelled') return 'finished';
  if (pausedAt !== null && pausedAt !== undefined) return 'paused';
  if (phase === 'blocked') return 'blocked';
  return 'active';
}

// =============================================================================
// Event Types (Facts vs Decisions)
// =============================================================================

export type EventCategory = 'fact' | 'decision';

export type EventSource = 'webhook' | 'tool_layer' | 'orchestrator' | 'operator';

// =============================================================================
// Job Queue Types
// =============================================================================

export type JobStatus = 'queued' | 'processing' | 'completed' | 'failed' | 'dead';

export type JobQueue =
  | 'webhooks'
  | 'runs'
  | 'agents'
  | 'cleanup'
  | 'github_writes';

// =============================================================================
// GitHub Types
// =============================================================================

export type GitHubWriteKind = 'comment' | 'check_run' | 'project_field_update' | 'pr_create';

export type GitHubWriteStatus = 'queued' | 'sent' | 'failed' | 'ambiguous';

export type GitHubTargetType = 'issue' | 'pr' | 'project_item' | 'repo';

// =============================================================================
// Webhook Types
// =============================================================================

export type WebhookStatus =
  | 'received'
  | 'processing'
  | 'processed'
  | 'failed'
  | 'ignored';

// =============================================================================
// Operator Action Types
// =============================================================================

export type OperatorActionType =
  | 'start_run'
  | 'approve_plan'
  | 'revise_plan'
  | 'reject_run'
  | 'retry'
  | 'pause'
  | 'resume'
  | 'cancel'
  | 'grant_policy_exception'
  | 'deny_policy_exception';

export type ActorType = 'operator' | 'system';

// =============================================================================
// Gate Types
// =============================================================================

export type GateStatus = 'pending' | 'passed' | 'failed';

export type GateKind = 'automatic' | 'human' | 'policy';

// =============================================================================
// Policy Types
// =============================================================================

export type PolicySeverity = 'warning' | 'blocking';

export type EnforcementPoint =
  | 'tool_invocation'
  | 'pre_push'
  | 'artifact_validation';

// =============================================================================
// Artifact Types
// =============================================================================

export type ArtifactType = 'plan' | 'review' | 'test_report' | 'other';

export type ValidationStatus = 'pending' | 'valid' | 'invalid';
