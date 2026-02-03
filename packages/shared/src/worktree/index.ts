/**
 * Worktree Module
 *
 * Manages git worktrees, repo clones, port allocation, and cleanup.
 * Part of WP4: Worktree & Environment Manager.
 */

import type { Database } from 'better-sqlite3';
import { execSync } from 'child_process';
import { existsSync, mkdirSync, rmSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { randomBytes } from 'crypto';
import { createLogger } from '../logger/index';

const log = createLogger({ name: 'conductor:worktree' });

// =============================================================================
// Configuration
// =============================================================================

/**
 * Get the base data directory for Conductor.
 * Configurable via CONDUCTOR_DATA_DIR env var.
 */
export function getDataDir(): string {
  return process.env['CONDUCTOR_DATA_DIR'] ?? join(process.env['HOME'] ?? '/tmp', '.conductor');
}

/**
 * Get the repos directory (bare clones).
 */
export function getReposDir(): string {
  return join(getDataDir(), 'repos');
}

/**
 * Get the worktrees directory.
 */
export function getWorktreesDir(): string {
  return join(getDataDir(), 'worktrees');
}

/**
 * Get port range for allocation.
 */
export function getPortRange(): { min: number; max: number } {
  const range = process.env['CONDUCTOR_PORT_RANGE'] ?? '3100-3199';
  const [min, max] = range.split('-').map(Number);
  return { min: min ?? 3100, max: max ?? 3199 };
}

/**
 * Get stale lease timeout in hours.
 */
export function getLeaseTimeoutHours(): number {
  return parseInt(process.env['CONDUCTOR_LEASE_TIMEOUT_HOURS'] ?? '24', 10);
}

// =============================================================================
// Types
// =============================================================================

export interface CloneResult {
  clonePath: string;
  clonedAt: string;
  wasExisting: boolean;
}

export interface Worktree {
  worktreeId: string;
  runId: string;
  projectId: string;
  repoId: string;
  path: string;
  branchName: string;
  baseCommit: string;
  status: 'active' | 'destroyed';
  lastHeartbeatAt: string;
  createdAt: string;
  destroyedAt: string | null;
}

export interface PortLease {
  portLeaseId: string;
  projectId: string;
  worktreeId: string;
  port: number;
  purpose: 'dev_server' | 'api' | 'db' | 'other';
  isActive: boolean;
  leasedAt: string;
  expiresAt: string;
  releasedAt: string | null;
}

// =============================================================================
// ID Generation
// =============================================================================

function generateWorktreeId(): string {
  const timestamp = Date.now().toString(36);
  const random = randomBytes(4).toString('hex');
  return `wt_${timestamp}${random}`;
}

function generatePortLeaseId(): string {
  const timestamp = Date.now().toString(36);
  const random = randomBytes(4).toString('hex');
  return `pl_${timestamp}${random}`;
}

// =============================================================================
// File Locking (Simple)
// =============================================================================

const activeLocks = new Map<string, boolean>();

function acquireLock(key: string, timeoutMs = 30000): boolean {
  const start = Date.now();
  while (activeLocks.get(key) === true) {
    if (Date.now() - start > timeoutMs) {
      return false;
    }
    // Busy wait (in production, use proper async lock)
    const end = Date.now() + 10;
    while (Date.now() < end) {
      // spin
    }
  }
  activeLocks.set(key, true);
  return true;
}

function releaseLock(key: string): void {
  activeLocks.delete(key);
}

// =============================================================================
// WP4.1: Base Repo Cloning
// =============================================================================

export interface CloneRepoOptions {
  projectId: string;
  repoId: string;
  githubOwner: string;
  githubName: string;
  installationToken: string;
}

/**
 * Clone or fetch a repository. Returns the clone path.
 * Uses bare clone for space efficiency.
 * Idempotent: if clone exists, fetches instead.
 */
export function cloneOrFetchRepo(
  db: Database,
  options: CloneRepoOptions
): CloneResult {
  const { projectId, repoId, githubOwner, githubName, installationToken } = options;
  const lockKey = `clone:${repoId}`;

  // Acquire lock to prevent concurrent clones
  if (!acquireLock(lockKey)) {
    throw new Error(`Timeout waiting for clone lock on repo ${repoId}`);
  }

  try {
    const reposDir = getReposDir();
    const clonePath = join(reposDir, projectId, repoId);
    const now = new Date().toISOString();

    // Check if clone already exists
    if (existsSync(clonePath)) {
      log.info({ repoId, clonePath }, 'Clone exists, fetching updates');

      // Fetch updates
      try {
        const cloneUrl = `https://x-access-token:${installationToken}@github.com/${githubOwner}/${githubName}.git`;
        execSync(`git fetch --prune "${cloneUrl}" "+refs/heads/*:refs/heads/*"`, {
          cwd: clonePath,
          stdio: 'pipe',
          timeout: 120000, // 2 minutes
        });

        // Update last_fetched_at
        const stmt = db.prepare(
          'UPDATE repos SET last_fetched_at = ?, updated_at = ? WHERE repo_id = ?'
        );
        stmt.run(now, now, repoId);

        log.info({ repoId }, 'Repo fetched successfully');
      } catch (err) {
        log.warn(
          { repoId, error: err instanceof Error ? err.message : 'Unknown' },
          'Fetch failed, will continue with existing clone'
        );
      }

      return { clonePath, clonedAt: now, wasExisting: true };
    }

    // Create parent directory
    mkdirSync(dirname(clonePath), { recursive: true });

    // Clone the repository (bare)
    log.info({ repoId, githubOwner, githubName }, 'Cloning repository');

    const cloneUrl = `https://x-access-token:${installationToken}@github.com/${githubOwner}/${githubName}.git`;

    try {
      execSync(`git clone --bare "${cloneUrl}" "${clonePath}"`, {
        stdio: 'pipe',
        timeout: 300000, // 5 minutes
      });
    } catch (err) {
      // Clean up partial clone
      if (existsSync(clonePath)) {
        rmSync(clonePath, { recursive: true, force: true });
      }
      throw new Error(
        `Failed to clone repository: ${err instanceof Error ? err.message : 'Unknown error'}`
      );
    }

    // Update database with clone info
    const stmt = db.prepare(
      'UPDATE repos SET clone_path = ?, cloned_at = ?, last_fetched_at = ?, updated_at = ? WHERE repo_id = ?'
    );
    stmt.run(clonePath, now, now, now, repoId);

    log.info({ repoId, clonePath }, 'Repository cloned successfully');

    return { clonePath, clonedAt: now, wasExisting: false };
  } finally {
    releaseLock(lockKey);
  }
}

/**
 * Get the clone path for a repo, or null if not cloned.
 */
export function getRepoClonePath(db: Database, repoId: string): string | null {
  const stmt = db.prepare('SELECT clone_path FROM repos WHERE repo_id = ?');
  const row = stmt.get(repoId) as { clone_path: string | null } | undefined;
  return row?.clone_path ?? null;
}

// =============================================================================
// WP4.2: Worktree Creation
// =============================================================================

export interface CreateWorktreeOptions {
  runId: string;
  projectId: string;
  repoId: string;
  baseBranch: string;
}

/**
 * Create a worktree for a run.
 * Idempotent: returns existing worktree if already created for this run.
 */
export function createWorktree(
  db: Database,
  options: CreateWorktreeOptions
): Worktree {
  const { runId, projectId, repoId, baseBranch } = options;
  const lockKey = `worktree:${runId}`;

  // Check if worktree already exists for this run
  const existingStmt = db.prepare(
    'SELECT * FROM worktrees WHERE run_id = ? AND destroyed_at IS NULL'
  );
  const existing = existingStmt.get(runId) as Record<string, unknown> | undefined;
  if (existing !== undefined) {
    log.info({ runId }, 'Worktree already exists for run');
    return rowToWorktree(existing);
  }

  // Acquire lock
  if (!acquireLock(lockKey)) {
    throw new Error(`Timeout waiting for worktree lock on run ${runId}`);
  }

  try {
    // Double-check after acquiring lock
    const checkAgain = existingStmt.get(runId) as Record<string, unknown> | undefined;
    if (checkAgain !== undefined) {
      return rowToWorktree(checkAgain);
    }

    // Get clone path
    const clonePath = getRepoClonePath(db, repoId);
    if (clonePath === null || !existsSync(clonePath)) {
      throw new Error(`Repo ${repoId} is not cloned. Clone first.`);
    }

    const worktreeId = generateWorktreeId();
    const worktreePath = join(getWorktreesDir(), runId);
    const branchName = `conductor/run-${runId}`;
    const now = new Date().toISOString();

    // Create worktree directory parent
    mkdirSync(dirname(worktreePath), { recursive: true });

    // Get base commit SHA
    let baseCommit: string;
    try {
      baseCommit = execSync(`git rev-parse refs/heads/${baseBranch}`, {
        cwd: clonePath,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
    } catch {
      // Try without refs/heads prefix
      try {
        baseCommit = execSync(`git rev-parse ${baseBranch}`, {
          cwd: clonePath,
          encoding: 'utf8',
          stdio: ['pipe', 'pipe', 'pipe'],
        }).trim();
      } catch {
        throw new Error(`Base branch '${baseBranch}' not found in repo`);
      }
    }

    // Create worktree with new branch
    try {
      execSync(
        `git worktree add -b "${branchName}" "${worktreePath}" "${baseCommit}"`,
        {
          cwd: clonePath,
          stdio: 'pipe',
          timeout: 60000,
        }
      );
    } catch (err) {
      // Clean up on failure
      if (existsSync(worktreePath)) {
        rmSync(worktreePath, { recursive: true, force: true });
      }
      throw new Error(
        `Failed to create worktree: ${err instanceof Error ? err.message : 'Unknown'}`
      );
    }

    // Insert into database
    const insertStmt = db.prepare(`
      INSERT INTO worktrees (
        worktree_id, run_id, project_id, repo_id, path, status, last_heartbeat_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insertStmt.run(worktreeId, runId, projectId, repoId, worktreePath, 'active', now, now);

    log.info({ worktreeId, runId, path: worktreePath }, 'Worktree created');

    return {
      worktreeId,
      runId,
      projectId,
      repoId,
      path: worktreePath,
      branchName,
      baseCommit,
      status: 'active',
      lastHeartbeatAt: now,
      createdAt: now,
      destroyedAt: null,
    };
  } finally {
    releaseLock(lockKey);
  }
}

/**
 * Get worktree for a run.
 */
export function getWorktreeForRun(db: Database, runId: string): Worktree | null {
  const stmt = db.prepare(
    'SELECT * FROM worktrees WHERE run_id = ? AND destroyed_at IS NULL'
  );
  const row = stmt.get(runId) as Record<string, unknown> | undefined;
  if (row === undefined) {
    return null;
  }
  return rowToWorktree(row);
}

// =============================================================================
// WP4.3: Branch Creation (integrated into createWorktree)
// =============================================================================

/**
 * Resolve the base branch for a repo.
 * Priority: repo config → GitHub default → main → master
 */
export function resolveBaseBranch(
  db: Database,
  repoId: string,
  configuredDefault?: string
): string {
  // 1. Use explicitly configured default if provided
  if (configuredDefault !== undefined && configuredDefault !== '') {
    return configuredDefault;
  }

  // 2. Use GitHub default branch from repo record
  const stmt = db.prepare('SELECT github_default_branch FROM repos WHERE repo_id = ?');
  const row = stmt.get(repoId) as { github_default_branch: string } | undefined;

  if (row !== undefined && row.github_default_branch !== '') {
    return row.github_default_branch;
  }

  // 3. Fallback to main
  return 'main';
}

/**
 * Generate branch name for a run.
 */
export function generateBranchName(runId: string): string {
  return `conductor/run-${runId}`;
}

// =============================================================================
// WP4.4: Port Allocation
// =============================================================================

/**
 * Allocate a port for a worktree.
 */
export function allocatePort(
  db: Database,
  projectId: string,
  worktreeId: string,
  purpose: PortLease['purpose'] = 'dev_server'
): PortLease {
  const { min, max } = getPortRange();
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + getLeaseTimeoutHours() * 60 * 60 * 1000).toISOString();

  // Find first available port
  for (let port = min; port <= max; port++) {
    const portLeaseId = generatePortLeaseId();

    try {
      const stmt = db.prepare(`
        INSERT INTO port_leases (
          port_lease_id, project_id, worktree_id, port, purpose, is_active, leased_at, expires_at
        ) VALUES (?, ?, ?, ?, ?, 1, ?, ?)
      `);
      stmt.run(portLeaseId, projectId, worktreeId, port, purpose, now, expiresAt);

      log.info({ portLeaseId, projectId, worktreeId, port }, 'Port allocated');

      return {
        portLeaseId,
        projectId,
        worktreeId,
        port,
        purpose,
        isActive: true,
        leasedAt: now,
        expiresAt,
        releasedAt: null,
      };
    } catch {
      // Port already taken, try next
      continue;
    }
  }

  throw new Error(`No ports available in range ${min}-${max} for project ${projectId}`);
}

/**
 * Release a port lease.
 */
export function releasePort(db: Database, portLeaseId: string): boolean {
  const now = new Date().toISOString();
  const stmt = db.prepare(
    'UPDATE port_leases SET is_active = 0, released_at = ? WHERE port_lease_id = ? AND is_active = 1'
  );
  const result = stmt.run(now, portLeaseId);

  if (result.changes > 0) {
    log.info({ portLeaseId }, 'Port released');
    return true;
  }
  return false;
}

/**
 * Release all ports for a worktree.
 */
export function releaseWorktreePorts(db: Database, worktreeId: string): number {
  const now = new Date().toISOString();
  const stmt = db.prepare(
    'UPDATE port_leases SET is_active = 0, released_at = ? WHERE worktree_id = ? AND is_active = 1'
  );
  const result = stmt.run(now, worktreeId);
  if (result.changes > 0) {
    log.info({ worktreeId, count: result.changes }, 'Worktree ports released');
  }
  return result.changes;
}

/**
 * Get active port leases for a worktree.
 */
export function getWorktreePorts(db: Database, worktreeId: string): PortLease[] {
  const stmt = db.prepare(
    'SELECT * FROM port_leases WHERE worktree_id = ? AND is_active = 1'
  );
  const rows = stmt.all(worktreeId) as Array<Record<string, unknown>>;
  return rows.map(rowToPortLease);
}

// =============================================================================
// WP4.5: Worktree Cleanup
// =============================================================================

/**
 * Cleanup a worktree: kill processes, remove files, release ports.
 */
export function cleanupWorktree(db: Database, runId: string): boolean {
  const worktree = getWorktreeForRun(db, runId);
  if (worktree === null) {
    log.info({ runId }, 'No active worktree to cleanup');
    return false;
  }

  const { worktreeId, path: worktreePath, repoId } = worktree;

  log.info({ worktreeId, runId, path: worktreePath }, 'Cleaning up worktree');

  // 1. Kill processes using the worktree (best effort)
  try {
    killProcessesInDir(worktreePath);
  } catch (err) {
    log.warn(
      { worktreeId, error: err instanceof Error ? err.message : 'Unknown' },
      'Failed to kill processes in worktree'
    );
  }

  // 2. Release port leases
  releaseWorktreePorts(db, worktreeId);

  // 3. Remove worktree via git
  const clonePath = getRepoClonePath(db, repoId);
  if (clonePath !== null && existsSync(clonePath)) {
    try {
      execSync(`git worktree remove --force "${worktreePath}"`, {
        cwd: clonePath,
        stdio: 'pipe',
        timeout: 30000,
      });
    } catch {
      // If git worktree remove fails, try direct deletion
      log.warn({ worktreeId }, 'git worktree remove failed, removing directory directly');
    }
  }

  // 4. Remove directory if still exists
  if (existsSync(worktreePath)) {
    try {
      rmSync(worktreePath, { recursive: true, force: true });
    } catch (err) {
      log.warn(
        { worktreeId, error: err instanceof Error ? err.message : 'Unknown' },
        'Failed to remove worktree directory'
      );
    }
  }

  // 5. Update database
  const now = new Date().toISOString();
  const stmt = db.prepare(
    'UPDATE worktrees SET status = ?, destroyed_at = ? WHERE worktree_id = ?'
  );
  stmt.run('destroyed', now, worktreeId);

  log.info({ worktreeId, runId }, 'Worktree cleanup complete');
  return true;
}

/**
 * Kill processes using a directory (best effort).
 */
function killProcessesInDir(dirPath: string): void {
  if (process.platform === 'win32') {
    // Windows: skip process killing
    return;
  }

  try {
    // Find processes using the directory
    const output = execSync(`lsof +D "${dirPath}" 2>/dev/null | awk 'NR>1 {print $2}' | sort -u`, {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const pids = output.trim().split('\n').filter(Boolean);

    for (const pid of pids) {
      try {
        // Send SIGTERM
        process.kill(parseInt(pid, 10), 'SIGTERM');
      } catch {
        // Process may have already exited
      }
    }

    // Wait briefly for processes to exit
    if (pids.length > 0) {
      execSync('sleep 2', { stdio: 'pipe' });

      // Force kill any remaining
      for (const pid of pids) {
        try {
          process.kill(parseInt(pid, 10), 'SIGKILL');
        } catch {
          // Ignore
        }
      }
    }
  } catch {
    // lsof may not find any processes, which is fine
  }
}

// =============================================================================
// WP4.6: Janitor Process
// =============================================================================

export interface JanitorResult {
  orphanedWorktreesMarked: number;
  orphanedDirectoriesRemoved: number;
  stalePortsReleased: number;
  errors: string[];
}

/**
 * Run janitor cleanup: reconcile DB ↔ filesystem.
 * Should be called on worker startup.
 */
export function runJanitor(db: Database): JanitorResult {
  log.info('Starting janitor cleanup');

  const result: JanitorResult = {
    orphanedWorktreesMarked: 0,
    orphanedDirectoriesRemoved: 0,
    stalePortsReleased: 0,
    errors: [],
  };

  // 1. DB → Filesystem: Mark worktrees as destroyed if directory missing
  try {
    const activeWorktrees = db.prepare(
      'SELECT worktree_id, path FROM worktrees WHERE destroyed_at IS NULL'
    ).all() as Array<{ worktree_id: string; path: string }>;

    for (const wt of activeWorktrees) {
      if (!existsSync(wt.path)) {
        const now = new Date().toISOString();
        db.prepare(
          'UPDATE worktrees SET status = ?, destroyed_at = ? WHERE worktree_id = ?'
        ).run('destroyed', now, wt.worktree_id);

        // Also release ports
        releaseWorktreePorts(db, wt.worktree_id);

        result.orphanedWorktreesMarked++;
        log.info({ worktreeId: wt.worktree_id }, 'Marked orphaned worktree as destroyed');
      }
    }
  } catch (err) {
    result.errors.push(`Failed to check orphaned worktrees: ${err instanceof Error ? err.message : 'Unknown'}`);
  }

  // 2. Filesystem → DB: Remove directories without DB records
  try {
    const worktreesDir = getWorktreesDir();
    if (existsSync(worktreesDir)) {
      const dirs = readdirSync(worktreesDir);

      for (const dir of dirs) {
        const dirPath = join(worktreesDir, dir);

        // Check if there's an active worktree record for this path
        const record = db.prepare(
          'SELECT worktree_id FROM worktrees WHERE path = ? AND destroyed_at IS NULL'
        ).get(dirPath) as { worktree_id: string } | undefined;

        if (record === undefined) {
          try {
            rmSync(dirPath, { recursive: true, force: true });
            result.orphanedDirectoriesRemoved++;
            log.info({ path: dirPath }, 'Removed orphaned worktree directory');
          } catch (err) {
            result.errors.push(`Failed to remove orphan dir ${dirPath}: ${err instanceof Error ? err.message : 'Unknown'}`);
          }
        }
      }
    }
  } catch (err) {
    result.errors.push(`Failed to scan worktrees directory: ${err instanceof Error ? err.message : 'Unknown'}`);
  }

  // 3. Release stale port leases
  try {
    const timeoutHours = getLeaseTimeoutHours();
    const cutoff = new Date(Date.now() - timeoutHours * 60 * 60 * 1000).toISOString();
    const now = new Date().toISOString();

    const staleLeases = db.prepare(
      'UPDATE port_leases SET is_active = 0, released_at = ? WHERE is_active = 1 AND leased_at < ?'
    ).run(now, cutoff);

    result.stalePortsReleased = staleLeases.changes;
    if (staleLeases.changes > 0) {
      log.info({ count: staleLeases.changes }, 'Released stale port leases');
    }
  } catch (err) {
    result.errors.push(`Failed to release stale ports: ${err instanceof Error ? err.message : 'Unknown'}`);
  }

  log.info(
    {
      orphanedWorktreesMarked: result.orphanedWorktreesMarked,
      orphanedDirectoriesRemoved: result.orphanedDirectoriesRemoved,
      stalePortsReleased: result.stalePortsReleased,
      errors: result.errors.length,
    },
    'Janitor cleanup complete'
  );

  return result;
}

// =============================================================================
// Heartbeat
// =============================================================================

/**
 * Update worktree heartbeat.
 */
export function updateWorktreeHeartbeat(db: Database, worktreeId: string): void {
  const now = new Date().toISOString();
  db.prepare('UPDATE worktrees SET last_heartbeat_at = ? WHERE worktree_id = ?').run(now, worktreeId);
}

// =============================================================================
// Helpers
// =============================================================================

function rowToWorktree(row: Record<string, unknown>): Worktree {
  return {
    worktreeId: row['worktree_id'] as string,
    runId: row['run_id'] as string,
    projectId: row['project_id'] as string,
    repoId: row['repo_id'] as string,
    path: row['path'] as string,
    branchName: '', // Not stored in DB, generated
    baseCommit: '', // Not stored in DB currently
    status: row['status'] as Worktree['status'],
    lastHeartbeatAt: row['last_heartbeat_at'] as string,
    createdAt: row['created_at'] as string,
    destroyedAt: row['destroyed_at'] as string | null,
  };
}

function rowToPortLease(row: Record<string, unknown>): PortLease {
  return {
    portLeaseId: row['port_lease_id'] as string,
    projectId: row['project_id'] as string,
    worktreeId: row['worktree_id'] as string,
    port: row['port'] as number,
    purpose: row['purpose'] as PortLease['purpose'],
    isActive: row['is_active'] === 1,
    leasedAt: row['leased_at'] as string,
    expiresAt: row['expires_at'] as string,
    releasedAt: row['released_at'] as string | null,
  };
}
