/**
 * Migration 007: Add user_id to projects
 *
 * Links projects to their owner user.
 * Part of WP13-A: Auth Spine.
 */

import type { Database } from 'better-sqlite3';
import type { Migration } from './index.ts';

export const migration007: Migration = {
  version: 7,
  name: 'projects_user_id',
  up: (db: Database) => {
    // Add user_id column to projects (nullable for existing data)
    db.exec(`
      ALTER TABLE projects ADD COLUMN user_id TEXT REFERENCES users(user_id)
    `);

    // Create index for user lookups
    db.exec(`CREATE INDEX idx_projects_user ON projects(user_id)`);
  },
};
