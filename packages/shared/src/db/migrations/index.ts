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
import { migration006 } from './006_users_and_sessions';
import { migration007 } from './007_projects_user_id';
import { migration008 } from './008_pending_installations_user_id';
import { migration009 } from './009_token_encryption_nonces';
import { migration010 } from './010_strict_ownership';

/**
 * All migrations in order
 */
export const migrations: Migration[] = [migration001, migration002, migration003, migration004, migration005, migration006, migration007, migration008, migration009, migration010];
