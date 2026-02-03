/**
 * Migration 008: Add user_id to pending_github_installations
 *
 * Scopes pending GitHub installations to specific users for security.
 * This prevents users from seeing or using installations they didn't create.
 */

import type { Database } from 'better-sqlite3';
import type { Migration } from './index';

export const migration008: Migration = {
  version: 8,
  name: 'pending_installations_user_id',
  up: (db: Database) => {
    // Add user_id column to pending_github_installations
    db.exec(`
      ALTER TABLE pending_github_installations
      ADD COLUMN user_id TEXT REFERENCES users(user_id) ON DELETE CASCADE
    `);

    // Create index for querying by user
    db.exec(`
      CREATE INDEX idx_pending_installations_user
        ON pending_github_installations(user_id)
    `);
  },
};
