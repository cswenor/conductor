/**
 * Worktree Module
 *
 * Manages git worktrees, repo clones, port allocation, and cleanup.
 * Part of WP4: Worktree & Environment Manager.
 */

import type { Database } from 'better-sqlite3';
import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, rmSync, readdirSync, rmdirSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { randomBytes } from 'crypto';
import { createLogger } from '../logger/index.ts';

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
 * Get the locks directory.
 */
export function getLocksDir(): string {
  return join(getDataDir(), 'locks');
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
  branchName: string | null;
  baseCommit: string | null;
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
// File-Based Locking (Cross-Process Safe)
// =============================================================================

const LOCK_TIMEOUT_MS = 30000;
const LOCK_POLL_MS = 100;

/**
 * Acquire a file-based lock using directory creation (atomic on POSIX).
 * Returns a release function, or throws if timeout.
 */
export function acquireFileLock(
  lockName: string,
  timeoutMs = LOCK_TIMEOUT_MS,
  staleLockTimeoutMs?: number
): () => void {
  const locksDir = getLocksDir();
  mkdirSync(locksDir, { recursive: true });

  const lockPath = join(locksDir, `${lockName}.lock`);
  const start = Date.now();

  for (;;) {
    try {
      // mkdir is atomic - if it succeeds, we have the lock
      mkdirSync(lockPath);
      log.debug({ lockName }, 'Lock acquired');

      return () => {
        try {
          rmdirSync(lockPath);
          log.debug({ lockName }, 'Lock released');
        } catch {
          // Lock may already be released
        }
      };
    } catch {
      // Lock exists, check timeout
      if (Date.now() - start > timeoutMs) {
        throw new Error(`Timeout acquiring lock '${lockName}' after ${timeoutMs}ms`);
      }

      // Check for stale lock (older than timeout)
      try {
        const stats = statSync(lockPath);
        const staleThreshold = staleLockTimeoutMs ?? timeoutMs * 2;
        if (Date.now() - stats.mtimeMs > staleThreshold) {
          // Stale lock, remove it
          log.warn({ lockName }, 'Removing stale lock');
          rmdirSync(lockPath);
          continue;
        }
      } catch {
        // Lock may have been released
        continue;
      }

      // Wait and retry
      const waitEnd = Date.now() + LOCK_POLL_MS;
      while (Date.now() < waitEnd) {
        // Busy wait (synchronous context)
      }
    }
  }
}

// =============================================================================
// Retry Helper
// =============================================================================

function sleep(ms: number): void {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    // Synchronous sleep
  }
}

function retryWithBackoff<T>(
  fn: () => T,
  maxRetries: number,
  baseDelayMs: number,
  description: string
): T {
  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return fn();
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt < maxRetries) {
        const delay = baseDelayMs * Math.pow(2, attempt);
        log.warn(
          { attempt: attempt + 1, maxRetries: maxRetries + 1, delay, error: lastError.message },
          `${description} failed, retrying`
        );
        sleep(delay);
      }
    }
  }

  throw lastError ?? new Error(`${description} failed after ${maxRetries + 1} attempts`);
}

// =============================================================================
// Safe Git Command Execution
// =============================================================================

interface GitResult {
  stdout: string;
  success: boolean;
}

function execGit(args: string[], options: { cwd?: string; timeout?: number } = {}): GitResult {
  try {
    const stdout = execFileSync('git', args, {
      cwd: options.cwd,
      encoding: 'utf8',
      timeout: options.timeout ?? 120000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { stdout: stdout.trim(), success: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    log.debug({ args, error: message }, 'Git command failed');
    return { stdout: '', success: false };
  }
}

function execGitOrThrow(args: string[], options: { cwd?: string; timeout?: number } = {}): string {
  const result = execGit(args, options);
  if (!result.success) {
    throw new Error(`Git command failed: git ${args.join(' ')}`);
  }
  return result.stdout;
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
 * Uses file-based locking for cross-process safety.
 * Implements retry with exponential backoff.
 */
export function cloneOrFetchRepo(
  db: Database,
  options: CloneRepoOptions
): CloneResult {
  const { projectId, repoId, githubOwner, githubName, installationToken } = options;

  // Acquire cross-process lock
  const releaseLock = acquireFileLock(`clone-${repoId}`, LOCK_TIMEOUT_MS, 600_000);

  try {
    const reposDir = getReposDir();
    const clonePath = join(reposDir, projectId, repoId);
    const now = new Date().toISOString();
    const cloneUrl = `https://x-access-token:${installationToken}@github.com/${githubOwner}/${githubName}.git`;

    // Check if clone already exists
    if (existsSync(clonePath)) {
      log.info({ repoId, clonePath }, 'Clone exists, fetching updates');

      try {
        retryWithBackoff(
          () => {
            execGitOrThrow(
              ['fetch', '--prune', cloneUrl, '+refs/heads/*:refs/heads/*'],
              { cwd: clonePath, timeout: 120000 }
            );
          },
          2,
          1000,
          'Git fetch'
        );

        // Update last_fetched_at
        db.prepare(
          'UPDATE repos SET last_fetched_at = ?, updated_at = ? WHERE repo_id = ?'
        ).run(now, now, repoId);

        log.info({ repoId }, 'Repo fetched successfully');
      } catch (err) {
        log.warn(
          { repoId, error: err instanceof Error ? err.message : 'Unknown' },
          'Fetch failed, continuing with existing clone'
        );
      }

      return { clonePath, clonedAt: now, wasExisting: true };
    }

    // Create parent directory
    mkdirSync(dirname(clonePath), { recursive: true });

    // Clone the repository (bare) with retry
    log.info({ repoId, githubOwner, githubName }, 'Cloning repository');

    try {
      retryWithBackoff(
        () => {
          execGitOrThrow(['clone', '--bare', cloneUrl, clonePath], { timeout: 300000 });
        },
        2,
        2000,
        'Git clone'
      );
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
    db.prepare(
      'UPDATE repos SET clone_path = ?, cloned_at = ?, last_fetched_at = ?, updated_at = ? WHERE repo_id = ?'
    ).run(clonePath, now, now, now, repoId);

    log.info({ repoId, clonePath }, 'Repository cloned successfully');

    return { clonePath, clonedAt: now, wasExisting: false };
  } finally {
    releaseLock();
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
// WP4.2 & WP4.3: Worktree and Branch Creation
// =============================================================================

export interface CreateWorktreeOptions {
  runId: string;
  projectId: string;
  repoId: string;
  baseBranch?: string;
}

/**
 * Create a worktree for a run.
 * Idempotent: returns existing worktree if already created for this run.
 * Uses file-based locking and DB unique constraint for cross-process safety.
 * Atomic: if DB insert fails after git worktree, compensating cleanup runs.
 */
export function createWorktree(
  db: Database,
  options: CreateWorktreeOptions
): Worktree {
  const { runId, projectId, repoId } = options;

  // Check if worktree already exists for this run
  const existingStmt = db.prepare(
    'SELECT * FROM worktrees WHERE run_id = ? AND destroyed_at IS NULL'
  );
  const existing = existingStmt.get(runId) as Record<string, unknown> | undefined;
  if (existing !== undefined) {
    log.info({ runId }, 'Worktree already exists for run');
    return rowToWorktree(existing);
  }

  // Acquire cross-process lock
  const releaseLock = acquireFileLock(`worktree-${runId}`, LOCK_TIMEOUT_MS, 120_000);

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

    // Resolve base branch (pass clonePath for main/master fallback verification)
    const baseBranch = resolveBaseBranch(db, repoId, options.baseBranch, clonePath);
    const worktreeId = generateWorktreeId();
    const worktreePath = join(getWorktreesDir(), runId);
    const branchName = generateBranchName(runId);
    const now = new Date().toISOString();

    // Create worktree directory parent
    mkdirSync(dirname(worktreePath), { recursive: true });

    // Get base commit SHA
    const baseCommit = resolveBaseCommit(clonePath, baseBranch);

    // Check if branch already exists (from failed previous attempt)
    const branchExists = execGit(['rev-parse', '--verify', `refs/heads/${branchName}`], { cwd: clonePath });
    if (branchExists.success) {
      log.warn({ branchName }, 'Branch already exists, deleting before recreate');
      execGit(['branch', '-D', branchName], { cwd: clonePath });
    }

    // Create worktree with new branch
    try {
      execGitOrThrow(
        ['worktree', 'add', '-b', branchName, worktreePath, baseCommit],
        { cwd: clonePath, timeout: 60000 }
      );
    } catch (err) {
      // Clean up on git failure
      if (existsSync(worktreePath)) {
        rmSync(worktreePath, { recursive: true, force: true });
      }
      throw new Error(
        `Failed to create worktree: ${err instanceof Error ? err.message : 'Unknown'}`
      );
    }

    // Insert into database (unique constraint prevents duplicates)
    try {
      const insertStmt = db.prepare(`
        INSERT INTO worktrees (
          worktree_id, run_id, project_id, repo_id, path, branch_name, base_commit, status, last_heartbeat_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      insertStmt.run(worktreeId, runId, projectId, repoId, worktreePath, branchName, baseCommit, 'active', now, now);
    } catch (dbErr) {
      // Compensating cleanup: remove git worktree and branch
      log.error({ runId, error: dbErr instanceof Error ? dbErr.message : 'Unknown' }, 'DB insert failed, cleaning up git worktree');
      try {
        execGit(['worktree', 'remove', '--force', worktreePath], { cwd: clonePath });
      } catch {
        // Best effort
      }
      if (existsSync(worktreePath)) {
        rmSync(worktreePath, { recursive: true, force: true });
      }
      try {
        execGit(['branch', '-D', branchName], { cwd: clonePath });
      } catch {
        // Best effort
      }

      // Check if another process won the race (unique constraint violation)
      const raceWinner = existingStmt.get(runId) as Record<string, unknown> | undefined;
      if (raceWinner !== undefined) {
        return rowToWorktree(raceWinner);
      }

      throw dbErr;
    }

    log.info({ worktreeId, runId, path: worktreePath, branchName, baseCommit }, 'Worktree created');

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
    releaseLock();
  }
}

/**
 * Resolve base commit SHA from branch name.
 * Tries refs/heads/{branch}, then {branch} directly.
 */
function resolveBaseCommit(clonePath: string, baseBranch: string): string {
  // Try refs/heads first (for bare repos)
  let result = execGit(['rev-parse', `refs/heads/${baseBranch}`], { cwd: clonePath });
  if (result.success) {
    return result.stdout;
  }

  // Try direct ref
  result = execGit(['rev-parse', baseBranch], { cwd: clonePath });
  if (result.success) {
    return result.stdout;
  }

  throw new Error(`Base branch '${baseBranch}' not found in repo`);
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

/**
 * Resolve the base branch for a repo.
 * Priority: configured → GitHub default → main → master (verified against clone)
 *
 * @param clonePath - If provided, verifies fallback branches actually exist in the clone.
 */
export function resolveBaseBranch(
  db: Database,
  repoId: string,
  configuredDefault?: string,
  clonePath?: string
): string {
  // 1. Use explicitly configured default if provided
  if (configuredDefault !== undefined && configuredDefault !== '') {
    if (!isValidBranchName(configuredDefault)) {
      throw new Error(`Invalid base branch name: '${configuredDefault}'`);
    }
    return configuredDefault;
  }

  // 2. Use GitHub default branch from repo record
  const stmt = db.prepare('SELECT github_default_branch FROM repos WHERE repo_id = ?');
  const row = stmt.get(repoId) as { github_default_branch: string } | undefined;

  if (row !== undefined && row.github_default_branch !== '') {
    if (!isValidBranchName(row.github_default_branch)) {
      log.warn(
        { repoId, githubDefaultBranch: row.github_default_branch },
        'Invalid github_default_branch in DB, falling back to clone inspection'
      );
    } else {
      return row.github_default_branch;
    }
  }

  // 3. Fallback: check which default branch exists in the clone
  if (clonePath !== undefined) {
    const mainExists = execGit(['rev-parse', '--verify', 'refs/heads/main'], { cwd: clonePath });
    if (mainExists.success) {
      return 'main';
    }

    const masterExists = execGit(['rev-parse', '--verify', 'refs/heads/master'], { cwd: clonePath });
    if (masterExists.success) {
      return 'master';
    }
  }

  // No clone to check — default to main
  return 'main';
}

/**
 * Validate a branch name for git compatibility.
 */
export function isValidBranchName(name: string): boolean {
  // Git branch name restrictions
  if (name === '' || name.length > 250) return false;
  if (name.startsWith('-') || name.startsWith('.')) return false;
  if (name.endsWith('.') || name.endsWith('.lock')) return false;
  if (name.includes('..') || name.includes('//') || name.includes('@{')) return false;
  // Check for control chars, DEL, and other invalid characters
   
  if (/[\u0000-\u001f\u007f~^:?*[\]\\]/.test(name)) return false;
  return true;
}

/**
 * Generate branch name for a run.
 */
export function generateBranchName(runId: string): string {
  const name = `conductor/run-${runId}`;
  if (!isValidBranchName(name)) {
    throw new Error(`Generated invalid branch name: ${name}`);
  }
  return name;
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

const PROCESS_TERM_TIMEOUT_MS = 10000; // 10 seconds per issue spec

/**
 * Cleanup a worktree: kill processes, remove files, release ports.
 */
export function cleanupWorktree(db: Database, runId: string): boolean {
  const worktree = getWorktreeForRun(db, runId);
  if (worktree === null) {
    log.info({ runId }, 'No active worktree to cleanup');
    return false;
  }

  const { worktreeId, path: worktreePath, repoId, branchName } = worktree;

  log.info({ worktreeId, runId, path: worktreePath }, 'Cleaning up worktree');

  // 1. Kill processes using the worktree (best effort)
  try {
    killProcessesInDir(worktreePath, PROCESS_TERM_TIMEOUT_MS);
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
    const result = execGit(['worktree', 'remove', '--force', worktreePath], { cwd: clonePath });
    if (!result.success) {
      log.warn({ worktreeId }, 'git worktree remove failed, removing directory directly');
    }

    // Also remove the branch (optional cleanup)
    if (branchName !== null) {
      execGit(['branch', '-D', branchName], { cwd: clonePath });
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
  db.prepare(
    'UPDATE worktrees SET status = ?, destroyed_at = ? WHERE worktree_id = ?'
  ).run('destroyed', now, worktreeId);

  log.info({ worktreeId, runId }, 'Worktree cleanup complete');
  return true;
}

/**
 * Kill processes using a directory (best effort).
 * SIGTERM first, wait up to timeoutMs, then SIGKILL.
 */
function killProcessesInDir(dirPath: string, timeoutMs: number): void {
  if (process.platform === 'win32') {
    // Windows: skip process killing
    return;
  }

  let pids: number[] = [];

  try {
    // Find processes using the directory
    const result = execFileSync('lsof', ['+D', dirPath], {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 5000,
    });

    // Parse PIDs from lsof output (skip header)
    const lines = result.split('\n').slice(1);
    const pidSet = new Set<number>();
    for (const line of lines) {
      const parts = line.trim().split(/\s+/);
      const pidStr = parts[1];
      if (pidStr !== undefined) {
        const pid = parseInt(pidStr, 10);
        if (!isNaN(pid) && pid > 0) {
          pidSet.add(pid);
        }
      }
    }
    pids = Array.from(pidSet);
  } catch {
    // lsof may fail if no processes found, which is fine
    return;
  }

  if (pids.length === 0) {
    return;
  }

  log.info({ pids, dirPath }, 'Terminating processes using worktree');

  // Send SIGTERM to all
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // Process may have already exited
    }
  }

  // Wait for processes to exit
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const remaining = pids.filter(pid => {
      try {
        process.kill(pid, 0); // Check if process exists
        return true;
      } catch {
        return false;
      }
    });

    if (remaining.length === 0) {
      return;
    }

    sleep(500);
  }

  // Force kill any remaining
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Ignore
    }
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
 * Should be called on worker startup before accepting jobs.
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
    branchName: (row['branch_name'] as string | null) ?? null,
    baseCommit: (row['base_commit'] as string | null) ?? null,
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
