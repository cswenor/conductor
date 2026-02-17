/**
 * SDK Result Extraction
 *
 * Shared helper for extracting plan/review text from the terminal
 * assistant message in SDK-based agent runs.
 */

import { AgentError } from '../provider.ts';

// =============================================================================
// Types
// =============================================================================

interface AssistantSnapshot {
  content: unknown[];
  stopReason: string | undefined;
}

// =============================================================================
// Extraction
// =============================================================================

/**
 * Extract plan/review text from the terminal assistant message.
 * Strict rules with distinct error codes for diagnostics/observability:
 * 1. Must have a captured assistant snapshot → 'no_output'
 * 2. stop_reason must be 'end_turn' → 'output_truncated' (max_tokens) or 'unexpected_stop' (other)
 * 3. Must NOT contain any tool_use blocks → 'tool_use_terminal'
 * 4. Must contain non-empty text → 'no_output'
 *
 * All codes are terminal failures (markRunFailed in worker), but distinct codes
 * enable log filtering, dashboards, and future retry-policy differentiation.
 */
export function extractTerminalAssistantText(
  snapshot: AssistantSnapshot | undefined,
  agentLabel: string,
): string {
  if (snapshot === undefined) {
    throw new AgentError(`${agentLabel} produced no assistant messages`, 'no_output');
  }

  if (snapshot.stopReason !== 'end_turn') {
    // Distinct codes: max_tokens is a common operational issue (model ran out of output budget)
    // vs other stop reasons which are unexpected
    const code = snapshot.stopReason === 'max_tokens' ? 'output_truncated' : 'unexpected_stop';
    throw new AgentError(
      `${agentLabel} final turn has stop_reason '${snapshot.stopReason ?? 'unknown'}', expected 'end_turn'`,
      code,
    );
  }

  const hasToolUse = snapshot.content.some(
    (b) => typeof b === 'object' && b !== null && 'type' in b && (b as { type: string }).type === 'tool_use',
  );
  if (hasToolUse) {
    throw new AgentError(
      `${agentLabel} final turn contains tool_use blocks — not a clean terminal response`,
      'tool_use_terminal',
    );
  }

  const textBlocks = snapshot.content
    .filter((b): b is { type: 'text'; text: string } =>
      typeof b === 'object' && b !== null && 'type' in b && (b as { type: string }).type === 'text')
    .map(b => b.text);
  const text = textBlocks.join('\n').trim();

  if (text.length === 0) {
    throw new AgentError(`${agentLabel} produced no text output`, 'no_output');
  }

  return text;
}
