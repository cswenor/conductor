/**
 * GitHub Write Outbox Module
 *
 * Implements the outbox pattern for reliable GitHub API writes.
 * All writes are persisted to the database before being sent,
 * ensuring crash-safe delivery with automatic retries.
 */

import type { Database } from 'better-sqlite3';
import { createLogger } from '../logger/index.ts';
import { redact } from '../redact/index.ts';
import type {
  GitHubWriteKind,
  GitHubWriteStatus,
  GitHubWriteTargetType,
} from '../types/index.ts';
import type { QueueManager } from '../queue/index.ts';

const log = createLogger({ name: 'conductor:outbox' });

// Re-export types for convenience
export type { GitHubWriteKind, GitHubWriteStatus, GitHubWriteTargetType };

// =============================================================================
// Types
// =============================================================================

/**
 * Base payload for all write operations
 */
interface BaseWritePayload {
  owner: string;
  repo: string;
}

/**
 * Payload for creating a comment
 */
export interface CommentWritePayload extends BaseWritePayload {
  issueNumber: number;
  body: string;
}

/**
 * Payload for creating a pull request
 */
export interface PullRequestWritePayload extends BaseWritePayload {
  title: string;
  body: string;
  head: string;
  base: string;
  draft?: boolean;
}

/**
 * Payload for creating/updating a check run
 */
export interface CheckRunWritePayload extends BaseWritePayload {
  headSha: string;
  name: string;
  status?: 'queued' | 'in_progress' | 'completed';
  conclusion?: 'success' | 'failure' | 'neutral' | 'cancelled' | 'skipped' | 'timed_out';
  title?: string;
  summary?: string;
  detailsUrl?: string;
  /** If provided, updates an existing check run */
  checkRunId?: number;
}

/**
 * Payload for creating a branch
 */
export interface BranchWritePayload extends BaseWritePayload {
  branchName: string;
  fromSha: string;
}

/**
 * Payload for adding a label
 */
export interface LabelWritePayload extends BaseWritePayload {
  issueNumber: number;
  labels: string[];
}

/**
 * Union of all write payloads
 */
export type GitHubWritePayload =
  | CommentWritePayload
  | PullRequestWritePayload
  | CheckRunWritePayload
  | BranchWritePayload
  | LabelWritePayload;

/**
 * GitHub write record for persistence
 */
export interface GitHubWriteRecord {
  githubWriteId: string;
  runId: string;
  kind: GitHubWriteKind;
  targetNodeId: string;
  targetType: GitHubWriteTargetType;
  idempotencyKey: string;
  payloadHash: string;
  payload?: GitHubWritePayload;
  status: GitHubWriteStatus;
  error?: string;
  githubId?: number;
  githubUrl?: string;
  createdAt: string;
  sentAt?: string;
  retryCount: number;
}

/**
 * Input for enqueuing a write operation
 */
export interface EnqueueWriteInput {
  runId: string;
  kind: GitHubWriteKind;
  targetNodeId: string;
  targetType: GitHubWriteTargetType;
  payload: GitHubWritePayload;
  /** Optional custom idempotency key. If not provided, one is generated. */
  idempotencyKey?: string;
}

/**
 * Result of enqueuing a write
 */
export interface EnqueueWriteResult {
  githubWriteId: string;
  isNew: boolean;
  status: GitHubWriteStatus;
}

/**
 * Result of executing a write
 */
export interface WriteExecutionResult {
  success: boolean;
  githubId?: number;
  githubUrl?: string;
  error?: string;
}

// =============================================================================
// ID Generation
// =============================================================================

/**
 * Generate a unique write ID
 */
export function generateWriteId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 10);
  return `ghw_${timestamp}${random}`;
}

/**
 * Generate an idempotency key for a write operation
 */
export function generateIdempotencyKey(
  runId: string,
  kind: GitHubWriteKind,
  targetNodeId: string,
  payloadHash: string
): string {
  return `${runId}:${kind}:${targetNodeId}:${payloadHash}`;
}

/**
 * Compute a hash of the payload for deduplication
 */
export function computeWritePayloadHash(payload: GitHubWritePayload): string {
  const result = redact(payload as unknown as Record<string, unknown>);
  return result.payloadHash;
}

// =============================================================================
// Outbox Operations
// =============================================================================

/**
 * Enqueue a write operation
 *
 * Persists the write to the outbox. If an identical write exists
 * (same idempotency key), returns the existing record.
 *
 * If a queue manager is provided, also enqueues a job for processing.
 */
export function enqueueWrite(
  db: Database,
  input: EnqueueWriteInput,
  queueManager?: QueueManager
): EnqueueWriteResult {
  const payloadHash = computeWritePayloadHash(input.payload);
  const idempotencyKey = input.idempotencyKey ?? generateIdempotencyKey(
    input.runId,
    input.kind,
    input.targetNodeId,
    payloadHash
  );

  // Check for existing write with same idempotency key
  const existingStmt = db.prepare(
    'SELECT github_write_id, status FROM github_writes WHERE idempotency_key = ?'
  );
  const existing = existingStmt.get(idempotencyKey) as
    | { github_write_id: string; status: string }
    | undefined;

  if (existing !== undefined) {
    log.debug(
      { idempotencyKey, existingId: existing.github_write_id, status: existing.status },
      'Duplicate write operation, returning existing'
    );
    return {
      githubWriteId: existing.github_write_id,
      isNew: false,
      status: existing.status as GitHubWriteStatus,
    };
  }

  const githubWriteId = generateWriteId();
  const createdAt = new Date().toISOString();

  const insertStmt = db.prepare(`
    INSERT INTO github_writes (
      github_write_id,
      run_id,
      kind,
      target_node_id,
      target_type,
      idempotency_key,
      payload_hash,
      payload_hash_scheme,
      payload_json,
      status,
      created_at,
      retry_count
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  insertStmt.run(
    githubWriteId,
    input.runId,
    input.kind,
    input.targetNodeId,
    input.targetType,
    idempotencyKey,
    payloadHash,
    'sha256:cjson:v1',
    JSON.stringify(input.payload),
    'queued',
    createdAt,
    0
  );

  log.info(
    {
      githubWriteId,
      runId: input.runId,
      kind: input.kind,
      targetType: input.targetType,
    },
    'Write operation enqueued'
  );

  // Enqueue job for processing if queue manager is provided
  if (queueManager !== undefined) {
    void queueManager.addJob('github_writes', githubWriteId, {
      githubWriteId,
      runId: input.runId,
      kind: input.kind,
      targetNodeId: input.targetNodeId,
      retryCount: 0,
    }).then(() => {
      log.debug({ githubWriteId }, 'GitHub write job enqueued');
    }).catch((err: unknown) => {
      log.error(
        { githubWriteId, error: err instanceof Error ? err.message : 'Unknown error' },
        'Failed to enqueue GitHub write job'
      );
    });
  }

  return {
    githubWriteId,
    isNew: true,
    status: 'queued',
  };
}

/**
 * Enqueue a write operation (async version)
 *
 * Like enqueueWrite, but ensures the job is queued before returning.
 * Use this when you need to guarantee the job is in the queue.
 */
export async function enqueueWriteAsync(
  db: Database,
  input: EnqueueWriteInput,
  queueManager: QueueManager
): Promise<EnqueueWriteResult> {
  const payloadHash = computeWritePayloadHash(input.payload);
  const idempotencyKey = input.idempotencyKey ?? generateIdempotencyKey(
    input.runId,
    input.kind,
    input.targetNodeId,
    payloadHash
  );

  // Check for existing write with same idempotency key
  const existingStmt = db.prepare(
    'SELECT github_write_id, status FROM github_writes WHERE idempotency_key = ?'
  );
  const existing = existingStmt.get(idempotencyKey) as
    | { github_write_id: string; status: string }
    | undefined;

  if (existing !== undefined) {
    log.debug(
      { idempotencyKey, existingId: existing.github_write_id, status: existing.status },
      'Duplicate write operation, returning existing'
    );
    return {
      githubWriteId: existing.github_write_id,
      isNew: false,
      status: existing.status as GitHubWriteStatus,
    };
  }

  const githubWriteId = generateWriteId();
  const createdAt = new Date().toISOString();

  const insertStmt = db.prepare(`
    INSERT INTO github_writes (
      github_write_id,
      run_id,
      kind,
      target_node_id,
      target_type,
      idempotency_key,
      payload_hash,
      payload_hash_scheme,
      payload_json,
      status,
      created_at,
      retry_count
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  insertStmt.run(
    githubWriteId,
    input.runId,
    input.kind,
    input.targetNodeId,
    input.targetType,
    idempotencyKey,
    payloadHash,
    'sha256:cjson:v1',
    JSON.stringify(input.payload),
    'queued',
    createdAt,
    0
  );

  log.info(
    {
      githubWriteId,
      runId: input.runId,
      kind: input.kind,
      targetType: input.targetType,
    },
    'Write operation enqueued'
  );

  // Enqueue job for processing and wait for it
  await queueManager.addJob('github_writes', githubWriteId, {
    githubWriteId,
    runId: input.runId,
    kind: input.kind,
    targetNodeId: input.targetNodeId,
    retryCount: 0,
  });

  log.debug({ githubWriteId }, 'GitHub write job enqueued');

  return {
    githubWriteId,
    isNew: true,
    status: 'queued',
  };
}

/**
 * Get a write record by ID
 */
export function getWrite(db: Database, githubWriteId: string): GitHubWriteRecord | null {
  const stmt = db.prepare('SELECT * FROM github_writes WHERE github_write_id = ?');
  const row = stmt.get(githubWriteId) as Record<string, unknown> | undefined;

  if (row === undefined) {
    return null;
  }

  return rowToWriteRecord(row);
}

/**
 * Get a write record by idempotency key
 */
export function getWriteByIdempotencyKey(
  db: Database,
  idempotencyKey: string
): GitHubWriteRecord | null {
  const stmt = db.prepare('SELECT * FROM github_writes WHERE idempotency_key = ?');
  const row = stmt.get(idempotencyKey) as Record<string, unknown> | undefined;

  if (row === undefined) {
    return null;
  }

  return rowToWriteRecord(row);
}

/**
 * List pending writes that are ready to be processed
 */
export function listPendingWrites(
  db: Database,
  options?: {
    runId?: string;
    limit?: number;
  }
): GitHubWriteRecord[] {
  const limit = options?.limit ?? 50;

  let sql = `
    SELECT * FROM github_writes
    WHERE status IN ('queued', 'failed')
  `;
  const params: (string | number)[] = [];

  if (options?.runId !== undefined) {
    sql += ' AND run_id = ?';
    params.push(options.runId);
  }

  // For failed writes, only include those ready for retry
  sql += ' ORDER BY created_at ASC LIMIT ?';
  params.push(limit);

  const stmt = db.prepare(sql);
  const rows = stmt.all(...params) as Array<Record<string, unknown>>;

  return rows.map(rowToWriteRecord);
}

/**
 * List writes for a run
 */
export function listRunWrites(
  db: Database,
  runId: string,
  options?: {
    status?: GitHubWriteStatus;
    limit?: number;
    offset?: number;
  }
): GitHubWriteRecord[] {
  const limit = options?.limit ?? 100;
  const offset = options?.offset ?? 0;

  let sql = 'SELECT * FROM github_writes WHERE run_id = ?';
  const params: (string | number)[] = [runId];

  if (options?.status !== undefined) {
    sql += ' AND status = ?';
    params.push(options.status);
  }

  sql += ' ORDER BY created_at ASC LIMIT ? OFFSET ?';
  params.push(limit, offset);

  const stmt = db.prepare(sql);
  const rows = stmt.all(...params) as Array<Record<string, unknown>>;

  return rows.map(rowToWriteRecord);
}

/**
 * Mark a write as processing (claimed for execution)
 */
export function markWriteProcessing(db: Database, githubWriteId: string): boolean {
  const stmt = db.prepare(`
    UPDATE github_writes
    SET status = 'processing'
    WHERE github_write_id = ? AND status IN ('queued', 'failed')
  `);
  const result = stmt.run(githubWriteId);
  return result.changes > 0;
}

/**
 * Mark a write as completed
 */
export function markWriteCompleted(
  db: Database,
  githubWriteId: string,
  result: { githubId?: number; githubUrl?: string }
): void {
  const stmt = db.prepare(`
    UPDATE github_writes
    SET status = 'completed',
        github_id = ?,
        github_url = ?,
        sent_at = ?,
        error = NULL
    WHERE github_write_id = ?
  `);
  stmt.run(
    result.githubId ?? null,
    result.githubUrl ?? null,
    new Date().toISOString(),
    githubWriteId
  );

  log.info(
    { githubWriteId, githubId: result.githubId, githubUrl: result.githubUrl },
    'Write operation completed'
  );
}

/**
 * Mark a write as failed
 */
export function markWriteFailed(
  db: Database,
  githubWriteId: string,
  error: string
): void {
  const stmt = db.prepare(`
    UPDATE github_writes
    SET status = 'failed',
        error = ?,
        retry_count = retry_count + 1
    WHERE github_write_id = ?
  `);
  stmt.run(error, githubWriteId);

  log.warn({ githubWriteId, error }, 'Write operation failed');
}

/**
 * Mark a write as cancelled
 */
export function markWriteCancelled(db: Database, githubWriteId: string): void {
  const stmt = db.prepare(`
    UPDATE github_writes
    SET status = 'cancelled'
    WHERE github_write_id = ? AND status IN ('queued', 'failed')
  `);
  stmt.run(githubWriteId);

  log.info({ githubWriteId }, 'Write operation cancelled');
}

/**
 * Cancel all pending writes for a run
 */
export function cancelRunWrites(db: Database, runId: string): number {
  const stmt = db.prepare(`
    UPDATE github_writes
    SET status = 'cancelled'
    WHERE run_id = ? AND status IN ('queued', 'failed', 'processing')
  `);
  const result = stmt.run(runId);

  if (result.changes > 0) {
    log.info({ runId, count: result.changes }, 'Cancelled pending writes for run');
  }

  return result.changes;
}

// =============================================================================
// Retry Logic
// =============================================================================

/**
 * Calculate retry delay using exponential backoff
 *
 * @param retryCount - Number of previous attempts
 * @param baseDelayMs - Base delay in milliseconds (default: 1000)
 * @param maxDelayMs - Maximum delay in milliseconds (default: 60000)
 * @returns Delay in milliseconds before next retry
 */
export function calculateRetryDelay(
  retryCount: number,
  baseDelayMs = 1000,
  maxDelayMs = 60000
): number {
  // Exponential backoff with jitter
  const exponentialDelay = baseDelayMs * Math.pow(2, retryCount);
  const jitter = Math.random() * 0.3 * exponentialDelay; // 0-30% jitter
  return Math.min(exponentialDelay + jitter, maxDelayMs);
}

/**
 * Check if a write should be retried based on retry count
 */
export function shouldRetry(retryCount: number, maxRetries = 5): boolean {
  return retryCount < maxRetries;
}

/**
 * Get writes that are ready for retry
 */
export function getRetryableWrites(
  db: Database,
  options?: {
    maxRetries?: number;
    limit?: number;
  }
): GitHubWriteRecord[] {
  const maxRetries = options?.maxRetries ?? 5;
  const limit = options?.limit ?? 50;

  const stmt = db.prepare(`
    SELECT * FROM github_writes
    WHERE status = 'failed' AND retry_count < ?
    ORDER BY created_at ASC
    LIMIT ?
  `);
  const rows = stmt.all(maxRetries, limit) as Array<Record<string, unknown>>;

  return rows.map(rowToWriteRecord);
}

// =============================================================================
// Statistics
// =============================================================================

/**
 * Get write statistics for a run
 */
export function getRunWriteStats(
  db: Database,
  runId: string
): {
  total: number;
  queued: number;
  processing: number;
  completed: number;
  failed: number;
  cancelled: number;
} {
  const stmt = db.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN status = 'queued' THEN 1 ELSE 0 END) as queued,
      SUM(CASE WHEN status = 'processing' THEN 1 ELSE 0 END) as processing,
      SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
      SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed,
      SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) as cancelled
    FROM github_writes
    WHERE run_id = ?
  `);
  const row = stmt.get(runId) as Record<string, number>;

  return {
    total: row['total'] ?? 0,
    queued: row['queued'] ?? 0,
    processing: row['processing'] ?? 0,
    completed: row['completed'] ?? 0,
    failed: row['failed'] ?? 0,
    cancelled: row['cancelled'] ?? 0,
  };
}

// =============================================================================
// Stalled Write Recovery
// =============================================================================

/**
 * Reset a stuck 'processing' write back to 'queued'.
 *
 * Only resets if the write has been in 'processing' longer than staleAfterMs
 * (uses created_at as a staleness proxy). A write that was just created moments
 * ago and is legitimately processing won't be reset.
 */
export function resetStalledWrite(
  db: Database,
  githubWriteId: string,
  staleAfterMs: number = 5 * 60_000
): boolean {
  const cutoff = new Date(Date.now() - staleAfterMs).toISOString();
  const result = db.prepare(
    `UPDATE github_writes SET status = 'queued'
     WHERE github_write_id = ? AND status = 'processing' AND created_at < ?`
  ).run(githubWriteId, cutoff);
  return result.changes > 0;
}

// =============================================================================
// Helper Functions
// =============================================================================

function rowToWriteRecord(row: Record<string, unknown>): GitHubWriteRecord {
  const payloadJson = row['payload_json'] as string | null;
  return {
    githubWriteId: row['github_write_id'] as string,
    runId: row['run_id'] as string,
    kind: row['kind'] as GitHubWriteKind,
    targetNodeId: row['target_node_id'] as string,
    targetType: row['target_type'] as GitHubWriteTargetType,
    idempotencyKey: row['idempotency_key'] as string,
    payloadHash: row['payload_hash'] as string,
    payload: payloadJson !== null ? JSON.parse(payloadJson) as GitHubWritePayload : undefined,
    status: row['status'] as GitHubWriteStatus,
    error: row['error'] as string | undefined,
    githubId: row['github_id'] as number | undefined,
    githubUrl: row['github_url'] as string | undefined,
    createdAt: row['created_at'] as string,
    sentAt: row['sent_at'] as string | undefined,
    retryCount: row['retry_count'] as number,
  };
}

// Re-export processor
export * from './processor.ts';
