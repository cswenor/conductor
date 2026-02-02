/**
 * Database module for Conductor
 *
 * Provides SQLite database initialization, connection management,
 * and forward-only migration system.
 */

import Database from 'better-sqlite3';
import type { Database as DatabaseType } from 'better-sqlite3';
import { migrations } from './migrations/index';
import { createLogger } from '../logger/index';

const log = createLogger({ name: 'conductor:db' });

export type { DatabaseType as Database };

/**
 * Database configuration options
 */
export interface DatabaseConfig {
  /** Path to SQLite database file */
  path: string;
  /** Enable verbose logging */
  verbose?: boolean;
}

/**
 * Initialize database with migrations
 */
export function initDatabase(config: DatabaseConfig): DatabaseType {
  const db = new Database(config.path, {
    verbose: config.verbose === true ? (msg: unknown) => log.debug({ sql: msg }, 'SQL') : undefined,
  });

  // Enable WAL mode for better concurrent access
  db.pragma('journal_mode = WAL');

  // Enable foreign keys
  db.pragma('foreign_keys = ON');

  // Run migrations
  runMigrations(db);

  return db;
}

/**
 * Schema version tracking
 */
interface SchemaVersion {
  version: number;
  name: string;
  applied_at: string;
}

/**
 * Run all pending migrations
 */
function runMigrations(db: DatabaseType): void {
  // Create schema_versions table if it doesn't exist
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_versions (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  // Get current version
  const currentVersion = db
    .prepare('SELECT MAX(version) as version FROM schema_versions')
    .get() as { version: number | null };

  const appliedVersion = currentVersion.version ?? 0;

  // Apply pending migrations
  for (const migration of migrations) {
    if (migration.version > appliedVersion) {
      log.info({ version: migration.version, name: migration.name }, 'Applying migration');

      db.transaction(() => {
        migration.up(db);

        db.prepare(
          'INSERT INTO schema_versions (version, name) VALUES (?, ?)'
        ).run(migration.version, migration.name);
      })();

      log.info({ version: migration.version }, 'Migration applied successfully');
    }
  }
}

/**
 * Get current schema version
 */
export function getSchemaVersion(db: DatabaseType): number {
  const result = db
    .prepare('SELECT MAX(version) as version FROM schema_versions')
    .get() as { version: number | null };
  return result.version ?? 0;
}

/**
 * Get all applied migrations
 */
export function getAppliedMigrations(db: DatabaseType): SchemaVersion[] {
  return db
    .prepare('SELECT * FROM schema_versions ORDER BY version ASC')
    .all() as SchemaVersion[];
}

/**
 * Close database connection
 */
export function closeDatabase(db: DatabaseType): void {
  db.close();
}
