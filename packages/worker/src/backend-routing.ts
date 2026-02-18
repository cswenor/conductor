/**
 * Backend Routing — Pure Helpers
 *
 * Encapsulates routing decisions for agent handler backend selection
 * and provider validation. Used by worker index.ts handlers.
 */

import type { ResolvedStepConfig, ResolvedWorkflowConfig } from '@conductor/shared';

/**
 * Get the step config for a given handler from the resolved workflow config.
 */
export function getStepConfig(
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

/**
 * Check if a step requires Anthropic provider. Returns error message or null.
 * Only SDK backend requires Anthropic.
 */
export function validateProviderForBackend(
  backend: 'raw' | 'agent_sdk',
  provider: string,
  stepLabel: string,
): string | null {
  if (backend === 'agent_sdk' && provider !== 'anthropic') {
    return `${stepLabel} SDK requires Anthropic provider (got: ${provider})`;
  }
  return null;
}

/**
 * Determine if SDK backend requires credential validation.
 */
export function requiresSdkCredentials(backend: 'raw' | 'agent_sdk'): boolean {
  return backend === 'agent_sdk';
}
