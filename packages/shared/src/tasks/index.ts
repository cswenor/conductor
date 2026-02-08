/**
 * Tasks Service Module
 *
 * Manages the tasks table (GitHub issues that can spawn runs).
 */

import type { Database } from 'better-sqlite3';
import { createLogger } from '../logger/index.ts';

const log = createLogger({ name: 'conductor:tasks' });

// =============================================================================
// Types
// =============================================================================

export interface Task {
  taskId: string;
  projectId: string;
  repoId: string;
  githubNodeId: string;
  githubIssueNumber: number;
  githubType: string;
  githubTitle: string;
  githubBody: string;
  githubState: string;
  githubLabelsJson: string;
  githubLastEtag?: string;
  githubSyncedAt: string;
  activeRunId?: string;
  createdAt: string;
  updatedAt: string;
  lastActivityAt: string;
}

export interface CreateTaskInput {
  projectId: string;
  repoId: string;
  githubNodeId: string;
  githubIssueNumber: number;
  githubType: string;
  githubTitle: string;
  githubBody: string;
  githubState: string;
  githubLabelsJson?: string;
}

export interface UpsertTaskFromIssueInput {
  projectId: string;
  repoId: string;
  githubNodeId: string;
  githubIssueNumber: number;
  githubType: string;
  githubTitle: string;
  githubBody: string;
  githubState: string;
  githubLabelsJson?: string;
}

export interface ListTasksOptions {
  repoId?: string;
  limit?: number;
  offset?: number;
}

export interface StartableTask {
  taskId: string;
  projectId: string;
  projectName: string;
  repoId: string;
  repoFullName: string;
  githubIssueNumber: number;
  githubType: string;
  githubTitle: string;
  githubLabelsJson: string;
  githubState: string;
  githubSyncedAt: string;
  lastActivityAt: string;
  createdAt: string;
}

export interface ListStartableTasksOptions {
  projectId?: string;
  repoId?: string;
  search?: string;
  limit?: number;
}

// =============================================================================
// ID Generation
// =============================================================================

export function generateTaskId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 8);
  return `task_${timestamp}${random}`;
}

// =============================================================================
// CRUD Operations
// =============================================================================

/**
 * Create a task record.
 */
export function createTask(db: Database, input: CreateTaskInput): Task {
  const taskId = generateTaskId();
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO tasks (
      task_id, project_id, repo_id, github_node_id, github_issue_number,
      github_type, github_title, github_body, github_state, github_labels_json,
      github_synced_at, created_at, updated_at, last_activity_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    taskId, input.projectId, input.repoId, input.githubNodeId, input.githubIssueNumber,
    input.githubType, input.githubTitle, input.githubBody, input.githubState,
    input.githubLabelsJson ?? '[]', now, now, now, now
  );

  log.info({ taskId, projectId: input.projectId, issueNumber: input.githubIssueNumber }, 'Task created');

  return {
    taskId,
    projectId: input.projectId,
    repoId: input.repoId,
    githubNodeId: input.githubNodeId,
    githubIssueNumber: input.githubIssueNumber,
    githubType: input.githubType,
    githubTitle: input.githubTitle,
    githubBody: input.githubBody,
    githubState: input.githubState,
    githubLabelsJson: input.githubLabelsJson ?? '[]',
    githubSyncedAt: now,
    createdAt: now,
    updatedAt: now,
    lastActivityAt: now,
  };
}

/**
 * Get a task by ID.
 */
export function getTask(db: Database, taskId: string): Task | null {
  const stmt = db.prepare('SELECT * FROM tasks WHERE task_id = ?');
  const row = stmt.get(taskId) as Record<string, unknown> | undefined;
  if (row === undefined) return null;
  return rowToTask(row);
}

/**
 * Get a task by GitHub node ID (UNIQUE column).
 */
export function getTaskByGithubNodeId(db: Database, githubNodeId: string): Task | null {
  const stmt = db.prepare('SELECT * FROM tasks WHERE github_node_id = ?');
  const row = stmt.get(githubNodeId) as Record<string, unknown> | undefined;
  if (row === undefined) return null;
  return rowToTask(row);
}

/**
 * List tasks for a project with optional filters.
 */
export function listTasks(
  db: Database,
  projectId: string,
  options?: ListTasksOptions
): Task[] {
  const limit = options?.limit ?? 100;
  const offset = options?.offset ?? 0;

  let sql = 'SELECT * FROM tasks WHERE project_id = ?';
  const params: (string | number)[] = [projectId];

  if (options?.repoId !== undefined) {
    sql += ' AND repo_id = ?';
    params.push(options.repoId);
  }

  sql += ' ORDER BY last_activity_at DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);

  const stmt = db.prepare(sql);
  const rows = stmt.all(...params) as Array<Record<string, unknown>>;
  return rows.map(rowToTask);
}

/**
 * Idempotent upsert using github_node_id as natural key.
 * Creates a new task if none exists, otherwise updates the existing one.
 */
export function upsertTaskFromIssue(db: Database, input: UpsertTaskFromIssueInput): Task {
  const existing = getTaskByGithubNodeId(db, input.githubNodeId);

  if (existing !== null) {
    const now = new Date().toISOString();
    db.prepare(`
      UPDATE tasks SET
        github_title = ?, github_body = ?, github_state = ?,
        github_labels_json = ?, github_synced_at = ?,
        updated_at = ?, last_activity_at = ?
      WHERE task_id = ?
    `).run(
      input.githubTitle, input.githubBody, input.githubState,
      input.githubLabelsJson ?? '[]', now, now, now,
      existing.taskId
    );

    log.info({ taskId: existing.taskId, githubNodeId: input.githubNodeId }, 'Task updated from issue');

    return {
      ...existing,
      githubTitle: input.githubTitle,
      githubBody: input.githubBody,
      githubState: input.githubState,
      githubLabelsJson: input.githubLabelsJson ?? '[]',
      githubSyncedAt: now,
      updatedAt: now,
      lastActivityAt: now,
    };
  }

  return createTask(db, input);
}

/**
 * Set or clear the active run for a task.
 */
export function updateTaskActiveRun(db: Database, taskId: string, runId: string | null): void {
  const now = new Date().toISOString();
  db.prepare(
    'UPDATE tasks SET active_run_id = ?, updated_at = ?, last_activity_at = ? WHERE task_id = ?'
  ).run(runId, now, now, taskId);

  log.info({ taskId, runId }, runId !== null ? 'Task active run set' : 'Task active run cleared');
}

// =============================================================================
// Cross-Project Queries
// =============================================================================

/**
 * List open issues without active runs across user's projects.
 * Used by the global "Start Work" page.
 */
export function listStartableTasks(
  db: Database,
  userId: string,
  options?: ListStartableTasksOptions
): StartableTask[] {
  const limit = options?.limit ?? 100;
  const conditions: string[] = [
    'p.user_id = ?',
    "t.github_state = 'open'",
    't.active_run_id IS NULL',
    "t.github_type = 'issue'",
  ];
  const params: (string | number)[] = [userId];

  if (options?.projectId !== undefined) {
    conditions.push('t.project_id = ?');
    params.push(options.projectId);
  }

  if (options?.repoId !== undefined) {
    conditions.push('t.repo_id = ?');
    params.push(options.repoId);
  }

  if (options?.search !== undefined && options.search.trim() !== '') {
    conditions.push('t.github_title LIKE ?');
    params.push(`%${options.search.trim()}%`);
  }

  const whereClause = conditions.join(' AND ');
  params.push(limit);

  const sql = `
    SELECT
      t.task_id, t.project_id, t.repo_id,
      t.github_issue_number, t.github_type, t.github_title,
      t.github_labels_json, t.github_state, t.github_synced_at,
      t.last_activity_at, t.created_at,
      p.name AS project_name,
      repos.github_full_name AS repo_full_name
    FROM tasks t
    JOIN projects p ON t.project_id = p.project_id
    JOIN repos ON t.repo_id = repos.repo_id
    WHERE ${whereClause}
    ORDER BY t.last_activity_at DESC
    LIMIT ?
  `;

  const rows = db.prepare(sql).all(...params) as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    taskId: row['task_id'] as string,
    projectId: row['project_id'] as string,
    projectName: row['project_name'] as string,
    repoId: row['repo_id'] as string,
    repoFullName: row['repo_full_name'] as string,
    githubIssueNumber: row['github_issue_number'] as number,
    githubType: row['github_type'] as string,
    githubTitle: row['github_title'] as string,
    githubLabelsJson: row['github_labels_json'] as string,
    githubState: row['github_state'] as string,
    githubSyncedAt: row['github_synced_at'] as string,
    lastActivityAt: row['last_activity_at'] as string,
    createdAt: row['created_at'] as string,
  }));
}

/**
 * Count open issues without active runs across user's projects.
 */
export function countStartableTasks(
  db: Database,
  userId: string,
  options?: ListStartableTasksOptions
): number {
  const conditions: string[] = [
    'p.user_id = ?',
    "t.github_state = 'open'",
    't.active_run_id IS NULL',
    "t.github_type = 'issue'",
  ];
  const params: (string | number)[] = [userId];

  if (options?.projectId !== undefined) {
    conditions.push('t.project_id = ?');
    params.push(options.projectId);
  }

  if (options?.repoId !== undefined) {
    conditions.push('t.repo_id = ?');
    params.push(options.repoId);
  }

  if (options?.search !== undefined && options.search.trim() !== '') {
    conditions.push('t.github_title LIKE ?');
    params.push(`%${options.search.trim()}%`);
  }

  const whereClause = conditions.join(' AND ');

  const row = db.prepare(`
    SELECT COUNT(*) AS count
    FROM tasks t
    JOIN projects p ON t.project_id = p.project_id
    JOIN repos ON t.repo_id = repos.repo_id
    WHERE ${whereClause}
  `).get(...params) as { count: number };

  return row.count;
}

// =============================================================================
// Helpers
// =============================================================================

function rowToTask(row: Record<string, unknown>): Task {
  return {
    taskId: row['task_id'] as string,
    projectId: row['project_id'] as string,
    repoId: row['repo_id'] as string,
    githubNodeId: row['github_node_id'] as string,
    githubIssueNumber: row['github_issue_number'] as number,
    githubType: row['github_type'] as string,
    githubTitle: row['github_title'] as string,
    githubBody: row['github_body'] as string,
    githubState: row['github_state'] as string,
    githubLabelsJson: row['github_labels_json'] as string,
    githubLastEtag: (row['github_last_etag'] as string | null) ?? undefined,
    githubSyncedAt: row['github_synced_at'] as string,
    activeRunId: (row['active_run_id'] as string | null) ?? undefined,
    createdAt: row['created_at'] as string,
    updatedAt: row['updated_at'] as string,
    lastActivityAt: row['last_activity_at'] as string,
  };
}
