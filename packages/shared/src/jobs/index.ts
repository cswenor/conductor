/**
 * Job Service
 *
 * Implements exactly-once job semantics with lease expiration,
 * idempotency keys, and dead letter handling.
 */

import type { Database } from 'better-sqlite3';
import type { JobQueue, JobStatus } from '../types/index.ts';

/**
 * Job record from database
 */
export interface Job {
  job_id: string;
  queue: JobQueue;
  job_type: string;
  payload_json: string;
  idempotency_key: string;
  status: JobStatus;
  priority: number;
  claimed_by: string | null;
  claimed_at: string | null;
  lease_expires_at: string | null;
  attempts: number;
  max_attempts: number;
  last_error: string | null;
  next_retry_at: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  run_id: string | null;
  project_id: string | null;
}

/**
 * Options for creating a job
 */
export interface CreateJobOptions {
  queue: JobQueue;
  jobType: string;
  payload: Record<string, unknown>;
  idempotencyKey: string;
  priority?: number;
  maxAttempts?: number;
  runId?: string;
  projectId?: string;
}

/**
 * Options for claiming a job
 */
export interface ClaimJobOptions {
  queue: JobQueue;
  workerId: string;
  leaseDurationMs?: number;
}

/**
 * Result of claiming a job
 */
export interface ClaimResult {
  job: Job | null;
  alreadyClaimed: boolean;
}

/**
 * Default lease duration (5 minutes)
 */
const DEFAULT_LEASE_DURATION_MS = 5 * 60 * 1000;

/**
 * Default max attempts before dead letter
 */
const DEFAULT_MAX_ATTEMPTS = 3;

/**
 * Generate a UUID for job IDs
 */
function generateId(): string {
  return crypto.randomUUID();
}

/**
 * Get current ISO timestamp
 */
function now(): string {
  return new Date().toISOString();
}

/**
 * Get ISO timestamp for future time
 */
function futureTime(ms: number): string {
  return new Date(Date.now() + ms).toISOString();
}

/**
 * Job Service for managing job lifecycle
 */
export class JobService {
  constructor(private readonly db: Database) {}

  /**
   * Create a new job (idempotent)
   *
   * If a job with the same idempotency_key exists, returns the existing job.
   */
  createJob(options: CreateJobOptions): Job {
    const {
      queue,
      jobType,
      payload,
      idempotencyKey,
      priority = 0,
      maxAttempts = DEFAULT_MAX_ATTEMPTS,
      runId,
      projectId,
    } = options;

    // Check for existing job with same idempotency key
    const existing = this.db
      .prepare('SELECT * FROM jobs WHERE idempotency_key = ?')
      .get(idempotencyKey) as Job | undefined;

    if (existing !== undefined) {
      return existing;
    }

    // Insert new job
    const jobId = generateId();
    const payloadJson = JSON.stringify(payload);
    const createdAt = now();

    this.db
      .prepare(
        `INSERT INTO jobs (
          job_id, queue, job_type, payload_json, idempotency_key,
          status, priority, max_attempts, created_at, run_id, project_id
        ) VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?)`
      )
      .run(
        jobId,
        queue,
        jobType,
        payloadJson,
        idempotencyKey,
        priority,
        maxAttempts,
        createdAt,
        runId ?? null,
        projectId ?? null
      );

    return this.db.prepare('SELECT * FROM jobs WHERE job_id = ?').get(jobId) as Job;
  }

  /**
   * Claim the next available job from a queue (atomic)
   *
   * A job is claimable if:
   * - status = 'queued' OR
   * - status = 'processing' AND lease_expires_at < NOW() (expired lease)
   *
   * Jobs are prioritized by:
   * 1. priority DESC (higher priority first)
   * 2. created_at ASC (older jobs first)
   */
  claimJob(options: ClaimJobOptions): ClaimResult {
    const { queue, workerId, leaseDurationMs = DEFAULT_LEASE_DURATION_MS } = options;

    const currentTime = now();
    const leaseExpiresAt = futureTime(leaseDurationMs);

    // Atomic claim: find and update in one statement
    // Uses RETURNING to get the claimed job
    const result = this.db
      .prepare(
        `UPDATE jobs SET
          status = 'processing',
          claimed_by = ?,
          claimed_at = ?,
          lease_expires_at = ?,
          started_at = COALESCE(started_at, ?),
          attempts = attempts + 1
        WHERE job_id = (
          SELECT job_id FROM jobs
          WHERE queue = ?
            AND (
              status = 'queued'
              OR (status = 'processing' AND lease_expires_at < ?)
            )
          ORDER BY priority DESC, created_at ASC
          LIMIT 1
        )
        RETURNING *`
      )
      .get(workerId, currentTime, leaseExpiresAt, currentTime, queue, currentTime) as Job | undefined;

    if (result === undefined) {
      return { job: null, alreadyClaimed: false };
    }

    return { job: result, alreadyClaimed: false };
  }

  /**
   * Complete a job successfully
   */
  completeJob(jobId: string): void {
    const completedAt = now();

    const result = this.db
      .prepare(
        `UPDATE jobs SET
          status = 'completed',
          completed_at = ?,
          last_error = NULL
        WHERE job_id = ? AND status = 'processing'`
      )
      .run(completedAt, jobId);

    if (result.changes === 0) {
      throw new Error(`Job ${jobId} not found or not in processing state`);
    }
  }

  /**
   * Fail a job with error
   *
   * If attempts >= max_attempts, moves to 'dead' status.
   * Otherwise, moves to 'failed' with next_retry_at.
   */
  failJob(jobId: string, error: string, retryDelayMs = 60000): void {
    const currentTime = now();

    // Get current job state
    const job = this.db.prepare('SELECT * FROM jobs WHERE job_id = ?').get(jobId) as
      | Job
      | undefined;

    if (job === undefined) {
      throw new Error(`Job ${jobId} not found`);
    }

    if (job.status !== 'processing') {
      throw new Error(`Job ${jobId} is not in processing state`);
    }

    // Check if max attempts reached
    if (job.attempts >= job.max_attempts) {
      // Move to dead letter
      this.db
        .prepare(
          `UPDATE jobs SET
            status = 'dead',
            last_error = ?,
            completed_at = ?
          WHERE job_id = ?`
        )
        .run(error, currentTime, jobId);
    } else {
      // Schedule retry
      const nextRetryAt = futureTime(retryDelayMs);
      this.db
        .prepare(
          `UPDATE jobs SET
            status = 'failed',
            last_error = ?,
            next_retry_at = ?,
            claimed_by = NULL,
            claimed_at = NULL,
            lease_expires_at = NULL
          WHERE job_id = ?`
        )
        .run(error, nextRetryAt, jobId);
    }
  }

  /**
   * Renew a job's lease
   *
   * Call this periodically for long-running jobs to prevent lease expiration.
   */
  renewLease(jobId: string, workerId: string, leaseDurationMs = DEFAULT_LEASE_DURATION_MS): boolean {
    const leaseExpiresAt = futureTime(leaseDurationMs);

    const result = this.db
      .prepare(
        `UPDATE jobs SET
          lease_expires_at = ?
        WHERE job_id = ? AND claimed_by = ? AND status = 'processing'`
      )
      .run(leaseExpiresAt, jobId, workerId);

    return result.changes > 0;
  }

  /**
   * Find jobs ready for retry
   *
   * Returns failed jobs where next_retry_at <= NOW()
   */
  findRetryableJobs(queue: JobQueue, limit = 10): Job[] {
    const currentTime = now();

    return this.db
      .prepare(
        `SELECT * FROM jobs
        WHERE queue = ?
          AND status = 'failed'
          AND next_retry_at <= ?
        ORDER BY next_retry_at ASC
        LIMIT ?`
      )
      .all(queue, currentTime, limit) as Job[];
  }

  /**
   * Requeue a failed job for retry
   */
  requeueJob(jobId: string): void {
    const result = this.db
      .prepare(
        `UPDATE jobs SET
          status = 'queued',
          next_retry_at = NULL,
          claimed_by = NULL,
          claimed_at = NULL,
          lease_expires_at = NULL
        WHERE job_id = ? AND status = 'failed'`
      )
      .run(jobId);

    if (result.changes === 0) {
      throw new Error(`Job ${jobId} not found or not in failed state`);
    }
  }

  /**
   * Find jobs with expired leases (for crash recovery)
   */
  findExpiredLeases(limit = 10): Job[] {
    const currentTime = now();

    return this.db
      .prepare(
        `SELECT * FROM jobs
        WHERE status = 'processing'
          AND lease_expires_at < ?
        ORDER BY lease_expires_at ASC
        LIMIT ?`
      )
      .all(currentTime, limit) as Job[];
  }

  /**
   * Get job by ID
   */
  getJob(jobId: string): Job | null {
    const job = this.db.prepare('SELECT * FROM jobs WHERE job_id = ?').get(jobId) as
      | Job
      | undefined;
    return job ?? null;
  }

  /**
   * Get job by idempotency key
   */
  getJobByIdempotencyKey(idempotencyKey: string): Job | null {
    const job = this.db
      .prepare('SELECT * FROM jobs WHERE idempotency_key = ?')
      .get(idempotencyKey) as Job | undefined;
    return job ?? null;
  }

  /**
   * Get queue statistics
   */
  getQueueStats(queue: JobQueue): {
    queued: number;
    processing: number;
    completed: number;
    failed: number;
    dead: number;
  } {
    const stats = this.db
      .prepare(
        `SELECT
          SUM(CASE WHEN status = 'queued' THEN 1 ELSE 0 END) as queued,
          SUM(CASE WHEN status = 'processing' THEN 1 ELSE 0 END) as processing,
          SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
          SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed,
          SUM(CASE WHEN status = 'dead' THEN 1 ELSE 0 END) as dead
        FROM jobs WHERE queue = ?`
      )
      .get(queue) as {
      queued: number;
      processing: number;
      completed: number;
      failed: number;
      dead: number;
    };

    return stats;
  }

  /**
   * Delete old completed jobs (cleanup)
   */
  deleteOldCompletedJobs(olderThanDays: number): number {
    const cutoff = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000).toISOString();

    const result = this.db
      .prepare(
        `DELETE FROM jobs
        WHERE status IN ('completed', 'dead')
          AND completed_at < ?`
      )
      .run(cutoff);

    return result.changes;
  }
}
