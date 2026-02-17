/**
 * Migration 024 Tests — rewind_context columns
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Database as DatabaseType } from 'better-sqlite3';
import { initDatabase, closeDatabase } from '../index.ts';
import { createRun, getRun } from '../../runs/index.ts';

// Mock pubsub
vi.mock('../../pubsub/index.ts', () => ({
  publishOperatorActionEvent: vi.fn(),
  publishRunUpdatedEvent: vi.fn(),
  publishTransitionEvent: vi.fn(),
  initPublisher: vi.fn(),
  publishGateEvaluatedEvent: vi.fn(),
  publishAgentInvocationEvent: vi.fn(),
  publishProjectUpdatedEvent: vi.fn(),
}));

let db: DatabaseType;

function seedTestData(database: DatabaseType): { runId: string } {
  const now = new Date().toISOString();

  database.prepare(`
    INSERT OR IGNORE INTO users (user_id, github_id, github_node_id, github_login, status, created_at, updated_at)
    VALUES ('u1', 1, 'U1', 'test', 'active', ?, ?)
  `).run(now, now);

  database.prepare(`
    INSERT INTO projects (project_id, user_id, name, github_org_id, github_org_node_id, github_org_name,
      github_installation_id, default_profile_id, default_base_branch,
      port_range_start, port_range_end, created_at, updated_at)
    VALUES ('p1', 'u1', 'P', 1, 'O1', 'org', 1, 'default', 'main', 3100, 3199, ?, ?)
  `).run(now, now);

  database.prepare(`
    INSERT INTO repos (repo_id, project_id, github_node_id, github_numeric_id,
      github_owner, github_name, github_full_name, github_default_branch,
      profile_id, status, created_at, updated_at)
    VALUES ('r1', 'p1', 'R1', 1, 'owner', 'repo', 'owner/repo', 'main', 'default', 'active', ?, ?)
  `).run(now, now);

  database.prepare(`
    INSERT INTO tasks (task_id, project_id, repo_id, github_node_id, github_issue_number,
      github_type, github_title, github_body, github_state, github_labels_json,
      github_synced_at, created_at, updated_at, last_activity_at)
    VALUES ('t1', 'p1', 'r1', 'I1', 1, 'issue', 'T', 'B', 'open', '[]', ?, ?, ?, ?)
  `).run(now, now, now, now);

  const run = createRun(database, { taskId: 't1', projectId: 'p1', repoId: 'r1', baseBranch: 'main' });
  return { runId: run.runId };
}

beforeEach(() => {
  db = initDatabase({ path: ':memory:' });
});

afterEach(() => {
  closeDatabase(db);
});

describe('migration 024 — rewind_context', () => {
  it('rewind_context_mode column exists and defaults to NULL', () => {
    const row = db.prepare(
      "SELECT rewind_context_mode FROM runs LIMIT 0"
    ).all();
    // Column exists — query didn't throw
    expect(row).toBeDefined();
  });

  it('rewind_context_summary column exists and defaults to NULL', () => {
    const row = db.prepare(
      "SELECT rewind_context_summary FROM runs LIMIT 0"
    ).all();
    expect(row).toBeDefined();
  });

  it('columns accept text values', () => {
    const { runId } = seedTestData(db);

    // Set rewind context columns
    db.prepare(
      'UPDATE runs SET rewind_context_mode = ?, rewind_context_summary = ? WHERE run_id = ?'
    ).run('preserve', 'Test summary content', runId);

    const row = db.prepare('SELECT rewind_context_mode, rewind_context_summary FROM runs WHERE run_id = ?')
      .get(runId) as Record<string, unknown>;

    expect(row['rewind_context_mode']).toBe('preserve');
    expect(row['rewind_context_summary']).toBe('Test summary content');
  });

  it('columns default to NULL for new runs', () => {
    const { runId } = seedTestData(db);

    const run = getRun(db, runId);
    expect(run?.rewindContextMode).toBeUndefined();
    expect(run?.rewindContextSummary).toBeUndefined();
  });
});
