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

import { migration001 } from './001_initial_schema.ts';
import { migration002 } from './002_add_violation_fk.ts';
import { migration003 } from './003_github_writes_payload.ts';
import { migration004 } from './004_events_source.ts';
import { migration005 } from './005_pending_github_installations.ts';
import { migration006 } from './006_users_and_sessions.ts';
import { migration007 } from './007_projects_user_id.ts';
import { migration008 } from './008_pending_installations_user_id.ts';
import { migration009 } from './009_token_encryption_nonces.ts';
import { migration010 } from './010_strict_ownership.ts';
import { migration011 } from './011_user_api_keys.ts';
import { migration012 } from './012_repo_clone_tracking.ts';
import { migration013 } from './013_worktree_metadata.ts';

/**
 * All migrations in order
 */
export const migrations: Migration[] = [migration001, migration002, migration003, migration004, migration005, migration006, migration007, migration008, migration009, migration010, migration011, migration012, migration013];
