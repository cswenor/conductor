/**
 * Migration 018: Create stream_events table for SSE V2 replay
 *
 * Stores persisted V2 stream events with auto-increment IDs for
 * Last-Event-ID replay on SSE reconnect. Two indexes:
 * - (project_id, id) for replay queries
 * - (created_at) for time-based pruning
 */

import type { Database } from 'better-sqlite3';
import type { Migration } from './index.ts';

export const migration018: Migration = {
  version: 18,
  name: 'stream_events',
  up: (db: Database) => {
    db.exec(`
      CREATE TABLE stream_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL,
        project_id TEXT NOT NULL,
        run_id TEXT,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (project_id) REFERENCES projects(project_id)
      );
      CREATE INDEX idx_stream_events_project_id ON stream_events(project_id, id);
      CREATE INDEX idx_stream_events_created_at ON stream_events(created_at);
    `);
  },
};
