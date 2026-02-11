/**
 * Migration 017: Add actor_type and actor_display_name to operator_actions
 *
 * DATA_MODEL.md Section 6.6 specifies full actor attribution on operator
 * actions. The existing `operator` column stores the actor ID; this migration
 * adds actor_type (defaulting to 'operator') and actor_display_name
 * (backfilled from the existing operator column to preserve attribution).
 */

import type { Database } from 'better-sqlite3';
import type { Migration } from './index.ts';

export const migration017: Migration = {
  version: 17,
  name: 'operator_actions_actor_columns',
  up: (db: Database) => {
    db.exec(`
      ALTER TABLE operator_actions ADD COLUMN actor_type TEXT NOT NULL DEFAULT 'operator';
      ALTER TABLE operator_actions ADD COLUMN actor_display_name TEXT NOT NULL DEFAULT 'Operator';
      UPDATE operator_actions SET actor_display_name = operator;
    `);
  },
};
