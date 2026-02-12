/**
 * Migration 018 test: stream_events table
 *
 * Verifies that:
 * - Table created with correct columns
 * - Auto-increment produces strictly monotonic IDs
 * - Indexes exist for (project_id, id) and (created_at)
 * - Foreign key on project_id enforced
 * - insertStreamEvent / queryStreamEventsForReplay / rowToStreamEventV2 / pruneStreamEvents work
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import type { Database as DatabaseType } from 'better-sqlite3';
import { migrations } from './index.ts';
import {
  insertStreamEvent,
  queryStreamEventsForReplay,
  rowToStreamEventV2,
  pruneStreamEvents,
} from '@conductor/shared';

let db: DatabaseType;

function applyMigrationsUpTo(database: DatabaseType, maxVersion: number): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_versions (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  for (const m of migrations) {
    if (m.version <= maxVersion) {
      database.transaction(() => {
        m.up(database);
        database.prepare(
          'INSERT INTO schema_versions (version, name) VALUES (?, ?)',
        ).run(m.version, m.name);
      })();
    }
  }
}

let seedCounter = 0;

function seedProject(database: DatabaseType, projectId: string): void {
  const now = new Date().toISOString();
  seedCounter++;
  database.prepare(`
    INSERT OR IGNORE INTO users (user_id, github_id, github_node_id, github_login, status, created_at, updated_at)
    VALUES ('u1', 1, 'U_1', 'alice', 'active', ?, ?)
  `).run(now, now);

  database.prepare(`
    INSERT INTO projects (
      project_id, user_id, name, github_org_id, github_org_node_id, github_org_name,
      github_installation_id, default_profile_id, default_base_branch,
      port_range_start, port_range_end, created_at, updated_at
    ) VALUES (?, 'u1', 'P', ?, ?, 'org', ?, 'default', 'main', ?, ?, ?, ?)
  `).run(projectId, seedCounter, `O_${seedCounter}`, 100 + seedCounter, 3100 + seedCounter * 100, 3199 + seedCounter * 100, now, now);
}

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
});

afterEach(() => {
  db.close();
});

describe('migration 018: stream_events', () => {
  it('creates stream_events table with correct columns', () => {
    applyMigrationsUpTo(db, 18);

    const columns = db.prepare(
      "PRAGMA table_info('stream_events')",
    ).all() as { name: string; type: string; notnull: number; pk: number }[];

    const columnMap = new Map(columns.map((c) => [c.name, c]));

    expect(columnMap.has('id')).toBe(true);
    expect(columnMap.get('id')?.pk).toBe(1);
    expect(columnMap.has('kind')).toBe(true);
    expect(columnMap.get('kind')?.notnull).toBe(1);
    expect(columnMap.has('project_id')).toBe(true);
    expect(columnMap.get('project_id')?.notnull).toBe(1);
    expect(columnMap.has('run_id')).toBe(true);
    expect(columnMap.has('payload_json')).toBe(true);
    expect(columnMap.get('payload_json')?.notnull).toBe(1);
    expect(columnMap.has('created_at')).toBe(true);
  });

  it('auto-increment produces strictly monotonic IDs', () => {
    applyMigrationsUpTo(db, 18);
    seedProject(db, 'proj_1');

    const id1 = insertStreamEvent(db, {
      kind: 'run.phase_changed',
      projectId: 'proj_1',
      runId: 'run_1',
      fromPhase: 'pending',
      toPhase: 'planning',
      timestamp: new Date().toISOString(),
    });

    const id2 = insertStreamEvent(db, {
      kind: 'run.phase_changed',
      projectId: 'proj_1',
      runId: 'run_2',
      fromPhase: 'planning',
      toPhase: 'executing',
      timestamp: new Date().toISOString(),
    });

    expect(id2).toBeGreaterThan(id1);
    expect(id2).toBe(id1 + 1);
  });

  it('indexes exist for (project_id, id) and (created_at)', () => {
    applyMigrationsUpTo(db, 18);

    const indexes = db.prepare(
      "PRAGMA index_list('stream_events')",
    ).all() as { name: string }[];

    const indexNames = indexes.map((i) => i.name);
    expect(indexNames).toContain('idx_stream_events_project_id');
    expect(indexNames).toContain('idx_stream_events_created_at');
  });

  it('enforces foreign key on project_id', () => {
    applyMigrationsUpTo(db, 18);

    expect(() => {
      insertStreamEvent(db, {
        kind: 'run.phase_changed',
        projectId: 'nonexistent_project',
        runId: 'run_1',
        fromPhase: 'pending',
        toPhase: 'planning',
        timestamp: new Date().toISOString(),
      });
    }).toThrow(/FOREIGN KEY/);
  });

  it('queryStreamEventsForReplay returns events after lastEventId', () => {
    applyMigrationsUpTo(db, 18);
    seedProject(db, 'proj_1');

    const id1 = insertStreamEvent(db, {
      kind: 'run.phase_changed',
      projectId: 'proj_1',
      runId: 'run_1',
      fromPhase: 'pending',
      toPhase: 'planning',
      timestamp: '2025-01-01T00:00:00.000Z',
    });

    insertStreamEvent(db, {
      kind: 'gate.evaluated',
      projectId: 'proj_1',
      runId: 'run_1',
      gateId: 'plan_approval',
      gateKind: 'approval',
      status: 'passed',
      timestamp: '2025-01-01T00:01:00.000Z',
    });

    insertStreamEvent(db, {
      kind: 'operator.action',
      projectId: 'proj_1',
      runId: 'run_1',
      action: 'approve_plan',
      operator: 'alice',
      timestamp: '2025-01-01T00:02:00.000Z',
    });

    // Query events after id1 — should return 2 events
    const rows = queryStreamEventsForReplay(db, id1, ['proj_1'], 101);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.kind).toBe('gate.evaluated');
    expect(rows[1]?.kind).toBe('operator.action');
  });

  it('queryStreamEventsForReplay scopes by project ID', () => {
    applyMigrationsUpTo(db, 18);
    seedProject(db, 'proj_1');
    seedProject(db, 'proj_2');

    insertStreamEvent(db, {
      kind: 'run.phase_changed',
      projectId: 'proj_1',
      runId: 'run_1',
      fromPhase: 'pending',
      toPhase: 'planning',
      timestamp: '2025-01-01T00:00:00.000Z',
    });

    insertStreamEvent(db, {
      kind: 'run.phase_changed',
      projectId: 'proj_2',
      runId: 'run_2',
      fromPhase: 'pending',
      toPhase: 'planning',
      timestamp: '2025-01-01T00:01:00.000Z',
    });

    // Query only proj_1 — should return 1 event
    const rows = queryStreamEventsForReplay(db, 0, ['proj_1'], 101);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.project_id).toBe('proj_1');
  });

  it('rowToStreamEventV2 reconstructs event from row', () => {
    applyMigrationsUpTo(db, 18);
    seedProject(db, 'proj_1');

    insertStreamEvent(db, {
      kind: 'gate.evaluated',
      projectId: 'proj_1',
      runId: 'run_1',
      gateId: 'plan_approval',
      gateKind: 'approval',
      status: 'passed',
      reason: 'Auto-approved',
      timestamp: '2025-01-01T00:00:00.000Z',
    });

    const rows = queryStreamEventsForReplay(db, 0, ['proj_1'], 101);
    expect(rows).toHaveLength(1);

    const event = rowToStreamEventV2(rows[0]!);
    expect(event.id).toBe(rows[0]!.id);
    expect(event.kind).toBe('gate.evaluated');
    expect(event.projectId).toBe('proj_1');
    if (event.kind === 'gate.evaluated') {
      expect(event.gateId).toBe('plan_approval');
      expect(event.gateKind).toBe('approval');
      expect(event.status).toBe('passed');
      expect(event.reason).toBe('Auto-approved');
    }
  });

  it('pruneStreamEvents deletes old rows', () => {
    applyMigrationsUpTo(db, 18);
    seedProject(db, 'proj_1');

    // Insert with old timestamp
    db.prepare(`
      INSERT INTO stream_events (kind, project_id, run_id, payload_json, created_at)
      VALUES ('run.phase_changed', 'proj_1', 'run_1', '{"fromPhase":"pending","toPhase":"planning"}', datetime('now', '-30 days'))
    `).run();

    // Insert with recent timestamp
    insertStreamEvent(db, {
      kind: 'run.phase_changed',
      projectId: 'proj_1',
      runId: 'run_2',
      fromPhase: 'planning',
      toPhase: 'executing',
      timestamp: new Date().toISOString(),
    });

    const deleted = pruneStreamEvents(db, 14);
    expect(deleted).toBe(1);

    // Only the recent one should remain
    const remaining = db.prepare('SELECT COUNT(*) as cnt FROM stream_events').get() as { cnt: number };
    expect(remaining.cnt).toBe(1);
  });

  it('queryStreamEventsForReplay returns empty array for no projects', () => {
    applyMigrationsUpTo(db, 18);
    const rows = queryStreamEventsForReplay(db, 0, [], 101);
    expect(rows).toHaveLength(0);
  });
});
