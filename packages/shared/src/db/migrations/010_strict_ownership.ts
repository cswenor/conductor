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
import type { Migration } from './index.ts';

export const migration010: Migration = {
  version: 10,
  name: 'strict_ownership',
  up: (db: Database) => {
    // =========================================================================
    // 1. Add unique constraint on projects.github_installation_id
    // =========================================================================
    // SQLite doesn't support ADD CONSTRAINT, so we create a unique index.
    // First, deduplicate any existing rows to prevent migration failure.

    // Delete duplicate projects, keeping only the oldest (first created) for each installation_id
    db.exec(`
      DELETE FROM projects
      WHERE rowid NOT IN (
        SELECT MIN(rowid)
        FROM projects
        GROUP BY github_installation_id
      )
    `);

    // Now safe to create unique index
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
    // 3. Recreate projects table with user_id NOT NULL
    // =========================================================================
    // SQLite requires table recreation to add NOT NULL constraint.
    // Must disable FK enforcement to allow dropping parent table.

    // First, delete any orphaned projects without user_id
    db.exec(`DELETE FROM projects WHERE user_id IS NULL`);

    // Drop indexes (will recreate after)
    db.exec(`DROP INDEX IF EXISTS idx_projects_installation_unique`);
    db.exec(`DROP INDEX IF EXISTS idx_projects_user`);

    // Create temp table with new schema (user_id NOT NULL)
    db.exec(`
      CREATE TABLE projects_new (
        project_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
        github_org_id INTEGER NOT NULL,
        github_org_node_id TEXT NOT NULL,
        github_org_name TEXT NOT NULL,
        github_installation_id INTEGER NOT NULL,
        github_projects_v2_id TEXT,
        default_profile_id TEXT NOT NULL,
        default_base_branch TEXT NOT NULL,
        enforce_projects INTEGER NOT NULL DEFAULT 0,
        port_range_start INTEGER NOT NULL,
        port_range_end INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);

    // Copy data to new table
    db.exec(`
      INSERT INTO projects_new (
        project_id, name, user_id, github_org_id, github_org_node_id,
        github_org_name, github_installation_id, github_projects_v2_id,
        default_profile_id, default_base_branch, enforce_projects,
        port_range_start, port_range_end, created_at, updated_at
      )
      SELECT
        project_id, name, user_id, github_org_id, github_org_node_id,
        github_org_name, github_installation_id, github_projects_v2_id,
        default_profile_id, default_base_branch, enforce_projects,
        port_range_start, port_range_end, created_at, updated_at
      FROM projects
    `);

    // Disable FK enforcement to drop parent table with child references
    db.pragma('foreign_keys = OFF');

    // Drop old table and rename new one
    db.exec(`DROP TABLE projects`);
    db.exec(`ALTER TABLE projects_new RENAME TO projects`);

    // Re-enable FK enforcement
    db.pragma('foreign_keys = ON');

    // Recreate indexes
    db.exec(`
      CREATE UNIQUE INDEX idx_projects_installation_unique
        ON projects(github_installation_id)
    `);
    db.exec(`CREATE INDEX idx_projects_user ON projects(user_id)`);
  },
};
