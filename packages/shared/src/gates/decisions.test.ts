/**
 * Gate Decisions CRUD + conflict detection tests
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Database as DatabaseType } from 'better-sqlite3';
import { initDatabase, closeDatabase } from '../db/index.ts';
import { createRun, type Run } from '../runs/index.ts';
import { ensureBuiltInGateDefinitions } from './gate-definitions.ts';
import { recordGateDecision, getGateDecision } from './decisions.ts';

let db: DatabaseType;

function seedTestData(database: DatabaseType): { run: Run; projectId: string } {
  const now = new Date().toISOString();
  const userId = 'user_test';
  const projectId = 'proj_test';
  const repoId = 'repo_test';
  const taskId = 'task_test';

  database.prepare(`
    INSERT OR IGNORE INTO users (user_id, github_id, github_node_id, github_login, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'active', ?, ?)
  `).run(userId, 100, 'U_test', 'testuser', now, now);

  database.prepare(`
    INSERT INTO projects (
      project_id, user_id, name, github_org_id, github_org_node_id, github_org_name,
      github_installation_id, default_profile_id, default_base_branch,
      port_range_start, port_range_end, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(projectId, userId, 'Test Project', 1, 'O_test', 'testorg',
    12345, 'default', 'main', 3100, 3199, now, now);

  database.prepare(`
    INSERT INTO repos (
      repo_id, project_id, github_node_id, github_numeric_id,
      github_owner, github_name, github_full_name, github_default_branch,
      profile_id, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(repoId, projectId, 'R_test', 100,
    'testowner', 'testrepo', 'testowner/testrepo', 'main',
    'default', 'active', now, now);

  database.prepare(`
    INSERT INTO tasks (
      task_id, project_id, repo_id, github_node_id, github_issue_number,
      github_type, github_title, github_body, github_state, github_labels_json,
      github_synced_at, created_at, updated_at, last_activity_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(taskId, projectId, repoId, 'I_test', 42,
    'issue', 'Test Task', 'Body', 'open', '[]',
    now, now, now, now);

  const run = createRun(database, { taskId, projectId, repoId, baseBranch: 'main' });
  return { run, projectId };
}

beforeEach(() => {
  db = initDatabase({ path: ':memory:' });
  ensureBuiltInGateDefinitions(db);
});

afterEach(() => {
  closeDatabase(db);
});

describe('recordGateDecision', () => {
  it('creates row with correct fields', () => {
    const { run } = seedTestData(db);

    const result = recordGateDecision(db, {
      runId: run.runId,
      gateId: 'plan_approval',
      cycle: 0,
      decision: 'approved',
      actorId: 'user_test',
      comment: 'Looks good',
    });

    expect(result.inserted).toBe(true);
    expect(result.conflict).toBe(false);
    expect(result.decision.runId).toBe(run.runId);
    expect(result.decision.gateId).toBe('plan_approval');
    expect(result.decision.cycle).toBe(0);
    expect(result.decision.decision).toBe('approved');
    expect(result.decision.actorId).toBe('user_test');
    expect(result.decision.comment).toBe('Looks good');
    expect(result.decision.gateDecisionId).toMatch(/^gd_/);
    expect(result.decision.createdAt).toBeDefined();
  });

  it('returns idempotent result for same decision', () => {
    const { run } = seedTestData(db);

    const first = recordGateDecision(db, {
      runId: run.runId,
      gateId: 'plan_approval',
      cycle: 0,
      decision: 'approved',
      actorId: 'user_test',
    });

    expect(first.inserted).toBe(true);

    const second = recordGateDecision(db, {
      runId: run.runId,
      gateId: 'plan_approval',
      cycle: 0,
      decision: 'approved',
      actorId: 'user_test2',
    });

    expect(second.inserted).toBe(false);
    expect(second.conflict).toBe(false);
    expect(second.decision.gateDecisionId).toBe(first.decision.gateDecisionId);
  });

  it('detects conflict for opposite decision', () => {
    const { run } = seedTestData(db);

    recordGateDecision(db, {
      runId: run.runId,
      gateId: 'plan_approval',
      cycle: 0,
      decision: 'approved',
      actorId: 'user_test',
    });

    const result = recordGateDecision(db, {
      runId: run.runId,
      gateId: 'plan_approval',
      cycle: 0,
      decision: 'rejected',
      actorId: 'user_test2',
    });

    expect(result.inserted).toBe(false);
    expect(result.conflict).toBe(true);
    expect(result.decision.decision).toBe('approved');
  });
});

describe('getGateDecision', () => {
  it('returns null when no decision exists', () => {
    const { run } = seedTestData(db);
    const result = getGateDecision(db, run.runId, 'plan_approval', 0);
    expect(result).toBeNull();
  });

  it('returns decision for correct cycle', () => {
    const { run } = seedTestData(db);

    recordGateDecision(db, {
      runId: run.runId,
      gateId: 'plan_approval',
      cycle: 0,
      decision: 'approved',
      actorId: 'user_test',
    });

    const result = getGateDecision(db, run.runId, 'plan_approval', 0);
    expect(result).not.toBeNull();
    expect(result?.decision).toBe('approved');
  });

  it('isolates decisions by cycle', () => {
    const { run } = seedTestData(db);

    recordGateDecision(db, {
      runId: run.runId,
      gateId: 'plan_approval',
      cycle: 1,
      decision: 'approved',
      actorId: 'user_test',
    });

    // Cycle 0 should be empty
    const result0 = getGateDecision(db, run.runId, 'plan_approval', 0);
    expect(result0).toBeNull();

    // Cycle 1 should have the decision
    const result1 = getGateDecision(db, run.runId, 'plan_approval', 1);
    expect(result1).not.toBeNull();
    expect(result1?.decision).toBe('approved');

    // Cycle 2 should be empty
    const result2 = getGateDecision(db, run.runId, 'plan_approval', 2);
    expect(result2).toBeNull();
  });

  it('enforces FK on gate_id', () => {
    const { run } = seedTestData(db);

    expect(() => recordGateDecision(db, {
      runId: run.runId,
      gateId: 'nonexistent_gate',
      cycle: 0,
      decision: 'approved',
      actorId: 'user_test',
    })).toThrow();
  });
});
