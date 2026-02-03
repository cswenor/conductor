/**
 * Projects Service Module
 *
 * Handles project CRUD operations and GitHub installation management.
 */

import type { Database } from 'better-sqlite3';
import { createLogger } from '../logger/index';

const log = createLogger({ name: 'conductor:projects' });

// =============================================================================
// Types
// =============================================================================

export interface Project {
  projectId: string;
  name: string;
  userId?: string;
  githubOrgId: number;
  githubOrgNodeId: string;
  githubOrgName: string;
  githubInstallationId: number;
  githubProjectsV2Id?: string;
  defaultProfileId: string;
  defaultBaseBranch: string;
  enforceProjects: boolean;
  portRangeStart: number;
  portRangeEnd: number;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectSummary {
  projectId: string;
  name: string;
  userId?: string;
  githubOrgName: string;
  repoCount: number;
  activeRunCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface CreateProjectInput {
  name: string;
  userId?: string;
  githubOrgId: number;
  githubOrgNodeId: string;
  githubOrgName: string;
  githubInstallationId: number;
  githubProjectsV2Id?: string;
  defaultBaseBranch?: string;
  portRangeStart?: number;
  portRangeEnd?: number;
}

export interface UpdateProjectInput {
  name?: string;
  defaultBaseBranch?: string;
  enforceProjects?: boolean;
  portRangeStart?: number;
  portRangeEnd?: number;
}

// =============================================================================
// ID Generation
// =============================================================================

export function generateProjectId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 8);
  return `proj_${timestamp}${random}`;
}

// =============================================================================
// CRUD Operations
// =============================================================================

/**
 * Create a new project
 */
export function createProject(
  db: Database,
  input: CreateProjectInput
): Project {
  const projectId = generateProjectId();
  const now = new Date().toISOString();

  const stmt = db.prepare(`
    INSERT INTO projects (
      project_id,
      name,
      user_id,
      github_org_id,
      github_org_node_id,
      github_org_name,
      github_installation_id,
      github_projects_v2_id,
      default_profile_id,
      default_base_branch,
      enforce_projects,
      port_range_start,
      port_range_end,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  stmt.run(
    projectId,
    input.name,
    input.userId ?? null,
    input.githubOrgId,
    input.githubOrgNodeId,
    input.githubOrgName,
    input.githubInstallationId,
    input.githubProjectsV2Id ?? null,
    'default',
    input.defaultBaseBranch ?? 'main',
    0, // enforce_projects defaults to false
    input.portRangeStart ?? 3000,
    input.portRangeEnd ?? 4000,
    now,
    now
  );

  log.info({ projectId, name: input.name, userId: input.userId }, 'Project created');

  return {
    projectId,
    name: input.name,
    userId: input.userId,
    githubOrgId: input.githubOrgId,
    githubOrgNodeId: input.githubOrgNodeId,
    githubOrgName: input.githubOrgName,
    githubInstallationId: input.githubInstallationId,
    githubProjectsV2Id: input.githubProjectsV2Id,
    defaultProfileId: 'default',
    defaultBaseBranch: input.defaultBaseBranch ?? 'main',
    enforceProjects: false,
    portRangeStart: input.portRangeStart ?? 3000,
    portRangeEnd: input.portRangeEnd ?? 4000,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Get a project by ID
 */
export function getProject(db: Database, projectId: string): Project | null {
  const stmt = db.prepare('SELECT * FROM projects WHERE project_id = ?');
  const row = stmt.get(projectId) as Record<string, unknown> | undefined;

  if (row === undefined) {
    return null;
  }

  return rowToProject(row);
}

/**
 * Get a project by GitHub installation ID
 */
export function getProjectByInstallation(
  db: Database,
  installationId: number
): Project | null {
  const stmt = db.prepare('SELECT * FROM projects WHERE github_installation_id = ?');
  const row = stmt.get(installationId) as Record<string, unknown> | undefined;

  if (row === undefined) {
    return null;
  }

  return rowToProject(row);
}

export interface ListProjectsOptions {
  userId?: string;
}

/**
 * List all projects with summary statistics
 * Optionally filter by user_id for ownership enforcement
 */
export function listProjects(db: Database, options?: ListProjectsOptions): ProjectSummary[] {
  const whereClause = options?.userId !== undefined ? 'WHERE p.user_id = ?' : '';
  const params = options?.userId !== undefined ? [options.userId] : [];

  const stmt = db.prepare(`
    SELECT
      p.project_id,
      p.name,
      p.user_id,
      p.github_org_name,
      p.created_at,
      p.updated_at,
      COUNT(DISTINCT r.repo_id) as repo_count,
      COUNT(DISTINCT CASE WHEN runs.phase NOT IN ('completed', 'cancelled') THEN runs.run_id END) as active_run_count
    FROM projects p
    LEFT JOIN repos r ON r.project_id = p.project_id
    LEFT JOIN runs ON runs.project_id = p.project_id
    ${whereClause}
    GROUP BY p.project_id
    ORDER BY p.updated_at DESC
  `);

  const rows = stmt.all(...params) as Array<Record<string, unknown>>;

  return rows.map((row) => ({
    projectId: row['project_id'] as string,
    name: row['name'] as string,
    userId: row['user_id'] as string | undefined,
    githubOrgName: row['github_org_name'] as string,
    repoCount: (row['repo_count'] as number) ?? 0,
    activeRunCount: (row['active_run_count'] as number) ?? 0,
    createdAt: row['created_at'] as string,
    updatedAt: row['updated_at'] as string,
  }));
}

/**
 * Update a project
 */
export function updateProject(
  db: Database,
  projectId: string,
  input: UpdateProjectInput
): Project | null {
  const updates: string[] = ['updated_at = ?'];
  const values: (string | number | null)[] = [new Date().toISOString()];

  if (input.name !== undefined) {
    updates.push('name = ?');
    values.push(input.name);
  }
  if (input.defaultBaseBranch !== undefined) {
    updates.push('default_base_branch = ?');
    values.push(input.defaultBaseBranch);
  }
  if (input.enforceProjects !== undefined) {
    updates.push('enforce_projects = ?');
    values.push(input.enforceProjects ? 1 : 0);
  }
  if (input.portRangeStart !== undefined) {
    updates.push('port_range_start = ?');
    values.push(input.portRangeStart);
  }
  if (input.portRangeEnd !== undefined) {
    updates.push('port_range_end = ?');
    values.push(input.portRangeEnd);
  }

  values.push(projectId);

  const stmt = db.prepare(
    `UPDATE projects SET ${updates.join(', ')} WHERE project_id = ?`
  );
  const result = stmt.run(...values);

  if (result.changes === 0) {
    return null;
  }

  log.info({ projectId }, 'Project updated');
  return getProject(db, projectId);
}

/**
 * Delete a project
 */
export function deleteProject(db: Database, projectId: string): boolean {
  const stmt = db.prepare('DELETE FROM projects WHERE project_id = ?');
  const result = stmt.run(projectId);

  if (result.changes > 0) {
    log.info({ projectId }, 'Project deleted');
    return true;
  }

  return false;
}

// =============================================================================
// Pending Installation Management
// =============================================================================

export interface PendingInstallation {
  installationId: number;
  setupAction: string;
  state?: string;
  userId?: string;
  createdAt: string;
}

export interface GetPendingInstallationOptions {
  userId?: string;
}

/**
 * Get a pending installation.
 * When userId is provided, only returns the installation if it belongs to that user.
 */
export function getPendingInstallation(
  db: Database,
  installationId: number,
  options?: GetPendingInstallationOptions
): PendingInstallation | null {
  const whereClause = options?.userId !== undefined
    ? 'WHERE installation_id = ? AND user_id = ?'
    : 'WHERE installation_id = ?';
  const params = options?.userId !== undefined
    ? [installationId, options.userId]
    : [installationId];

  const stmt = db.prepare(
    `SELECT * FROM pending_github_installations ${whereClause}`
  );
  const row = stmt.get(...params) as Record<string, unknown> | undefined;

  if (row === undefined) {
    return null;
  }

  return {
    installationId: row['installation_id'] as number,
    setupAction: row['setup_action'] as string,
    state: row['state'] as string | undefined,
    userId: row['user_id'] as string | undefined,
    createdAt: row['created_at'] as string,
  };
}

export interface ListPendingInstallationsOptions {
  userId?: string;
}

/**
 * List pending installations.
 * Optionally filter by user_id for ownership enforcement.
 */
export function listPendingInstallations(
  db: Database,
  options?: ListPendingInstallationsOptions
): PendingInstallation[] {
  const whereClause = options?.userId !== undefined ? 'WHERE user_id = ?' : '';
  const params = options?.userId !== undefined ? [options.userId] : [];

  const stmt = db.prepare(
    `SELECT * FROM pending_github_installations ${whereClause} ORDER BY created_at DESC`
  );
  const rows = stmt.all(...params) as Array<Record<string, unknown>>;

  return rows.map((row) => ({
    installationId: row['installation_id'] as number,
    setupAction: row['setup_action'] as string,
    state: row['state'] as string | undefined,
    userId: row['user_id'] as string | undefined,
    createdAt: row['created_at'] as string,
  }));
}

/**
 * Delete a pending installation (after project is created)
 */
export function deletePendingInstallation(
  db: Database,
  installationId: number
): boolean {
  const stmt = db.prepare(
    'DELETE FROM pending_github_installations WHERE installation_id = ?'
  );
  const result = stmt.run(installationId);
  return result.changes > 0;
}

// =============================================================================
// Helper Functions
// =============================================================================

function rowToProject(row: Record<string, unknown>): Project {
  return {
    projectId: row['project_id'] as string,
    name: row['name'] as string,
    userId: row['user_id'] as string | undefined,
    githubOrgId: row['github_org_id'] as number,
    githubOrgNodeId: row['github_org_node_id'] as string,
    githubOrgName: row['github_org_name'] as string,
    githubInstallationId: row['github_installation_id'] as number,
    githubProjectsV2Id: row['github_projects_v2_id'] as string | undefined,
    defaultProfileId: row['default_profile_id'] as string,
    defaultBaseBranch: row['default_base_branch'] as string,
    enforceProjects: (row['enforce_projects'] as number) === 1,
    portRangeStart: row['port_range_start'] as number,
    portRangeEnd: row['port_range_end'] as number,
    createdAt: row['created_at'] as string,
    updatedAt: row['updated_at'] as string,
  };
}
