/**
 * Backend Routing — Pure Helpers
 *
 * Provider validation for agent handler backend selection.
 * Used by worker index.ts handlers.
 */

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
