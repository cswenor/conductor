/**
 * Tasks Service Module
 *
 * Manages the tasks table (GitHub issues that can spawn runs).
 */

import type { Database } from 'better-sqlite3';
import { createLogger } from '../logger/index';

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
