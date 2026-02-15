/**
 * Migration 021: Implementer backend column on runs
 *
 * Allows per-run selection of the implementer runtime (raw tool loop vs Agent SDK).
 * Default 'raw' preserves existing behaviour for all current runs.
 */

import type { Database } from 'better-sqlite3';
import type { Migration } from './index.ts';

export const migration021: Migration = {
  version: 21,
  name: 'implementer_backend',
  up(db: Database) {
    db.exec(`
      ALTER TABLE runs ADD COLUMN implementer_backend TEXT NOT NULL DEFAULT 'raw'
        CHECK (implementer_backend IN ('raw', 'agent_sdk'));
    `);
  },
};
