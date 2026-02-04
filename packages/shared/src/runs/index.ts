/**
 * Runs Service Module
 *
 * Core run CRUD. Does NOT handle phase transitions (that's the orchestrator).
 */

import type { Database } from 'better-sqlite3';
import { createLogger } from '../logger/index';
import type { RunPhase, RunStep, RunStatus } from '../types/index';
import { deriveRunStatus } from '../types/index';
import { ensureDefaultPolicySet } from '../policy-sets/index';

const log = createLogger({ name: 'conductor:runs' });

// =============================================================================
// Types
// =============================================================================

export interface Run {
  runId: string;
  taskId: string;
  projectId: string;
  repoId: string;
  runNumber: number;
  parentRunId?: string;
  supersedesRunId?: string;
  phase: RunPhase;
  step: RunStep;
  policySetId: string;
  lastEventSequence: number;
  nextSequence: number;
  pausedAt?: string;
  pausedBy?: string;
  blockedReason?: string;
  blockedContextJson?: string;
  baseBranch: string;
  branch: string;
  headSha?: string;
  prNumber?: number;
  prNodeId?: string;
  prUrl?: string;
  prState?: string;
  prSyncedAt?: string;
  planRevisions: number;
  testFixAttempts: number;
  reviewRounds: number;
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  result?: string;
  resultReason?: string;
}

export interface RunSummary {
  runId: string;
  taskId: string;
  projectId: string;
  repoId: string;
  runNumber: number;
  phase: RunPhase;
  step: RunStep;
  status: RunStatus;
  taskTitle: string;
  repoFullName: string;
  branch: string;
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  result?: string;
}

export interface CreateRunInput {
  taskId: string;
  projectId: string;
  repoId: string;
  baseBranch: string;
  parentRunId?: string;
  supersedesRunId?: string;
}

export interface ListRunsOptions {
  projectId?: string;
  userId?: string;
  phase?: RunPhase;
  limit?: number;
  offset?: number;
}

// =============================================================================
// ID Generation
// =============================================================================

export function generateRunId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 8);
  return `run_${timestamp}${random}`;
}

// =============================================================================
// CRUD Operations
// =============================================================================

/**
 * Create a new run in 'pending' phase.
 * Ensures a default policy set exists and computes run_number.
 */
export function createRun(db: Database, input: CreateRunInput): Run {
  const runId = generateRunId();
  const now = new Date().toISOString();

  const policySet = ensureDefaultPolicySet(db, input.projectId);
  const runNumber = getRunCountForTask(db, input.taskId) + 1;

  db.prepare(`
    INSERT INTO runs (
      run_id, task_id, project_id, repo_id, run_number,
      parent_run_id, supersedes_run_id,
      phase, step, policy_set_id,
      last_event_sequence, next_sequence,
      base_branch, branch,
      started_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    runId, input.taskId, input.projectId, input.repoId, runNumber,
    input.parentRunId ?? null, input.supersedesRunId ?? null,
    'pending', 'setup_worktree', policySet.policySetId,
    0, 1,
    input.baseBranch, '',
    now, now
  );

  log.info({ runId, taskId: input.taskId, runNumber }, 'Run created');

  return {
    runId,
    taskId: input.taskId,
    projectId: input.projectId,
    repoId: input.repoId,
    runNumber,
    parentRunId: input.parentRunId,
    supersedesRunId: input.supersedesRunId,
    phase: 'pending',
    step: 'setup_worktree',
    policySetId: policySet.policySetId,
    lastEventSequence: 0,
    nextSequence: 1,
    baseBranch: input.baseBranch,
    branch: '',
    planRevisions: 0,
    testFixAttempts: 0,
    reviewRounds: 0,
    startedAt: now,
    updatedAt: now,
  };
}

/**
 * Get a run by ID.
 */
export function getRun(db: Database, runId: string): Run | null {
  const stmt = db.prepare('SELECT * FROM runs WHERE run_id = ?');
  const row = stmt.get(runId) as Record<string, unknown> | undefined;
  if (row === undefined) return null;
  return rowToRun(row);
}

/**
 * List runs with JOINs for task title and repo name.
 * Supports filtering by projectId, userId (via projects), and phase.
 */
export function listRuns(db: Database, options?: ListRunsOptions): RunSummary[] {
  const limit = options?.limit ?? 50;
  const offset = options?.offset ?? 0;

  const conditions: string[] = [];
  const params: (string | number)[] = [];

  if (options?.projectId !== undefined) {
    conditions.push('r.project_id = ?');
    params.push(options.projectId);
  }

  if (options?.userId !== undefined) {
    conditions.push('p.user_id = ?');
    params.push(options.userId);
  }

  if (options?.phase !== undefined) {
    conditions.push('r.phase = ?');
    params.push(options.phase);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const sql = `
    SELECT
      r.run_id, r.task_id, r.project_id, r.repo_id, r.run_number,
      r.phase, r.step, r.paused_at, r.branch,
      r.started_at, r.updated_at, r.completed_at, r.result,
      t.github_title AS task_title,
      repos.github_full_name AS repo_full_name
    FROM runs r
    JOIN projects p ON r.project_id = p.project_id
    JOIN tasks t ON r.task_id = t.task_id
    JOIN repos ON r.repo_id = repos.repo_id
    ${whereClause}
    ORDER BY r.updated_at DESC
    LIMIT ? OFFSET ?
  `;
  params.push(limit, offset);

  const rows = db.prepare(sql).all(...params) as Array<Record<string, unknown>>;

  return rows.map((row) => ({
    runId: row['run_id'] as string,
    taskId: row['task_id'] as string,
    projectId: row['project_id'] as string,
    repoId: row['repo_id'] as string,
    runNumber: row['run_number'] as number,
    phase: row['phase'] as RunPhase,
    step: row['step'] as RunStep,
    status: deriveRunStatus(
      row['phase'] as RunPhase,
      (row['paused_at'] as string | null) ?? undefined
    ),
    taskTitle: row['task_title'] as string,
    repoFullName: row['repo_full_name'] as string,
    branch: row['branch'] as string,
    startedAt: row['started_at'] as string,
    updatedAt: row['updated_at'] as string,
    completedAt: (row['completed_at'] as string | null) ?? undefined,
    result: (row['result'] as string | null) ?? undefined,
  }));
}

/**
 * Get the count of runs for a task (for computing run_number).
 */
export function getRunCountForTask(db: Database, taskId: string): number {
  const stmt = db.prepare('SELECT COUNT(*) AS count FROM runs WHERE task_id = ?');
  const result = stmt.get(taskId) as { count: number };
  return result.count;
}

/**
 * When a run reaches completed/cancelled, atomically clear tasks.active_run_id.
 * Only clears if active_run_id matches the given runId.
 */
export function clearActiveRunIfTerminal(db: Database, runId: string): void {
  const run = getRun(db, runId);
  if (run === null) return;

  if (run.phase !== 'completed' && run.phase !== 'cancelled') return;

  const result = db.prepare(
    'UPDATE tasks SET active_run_id = NULL, updated_at = ? WHERE task_id = ? AND active_run_id = ?'
  ).run(new Date().toISOString(), run.taskId, runId);

  if (result.changes > 0) {
    log.info({ runId, taskId: run.taskId }, 'Cleared active run for task (terminal phase)');
  }
}

// =============================================================================
// Helpers
// =============================================================================

function rowToRun(row: Record<string, unknown>): Run {
  return {
    runId: row['run_id'] as string,
    taskId: row['task_id'] as string,
    projectId: row['project_id'] as string,
    repoId: row['repo_id'] as string,
    runNumber: row['run_number'] as number,
    parentRunId: (row['parent_run_id'] as string | null) ?? undefined,
    supersedesRunId: (row['supersedes_run_id'] as string | null) ?? undefined,
    phase: row['phase'] as RunPhase,
    step: row['step'] as RunStep,
    policySetId: row['policy_set_id'] as string,
    lastEventSequence: row['last_event_sequence'] as number,
    nextSequence: row['next_sequence'] as number,
    pausedAt: (row['paused_at'] as string | null) ?? undefined,
    pausedBy: (row['paused_by'] as string | null) ?? undefined,
    blockedReason: (row['blocked_reason'] as string | null) ?? undefined,
    blockedContextJson: (row['blocked_context_json'] as string | null) ?? undefined,
    baseBranch: row['base_branch'] as string,
    branch: row['branch'] as string,
    headSha: (row['head_sha'] as string | null) ?? undefined,
    prNumber: (row['pr_number'] as number | null) ?? undefined,
    prNodeId: (row['pr_node_id'] as string | null) ?? undefined,
    prUrl: (row['pr_url'] as string | null) ?? undefined,
    prState: (row['pr_state'] as string | null) ?? undefined,
    prSyncedAt: (row['pr_synced_at'] as string | null) ?? undefined,
    planRevisions: row['plan_revisions'] as number,
    testFixAttempts: row['test_fix_attempts'] as number,
    reviewRounds: row['review_rounds'] as number,
    startedAt: row['started_at'] as string,
    updatedAt: row['updated_at'] as string,
    completedAt: (row['completed_at'] as string | null) ?? undefined,
    result: (row['result'] as string | null) ?? undefined,
    resultReason: (row['result_reason'] as string | null) ?? undefined,
  };
}
