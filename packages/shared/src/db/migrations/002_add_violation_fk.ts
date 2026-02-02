/**
 * Migration 002: Add violation_id FK constraint
 *
 * Adds the foreign key constraint from tool_invocations.violation_id
 * to policy_violations.violation_id via table rebuild.
 *
 * This constraint couldn't be added in migration 001 because
 * policy_violations is created after tool_invocations.
 */

import type { Database } from 'better-sqlite3';
import type { Migration } from './index';

export const migration002: Migration = {
  version: 2,
  name: 'add_violation_fk',
  up: (db: Database) => {
    // SQLite requires table rebuild to add FK constraints
    // 1. Create new table with FK
    // 2. Copy data
    // 3. Drop old table
    // 4. Rename new table
    // 5. Recreate indexes

    db.exec(`
      CREATE TABLE tool_invocations_new (
        tool_invocation_id TEXT PRIMARY KEY,
        agent_invocation_id TEXT NOT NULL REFERENCES agent_invocations(agent_invocation_id),
        run_id TEXT NOT NULL REFERENCES runs(run_id),

        tool TEXT NOT NULL,
        target TEXT,

        -- Redacted storage
        args_redacted_json TEXT NOT NULL,
        args_fields_removed_json TEXT NOT NULL,
        args_secrets_detected INTEGER NOT NULL DEFAULT 0,
        args_payload_hash TEXT NOT NULL,
        args_payload_hash_scheme TEXT NOT NULL DEFAULT 'sha256:cjson:v1',

        result_meta_json TEXT NOT NULL,
        result_payload_hash TEXT NOT NULL,
        result_payload_hash_scheme TEXT NOT NULL DEFAULT 'sha256:cjson:v1',

        policy_decision TEXT NOT NULL,
        policy_id TEXT REFERENCES policy_definitions(policy_id),
        policy_set_id TEXT REFERENCES policy_sets(policy_set_id),
        violation_id TEXT REFERENCES policy_violations(violation_id),

        status TEXT NOT NULL,
        duration_ms INTEGER NOT NULL,
        created_at TEXT NOT NULL
      )
    `);

    // Copy existing data
    db.exec(`
      INSERT INTO tool_invocations_new
      SELECT * FROM tool_invocations
    `);

    // Drop old table
    db.exec(`DROP TABLE tool_invocations`);

    // Rename new table
    db.exec(`ALTER TABLE tool_invocations_new RENAME TO tool_invocations`);

    // Recreate indexes
    db.exec(`CREATE INDEX idx_tool_invocations_run ON tool_invocations(run_id)`);
    db.exec(`CREATE INDEX idx_tool_invocations_violation ON tool_invocations(violation_id)`);
  },
};
