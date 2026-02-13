/**
 * Agent Messages Service
 *
 * CRUD operations for the agent_messages table.
 * Persists conversation turns (system, user, assistant, tool_result)
 * from agent invocations for debugging visibility.
 */

import type { Database } from 'better-sqlite3';

// =============================================================================
// Types
// =============================================================================

export interface AgentMessage {
  agentMessageId: string;
  agentInvocationId: string;
  runId: string;
  turnIndex: number;
  role: 'system' | 'user' | 'assistant' | 'tool_result';
  contentJson: string;
  tokensInput?: number;
  tokensOutput?: number;
  stopReason?: string;
  contentSizeBytes: number;
  createdAt: string;
}

export interface CreateAgentMessageInput {
  agentInvocationId: string;
  turnIndex: number;
  role: 'system' | 'user' | 'assistant' | 'tool_result';
  contentJson: string;
  tokensInput?: number;
  tokensOutput?: number;
  stopReason?: string;
}

interface AgentMessageRow {
  agent_message_id: string;
  agent_invocation_id: string;
  run_id: string;
  turn_index: number;
  role: string;
  content_json: string;
  tokens_input: number | null;
  tokens_output: number | null;
  stop_reason: string | null;
  content_size_bytes: number;
  created_at: string;
}

// =============================================================================
// Constants
// =============================================================================

const MAX_CONTENT_JSON_BYTES = 512 * 1024; // 512KB per message

// =============================================================================
// Helpers
// =============================================================================

export function generateAgentMessageId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 8);
  return `am_${timestamp}${random}`;
}

function mapRow(row: AgentMessageRow): AgentMessage {
  return {
    agentMessageId: row.agent_message_id,
    agentInvocationId: row.agent_invocation_id,
    runId: row.run_id,
    turnIndex: row.turn_index,
    role: row.role as AgentMessage['role'],
    contentJson: row.content_json,
    tokensInput: row.tokens_input ?? undefined,
    tokensOutput: row.tokens_output ?? undefined,
    stopReason: row.stop_reason ?? undefined,
    contentSizeBytes: row.content_size_bytes,
    createdAt: row.created_at,
  };
}

// =============================================================================
// CRUD
// =============================================================================

export function createAgentMessage(
  db: Database,
  input: CreateAgentMessageInput,
): AgentMessage {
  // Derive run_id from the invocation — single source of truth
  const inv = db
    .prepare(
      'SELECT run_id FROM agent_invocations WHERE agent_invocation_id = ?',
    )
    .get(input.agentInvocationId) as { run_id: string } | undefined;
  if (inv === undefined)
    throw new Error(`Agent invocation not found: ${input.agentInvocationId}`);
  const runId = inv.run_id;

  // Write-time size guard: role-aware truncation for oversized content
  let contentJson = input.contentJson;
  const rawSize = Buffer.byteLength(contentJson, 'utf8');
  if (rawSize > MAX_CONTENT_JSON_BYTES) {
    const msg = `[Content truncated: ${rawSize} bytes exceeded ${MAX_CONTENT_JSON_BYTES} byte limit]`;
    switch (input.role) {
      case 'system':
      case 'user':
        contentJson = JSON.stringify(msg);
        break;
      case 'assistant':
        contentJson = JSON.stringify([{ type: 'text', text: msg }]);
        break;
      case 'tool_result':
        contentJson = JSON.stringify([
          { type: 'tool_result', tool_use_id: 'truncated', content: msg },
        ]);
        break;
    }
  }

  const contentSizeBytes = Buffer.byteLength(contentJson, 'utf8');
  const id = generateAgentMessageId();
  const now = new Date().toISOString();

  db.prepare(
    `
    INSERT INTO agent_messages (
      agent_message_id, agent_invocation_id, run_id, turn_index, role,
      content_json, tokens_input, tokens_output, stop_reason,
      content_size_bytes, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(
    id,
    input.agentInvocationId,
    runId,
    input.turnIndex,
    input.role,
    contentJson,
    input.tokensInput ?? null,
    input.tokensOutput ?? null,
    input.stopReason ?? null,
    contentSizeBytes,
    now,
  );

  return {
    agentMessageId: id,
    agentInvocationId: input.agentInvocationId,
    runId,
    turnIndex: input.turnIndex,
    role: input.role,
    contentJson,
    tokensInput: input.tokensInput,
    tokensOutput: input.tokensOutput,
    stopReason: input.stopReason,
    contentSizeBytes,
    createdAt: now,
  };
}

export function listAgentMessages(
  db: Database,
  agentInvocationId: string,
): AgentMessage[] {
  const rows = db
    .prepare(
      'SELECT * FROM agent_messages WHERE agent_invocation_id = ? ORDER BY turn_index ASC',
    )
    .all(agentInvocationId) as AgentMessageRow[];

  return rows.map(mapRow);
}

/**
 * DB-backed paginated query for agent messages.
 * Returns messages with turn_index > afterTurnIndex, ordered ascending, limited.
 */
export function listAgentMessagesPaginated(
  db: Database,
  agentInvocationId: string,
  afterTurnIndex: number,
  limit: number,
): AgentMessage[] {
  const rows = db
    .prepare(
      `SELECT * FROM agent_messages
       WHERE agent_invocation_id = ? AND turn_index > ?
       ORDER BY turn_index ASC
       LIMIT ?`,
    )
    .all(agentInvocationId, afterTurnIndex, limit) as AgentMessageRow[];

  return rows.map(mapRow);
}

/**
 * Count total messages for an invocation (single scalar query).
 */
export function countAgentMessages(
  db: Database,
  agentInvocationId: string,
): number {
  const row = db
    .prepare(
      'SELECT COUNT(*) as count FROM agent_messages WHERE agent_invocation_id = ?',
    )
    .get(agentInvocationId) as { count: number };

  return row.count;
}

export function listAgentMessagesByRun(
  db: Database,
  runId: string,
): AgentMessage[] {
  const rows = db
    .prepare(
      'SELECT * FROM agent_messages WHERE run_id = ? ORDER BY agent_invocation_id, turn_index ASC',
    )
    .all(runId) as AgentMessageRow[];

  return rows.map(mapRow);
}

export function getAgentMessageCountsByRun(
  db: Database,
  runId: string,
): Record<string, number> {
  const rows = db
    .prepare(
      'SELECT agent_invocation_id, COUNT(*) as count FROM agent_messages WHERE run_id = ? GROUP BY agent_invocation_id',
    )
    .all(runId) as Array<{ agent_invocation_id: string; count: number }>;

  const result: Record<string, number> = {};
  for (const row of rows) {
    result[row.agent_invocation_id] = row.count;
  }
  return result;
}

export function pruneAgentMessages(
  db: Database,
  maxAgeDays: number = 30,
): number {
  const result = db
    .prepare(
      `DELETE FROM agent_messages WHERE created_at < datetime('now', '-' || ? || ' days')`,
    )
    .run(maxAgeDays);
  return result.changes;
}
