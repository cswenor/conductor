/**
 * Migration 005: Pending GitHub Installations
 *
 * Creates table to store GitHub App installation IDs that are pending
 * project creation. When a user installs the app but hasn't yet created
 * a project, the installation_id is stored here temporarily.
 */

import type { Database } from 'better-sqlite3';
import type { Migration } from './index';

export const migration005: Migration = {
  version: 5,
  name: 'pending_github_installations',
  up: (db: Database) => {
    db.exec(`
      CREATE TABLE pending_github_installations (
        installation_id INTEGER PRIMARY KEY,
        setup_action TEXT NOT NULL DEFAULT 'install',
        state TEXT,
        created_at TEXT NOT NULL
      )
    `);

    // Index for cleanup queries (find old pending installations)
    db.exec(`
      CREATE INDEX idx_pending_installations_created
        ON pending_github_installations(created_at)
    `);
  },
};
