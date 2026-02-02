import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, unlinkSync } from 'node:fs';
import { initDatabase, closeDatabase, getSchemaVersion, getAppliedMigrations } from './index';

const TEST_DB_PATH = './test-conductor.db';

function cleanupTestDb() {
  const paths = [TEST_DB_PATH, `${TEST_DB_PATH}-wal`, `${TEST_DB_PATH}-shm`];
  for (const path of paths) {
    if (existsSync(path)) {
      unlinkSync(path);
    }
  }
}

describe('Database', () => {
  afterEach(() => {
    cleanupTestDb();
  });

  describe('initDatabase', () => {
    it('should create database and run migrations', () => {
      cleanupTestDb();

      const db = initDatabase({ path: TEST_DB_PATH });

      // Verify database was created
      expect(existsSync(TEST_DB_PATH)).toBe(true);

      // Verify schema version is set
      const version = getSchemaVersion(db);
      expect(version).toBeGreaterThanOrEqual(1);

      closeDatabase(db);
    });

    it('should enable WAL mode', () => {
      cleanupTestDb();

      const db = initDatabase({ path: TEST_DB_PATH });
      const result = db.pragma('journal_mode') as Array<{ journal_mode: string }>;
      expect(result[0]['journal_mode']).toBe('wal');

      closeDatabase(db);
    });

    it('should enable foreign keys', () => {
      cleanupTestDb();

      const db = initDatabase({ path: TEST_DB_PATH });
      const result = db.pragma('foreign_keys') as Array<{ foreign_keys: number }>;
      expect(result[0]['foreign_keys']).toBe(1);

      closeDatabase(db);
    });
  });

  describe('migrations', () => {
    it('should record all applied migrations', () => {
      cleanupTestDb();

      const db = initDatabase({ path: TEST_DB_PATH });
      const migrations = getAppliedMigrations(db);

      expect(migrations.length).toBeGreaterThanOrEqual(1);
      expect(migrations[0]['version']).toBe(1);
      expect(migrations[0]['name']).toBe('initial_schema');

      closeDatabase(db);
    });

    it('should create all expected tables', () => {
      cleanupTestDb();

      const db = initDatabase({ path: TEST_DB_PATH });

      const tables = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
        )
        .all() as Array<{ name: string }>;

      const tableNames = tables.map((t) => t['name']);

      // Core tables from migration 001
      expect(tableNames).toContain('projects');
      expect(tableNames).toContain('repos');
      expect(tableNames).toContain('tasks');
      expect(tableNames).toContain('runs');
      expect(tableNames).toContain('events');
      expect(tableNames).toContain('agent_invocations');
      expect(tableNames).toContain('tool_invocations');
      expect(tableNames).toContain('policy_definitions');
      expect(tableNames).toContain('policy_violations');
      expect(tableNames).toContain('schema_versions');

      closeDatabase(db);
    });

    it('should be idempotent (re-running does not fail)', () => {
      cleanupTestDb();

      // First run
      const db1 = initDatabase({ path: TEST_DB_PATH });
      const version1 = getSchemaVersion(db1);
      closeDatabase(db1);

      // Second run (simulates restart)
      const db2 = initDatabase({ path: TEST_DB_PATH });
      const version2 = getSchemaVersion(db2);
      closeDatabase(db2);

      expect(version1).toBe(version2);
    });
  });
});
