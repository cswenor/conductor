/**
 * Migration 004: Add source column to events
 *
 * Tracks the origin of events (webhook, internal, operator, system).
 */

import type { Database } from 'better-sqlite3';
import type { Migration } from './index';

export const migration004: Migration = {
  version: 4,
  name: 'events_source',
  up: (db: Database) => {
    // Add source column to events table with default 'webhook' for existing rows
    db.exec(`
      ALTER TABLE events
      ADD COLUMN source TEXT NOT NULL DEFAULT 'webhook'
    `);
  },
};
