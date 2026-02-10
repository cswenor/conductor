/**
 * Migration 016: Add github_number column to github_writes
 *
 * Stores the GitHub-assigned number (e.g. PR number) alongside github_id.
 * This avoids fragile URL parsing during crash recovery — the number is
 * persisted at completion time and read directly.
 */

import type { Database } from 'better-sqlite3';
import type { Migration } from './index.ts';

export const migration016: Migration = {
  version: 16,
  name: 'github_writes_number',
  up: (db: Database) => {
    db.exec(`
      ALTER TABLE github_writes
      ADD COLUMN github_number INTEGER
    `);
  },
};
