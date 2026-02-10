/**
 * Tests for casUpdateRunStep — the atomic compare-and-set step update.
 *
 * Uses a real in-memory SQLite database (via shared's initDatabase) so we
 * exercise the actual SQL WHERE clause rather than mocking it away.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  initDatabase,
  closeDatabase,
  getDatabase,
  createRun,
  getRun,
  transitionPhase,
} from '@conductor/shared';
import { casUpdateRunStep } from './run-helpers.ts';

type Db = ReturnType<typeof getDatabase>;
let db: Db;

function seedTestData(db: Db) {
  const now = new Date().toISOString();
  const userId = 'user_cas';
  const projectId = 'proj_cas';
  const repoId = 'repo_cas';
  const taskId = 'task_cas';

  db.prepare(`
    INSERT OR IGNORE INTO users (user_id, github_id, github_node_id, github_login, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'active', ?, ?)
  `).run(userId, 900, 'U_cas', 'casuser', now, now);

  db.prepare(`
    INSERT INTO projects (
      project_id, user_id, name, github_org_id, github_org_node_id, github_org_name,
      github_installation_id, default_profile_id, default_base_branch,
      port_range_start, port_range_end, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(projectId, userId, 'CAS Project', 900, 'O_cas', 'casorg',
    90000, 'default', 'main', 3100, 3199, now, now);

  db.prepare(`
    INSERT INTO repos (
      repo_id, project_id, github_node_id, github_numeric_id,
      github_owner, github_name, github_full_name, github_default_branch,
      profile_id, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(repoId, projectId, 'R_cas', 900,
    'casowner', 'casrepo', 'casowner/casrepo', 'main',
    'default', 'active', now, now);

  db.prepare(`
    INSERT INTO tasks (
      task_id, project_id, repo_id, github_node_id, github_issue_number,
      github_type, github_title, github_body, github_state, github_labels_json,
      github_synced_at, created_at, updated_at, last_activity_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(taskId, projectId, repoId, 'I_cas', 1,
    'issue', 'CAS Task', 'Body', 'open', '[]',
    now, now, now, now);

  return { userId, projectId, repoId, taskId };
}

function createTestRun(db: Db, seed: ReturnType<typeof seedTestData>) {
  return createRun(db, {
    taskId: seed.taskId,
    projectId: seed.projectId,
    repoId: seed.repoId,
    baseBranch: 'main',
  });
}

/** Move a run to awaiting_review/reviewer_review_code via valid transitions. */
function advanceToReviewing(db: Db, runId: string): void {
  transitionPhase(db, {
    runId,
    toPhase: 'planning',
    toStep: 'planner_create_plan',
    triggeredBy: 'system',
  });
  transitionPhase(db, {
    runId,
    toPhase: 'awaiting_plan_approval',
    toStep: 'wait_plan_approval',
    triggeredBy: 'system',
  });
  transitionPhase(db, {
    runId,
    toPhase: 'executing',
    toStep: 'implementer_apply_changes',
    triggeredBy: 'system',
  });
  transitionPhase(db, {
    runId,
    toPhase: 'awaiting_review',
    toStep: 'reviewer_review_code',
    triggeredBy: 'system',
  });
}

beforeEach(() => {
  db = initDatabase({ path: ':memory:' });
});

afterEach(() => {
  closeDatabase(db);
});

describe('casUpdateRunStep', () => {
  it('succeeds when phase and step match', () => {
    const seed = seedTestData(db);
    const run = createTestRun(db, seed);
    advanceToReviewing(db, run.runId);

    const ok = casUpdateRunStep(db, run.runId, 'awaiting_review', 'reviewer_review_code', 'create_pr');

    expect(ok).toBe(true);
    const updated = getRun(db, run.runId);
    expect(updated?.step).toBe('create_pr');
    expect(updated?.phase).toBe('awaiting_review'); // phase unchanged
  });

  it('fails when phase does not match', () => {
    const seed = seedTestData(db);
    const run = createTestRun(db, seed); // phase = pending

    const ok = casUpdateRunStep(db, run.runId, 'awaiting_review', 'reviewer_review_code', 'create_pr');

    expect(ok).toBe(false);
    const unchanged = getRun(db, run.runId);
    expect(unchanged?.phase).toBe('pending');
    expect(unchanged?.step).toBe('setup_worktree');
  });

  it('fails when step does not match', () => {
    const seed = seedTestData(db);
    const run = createTestRun(db, seed);
    advanceToReviewing(db, run.runId);
    // Manually set a different step within the same phase
    db.prepare('UPDATE runs SET step = ? WHERE run_id = ?').run('create_pr', run.runId);

    const ok = casUpdateRunStep(db, run.runId, 'awaiting_review', 'reviewer_review_code', 'create_pr');

    expect(ok).toBe(false);
  });

  it('fails when run has been cancelled (terminal phase)', () => {
    const seed = seedTestData(db);
    const run = createTestRun(db, seed);
    advanceToReviewing(db, run.runId);

    // Cancel the run
    transitionPhase(db, {
      runId: run.runId,
      toPhase: 'cancelled',
      triggeredBy: 'system',
    });

    const ok = casUpdateRunStep(db, run.runId, 'awaiting_review', 'reviewer_review_code', 'create_pr');

    expect(ok).toBe(false);
    const cancelled = getRun(db, run.runId);
    expect(cancelled?.phase).toBe('cancelled');
  });

  it('fails for nonexistent run', () => {
    const ok = casUpdateRunStep(db, 'run_nonexistent', 'awaiting_review', 'reviewer_review_code', 'create_pr');

    expect(ok).toBe(false);
  });

  it('does not modify updated_at on CAS failure', () => {
    const seed = seedTestData(db);
    const run = createTestRun(db, seed); // phase = pending
    const before = getRun(db, run.runId);

    casUpdateRunStep(db, run.runId, 'awaiting_review', 'reviewer_review_code', 'create_pr');

    const after = getRun(db, run.runId);
    expect(after?.updatedAt).toBe(before?.updatedAt);
  });
});
