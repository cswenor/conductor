/**
 * Migration registry
 *
 * All migrations must be registered here in order.
 * Migrations are forward-only (no down migrations).
 */

import type { Database } from 'better-sqlite3';

export interface Migration {
  version: number;
  name: string;
  up: (db: Database) => void;
}

import { migration001 } from './001_initial_schema';

/**
 * All migrations in order
 */
export const migrations: Migration[] = [migration001];
