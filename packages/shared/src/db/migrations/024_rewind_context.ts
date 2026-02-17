/**
 * Migration 024: Rewind context columns
 *
 * Adds rewind_context_mode and rewind_context_summary to runs.
 * These store the context mode and pre-built summary when a run
 * is rewound to a checkpoint with preserve mode.
 *
 * No DB-level CHECK constraint — SQLite ALTER TABLE ADD COLUMN
 * does not support inline CHECK. Validation is runtime-only.
 */

import type { Database } from 'better-sqlite3';
import type { Migration } from './index.ts';

export const migration024: Migration = {
  version: 24,
  name: 'rewind_context',
  up(db: Database) {
    db.exec(`
      ALTER TABLE runs ADD COLUMN rewind_context_mode TEXT DEFAULT NULL;
    `);
    db.exec(`
      ALTER TABLE runs ADD COLUMN rewind_context_summary TEXT DEFAULT NULL;
    `);
  },
};
