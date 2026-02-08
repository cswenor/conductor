/**
 * Migration 003: Add payload_json to github_writes
 *
 * Adds payload storage to the github_writes table for reliable processing.
 * The payload is stored as JSON and used by the outbox processor.
 */

import type { Database } from 'better-sqlite3';
import type { Migration } from './index.ts';

export const migration003: Migration = {
  version: 3,
  name: 'github_writes_payload',
  up: (db: Database) => {
    // Add payload_json column to github_writes table
    db.exec(`
      ALTER TABLE github_writes
      ADD COLUMN payload_json TEXT
    `);
  },
};
