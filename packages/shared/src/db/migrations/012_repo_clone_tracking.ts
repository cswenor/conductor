/**
 * Migration 012: Repo Clone Tracking
 *
 * Adds columns to repos table to track local clone state.
 */

import type { Database } from 'better-sqlite3';
import type { Migration } from './index';

export const migration012: Migration = {
  version: 12,
  name: 'repo_clone_tracking',
  up: (db: Database) => {
    // Add clone tracking columns to repos table
    db.exec(`
      ALTER TABLE repos ADD COLUMN clone_path TEXT
    `);
    db.exec(`
      ALTER TABLE repos ADD COLUMN cloned_at TEXT
    `);
    db.exec(`
      ALTER TABLE repos ADD COLUMN last_fetched_at TEXT
    `);
  },
};
