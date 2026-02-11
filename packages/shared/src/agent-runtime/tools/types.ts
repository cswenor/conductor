/**
 * Tool System Types
 *
 * Core type definitions for the agent tool-use framework.
 * Tools are registered with the ToolRegistry and executed during
 * the multi-turn conversation loop in the executor.
 */

import type { Database } from 'better-sqlite3';

// =============================================================================
// Tool Input Schema (matches Anthropic SDK format)
// =============================================================================

export interface ToolInputSchema {
  type: 'object';
  properties?: Record<string, unknown>;
  required?: string[];
}

// =============================================================================
// Tool Definition
// =============================================================================

export interface ToolExecutionContext {
  runId: string;
  agentInvocationId: string;
  worktreePath: string;
  db: Database;
  projectId: string;
  /** Abort signal for cancellation — tools should listen for this to terminate subprocesses */
  abortSignal?: AbortSignal;
}

export interface ToolResult {
  /** Sent back to model as tool_result content */
  content: string;
  /** Marks tool_result as error */
  isError?: boolean;
  /** Persisted to tool_invocations (not sent to model) */
  meta: Record<string, unknown>;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: ToolInputSchema;
  execute: (input: Record<string, unknown>, context: ToolExecutionContext) => Promise<ToolResult>;
  /** Extract a target identifier (e.g. file path) from tool input for logging */
  extractTarget?: (input: Record<string, unknown>) => string | undefined;
}

// =============================================================================
// Tool Call (from model response)
// =============================================================================

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}
