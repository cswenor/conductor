/**
 * Step Credential Requirements
 *
 * Maps each run step to an execution mode and required credentials.
 */

import type { RunStep } from '../types/index.js';
import type { ApiKeyProvider } from '../api-keys/index.js';

// =============================================================================
// Types
// =============================================================================

export type CredentialMode = 'none' | 'ai_provider' | 'github_installation';

export interface StepCredentialRequirement {
  step: RunStep;
  mode: CredentialMode;
  provider?: ApiKeyProvider;
}

// =============================================================================
// Step → Credential Mapping
// =============================================================================

const STEP_CREDENTIAL_MAP: Record<RunStep, StepCredentialRequirement> = {
  setup_worktree: { step: 'setup_worktree', mode: 'github_installation' },
  route: { step: 'route', mode: 'none' },
  planner_create_plan: { step: 'planner_create_plan', mode: 'ai_provider', provider: 'anthropic' },
  reviewer_review_plan: { step: 'reviewer_review_plan', mode: 'ai_provider', provider: 'anthropic' },
  wait_plan_approval: { step: 'wait_plan_approval', mode: 'none' },
  implementer_apply_changes: { step: 'implementer_apply_changes', mode: 'ai_provider', provider: 'anthropic' },
  tester_run_tests: { step: 'tester_run_tests', mode: 'none' },
  reviewer_review_code: { step: 'reviewer_review_code', mode: 'ai_provider', provider: 'anthropic' },
  create_pr: { step: 'create_pr', mode: 'github_installation' },
  wait_pr_merge: { step: 'wait_pr_merge', mode: 'none' },
  cleanup: { step: 'cleanup', mode: 'none' },
};

/**
 * Get the credential requirement for a given step.
 */
export function getStepCredentialRequirement(step: RunStep): StepCredentialRequirement {
  return STEP_CREDENTIAL_MAP[step];
}
