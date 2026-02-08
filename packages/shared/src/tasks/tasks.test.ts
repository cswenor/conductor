/**
 * Tasks Service Module Tests
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Database as DatabaseType } from 'better-sqlite3';
import { initDatabase, closeDatabase } from '../db/index.ts';
import {
  generateTaskId,
  createTask,
  getTask,
  getTaskByGithubNodeId,
  listTasks,
  upsertTaskFromIssue,
  updateTaskActiveRun,
} from './index.ts';

let db: DatabaseType;

function seedProject(db: DatabaseType): { projectId: string; repoId: string } {
  const now = new Date().toISOString();
  const projectId = 'proj_test';
  const repoId = 'repo_test';

  db.prepare(`
    INSERT INTO users (user_id, github_id, github_node_id, github_login, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'active', ?, ?)
  `).run('user_test', 100, 'U_test', 'testuser', now, now);

  db.prepare(`
    INSERT INTO projects (
      project_id, user_id, name, github_org_id, github_org_node_id, github_org_name,
      github_installation_id, default_profile_id, default_base_branch,
      port_range_start, port_range_end, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(projectId, 'user_test', 'Test Project', 1, 'O_test', 'testorg',
    12345, 'default', 'main', 3100, 3199, now, now);

  db.prepare(`
    INSERT INTO repos (
      repo_id, project_id, github_node_id, github_numeric_id,
      github_owner, github_name, github_full_name, github_default_branch,
      profile_id, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(repoId, projectId, 'R_test', 100, 'testowner', 'testrepo',
    'testowner/testrepo', 'main', 'default', 'active', now, now);

  return { projectId, repoId };
}

beforeEach(() => {
  db = initDatabase({ path: ':memory:' });
});

afterEach(() => {
  closeDatabase(db);
});

describe('generateTaskId', () => {
  it('produces ids with task_ prefix', () => {
    const id = generateTaskId();
    expect(id).toMatch(/^task_/);
  });

  it('produces unique ids', () => {
    const ids = new Set(Array.from({ length: 100 }, () => generateTaskId()));
    expect(ids.size).toBe(100);
  });
});

describe('createTask', () => {
  it('creates a task record with defaults', () => {
    const { projectId, repoId } = seedProject(db);
    const task = createTask(db, {
      projectId,
      repoId,
      githubNodeId: 'I_123',
      githubIssueNumber: 42,
      githubType: 'issue',
      githubTitle: 'Fix bug',
      githubBody: 'Something is broken',
      githubState: 'open',
    });

    expect(task.taskId).toMatch(/^task_/);
    expect(task.projectId).toBe(projectId);
    expect(task.repoId).toBe(repoId);
    expect(task.githubTitle).toBe('Fix bug');
    expect(task.githubLabelsJson).toBe('[]');
    expect(task.activeRunId).toBeUndefined();
  });

  it('enforces unique github_node_id', () => {
    const { projectId, repoId } = seedProject(db);
    createTask(db, {
      projectId, repoId, githubNodeId: 'I_dup', githubIssueNumber: 1,
      githubType: 'issue', githubTitle: 'A', githubBody: '', githubState: 'open',
    });

    expect(() =>
      createTask(db, {
        projectId, repoId, githubNodeId: 'I_dup', githubIssueNumber: 2,
        githubType: 'issue', githubTitle: 'B', githubBody: '', githubState: 'open',
      })
    ).toThrow();
  });
});

describe('getTask', () => {
  it('returns task by ID', () => {
    const { projectId, repoId } = seedProject(db);
    const created = createTask(db, {
      projectId, repoId, githubNodeId: 'I_1', githubIssueNumber: 1,
      githubType: 'issue', githubTitle: 'Test', githubBody: '', githubState: 'open',
    });

    const fetched = getTask(db, created.taskId);
    expect(fetched).not.toBeNull();
    expect(fetched!.taskId).toBe(created.taskId);
    expect(fetched!.githubTitle).toBe('Test');
  });

  it('returns null for missing task', () => {
    expect(getTask(db, 'task_nonexistent')).toBeNull();
  });
});

describe('getTaskByGithubNodeId', () => {
  it('returns task by GitHub node ID', () => {
    const { projectId, repoId } = seedProject(db);
    createTask(db, {
      projectId, repoId, githubNodeId: 'I_findme', githubIssueNumber: 1,
      githubType: 'issue', githubTitle: 'Find Me', githubBody: '', githubState: 'open',
    });

    const found = getTaskByGithubNodeId(db, 'I_findme');
    expect(found).not.toBeNull();
    expect(found!.githubTitle).toBe('Find Me');
  });

  it('returns null for unknown node ID', () => {
    expect(getTaskByGithubNodeId(db, 'I_missing')).toBeNull();
  });
});

describe('listTasks', () => {
  it('lists tasks for a project', () => {
    const { projectId, repoId } = seedProject(db);
    createTask(db, {
      projectId, repoId, githubNodeId: 'I_a', githubIssueNumber: 1,
      githubType: 'issue', githubTitle: 'A', githubBody: '', githubState: 'open',
    });
    createTask(db, {
      projectId, repoId, githubNodeId: 'I_b', githubIssueNumber: 2,
      githubType: 'issue', githubTitle: 'B', githubBody: '', githubState: 'open',
    });

    const tasks = listTasks(db, projectId);
    expect(tasks).toHaveLength(2);
  });

  it('filters by repoId', () => {
    const { projectId, repoId } = seedProject(db);
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO repos (
        repo_id, project_id, github_node_id, github_numeric_id,
        github_owner, github_name, github_full_name, github_default_branch,
        profile_id, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run('repo_other', projectId, 'R_other', 200, 'owner2', 'repo2',
      'owner2/repo2', 'main', 'default', 'active', now, now);

    createTask(db, {
      projectId, repoId, githubNodeId: 'I_r1', githubIssueNumber: 1,
      githubType: 'issue', githubTitle: 'In repo 1', githubBody: '', githubState: 'open',
    });
    createTask(db, {
      projectId, repoId: 'repo_other', githubNodeId: 'I_r2', githubIssueNumber: 2,
      githubType: 'issue', githubTitle: 'In repo 2', githubBody: '', githubState: 'open',
    });

    const tasks = listTasks(db, projectId, { repoId });
    expect(tasks).toHaveLength(1);
    expect(tasks[0].githubTitle).toBe('In repo 1');
  });

  it('supports pagination', () => {
    const { projectId, repoId } = seedProject(db);
    for (let i = 0; i < 5; i++) {
      createTask(db, {
        projectId, repoId, githubNodeId: `I_page_${i}`, githubIssueNumber: i + 1,
        githubType: 'issue', githubTitle: `Task ${i}`, githubBody: '', githubState: 'open',
      });
    }

    const page1 = listTasks(db, projectId, { limit: 2, offset: 0 });
    expect(page1).toHaveLength(2);

    const page2 = listTasks(db, projectId, { limit: 2, offset: 2 });
    expect(page2).toHaveLength(2);

    const page3 = listTasks(db, projectId, { limit: 2, offset: 4 });
    expect(page3).toHaveLength(1);
  });
});

describe('upsertTaskFromIssue', () => {
  it('creates a new task when none exists', () => {
    const { projectId, repoId } = seedProject(db);
    const task = upsertTaskFromIssue(db, {
      projectId, repoId, githubNodeId: 'I_new', githubIssueNumber: 1,
      githubType: 'issue', githubTitle: 'New', githubBody: 'body', githubState: 'open',
    });

    expect(task.taskId).toMatch(/^task_/);
    expect(task.githubTitle).toBe('New');
  });

  it('updates existing task on repeat', () => {
    const { projectId, repoId } = seedProject(db);
    const first = upsertTaskFromIssue(db, {
      projectId, repoId, githubNodeId: 'I_upsert', githubIssueNumber: 1,
      githubType: 'issue', githubTitle: 'Original', githubBody: 'body1', githubState: 'open',
    });

    const second = upsertTaskFromIssue(db, {
      projectId, repoId, githubNodeId: 'I_upsert', githubIssueNumber: 1,
      githubType: 'issue', githubTitle: 'Updated', githubBody: 'body2', githubState: 'closed',
    });

    expect(second.taskId).toBe(first.taskId);
    expect(second.githubTitle).toBe('Updated');
    expect(second.githubBody).toBe('body2');
    expect(second.githubState).toBe('closed');
  });

  it('preserves activeRunId on upsert', () => {
    const { projectId, repoId } = seedProject(db);
    const task = upsertTaskFromIssue(db, {
      projectId, repoId, githubNodeId: 'I_keep', githubIssueNumber: 1,
      githubType: 'issue', githubTitle: 'Keep', githubBody: '', githubState: 'open',
    });

    updateTaskActiveRun(db, task.taskId, 'run_abc');

    const updated = upsertTaskFromIssue(db, {
      projectId, repoId, githubNodeId: 'I_keep', githubIssueNumber: 1,
      githubType: 'issue', githubTitle: 'Kept', githubBody: '', githubState: 'open',
    });

    // The returned object is built from the spread of existing + new fields;
    // activeRunId comes from the existing record
    expect(updated.activeRunId).toBe('run_abc');
  });
});

describe('updateTaskActiveRun', () => {
  it('sets active run ID', () => {
    const { projectId, repoId } = seedProject(db);
    const task = createTask(db, {
      projectId, repoId, githubNodeId: 'I_active', githubIssueNumber: 1,
      githubType: 'issue', githubTitle: 'Active', githubBody: '', githubState: 'open',
    });

    updateTaskActiveRun(db, task.taskId, 'run_123');
    const updated = getTask(db, task.taskId);
    expect(updated!.activeRunId).toBe('run_123');
  });

  it('clears active run ID', () => {
    const { projectId, repoId } = seedProject(db);
    const task = createTask(db, {
      projectId, repoId, githubNodeId: 'I_clear', githubIssueNumber: 1,
      githubType: 'issue', githubTitle: 'Clear', githubBody: '', githubState: 'open',
    });

    updateTaskActiveRun(db, task.taskId, 'run_123');
    updateTaskActiveRun(db, task.taskId, null);
    const updated = getTask(db, task.taskId);
    expect(updated!.activeRunId).toBeUndefined();
  });

  it('updates last_activity_at', () => {
    const { projectId, repoId } = seedProject(db);
    const task = createTask(db, {
      projectId, repoId, githubNodeId: 'I_ts', githubIssueNumber: 1,
      githubType: 'issue', githubTitle: 'Timestamp', githubBody: '', githubState: 'open',
    });

    const beforeUpdate = new Date(task.lastActivityAt).getTime();
    updateTaskActiveRun(db, task.taskId, 'run_ts');
    const updated = getTask(db, task.taskId);
    const afterUpdate = new Date(updated!.lastActivityAt).getTime();
    expect(afterUpdate).toBeGreaterThanOrEqual(beforeUpdate);
  });
});
