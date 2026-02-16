/**
 * Migration 022 test: workflow_config columns
 *
 * Verifies that:
 * - workflow_config_json column exists on projects (null default)
 * - workflow_snapshot_json and workflow_overlay_json columns exist on runs (null default)
 * - Existing data survives the migration
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import type { Database as DatabaseType } from 'better-sqlite3';
import { migrations } from './index.ts';
import { migration022 } from './022_workflow_config.ts';

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

function seedProjectAndRun(database: DatabaseType): { projectId: string; runId: string } {
  const now = new Date().toISOString();
  seedCounter++;
  const projectId = `proj_${seedCounter}`;
  const runId = `run_${seedCounter}`;
  const userId = `user_${seedCounter}`;
  const taskId = `task_${seedCounter}`;
  const repoId = `repo_${seedCounter}`;

  database.prepare(`
    INSERT OR IGNORE INTO users (user_id, github_id, github_node_id, github_login, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'active', ?, ?)
  `).run(userId, 100 + seedCounter, `U_${seedCounter}`, `user${seedCounter}`, now, now);

  database.prepare(`
    INSERT INTO projects (
      project_id, user_id, name, github_org_id, github_org_node_id, github_org_name,
      github_installation_id, default_profile_id, default_base_branch,
      port_range_start, port_range_end, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(projectId, userId, `Project ${seedCounter}`, seedCounter, `O_${seedCounter}`, `org${seedCounter}`,
    10000 + seedCounter, 'default', 'main', 3000, 4000, now, now);

  database.prepare(`
    INSERT INTO repos (
      repo_id, project_id, github_node_id, github_numeric_id,
      github_owner, github_name, github_full_name, github_default_branch,
      profile_id, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(repoId, projectId, `R_${seedCounter}`, 200 + seedCounter,
    'owner', `repo${seedCounter}`, `owner/repo${seedCounter}`, 'main',
    'default', 'active', now, now);

  database.prepare(`
    INSERT INTO tasks (
      task_id, project_id, repo_id, github_node_id, github_issue_number,
      github_type, github_title, github_body, github_state, github_labels_json,
      github_synced_at, created_at, updated_at, last_activity_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(taskId, projectId, repoId, `I_${seedCounter}`, 1,
    'issue', 'Test', 'Body', 'open', '[]', now, now, now, now);

  // Insert a minimal policy_sets row for FK
  database.prepare(`
    INSERT OR IGNORE INTO policy_sets (policy_set_id, project_id, config_hash, created_by, created_at)
    VALUES (?, ?, 'default:v1', 'system', ?)
  `).run(`ps_${seedCounter}`, projectId, now);

  database.prepare(`
    INSERT INTO runs (
      run_id, task_id, project_id, repo_id, run_number,
      phase, step, policy_set_id,
      last_event_sequence, next_sequence,
      base_branch, branch,
      implementer_backend,
      started_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(runId, taskId, projectId, repoId, 1,
    'pending', 'setup_worktree', `ps_${seedCounter}`,
    0, 1, 'main', '', 'raw', now, now);

  return { projectId, runId };
}

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  seedCounter = 0;
});

afterEach(() => {
  db.close();
});

describe('migration 022: workflow_config', () => {
  it('creates workflow_config_json column on projects with null default', () => {
    applyMigrationsUpTo(db, 22);

    const columns = db.prepare("PRAGMA table_info('projects')").all() as {
      name: string;
      type: string;
      notnull: number;
    }[];

    const col = columns.find(c => c.name === 'workflow_config_json');
    expect(col).toBeDefined();
    expect(col?.type).toBe('TEXT');
    expect(col?.notnull).toBe(0);
  });

  it('creates workflow_snapshot_json and workflow_overlay_json columns on runs with null default', () => {
    applyMigrationsUpTo(db, 22);

    const columns = db.prepare("PRAGMA table_info('runs')").all() as {
      name: string;
      type: string;
      notnull: number;
    }[];

    const snapshotCol = columns.find(c => c.name === 'workflow_snapshot_json');
    expect(snapshotCol).toBeDefined();
    expect(snapshotCol?.type).toBe('TEXT');
    expect(snapshotCol?.notnull).toBe(0);

    const overlayCol = columns.find(c => c.name === 'workflow_overlay_json');
    expect(overlayCol).toBeDefined();
    expect(overlayCol?.type).toBe('TEXT');
    expect(overlayCol?.notnull).toBe(0);
  });

  it('existing data survives migration upgrade', () => {
    applyMigrationsUpTo(db, 21);
    const { projectId, runId } = seedProjectAndRun(db);

    // Apply migration 022
    migration022.up(db);

    // Verify original data intact
    const project = db.prepare('SELECT * FROM projects WHERE project_id = ?').get(projectId) as Record<string, unknown>;
    expect(project['name']).toBe('Project 1');
    expect(project['workflow_config_json']).toBeNull();

    const run = db.prepare('SELECT * FROM runs WHERE run_id = ?').get(runId) as Record<string, unknown>;
    expect(run['phase']).toBe('pending');
    expect(run['implementer_backend']).toBe('raw');
    expect(run['workflow_snapshot_json']).toBeNull();
    expect(run['workflow_overlay_json']).toBeNull();
  });
});
