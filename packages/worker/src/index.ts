/**
 * Conductor Worker
 *
 * Standalone process that consumes jobs from BullMQ queues and executes
 * orchestration logic.
 */

import { Worker, Job } from 'bullmq';
import {
  type JobQueue,
  initQueueManager,
  getQueueManager,
  closeQueueManager,
  type WebhookJobData,
  type RunJobData,
  type AgentJobData,
  type CleanupJobData,
  type GitHubWriteJobData,
} from '@conductor/shared';

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
  redisUrl: string;
  concurrency: number;
}

/** Load configuration from environment */
function loadConfig(): WorkerConfig {
  return {
    redisUrl: process.env['REDIS_URL'] ?? 'redis://localhost:6379',
    concurrency: parseInt(process.env['WORKER_CONCURRENCY'] ?? '1', 10),
  };
}

/** Logger utility */
const log = {
  // eslint-disable-next-line no-console
  info: (msg: string, data?: Record<string, unknown>) => console.log(`[INFO] ${msg}`, data ?? ''),
  // eslint-disable-next-line no-console
  error: (msg: string, data?: Record<string, unknown>) => console.error(`[ERROR] ${msg}`, data ?? ''),
  // eslint-disable-next-line no-console
  warn: (msg: string, data?: Record<string, unknown>) => console.warn(`[WARN] ${msg}`, data ?? ''),
};

/**
 * Process webhook jobs
 */
async function processWebhook(job: Job<WebhookJobData>): Promise<void> {
  log.info(`Processing webhook: ${job.data.deliveryId}`, {
    eventType: job.data.eventType,
    action: job.data.action,
  });
  // TODO: Implement webhook processing in WP2
  await Promise.resolve();
}

/**
 * Process run jobs (start, resume, cancel, timeout)
 */
async function processRun(job: Job<RunJobData>): Promise<void> {
  log.info(`Processing run: ${job.data.runId}`, {
    action: job.data.action,
  });
  // TODO: Implement run processing in WP3+
  await Promise.resolve();
}

/**
 * Process agent invocation jobs
 */
async function processAgent(job: Job<AgentJobData>): Promise<void> {
  log.info(`Processing agent: ${job.data.agent}`, {
    runId: job.data.runId,
    action: job.data.action,
  });
  // TODO: Implement agent processing in WP3+
  await Promise.resolve();
}

/**
 * Process cleanup jobs (worktrees, expired leases, old jobs)
 */
async function processCleanup(job: Job<CleanupJobData>): Promise<void> {
  log.info(`Processing cleanup: ${job.data.type}`, {
    targetId: job.data.targetId,
  });
  // TODO: Implement cleanup processing
  await Promise.resolve();
}

/**
 * Process GitHub write jobs (outbox pattern)
 */
async function processGitHubWrite(job: Job<GitHubWriteJobData>): Promise<void> {
  log.info(`Processing GitHub write: ${job.data.kind}`, {
    runId: job.data.runId,
    targetNodeId: job.data.targetNodeId,
    retryCount: job.data.retryCount,
  });
  // TODO: Implement GitHub write processing in WP2
  await Promise.resolve();
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
    log.warn('Shutdown already in progress, ignoring signal', { signal });
    return;
  }

  isShuttingDown = true;
  log.info(`Received ${signal}, starting graceful shutdown...`);

  // Close all workers (waits for current jobs to complete)
  log.info('Closing workers...');
  await Promise.all(workers.map(w => w.close()));

  // Close queue manager (closes Redis connections)
  log.info('Closing queue manager...');
  await closeQueueManager();

  log.info('Shutdown complete');
  process.exit(0);
}

/**
 * Main entry point
 */
async function main(): Promise<void> {
  const config = loadConfig();

  log.info('Conductor Worker starting...', {
    redisUrl: config.redisUrl.replace(/\/\/.*@/, '//***@'), // Redact password
    concurrency: config.concurrency,
    queues: QUEUES,
  });

  // Initialize queue manager
  initQueueManager({ redisUrl: config.redisUrl });
  const queueManager = getQueueManager();

  // Verify Redis connection
  const health = await queueManager.healthCheck();
  if (!health.healthy) {
    throw new Error('Failed to connect to Redis');
  }
  log.info('Connected to Redis', { latencyMs: health.latencyMs });

  // Create workers for each queue
  log.info('Starting queue workers...');

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
      log.error(`Job failed: ${job?.id ?? 'unknown'}`, {
        queue: worker.name,
        error: err.message,
      });
    });

    worker.on('error', (err) => {
      log.error(`Worker error: ${worker.name}`, { error: err.message });
    });
  }

  // Register shutdown handlers
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  log.info('Worker ready', {
    workers: workers.length,
    queues: QUEUES,
  });
}

// Start the worker
main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : 'Unknown error';
  log.error('Worker failed to start', { error: message });
  process.exit(1);
});
