/**
 * Migration 015: Add summary column to mirror_deferred_events
 *
 * Stores a concise one-line summary alongside the full formatted body.
 * Summaries are used for coalesced comments; full bodies are used for
 * single-event posts.
 */

import type { Database } from 'better-sqlite3';
import type { Migration } from './index.ts';

export const migration015: Migration = {
  version: 15,
  name: 'mirror_deferred_summary',
  up: (db: Database) => {
    db.exec(`
      ALTER TABLE mirror_deferred_events
      ADD COLUMN summary TEXT NOT NULL DEFAULT ''
    `);
  },
};
