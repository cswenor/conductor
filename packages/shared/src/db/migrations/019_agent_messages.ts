/**
 * Migration 019: Create agent_messages table for conversation history
 *
 * Persists every conversation turn (system prompt, user prompt, assistant
 * responses, tool results) from agent invocations. Enables debugging agent
 * failures by viewing the full LLM conversation.
 *
 * - UNIQUE(agent_invocation_id, turn_index) prevents duplicate/ambiguous ordering
 * - CHECK(turn_index >= 0) guards against negative indexes
 * - idx_agent_messages_created_at supports efficient pruning
 */

import type { Database } from 'better-sqlite3';
import type { Migration } from './index.ts';

export const migration019: Migration = {
  version: 19,
  name: 'agent_messages',
  up: (db: Database) => {
    db.exec(`
      CREATE TABLE agent_messages (
        agent_message_id TEXT PRIMARY KEY,
        agent_invocation_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        turn_index INTEGER NOT NULL CHECK (turn_index >= 0),
        role TEXT NOT NULL CHECK (role IN ('system', 'user', 'assistant', 'tool_result')),
        content_json TEXT NOT NULL,
        tokens_input INTEGER,
        tokens_output INTEGER,
        stop_reason TEXT,
        content_size_bytes INTEGER NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (agent_invocation_id) REFERENCES agent_invocations(agent_invocation_id),
        FOREIGN KEY (run_id) REFERENCES runs(run_id),
        UNIQUE (agent_invocation_id, turn_index)
      );
      CREATE INDEX idx_agent_messages_invocation ON agent_messages(agent_invocation_id, turn_index);
      CREATE INDEX idx_agent_messages_run ON agent_messages(run_id);
      CREATE INDEX idx_agent_messages_created_at ON agent_messages(created_at);
    `);
  },
};
