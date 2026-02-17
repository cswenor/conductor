/**
 * Migration 023: Workflow epoch counter
 *
 * Adds a workflow_epoch counter to runs for tracking mutations
 * (workflow edits, rewinds). Incremented on each pause-time mutation.
 * Jobs carry the epoch at dispatch time; stale jobs are skipped when
 * the epoch doesn't match.
 */

import type { Database } from 'better-sqlite3';
import type { Migration } from './index.ts';

export const migration023: Migration = {
  version: 23,
  name: 'workflow_epoch',
  up(db: Database) {
    db.exec(`
      ALTER TABLE runs ADD COLUMN workflow_epoch INTEGER NOT NULL DEFAULT 0;
    `);
  },
};
