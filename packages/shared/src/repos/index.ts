/**
 * Repos Service Module
 *
 * Handles repository CRUD operations.
 */

import type { Database } from 'better-sqlite3';
import { createLogger } from '../logger/index.ts';

const log = createLogger({ name: 'conductor:repos' });

// =============================================================================
// Types
// =============================================================================

export interface Repo {
  repoId: string;
  projectId: string;
  githubNodeId: string;
  githubNumericId: number;
  githubOwner: string;
  githubName: string;
  githubFullName: string;
  githubDefaultBranch: string;
  profileId: string;
  status: 'active' | 'inactive' | 'syncing' | 'error';
  lastIndexedAt?: string;
  clonePath?: string;
  clonedAt?: string;
  lastFetchedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateRepoInput {
  projectId: string;
  githubNodeId: string;
  githubNumericId: number;
  githubOwner: string;
  githubName: string;
  githubFullName: string;
  githubDefaultBranch: string;
  profileId?: string;
}

export interface UpdateRepoInput {
  profileId?: string;
  status?: Repo['status'];
  githubDefaultBranch?: string;
  lastIndexedAt?: string;
}

// =============================================================================
// ID Generation
// =============================================================================

export function generateRepoId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 8);
  return `repo_${timestamp}${random}`;
}

// =============================================================================
// CRUD Operations
// =============================================================================

export class RepoAlreadyExistsError extends Error {
  public readonly existingProjectId: string;
  public readonly existingRepoId: string;

  constructor(existingProjectId: string, existingRepoId: string, githubFullName: string) {
    super(`Repository ${githubFullName} is already linked to another project`);
    this.name = 'RepoAlreadyExistsError';
    this.existingProjectId = existingProjectId;
    this.existingRepoId = existingRepoId;
  }
}

/**
 * Create a new repo
 */
export function createRepo(db: Database, input: CreateRepoInput): Repo {
  const repoId = generateRepoId();
  const now = new Date().toISOString();

  // Check if repo already exists globally (DB has UNIQUE constraint on github_node_id)
  const existingStmt = db.prepare(
    'SELECT repo_id, project_id FROM repos WHERE github_node_id = ?'
  );
  const existing = existingStmt.get(input.githubNodeId) as
    | { repo_id: string; project_id: string }
    | undefined;

  if (existing !== undefined) {
    // If it's in the same project, return the existing repo
    if (existing.project_id === input.projectId) {
      log.info(
        { projectId: input.projectId, githubNodeId: input.githubNodeId },
        'Repo already exists in this project'
      );
      const repo = getRepo(db, existing.repo_id);
      if (repo !== null) {
        return repo;
      }
    }
    // If it's in a different project, throw an error
    log.warn(
      {
        projectId: input.projectId,
        existingProjectId: existing.project_id,
        githubNodeId: input.githubNodeId
      },
      'Repo already exists in another project'
    );
    throw new RepoAlreadyExistsError(
      existing.project_id,
      existing.repo_id,
      input.githubFullName
    );
  }

  const stmt = db.prepare(`
    INSERT INTO repos (
      repo_id,
      project_id,
      github_node_id,
      github_numeric_id,
      github_owner,
      github_name,
      github_full_name,
      github_default_branch,
      profile_id,
      status,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  stmt.run(
    repoId,
    input.projectId,
    input.githubNodeId,
    input.githubNumericId,
    input.githubOwner,
    input.githubName,
    input.githubFullName,
    input.githubDefaultBranch,
    input.profileId ?? 'default',
    'active',
    now,
    now
  );

  log.info({ repoId, projectId: input.projectId, githubFullName: input.githubFullName }, 'Repo created');

  return {
    repoId,
    projectId: input.projectId,
    githubNodeId: input.githubNodeId,
    githubNumericId: input.githubNumericId,
    githubOwner: input.githubOwner,
    githubName: input.githubName,
    githubFullName: input.githubFullName,
    githubDefaultBranch: input.githubDefaultBranch,
    profileId: input.profileId ?? 'default',
    status: 'active',
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Get a repo by ID
 */
export function getRepo(db: Database, repoId: string): Repo | null {
  const stmt = db.prepare('SELECT * FROM repos WHERE repo_id = ?');
  const row = stmt.get(repoId) as Record<string, unknown> | undefined;

  if (row === undefined) {
    return null;
  }

  return rowToRepo(row);
}

/**
 * Get a repo by GitHub node ID
 */
export function getRepoByNodeId(db: Database, githubNodeId: string): Repo | null {
  const stmt = db.prepare('SELECT * FROM repos WHERE github_node_id = ?');
  const row = stmt.get(githubNodeId) as Record<string, unknown> | undefined;

  if (row === undefined) {
    return null;
  }

  return rowToRepo(row);
}

/**
 * List repos for a project
 */
export function listProjectRepos(
  db: Database,
  projectId: string,
  options?: { status?: Repo['status']; limit?: number; offset?: number }
): Repo[] {
  const limit = options?.limit ?? 100;
  const offset = options?.offset ?? 0;

  let sql = 'SELECT * FROM repos WHERE project_id = ?';
  const params: (string | number)[] = [projectId];

  if (options?.status !== undefined) {
    sql += ' AND status = ?';
    params.push(options.status);
  }

  sql += ' ORDER BY github_full_name ASC LIMIT ? OFFSET ?';
  params.push(limit, offset);

  const stmt = db.prepare(sql);
  const rows = stmt.all(...params) as Array<Record<string, unknown>>;

  return rows.map(rowToRepo);
}

/**
 * Update a repo
 */
export function updateRepo(
  db: Database,
  repoId: string,
  input: UpdateRepoInput
): Repo | null {
  const updates: string[] = ['updated_at = ?'];
  const values: (string | number | null)[] = [new Date().toISOString()];

  if (input.profileId !== undefined) {
    updates.push('profile_id = ?');
    values.push(input.profileId);
  }
  if (input.status !== undefined) {
    updates.push('status = ?');
    values.push(input.status);
  }
  if (input.githubDefaultBranch !== undefined) {
    updates.push('github_default_branch = ?');
    values.push(input.githubDefaultBranch);
  }
  if (input.lastIndexedAt !== undefined) {
    updates.push('last_indexed_at = ?');
    values.push(input.lastIndexedAt);
  }

  values.push(repoId);

  const stmt = db.prepare(
    `UPDATE repos SET ${updates.join(', ')} WHERE repo_id = ?`
  );
  const result = stmt.run(...values);

  if (result.changes === 0) {
    return null;
  }

  log.info({ repoId }, 'Repo updated');
  return getRepo(db, repoId);
}

/**
 * Delete a repo
 */
export function deleteRepo(db: Database, repoId: string): boolean {
  const stmt = db.prepare('DELETE FROM repos WHERE repo_id = ?');
  const result = stmt.run(repoId);

  if (result.changes > 0) {
    log.info({ repoId }, 'Repo deleted');
    return true;
  }

  return false;
}

// =============================================================================
// Helper Functions
// =============================================================================

function rowToRepo(row: Record<string, unknown>): Repo {
  return {
    repoId: row['repo_id'] as string,
    projectId: row['project_id'] as string,
    githubNodeId: row['github_node_id'] as string,
    githubNumericId: row['github_numeric_id'] as number,
    githubOwner: row['github_owner'] as string,
    githubName: row['github_name'] as string,
    githubFullName: row['github_full_name'] as string,
    githubDefaultBranch: row['github_default_branch'] as string,
    profileId: row['profile_id'] as string,
    status: row['status'] as Repo['status'],
    lastIndexedAt: row['last_indexed_at'] as string | undefined,
    clonePath: row['clone_path'] as string | undefined,
    clonedAt: row['cloned_at'] as string | undefined,
    lastFetchedAt: row['last_fetched_at'] as string | undefined,
    createdAt: row['created_at'] as string,
    updatedAt: row['updated_at'] as string,
  };
}
