/**
 * Migration 022: Workflow config columns
 *
 * Adds layered workflow configuration support:
 * - projects.workflow_config_json: project-level step config overrides
 * - runs.workflow_snapshot_json: immutable resolved config at run creation
 * - runs.workflow_overlay_json: mutable overlay (settable while paused)
 */

import type { Database } from 'better-sqlite3';
import type { Migration } from './index.ts';

export const migration022: Migration = {
  version: 22,
  name: 'workflow_config',
  up(db: Database) {
    db.exec(`
      ALTER TABLE projects ADD COLUMN workflow_config_json TEXT;
      ALTER TABLE runs ADD COLUMN workflow_snapshot_json TEXT;
      ALTER TABLE runs ADD COLUMN workflow_overlay_json TEXT;
    `);
  },
};
