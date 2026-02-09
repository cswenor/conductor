/**
 * Migration 014: Mirroring Rate Limits
 *
 * Adds a deferred events table for WP9 GitHub mirroring rate limiting.
 * When comments are posted too rapidly, events are deferred and coalesced
 * into a single comment on the next allowed post.
 */

import type { Database } from 'better-sqlite3';
import type { Migration } from './index.ts';

export const migration014: Migration = {
  version: 14,
  name: 'mirroring_rate_limits',
  up: (db: Database) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS mirror_deferred_events (
        deferred_event_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(run_id),
        event_type TEXT NOT NULL,
        formatted_body TEXT NOT NULL,
        idempotency_suffix TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);

    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_mirror_deferred_run_time
        ON mirror_deferred_events(run_id, created_at ASC)
    `);
  },
};
