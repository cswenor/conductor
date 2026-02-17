/**
 * Backend Dispatch
 *
 * Pure module for backend resolution, provider validation, and step config
 * mapping. No Redis, no DB, no worker bootstrap — fully testable.
 */

import type { ResolvedStepConfig, ResolvedWorkflowConfig } from '@conductor/shared';

// =============================================================================
// Types
// =============================================================================

export type BackendDispatch =
  | { backend: 'raw' }
  | { backend: 'agent_sdk'; providerCheck: true };

// =============================================================================
// Dispatch Resolution
// =============================================================================

/**
 * Determine backend dispatch for a step. Pure function — no side effects.
 */
export function resolveBackendDispatch(config: ResolvedStepConfig): BackendDispatch {
  if (config.backend === 'agent_sdk') {
    return { backend: 'agent_sdk', providerCheck: true };
  }
  return { backend: 'raw' };
}

/**
 * Validate provider is Anthropic for SDK paths. Returns error message or null.
 */
export function validateSdkProvider(provider: string): string | null {
  if (provider !== 'anthropic') {
    return `SDK backend requires Anthropic provider (got: ${provider})`;
  }
  return null;
}

/**
 * Get the step config for a given agent handler from the resolved workflow config.
 * Pure mapping — no side effects.
 */
export function getStepConfigForHandler(
  config: ResolvedWorkflowConfig,
  handler: 'planner' | 'planReviewer' | 'implementer' | 'codeReviewer',
): ResolvedStepConfig {
  switch (handler) {
    case 'planner': return config.planner;
    case 'planReviewer': return config.reviewerPlan;
    case 'implementer': return config.implementer;
    case 'codeReviewer': return config.reviewerCode;
  }
}
