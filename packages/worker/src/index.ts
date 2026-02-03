/**
 * Conductor Worker
 *
 * Standalone process that consumes jobs from BullMQ queues and executes
 * orchestration logic.
 */

import { Worker, Job } from 'bullmq';
import {
  type JobQueue,
  getQueueManager,
  getDatabase,
  type WebhookJobData,
  type RunJobData,
  type AgentJobData,
  type CleanupJobData,
  type GitHubWriteJobData,
  createLogger,
  getEnv,
  validateRedisUrl,
  validateNumber,
  bootstrap,
  shutdown as bootstrapShutdown,
  // Webhook processing
  getWebhookDelivery,
  updateWebhookStatus,
  normalizeWebhook,
  createEvent,
  // Outbox processing
  processSingleWrite,
  getWrite,
  markWriteFailed,
} from '@conductor/shared';

const log = createLogger({ name: 'conductor:worker' });

/** All queues the worker consumes from */
const QUEUES: JobQueue[] = [
  'webhooks',
  'runs',
  'agents',
  'cleanup',
  'github_writes',
];

/** Worker configuration from environment */
interface WorkerConfig {
  databasePath: string;
  redisUrl: string;
  concurrency: number;
}

/** Load configuration from environment with validation */
function loadConfig(): WorkerConfig {
  const databasePath = getEnv({
    name: 'DATABASE_PATH',
    type: 'path',
    required: false,
    default: './conductor.db',
    description: 'SQLite database file path',
  });

  const redisUrl = getEnv({
    name: 'REDIS_URL',
    type: 'url',
    required: false,
    default: 'redis://localhost:6379',
    validate: validateRedisUrl,
    description: 'Redis connection URL',
  });

  const concurrencyStr = getEnv({
    name: 'WORKER_CONCURRENCY',
    type: 'number',
    required: false,
    default: '1',
    validate: (val) => validateNumber(val, { min: 1, max: 100 }),
    description: 'Number of concurrent jobs per queue',
  });

  return {
    databasePath,
    redisUrl,
    concurrency: Number.parseInt(concurrencyStr, 10),
  };
}

/**
 * Process webhook jobs
 *
 * Pipeline: webhook delivery -> normalize -> persist event -> mark processed
 * Note: All database operations are synchronous (better-sqlite3)
 */
function processWebhook(job: Job<WebhookJobData>): void {
  const { deliveryId, eventType, action, repositoryNodeId, payloadSummary } = job.data;

  log.info(
    { deliveryId, eventType, action },
    'Processing webhook'
  );

  const db = getDatabase();

  // Get the webhook delivery to verify it exists
  const delivery = getWebhookDelivery(db, deliveryId);
  if (delivery === null) {
    log.error({ deliveryId }, 'Webhook delivery not found');
    throw new Error(`Webhook delivery ${deliveryId} not found`);
  }

  // Normalize the webhook into an internal event
  const normalized = normalizeWebhook(deliveryId, eventType, action, payloadSummary);

  if (normalized === null) {
    // Event type not supported or action not handled
    updateWebhookStatus(db, deliveryId, 'ignored', {
      ignoreReason: `Event type '${eventType}' action '${action ?? 'none'}' not handled`,
      processedAt: new Date().toISOString(),
    });
    log.info({ deliveryId, eventType, action }, 'Webhook ignored (unhandled event type/action)');
    return;
  }

  // Find the project for this repository (if any)
  // For now, we'll use a placeholder project ID since project lookup requires WP3
  // In the full implementation, we'd look up the repo by node_id and get its project_id
  let projectId: string | null = null;

  if (repositoryNodeId !== undefined) {
    const repoStmt = db.prepare('SELECT project_id FROM repos WHERE github_node_id = ?');
    const repo = repoStmt.get(repositoryNodeId) as { project_id: string } | undefined;
    projectId = repo?.project_id ?? null;
  }

  if (projectId === null) {
    // No project found for this repository - can't create event without project
    updateWebhookStatus(db, deliveryId, 'ignored', {
      ignoreReason: `No project found for repository ${repositoryNodeId ?? 'unknown'}`,
      processedAt: new Date().toISOString(),
    });
    log.info({ deliveryId, repositoryNodeId }, 'Webhook ignored (no project for repo)');
    return;
  }

  // Create the internal event
  const event = createEvent(db, {
    projectId,
    repoId: undefined, // Would be looked up from repos table
    type: normalized.eventType,
    class: normalized.class,
    payload: normalized.payload,
    idempotencyKey: normalized.idempotencyKey,
    source: 'webhook',
  });

  if (event === null) {
    // Duplicate event (idempotency)
    updateWebhookStatus(db, deliveryId, 'processed', {
      processedAt: new Date().toISOString(),
    });
    log.info({ deliveryId }, 'Webhook already processed (duplicate event)');
    return;
  }

  // Mark webhook as processed
  updateWebhookStatus(db, deliveryId, 'processed', {
    processedAt: new Date().toISOString(),
  });

  log.info(
    { deliveryId, eventId: event.eventId, eventType: normalized.eventType },
    'Webhook processed successfully'
  );
}

/**
 * Process run jobs (start, resume, cancel, timeout)
 */
async function processRun(job: Job<RunJobData>): Promise<void> {
  log.info({ runId: job.data.runId, action: job.data.action }, 'Processing run');
  // TODO: Implement run processing in WP3+
  await Promise.resolve();
}

/**
 * Process agent invocation jobs
 */
async function processAgent(job: Job<AgentJobData>): Promise<void> {
  log.info(
    { agent: job.data.agent, runId: job.data.runId, action: job.data.action },
    'Processing agent'
  );
  // TODO: Implement agent processing in WP3+
  await Promise.resolve();
}

/**
 * Process cleanup jobs (worktrees, expired leases, old jobs)
 */
async function processCleanup(job: Job<CleanupJobData>): Promise<void> {
  log.info({ type: job.data.type, targetId: job.data.targetId }, 'Processing cleanup');
  // TODO: Implement cleanup processing
  await Promise.resolve();
}

/**
 * Process GitHub write jobs (outbox pattern)
 *
 * Pipeline: get write -> get installation -> execute write -> update status
 */
async function processGitHubWrite(job: Job<GitHubWriteJobData>): Promise<void> {
  const { githubWriteId, runId, kind, targetNodeId, retryCount } = job.data;

  log.info(
    { githubWriteId, runId, kind, targetNodeId, retryCount },
    'Processing GitHub write'
  );

  const db = getDatabase();

  // Get the write record
  const write = getWrite(db, githubWriteId);
  if (write === null) {
    log.error({ githubWriteId }, 'GitHub write not found');
    throw new Error(`GitHub write ${githubWriteId} not found`);
  }

  // Check if already completed or cancelled
  if (write.status === 'completed' || write.status === 'cancelled') {
    log.info({ githubWriteId, status: write.status }, 'GitHub write already finished');
    return;
  }

  // Get the installation ID from the run's project
  const installationStmt = db.prepare(`
    SELECT p.github_installation_id
    FROM runs r
    JOIN projects p ON r.project_id = p.project_id
    WHERE r.run_id = ?
  `);
  const installationRow = installationStmt.get(runId) as { github_installation_id: number } | undefined;

  if (installationRow === undefined) {
    // No installation found - mark as failed
    markWriteFailed(db, githubWriteId, 'Run or project not found, cannot determine GitHub installation');
    log.error({ githubWriteId, runId }, 'Cannot find GitHub installation for write');
    return;
  }

  const installationId = installationRow.github_installation_id;

  // Process the write using the outbox processor
  const result = await processSingleWrite(db, githubWriteId, installationId);

  if (result.success) {
    log.info(
      { githubWriteId, githubId: result.githubId, githubUrl: result.githubUrl },
      'GitHub write completed successfully'
    );
  } else {
    log.warn(
      { githubWriteId, error: result.error, retryable: result.retryable },
      'GitHub write failed'
    );

    // If retryable, throw to trigger BullMQ retry
    if (result.retryable) {
      throw new Error(result.error ?? 'GitHub write failed (retryable)');
    }
  }
}

/** Active workers for graceful shutdown */
const workers: Worker[] = [];

/** Flag to track shutdown state */
let isShuttingDown = false;

/**
 * Graceful shutdown handler
 */
async function shutdown(signal: string): Promise<void> {
  if (isShuttingDown) {
    log.warn({ signal }, 'Shutdown already in progress, ignoring signal');
    return;
  }

  isShuttingDown = true;
  log.info({ signal }, 'Starting graceful shutdown');

  // Close all workers (waits for current jobs to complete)
  log.info('Closing workers');
  await Promise.all(workers.map(w => w.close()));

  // Close bootstrap (queue manager + database)
  log.info('Closing services');
  await bootstrapShutdown();

  log.info('Shutdown complete');
  process.exit(0);
}

/**
 * Main entry point
 */
async function main(): Promise<void> {
  const config = loadConfig();

  log.info(
    {
      databasePath: config.databasePath,
      redisUrl: config.redisUrl.replace(/\/\/.*@/, '//***@'), // Redact password
      concurrency: config.concurrency,
      queues: QUEUES,
    },
    'Conductor Worker starting'
  );

  // Bootstrap database and queue manager
  await bootstrap({
    databasePath: config.databasePath,
    redisUrl: config.redisUrl,
  });

  const queueManager = getQueueManager();
  log.info('Database and Redis initialized');

  // Create workers for each queue
  log.info('Starting queue workers');

  const webhookWorker = queueManager.createWorker('webhooks', processWebhook, {
    concurrency: config.concurrency,
  });
  workers.push(webhookWorker);

  const runWorker = queueManager.createWorker('runs', processRun, {
    concurrency: config.concurrency,
  });
  workers.push(runWorker);

  const agentWorker = queueManager.createWorker('agents', processAgent, {
    concurrency: config.concurrency,
  });
  workers.push(agentWorker);

  const cleanupWorker = queueManager.createWorker('cleanup', processCleanup, {
    concurrency: 1, // Cleanup jobs should run serially
  });
  workers.push(cleanupWorker);

  const githubWriteWorker = queueManager.createWorker('github_writes', processGitHubWrite, {
    concurrency: config.concurrency,
  });
  workers.push(githubWriteWorker);

  // Set up error handlers for all workers
  for (const worker of workers) {
    worker.on('failed', (job, err) => {
      log.error({ jobId: job?.id ?? 'unknown', queue: worker.name, error: err.message }, 'Job failed');
    });

    worker.on('error', (err) => {
      log.error({ queue: worker.name, error: err.message }, 'Worker error');
    });
  }

  // Register shutdown handlers
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  log.info({ workerCount: workers.length, queues: QUEUES }, 'Worker ready');
}

// Start the worker
main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : 'Unknown error';
  log.error({ error: message }, 'Worker failed to start');
  process.exit(1);
});
