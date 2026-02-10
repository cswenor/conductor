/**
 * GitHub Write Outbox Processor
 *
 * Processes pending writes from the outbox using the GitHubClient.
 * Handles execution, retries, and status updates.
 */

import type { Database } from 'better-sqlite3';
import { createLogger } from '../logger/index.ts';
import { GitHubClient } from '../github/client.ts';
import {
  getWrite,
  listPendingWrites,
  markWriteProcessing,
  markWriteCompleted,
  markWriteFailed,
  shouldRetry,
  type GitHubWriteRecord,
  type CommentWritePayload,
  type PullRequestWritePayload,
  type CheckRunWritePayload,
  type BranchWritePayload,
  type LabelWritePayload,
} from './index.ts';

const log = createLogger({ name: 'conductor:outbox-processor' });

// =============================================================================
// High-Level Write Functions
// =============================================================================

/**
 * Enqueue a comment to be posted
 */
export interface EnqueueCommentInput {
  db: Database;
  runId: string;
  owner: string;
  repo: string;
  issueNumber: number;
  issueNodeId: string;
  body: string;
}

/**
 * Enqueue a pull request to be created
 */
export interface EnqueuePullRequestInput {
  db: Database;
  runId: string;
  owner: string;
  repo: string;
  repoNodeId: string;
  title: string;
  body: string;
  head: string;
  base: string;
  draft?: boolean;
}

/**
 * Enqueue a check run to be created/updated
 */
export interface EnqueueCheckRunInput {
  db: Database;
  runId: string;
  owner: string;
  repo: string;
  commitSha: string;
  name: string;
  status?: 'queued' | 'in_progress' | 'completed';
  conclusion?: 'success' | 'failure' | 'neutral' | 'cancelled' | 'skipped' | 'timed_out';
  title?: string;
  summary?: string;
  detailsUrl?: string;
  checkRunId?: number;
}

// Import enqueueWrite from the main outbox module
import { enqueueWrite, type EnqueueWriteResult } from './index.ts';

/**
 * Enqueue a comment to be posted to an issue or PR
 */
export function enqueueComment(input: EnqueueCommentInput): EnqueueWriteResult {
  const payload: CommentWritePayload = {
    owner: input.owner,
    repo: input.repo,
    issueNumber: input.issueNumber,
    body: input.body,
  };

  return enqueueWrite(input.db, {
    runId: input.runId,
    kind: 'comment',
    targetNodeId: input.issueNodeId,
    targetType: 'issue',
    payload,
  });
}

/**
 * Enqueue a pull request to be created
 */
export function enqueuePullRequest(input: EnqueuePullRequestInput): EnqueueWriteResult {
  const payload: PullRequestWritePayload = {
    owner: input.owner,
    repo: input.repo,
    title: input.title,
    body: input.body,
    head: input.head,
    base: input.base,
    draft: input.draft,
  };

  return enqueueWrite(input.db, {
    runId: input.runId,
    kind: 'pull_request',
    targetNodeId: input.repoNodeId,
    targetType: 'repository',
    payload,
  });
}

/**
 * Enqueue a check run to be created or updated
 */
export function enqueueCheckRun(input: EnqueueCheckRunInput): EnqueueWriteResult {
  const payload: CheckRunWritePayload = {
    owner: input.owner,
    repo: input.repo,
    headSha: input.commitSha,
    name: input.name,
    status: input.status,
    conclusion: input.conclusion,
    title: input.title,
    summary: input.summary,
    detailsUrl: input.detailsUrl,
    checkRunId: input.checkRunId,
  };

  return enqueueWrite(input.db, {
    runId: input.runId,
    kind: 'check_run',
    targetNodeId: input.commitSha,
    targetType: 'commit',
    payload,
  });
}

// =============================================================================
// Write Execution
// =============================================================================

/**
 * Result of processing a single write
 */
export interface ProcessWriteResult {
  githubWriteId: string;
  success: boolean;
  githubId?: number;
  githubUrl?: string;
  nodeId?: string;
  number?: number;
  error?: string;
  retryable: boolean;
}

/**
 * Execute a single write operation
 */
export async function executeWrite(
  client: GitHubClient,
  write: GitHubWriteRecord
): Promise<ProcessWriteResult> {
  if (write.payload === undefined) {
    return {
      githubWriteId: write.githubWriteId,
      success: false,
      error: 'Write payload is missing',
      retryable: false,
    };
  }

  try {
    switch (write.kind) {
      case 'comment': {
        const payload = write.payload as CommentWritePayload;
        const result = await client.createComment({
          owner: payload.owner,
          repo: payload.repo,
          issueNumber: payload.issueNumber,
          body: payload.body,
        });
        return {
          githubWriteId: write.githubWriteId,
          success: true,
          githubId: result.id,
          githubUrl: result.htmlUrl,
          retryable: false,
        };
      }

      case 'pull_request': {
        const payload = write.payload as PullRequestWritePayload;
        const result = await client.createPullRequest({
          owner: payload.owner,
          repo: payload.repo,
          title: payload.title,
          body: payload.body,
          head: payload.head,
          base: payload.base,
          draft: payload.draft,
        });
        return {
          githubWriteId: write.githubWriteId,
          success: true,
          githubId: result.id,
          githubUrl: result.htmlUrl,
          nodeId: result.nodeId,
          number: result.number,
          retryable: false,
        };
      }

      case 'check_run': {
        const payload = write.payload as CheckRunWritePayload;
        if (payload.checkRunId !== undefined) {
          // Update existing check run
          await client.updateCheckRun(
            payload.owner,
            payload.repo,
            payload.checkRunId,
            {
              status: payload.status,
              conclusion: payload.conclusion,
              title: payload.title,
              summary: payload.summary,
            }
          );
          return {
            githubWriteId: write.githubWriteId,
            success: true,
            githubId: payload.checkRunId,
            retryable: false,
          };
        } else {
          // Create new check run
          const result = await client.createCheckRun(
            payload.owner,
            payload.repo,
            {
              name: payload.name,
              headSha: payload.headSha,
              status: payload.status,
              conclusion: payload.conclusion,
              title: payload.title,
              summary: payload.summary,
              detailsUrl: payload.detailsUrl,
            }
          );
          return {
            githubWriteId: write.githubWriteId,
            success: true,
            githubId: result.id,
            githubUrl: result.htmlUrl,
            retryable: false,
          };
        }
      }

      case 'branch': {
        const payload = write.payload as BranchWritePayload;
        const result = await client.createBranch({
          owner: payload.owner,
          repo: payload.repo,
          branchName: payload.branchName,
          fromSha: payload.fromSha,
        });
        return {
          githubWriteId: write.githubWriteId,
          success: true,
          githubUrl: `https://github.com/${payload.owner}/${payload.repo}/tree/${result.ref.replace('refs/heads/', '')}`,
          retryable: false,
        };
      }

      case 'label': {
        const _payload = write.payload as LabelWritePayload;
        // Use the Octokit instance directly for label operations
        // This would require extending GitHubClient - for now, return not implemented
        return {
          githubWriteId: write.githubWriteId,
          success: false,
          error: `Label writes not yet implemented for ${_payload.owner}/${_payload.repo}`,
          retryable: false,
        };
      }

      case 'review': {
        // PR review writes - not yet implemented
        return {
          githubWriteId: write.githubWriteId,
          success: false,
          error: 'Review writes not yet implemented',
          retryable: false,
        };
      }

      case 'project_field_update': {
        // GitHub Projects field updates - not yet implemented
        return {
          githubWriteId: write.githubWriteId,
          success: false,
          error: 'Project field update writes not yet implemented',
          retryable: false,
        };
      }

      default: {
        // Exhaustive check - this should never happen if all GitHubWriteKind values are handled
        const unknownKind: never = write.kind;
        return {
          githubWriteId: write.githubWriteId,
          success: false,
          error: `Unknown write kind: ${String(unknownKind)}`,
          retryable: false,
        };
      }
    }
  } catch (err) {
    const error = err instanceof Error ? err.message : 'Unknown error';
    const isRetryable = isRetryableError(err);

    log.warn(
      { githubWriteId: write.githubWriteId, kind: write.kind, error, retryable: isRetryable },
      'Write execution failed'
    );

    return {
      githubWriteId: write.githubWriteId,
      success: false,
      error,
      retryable: isRetryable,
    };
  }
}

/**
 * Determine if an error is retryable
 */
function isRetryableError(err: unknown): boolean {
  if (!(err instanceof Error)) {
    return false;
  }

  const message = err.message.toLowerCase();

  // Rate limiting errors are retryable
  if (message.includes('rate limit') || message.includes('too many requests')) {
    return true;
  }

  // Server errors are typically retryable
  if (message.includes('500') || message.includes('502') || message.includes('503')) {
    return true;
  }

  // Network errors are retryable
  if (message.includes('network') || message.includes('timeout') || message.includes('econnreset')) {
    return true;
  }

  // Client errors (4xx except rate limit) are generally not retryable
  if (message.includes('404') || message.includes('403') || message.includes('401')) {
    return false;
  }

  // Default to not retryable to avoid infinite loops
  return false;
}

// =============================================================================
// Batch Processing
// =============================================================================

/**
 * Options for processing the outbox
 */
export interface ProcessOutboxOptions {
  /** Installation ID for GitHub API calls */
  installationId: number;
  /** Maximum number of writes to process */
  limit?: number;
  /** Only process writes for this run */
  runId?: string;
  /** Maximum retries before giving up */
  maxRetries?: number;
}

/**
 * Result of processing the outbox
 */
export interface ProcessOutboxResult {
  processed: number;
  succeeded: number;
  failed: number;
  retrying: number;
}

/**
 * Process pending writes from the outbox
 */
export async function processOutbox(
  db: Database,
  options: ProcessOutboxOptions
): Promise<ProcessOutboxResult> {
  const limit = options.limit ?? 50;
  const maxRetries = options.maxRetries ?? 5;

  const client = new GitHubClient(options.installationId);
  const pendingWrites = listPendingWrites(db, {
    runId: options.runId,
    limit,
  });

  const result: ProcessOutboxResult = {
    processed: 0,
    succeeded: 0,
    failed: 0,
    retrying: 0,
  };

  for (const write of pendingWrites) {
    // Skip if max retries exceeded
    if (!shouldRetry(write.retryCount, maxRetries)) {
      log.warn(
        { githubWriteId: write.githubWriteId, retryCount: write.retryCount },
        'Write exceeded max retries, skipping'
      );
      continue;
    }

    // Try to claim the write
    const claimed = markWriteProcessing(db, write.githubWriteId);
    if (!claimed) {
      // Already being processed by another worker
      continue;
    }

    result.processed++;

    // Re-fetch to get latest state (including payload)
    const currentWrite = getWrite(db, write.githubWriteId);
    if (currentWrite === null) {
      continue;
    }

    // Execute the write
    const execResult = await executeWrite(client, currentWrite);

    if (execResult.success) {
      markWriteCompleted(db, write.githubWriteId, {
        githubId: execResult.githubId,
        githubUrl: execResult.githubUrl,
        githubNumber: execResult.number,
      });
      result.succeeded++;
    } else {
      markWriteFailed(db, write.githubWriteId, execResult.error ?? 'Unknown error');
      if (execResult.retryable && shouldRetry(write.retryCount + 1, maxRetries)) {
        result.retrying++;
      } else {
        result.failed++;
      }
    }
  }

  log.info(
    {
      processed: result.processed,
      succeeded: result.succeeded,
      failed: result.failed,
      retrying: result.retrying,
    },
    'Outbox processing complete'
  );

  return result;
}

/**
 * Process a single write by ID
 */
export async function processSingleWrite(
  db: Database,
  githubWriteId: string,
  installationId: number
): Promise<ProcessWriteResult> {
  const write = getWrite(db, githubWriteId);
  if (write === null) {
    return {
      githubWriteId,
      success: false,
      error: 'Write not found',
      retryable: false,
    };
  }

  // Try to claim the write
  const claimed = markWriteProcessing(db, githubWriteId);
  if (!claimed) {
    return {
      githubWriteId,
      success: false,
      error: 'Write already being processed or completed',
      retryable: false,
    };
  }

  const client = new GitHubClient(installationId);
  const result = await executeWrite(client, write);

  if (result.success) {
    markWriteCompleted(db, githubWriteId, {
      githubId: result.githubId,
      githubUrl: result.githubUrl,
      githubNumber: result.number,
    });
  } else {
    markWriteFailed(db, githubWriteId, result.error ?? 'Unknown error');
  }

  return result;
}
