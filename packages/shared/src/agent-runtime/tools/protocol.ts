/**
 * SDK Tool Protocol Helpers
 *
 * Reusable FIFO dequeue/flush protocol for SDK-path tool results.
 * Owns the `ToolResultEntry` type — single source of truth.
 */

import type { Database } from 'better-sqlite3';
import { createLogger } from '../../logger/index.ts';
import { createAgentMessage } from '../agent-messages.ts';

const log = createLogger({ name: 'conductor:protocol' });

// =============================================================================
// Types
// =============================================================================

export interface ToolResultEntry {
  type: 'tool_result';
  tool_use_id: string;
  content: string;
  is_error: boolean;
}

// =============================================================================
// FIFO Dequeue + Record
// =============================================================================

/**
 * Dequeue a tool_use_id from the FIFO queue and push a ToolResultEntry.
 * If the queue is empty, generates a synthetic ID (warning-only).
 * Returns the tool_use_id used.
 */
export function recordToolResult(
  pendingToolUseIds: string[],
  pendingToolResults: ToolResultEntry[],
  toolName: string,
  audited: { content: string; isError?: boolean },
): string {
  const toolUseId = pendingToolUseIds.shift()
    ?? `synth_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  if (toolUseId.startsWith('synth_')) {
    log.warn({ toolName }, 'Using synthetic tool_use_id — queue was empty');
  }

  pendingToolResults.push({
    type: 'tool_result',
    tool_use_id: toolUseId,
    content: audited.content,
    is_error: audited.isError ?? false,
  });

  return toolUseId;
}

// =============================================================================
// Flush Pending Results
// =============================================================================

/**
 * Persist all pending tool results as a single agent_message, then drain both arrays.
 * No-op when `pendingToolResults` is empty (stale IDs are NOT drained in that case).
 */
export function flushToolResults(
  pendingToolResults: ToolResultEntry[],
  pendingToolUseIds: string[],
  db: Database,
  agentInvocationId: string,
  nextTurnIndex: () => number,
): void {
  if (pendingToolResults.length === 0) return;

  if (pendingToolUseIds.length > 0) {
    log.warn({ remaining: pendingToolUseIds.length }, 'Stale tool_use_ids remaining after batch');
    pendingToolUseIds.length = 0;
  }

  try {
    createAgentMessage(db, {
      agentInvocationId,
      turnIndex: nextTurnIndex(),
      role: 'tool_result',
      contentJson: JSON.stringify(pendingToolResults),
    });
  } catch (e) {
    log.warn({ err: e }, 'Failed to persist tool_result message');
  }

  pendingToolResults.length = 0;
}
