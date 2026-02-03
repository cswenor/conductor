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
import { migration002 } from './002_add_violation_fk';
import { migration003 } from './003_github_writes_payload';
import { migration004 } from './004_events_source';
import { migration005 } from './005_pending_github_installations';

/**
 * All migrations in order
 */
export const migrations: Migration[] = [migration001, migration002, migration003, migration004, migration005];
