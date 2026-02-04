/**
 * Agent Invocations Service
 *
 * CRUD operations for the agent_invocations table.
 * Manages the lifecycle of individual agent calls.
 */

import type { Database } from 'better-sqlite3';

// =============================================================================
// Types
// =============================================================================

export type AgentInvocationStatus = 'pending' | 'running' | 'completed' | 'failed' | 'timed_out';

export interface AgentInvocation {
  agentInvocationId: string;
  runId: string;
  agent: string;
  action: string;
  status: AgentInvocationStatus;
  tokensInput: number;
  tokensOutput: number;
  durationMs?: number;
  contextSummary?: string;
  errorCode?: string;
  errorMessage?: string;
  startedAt: string;
  completedAt?: string;
}

interface AgentInvocationRow {
  agent_invocation_id: string;
  run_id: string;
  agent: string;
  action: string;
  status: string;
  tokens_input: number;
  tokens_output: number;
  duration_ms: number | null;
  context_summary: string | null;
  error_code: string | null;
  error_message: string | null;
  started_at: string;
  completed_at: string | null;
}

export interface CreateAgentInvocationInput {
  runId: string;
  agent: string;
  action: string;
  contextSummary?: string;
}

export interface CompleteAgentInvocationInput {
  tokensInput: number;
  tokensOutput: number;
  durationMs: number;
}

export interface FailAgentInvocationInput {
  errorCode: string;
  errorMessage: string;
  durationMs?: number;
}

// =============================================================================
// Helpers
// =============================================================================

export function generateAgentInvocationId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 8);
  return `ai_${timestamp}${random}`;
}

function mapRow(row: AgentInvocationRow): AgentInvocation {
  return {
    agentInvocationId: row.agent_invocation_id,
    runId: row.run_id,
    agent: row.agent,
    action: row.action,
    status: row.status as AgentInvocationStatus,
    tokensInput: row.tokens_input,
    tokensOutput: row.tokens_output,
    durationMs: row.duration_ms ?? undefined,
    contextSummary: row.context_summary ?? undefined,
    errorCode: row.error_code ?? undefined,
    errorMessage: row.error_message ?? undefined,
    startedAt: row.started_at,
    completedAt: row.completed_at ?? undefined,
  };
}

// =============================================================================
// CRUD
// =============================================================================

/**
 * Create a new agent invocation record.
 */
export function createAgentInvocation(
  db: Database,
  input: CreateAgentInvocationInput
): AgentInvocation {
  const id = generateAgentInvocationId();
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO agent_invocations (
      agent_invocation_id, run_id, agent, action, status,
      tokens_input, tokens_output, context_summary, started_at
    ) VALUES (?, ?, ?, ?, 'pending', 0, 0, ?, ?)
  `).run(id, input.runId, input.agent, input.action, input.contextSummary ?? null, now);

  return {
    agentInvocationId: id,
    runId: input.runId,
    agent: input.agent,
    action: input.action,
    status: 'pending',
    tokensInput: 0,
    tokensOutput: 0,
    contextSummary: input.contextSummary,
    startedAt: now,
  };
}

/**
 * Get an agent invocation by ID.
 */
export function getAgentInvocation(
  db: Database,
  agentInvocationId: string
): AgentInvocation | null {
  const row = db.prepare(
    'SELECT * FROM agent_invocations WHERE agent_invocation_id = ?'
  ).get(agentInvocationId) as AgentInvocationRow | undefined;

  if (row === undefined) {
    return null;
  }

  return mapRow(row);
}

/**
 * List all invocations for a run, ordered by started_at.
 */
export function listAgentInvocations(
  db: Database,
  runId: string
): AgentInvocation[] {
  const rows = db.prepare(
    'SELECT * FROM agent_invocations WHERE run_id = ? ORDER BY started_at ASC'
  ).all(runId) as AgentInvocationRow[];

  return rows.map(mapRow);
}

/**
 * Mark an invocation as running.
 */
export function markAgentRunning(
  db: Database,
  agentInvocationId: string
): void {
  db.prepare(
    'UPDATE agent_invocations SET status = ? WHERE agent_invocation_id = ? AND status = ?'
  ).run('running', agentInvocationId, 'pending');
}

/**
 * Complete an agent invocation with results.
 */
export function completeAgentInvocation(
  db: Database,
  agentInvocationId: string,
  result: CompleteAgentInvocationInput
): void {
  const now = new Date().toISOString();
  const changes = db.prepare(`
    UPDATE agent_invocations
    SET status = 'completed',
        tokens_input = ?,
        tokens_output = ?,
        duration_ms = ?,
        completed_at = ?
    WHERE agent_invocation_id = ?
      AND status IN ('pending', 'running')
  `).run(
    result.tokensInput,
    result.tokensOutput,
    result.durationMs,
    now,
    agentInvocationId
  );

  if (changes.changes === 0) {
    throw new Error(`Cannot complete invocation ${agentInvocationId}: not in pending/running state`);
  }
}

/**
 * Fail an agent invocation with error details.
 */
export function failAgentInvocation(
  db: Database,
  agentInvocationId: string,
  error: FailAgentInvocationInput
): void {
  const now = new Date().toISOString();
  const changes = db.prepare(`
    UPDATE agent_invocations
    SET status = 'failed',
        error_code = ?,
        error_message = ?,
        duration_ms = ?,
        completed_at = ?
    WHERE agent_invocation_id = ?
      AND status IN ('pending', 'running')
  `).run(
    error.errorCode,
    error.errorMessage,
    error.durationMs ?? null,
    now,
    agentInvocationId
  );

  if (changes.changes === 0) {
    throw new Error(`Cannot fail invocation ${agentInvocationId}: not in pending/running state`);
  }
}
