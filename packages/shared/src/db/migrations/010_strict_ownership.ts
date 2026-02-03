/**
 * Migration 010: Strict ownership constraints
 *
 * Enforces strict ownership invariants:
 * - projects.github_installation_id must be unique (one project per installation)
 * - pending_github_installations uses compound key (installation_id, user_id)
 * - user_id columns are NOT NULL where required for security
 *
 * Part of WP13-A: Auth Spine security hardening.
 */

import type { Database } from 'better-sqlite3';
import type { Migration } from './index';

export const migration010: Migration = {
  version: 10,
  name: 'strict_ownership',
  up: (db: Database) => {
    // =========================================================================
    // 1. Add unique constraint on projects.github_installation_id
    // =========================================================================
    // SQLite doesn't support ADD CONSTRAINT, so we create a unique index
    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_installation_unique
        ON projects(github_installation_id)
    `);

    // =========================================================================
    // 2. Recreate pending_github_installations with compound key and NOT NULL user_id
    // =========================================================================
    // SQLite requires table recreation to change primary key and add NOT NULL

    // First, delete any orphaned pending installations without user_id
    db.exec(`
      DELETE FROM pending_github_installations WHERE user_id IS NULL
    `);

    // Rename old table
    db.exec(`
      ALTER TABLE pending_github_installations RENAME TO pending_github_installations_old
    `);

    // Create new table with compound primary key and NOT NULL user_id
    db.exec(`
      CREATE TABLE pending_github_installations (
        installation_id INTEGER NOT NULL,
        user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
        setup_action TEXT NOT NULL DEFAULT 'install',
        state TEXT,
        created_at TEXT NOT NULL,
        PRIMARY KEY (installation_id, user_id)
      )
    `);

    // Migrate data from old table
    db.exec(`
      INSERT INTO pending_github_installations (installation_id, user_id, setup_action, state, created_at)
      SELECT installation_id, user_id, setup_action, state, created_at
      FROM pending_github_installations_old
      WHERE user_id IS NOT NULL
    `);

    // Drop old table
    db.exec(`DROP TABLE pending_github_installations_old`);

    // Recreate indexes
    db.exec(`
      CREATE INDEX idx_pending_installations_user
        ON pending_github_installations(user_id)
    `);
    db.exec(`
      CREATE INDEX idx_pending_installations_created
        ON pending_github_installations(created_at)
    `);

    // =========================================================================
    // 3. Handle projects.user_id - we can't make it NOT NULL easily without
    //    recreating the table. For now, ensure new projects require user_id
    //    via application code. The unique installation constraint prevents
    //    the main attack vector.
    // =========================================================================
    // Note: Making user_id NOT NULL would require table recreation which is
    // risky for production data. The application layer enforces this requirement.
  },
};
