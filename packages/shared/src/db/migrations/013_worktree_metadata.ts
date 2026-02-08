/**
 * Migration 013: Worktree Metadata
 *
 * Adds branch_name and base_commit columns to worktrees table,
 * and unique constraint to prevent duplicate active worktrees per run.
 */

import type { Database } from 'better-sqlite3';
import type { Migration } from './index.ts';

export const migration013: Migration = {
  version: 13,
  name: 'worktree_metadata',
  up: (db: Database) => {
    // Add branch metadata columns
    db.exec(`ALTER TABLE worktrees ADD COLUMN branch_name TEXT`);
    db.exec(`ALTER TABLE worktrees ADD COLUMN base_commit TEXT`);

    // Add unique constraint: only one active worktree per run
    // This prevents race conditions from creating duplicate worktrees
    db.exec(`
      CREATE UNIQUE INDEX idx_worktrees_active_run
      ON worktrees(run_id)
      WHERE destroyed_at IS NULL
    `);
  },
};
