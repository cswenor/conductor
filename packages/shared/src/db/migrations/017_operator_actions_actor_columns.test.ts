/**
 * Migration 017 backfill test
 *
 * Verifies that applying migration 017 on a pre-017 schema correctly:
 * - Adds actor_type with default 'operator'
 * - Adds actor_display_name with default 'Operator'
 * - Backfills actor_display_name from the existing operator column
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import type { Database as DatabaseType } from 'better-sqlite3';
import { migrations } from './index.ts';
import { migration017 } from './017_operator_actions_actor_columns.ts';

let db: DatabaseType;

/**
 * Apply migrations up to (and including) the given version.
 */
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
          'INSERT INTO schema_versions (version, name) VALUES (?, ?)'
        ).run(m.version, m.name);
      })();
    }
  }
}

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
});

afterEach(() => {
  db.close();
});

describe('migration 017: operator_actions actor columns', () => {
  it('backfills actor_display_name from operator column', () => {
    // Set up schema through migration 016
    applyMigrationsUpTo(db, 16);

    // Seed minimal FK chain so we can insert an operator_action
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO users (user_id, github_id, github_node_id, github_login, status, created_at, updated_at)
      VALUES ('u1', 1, 'U_1', 'alice', 'active', ?, ?)
    `).run(now, now);

    db.prepare(`
      INSERT INTO projects (
        project_id, user_id, name, github_org_id, github_org_node_id, github_org_name,
        github_installation_id, default_profile_id, default_base_branch,
        port_range_start, port_range_end, created_at, updated_at
      ) VALUES ('p1', 'u1', 'P', 1, 'O_1', 'org', 100, 'default', 'main', 3100, 3199, ?, ?)
    `).run(now, now);

    db.prepare(`
      INSERT INTO repos (
        repo_id, project_id, github_node_id, github_numeric_id,
        github_owner, github_name, github_full_name, github_default_branch,
        profile_id, status, created_at, updated_at
      ) VALUES ('r1', 'p1', 'R_1', 1, 'owner', 'repo', 'owner/repo', 'main', 'default', 'active', ?, ?)
    `).run(now, now);

    db.prepare(`
      INSERT INTO tasks (
        task_id, project_id, repo_id, github_node_id, github_issue_number,
        github_type, github_title, github_body, github_state, github_labels_json,
        github_synced_at, created_at, updated_at, last_activity_at
      ) VALUES ('t1', 'p1', 'r1', 'I_1', 1, 'issue', 'T', '', 'open', '[]', ?, ?, ?, ?)
    `).run(now, now, now, now);

    db.prepare(`
      INSERT INTO policy_sets (policy_set_id, project_id, config_hash, created_by, created_at)
      VALUES ('ps1', 'p1', 'hash', 'system', ?)
    `).run(now);

    db.prepare(`
      INSERT INTO runs (
        run_id, task_id, project_id, repo_id, base_branch, branch,
        phase, step, policy_set_id, started_at, updated_at
      ) VALUES ('run1', 't1', 'p1', 'r1', 'main', '', 'pending', 'setup_worktree', 'ps1', ?, ?)
    `).run(now, now);

    // Insert two operator_actions in the pre-017 schema (no actor_type / actor_display_name)
    db.prepare(`
      INSERT INTO operator_actions (
        operator_action_id, run_id, action, operator,
        comment, from_phase, to_phase, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run('oa_1', 'run1', 'cancel', 'alice_id', 'bye', 'pending', 'cancelled', now);

    db.prepare(`
      INSERT INTO operator_actions (
        operator_action_id, run_id, action, operator,
        comment, from_phase, to_phase, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run('oa_2', 'run1', 'cancel', 'bob_id', null, null, null, now);

    // Apply migration 017
    migration017.up(db);

    // Verify backfill: actor_display_name should equal the operator value
    const rows = db.prepare(
      'SELECT operator_action_id, operator, actor_type, actor_display_name FROM operator_actions ORDER BY operator_action_id'
    ).all() as { operator_action_id: string; operator: string; actor_type: string; actor_display_name: string }[];

    expect(rows).toHaveLength(2);

    expect(rows[0]?.actor_type).toBe('operator');
    expect(rows[0]?.actor_display_name).toBe('alice_id');

    expect(rows[1]?.actor_type).toBe('operator');
    expect(rows[1]?.actor_display_name).toBe('bob_id');
  });

  it('sets correct defaults on rows inserted after migration without explicit values', () => {
    applyMigrationsUpTo(db, 17);

    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO users (user_id, github_id, github_node_id, github_login, status, created_at, updated_at)
      VALUES ('u1', 1, 'U_1', 'alice', 'active', ?, ?)
    `).run(now, now);

    db.prepare(`
      INSERT INTO projects (
        project_id, user_id, name, github_org_id, github_org_node_id, github_org_name,
        github_installation_id, default_profile_id, default_base_branch,
        port_range_start, port_range_end, created_at, updated_at
      ) VALUES ('p1', 'u1', 'P', 1, 'O_1', 'org', 100, 'default', 'main', 3100, 3199, ?, ?)
    `).run(now, now);

    db.prepare(`
      INSERT INTO repos (
        repo_id, project_id, github_node_id, github_numeric_id,
        github_owner, github_name, github_full_name, github_default_branch,
        profile_id, status, created_at, updated_at
      ) VALUES ('r1', 'p1', 'R_1', 1, 'owner', 'repo', 'owner/repo', 'main', 'default', 'active', ?, ?)
    `).run(now, now);

    db.prepare(`
      INSERT INTO tasks (
        task_id, project_id, repo_id, github_node_id, github_issue_number,
        github_type, github_title, github_body, github_state, github_labels_json,
        github_synced_at, created_at, updated_at, last_activity_at
      ) VALUES ('t1', 'p1', 'r1', 'I_1', 1, 'issue', 'T', '', 'open', '[]', ?, ?, ?, ?)
    `).run(now, now, now, now);

    db.prepare(`
      INSERT INTO policy_sets (policy_set_id, project_id, config_hash, created_by, created_at)
      VALUES ('ps1', 'p1', 'hash', 'system', ?)
    `).run(now);

    db.prepare(`
      INSERT INTO runs (
        run_id, task_id, project_id, repo_id, base_branch, branch,
        phase, step, policy_set_id, started_at, updated_at
      ) VALUES ('run1', 't1', 'p1', 'r1', 'main', '', 'pending', 'setup_worktree', 'ps1', ?, ?)
    `).run(now, now);

    // Insert without specifying actor_type / actor_display_name — defaults should apply
    db.prepare(`
      INSERT INTO operator_actions (
        operator_action_id, run_id, action, operator,
        comment, from_phase, to_phase, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run('oa_new', 'run1', 'cancel', 'some_operator', null, null, null, now);

    const row = db.prepare(
      'SELECT actor_type, actor_display_name FROM operator_actions WHERE operator_action_id = ?'
    ).get('oa_new') as { actor_type: string; actor_display_name: string };

    expect(row.actor_type).toBe('operator');
    expect(row.actor_display_name).toBe('Operator');
  });
});
