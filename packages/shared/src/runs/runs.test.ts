/**
 * Runs Service Module Tests
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Database as DatabaseType } from 'better-sqlite3';
import { initDatabase, closeDatabase } from '../db/index.ts';
import {
  generateRunId,
  createRun,
  getRun,
  listRuns,
  getRunCountForTask,
  clearActiveRunIfTerminal,
} from './index.ts';
import { updateTaskActiveRun } from '../tasks/index.ts';

let db: DatabaseType;

interface SeedResult {
  userId: string;
  projectId: string;
  repoId: string;
  taskId: string;
}

function seedTestData(db: DatabaseType, suffix = ''): SeedResult {
  const s = suffix;
  const now = new Date().toISOString();
  const userId = `user_test${s}`;
  const projectId = `proj_test${s}`;
  const repoId = `repo_test${s}`;
  const taskId = `task_test${s}`;

  db.prepare(`
    INSERT OR IGNORE INTO users (user_id, github_id, github_node_id, github_login, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'active', ?, ?)
  `).run(userId, 100 + Number(s || 0), `U_test${s}`, `testuser${s}`, now, now);

  db.prepare(`
    INSERT INTO projects (
      project_id, user_id, name, github_org_id, github_org_node_id, github_org_name,
      github_installation_id, default_profile_id, default_base_branch,
      port_range_start, port_range_end, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(projectId, userId, `Test Project${s}`, 1 + Number(s || 0), `O_test${s}`, `testorg${s}`,
    12345 + Number(s || 0), 'default', 'main', 3100, 3199, now, now);

  db.prepare(`
    INSERT INTO repos (
      repo_id, project_id, github_node_id, github_numeric_id,
      github_owner, github_name, github_full_name, github_default_branch,
      profile_id, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(repoId, projectId, `R_test${s}`, 100 + Number(s || 0),
    'testowner', `testrepo${s}`, `testowner/testrepo${s}`, 'main',
    'default', 'active', now, now);

  db.prepare(`
    INSERT INTO tasks (
      task_id, project_id, repo_id, github_node_id, github_issue_number,
      github_type, github_title, github_body, github_state, github_labels_json,
      github_synced_at, created_at, updated_at, last_activity_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(taskId, projectId, repoId, `I_test${s}`, 42,
    'issue', 'Test Task', 'Body', 'open', '[]',
    now, now, now, now);

  return { userId, projectId, repoId, taskId };
}

beforeEach(() => {
  db = initDatabase({ path: ':memory:' });
});

afterEach(() => {
  closeDatabase(db);
});

describe('generateRunId', () => {
  it('produces ids with run_ prefix', () => {
    const id = generateRunId();
    expect(id).toMatch(/^run_/);
  });

  it('produces unique ids', () => {
    const ids = new Set(Array.from({ length: 100 }, () => generateRunId()));
    expect(ids.size).toBe(100);
  });
});

describe('createRun', () => {
  it('creates a run in pending phase with setup_worktree step', () => {
    const { projectId, repoId, taskId } = seedTestData(db);
    const run = createRun(db, { taskId, projectId, repoId, baseBranch: 'main' });

    expect(run.runId).toMatch(/^run_/);
    expect(run.phase).toBe('pending');
    expect(run.step).toBe('setup_worktree');
    expect(run.branch).toBe('');
    expect(run.runNumber).toBe(1);
    expect(run.policySetId).toMatch(/^ps_/);
    expect(run.lastEventSequence).toBe(0);
    expect(run.nextSequence).toBe(1);
  });

  it('auto-increments run_number per task', () => {
    const { projectId, repoId, taskId } = seedTestData(db);
    const run1 = createRun(db, { taskId, projectId, repoId, baseBranch: 'main' });
    const run2 = createRun(db, { taskId, projectId, repoId, baseBranch: 'main' });

    expect(run1.runNumber).toBe(1);
    expect(run2.runNumber).toBe(2);
  });

  it('reuses existing default policy set', () => {
    const { projectId, repoId, taskId } = seedTestData(db);
    const run1 = createRun(db, { taskId, projectId, repoId, baseBranch: 'main' });
    const run2 = createRun(db, { taskId, projectId, repoId, baseBranch: 'main' });
    expect(run1.policySetId).toBe(run2.policySetId);
  });
});

describe('getRun', () => {
  it('returns run by ID with all fields', () => {
    const { projectId, repoId, taskId } = seedTestData(db);
    const created = createRun(db, { taskId, projectId, repoId, baseBranch: 'main' });
    const fetched = getRun(db, created.runId);

    expect(fetched).not.toBeNull();
    expect(fetched!.runId).toBe(created.runId);
    expect(fetched!.nextSequence).toBe(1);
    expect(fetched!.planRevisions).toBe(0);
    expect(fetched!.baseBranch).toBe('main');
    expect(fetched!.completedAt).toBeUndefined();
    expect(fetched!.parentRunId).toBeUndefined();
  });

  it('returns null for missing run', () => {
    expect(getRun(db, 'run_missing')).toBeNull();
  });
});

describe('listRuns', () => {
  it('lists runs for a project with joined fields', () => {
    const { projectId, repoId, taskId } = seedTestData(db);
    createRun(db, { taskId, projectId, repoId, baseBranch: 'main' });
    createRun(db, { taskId, projectId, repoId, baseBranch: 'main' });

    const runs = listRuns(db, { projectId });
    expect(runs).toHaveLength(2);
    expect(runs[0].taskTitle).toBe('Test Task');
    expect(runs[0].repoFullName).toBe('testowner/testrepo');
  });

  it('filters by userId through projects', () => {
    const seed1 = seedTestData(db, '1');
    const seed2 = seedTestData(db, '2');
    createRun(db, { taskId: seed1.taskId, projectId: seed1.projectId, repoId: seed1.repoId, baseBranch: 'main' });
    createRun(db, { taskId: seed2.taskId, projectId: seed2.projectId, repoId: seed2.repoId, baseBranch: 'main' });

    const runs = listRuns(db, { userId: seed1.userId });
    expect(runs).toHaveLength(1);
    expect(runs[0].projectId).toBe(seed1.projectId);
  });

  it('filters by phase', () => {
    const { projectId, repoId, taskId } = seedTestData(db);
    const run = createRun(db, { taskId, projectId, repoId, baseBranch: 'main' });

    const pending = listRuns(db, { projectId, phase: 'pending' });
    expect(pending).toHaveLength(1);

    const planning = listRuns(db, { projectId, phase: 'planning' });
    expect(planning).toHaveLength(0);

    // Move to completed
    db.prepare('UPDATE runs SET phase = ?, completed_at = ? WHERE run_id = ?')
      .run('completed', new Date().toISOString(), run.runId);

    const completed = listRuns(db, { projectId, phase: 'completed' });
    expect(completed).toHaveLength(1);
  });

  it('derives status correctly', () => {
    const { projectId, repoId, taskId } = seedTestData(db);
    const run = createRun(db, { taskId, projectId, repoId, baseBranch: 'main' });

    let runs = listRuns(db, { projectId });
    expect(runs[0].status).toBe('active');

    db.prepare('UPDATE runs SET phase = ?, completed_at = ? WHERE run_id = ?')
      .run('completed', new Date().toISOString(), run.runId);

    runs = listRuns(db, { projectId });
    expect(runs[0].status).toBe('finished');
  });

  it('supports pagination', () => {
    const { projectId, repoId, taskId } = seedTestData(db);
    for (let i = 0; i < 5; i++) {
      createRun(db, { taskId, projectId, repoId, baseBranch: 'main' });
    }

    const page1 = listRuns(db, { projectId, limit: 2, offset: 0 });
    expect(page1).toHaveLength(2);

    const page2 = listRuns(db, { projectId, limit: 2, offset: 2 });
    expect(page2).toHaveLength(2);

    const page3 = listRuns(db, { projectId, limit: 2, offset: 4 });
    expect(page3).toHaveLength(1);
  });
});

describe('getRunCountForTask', () => {
  it('returns 0 for task with no runs', () => {
    const { taskId } = seedTestData(db);
    expect(getRunCountForTask(db, taskId)).toBe(0);
  });

  it('counts runs correctly', () => {
    const { projectId, repoId, taskId } = seedTestData(db);
    createRun(db, { taskId, projectId, repoId, baseBranch: 'main' });
    createRun(db, { taskId, projectId, repoId, baseBranch: 'main' });
    expect(getRunCountForTask(db, taskId)).toBe(2);
  });
});

describe('clearActiveRunIfTerminal', () => {
  it('clears active_run_id when run is completed', () => {
    const { projectId, repoId, taskId } = seedTestData(db);
    const run = createRun(db, { taskId, projectId, repoId, baseBranch: 'main' });
    updateTaskActiveRun(db, taskId, run.runId);

    db.prepare('UPDATE runs SET phase = ?, completed_at = ? WHERE run_id = ?')
      .run('completed', new Date().toISOString(), run.runId);

    clearActiveRunIfTerminal(db, run.runId);

    const taskRow = db.prepare('SELECT active_run_id FROM tasks WHERE task_id = ?').get(taskId) as { active_run_id: string | null };
    expect(taskRow.active_run_id).toBeNull();
  });

  it('clears active_run_id when run is cancelled', () => {
    const { projectId, repoId, taskId } = seedTestData(db);
    const run = createRun(db, { taskId, projectId, repoId, baseBranch: 'main' });
    updateTaskActiveRun(db, taskId, run.runId);

    db.prepare('UPDATE runs SET phase = ?, completed_at = ? WHERE run_id = ?')
      .run('cancelled', new Date().toISOString(), run.runId);

    clearActiveRunIfTerminal(db, run.runId);

    const taskRow = db.prepare('SELECT active_run_id FROM tasks WHERE task_id = ?').get(taskId) as { active_run_id: string | null };
    expect(taskRow.active_run_id).toBeNull();
  });

  it('does nothing for non-terminal phases', () => {
    const { projectId, repoId, taskId } = seedTestData(db);
    const run = createRun(db, { taskId, projectId, repoId, baseBranch: 'main' });
    updateTaskActiveRun(db, taskId, run.runId);

    clearActiveRunIfTerminal(db, run.runId);

    const taskRow = db.prepare('SELECT active_run_id FROM tasks WHERE task_id = ?').get(taskId) as { active_run_id: string | null };
    expect(taskRow.active_run_id).toBe(run.runId);
  });

  it('only clears if active_run_id matches', () => {
    const { projectId, repoId, taskId } = seedTestData(db);
    const run = createRun(db, { taskId, projectId, repoId, baseBranch: 'main' });
    updateTaskActiveRun(db, taskId, 'run_other');

    db.prepare('UPDATE runs SET phase = ?, completed_at = ? WHERE run_id = ?')
      .run('completed', new Date().toISOString(), run.runId);

    clearActiveRunIfTerminal(db, run.runId);

    const taskRow = db.prepare('SELECT active_run_id FROM tasks WHERE task_id = ?').get(taskId) as { active_run_id: string | null };
    expect(taskRow.active_run_id).toBe('run_other');
  });

  it('handles missing run gracefully', () => {
    expect(() => clearActiveRunIfTerminal(db, 'run_nonexistent')).not.toThrow();
  });
});
