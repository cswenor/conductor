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
  // Worktree management (WP4)
  runJanitor,
  cleanupWorktree,
  cloneOrFetchRepo,
  createWorktree,
  getWorktreeForRun,
  // Repos
  getRepo,
  // GitHub App
  initGitHubApp,
  isGitHubAppInitialized,
  getInstallationToken,
  // Runs & Orchestrator (WP5)
  getRun,
  transitionPhase,
  TERMINAL_PHASES,
  type Run,
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
  githubAppId: string;
  githubPrivateKey: string;
  githubWebhookSecret: string;
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

  const githubAppId = getEnv({
    name: 'GITHUB_APP_ID',
    type: 'string',
    required: true,
    description: 'GitHub App ID',
  });

  const githubPrivateKey = getEnv({
    name: 'GITHUB_PRIVATE_KEY',
    type: 'string',
    required: true,
    description: 'GitHub App private key (PEM format or base64)',
  });

  const githubWebhookSecret = getEnv({
    name: 'GITHUB_WEBHOOK_SECRET',
    type: 'string',
    required: true,
    description: 'GitHub webhook secret for signature verification',
  });

  return {
    databasePath,
    redisUrl,
    concurrency: Number.parseInt(concurrencyStr, 10),
    githubAppId,
    githubPrivateKey,
    githubWebhookSecret,
  };
}

/**
 * Process webhook jobs
 *
 * Pipeline: webhook delivery -> normalize -> persist event -> mark processed
 * Note: All database operations are synchronous (better-sqlite3), but BullMQ
 * requires processors to return Promise<void>
 */
async function processWebhook(job: Job<WebhookJobData>): Promise<void> {
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
    return Promise.reject(new Error(`Webhook delivery ${deliveryId} not found`));
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
    return Promise.resolve();
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
    return Promise.resolve();
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
    return Promise.resolve();
  }

  // Mark webhook as processed
  updateWebhookStatus(db, deliveryId, 'processed', {
    processedAt: new Date().toISOString(),
  });

  log.info(
    { deliveryId, eventId: event.eventId, eventType: normalized.eventType },
    'Webhook processed successfully'
  );

  return Promise.resolve();
}

/**
 * Process run jobs (start, resume, cancel, timeout)
 */
async function processRun(job: Job<RunJobData>): Promise<void> {
  const { runId, action, triggeredBy } = job.data;
  log.info({ runId, action, triggeredBy }, 'Processing run');

  const db = getDatabase();

  // Fetch the run record
  const run = getRun(db, runId);

  if (run === null) {
    log.error({ runId }, 'Run not found');
    return;
  }

  // Idempotency guard: skip if already in terminal state
  if (TERMINAL_PHASES.has(run.phase)) {
    log.info({ runId, phase: run.phase }, 'Run already in terminal state, skipping');
    return;
  }

  switch (action) {
    case 'start':
      await handleRunStart(db, run);
      break;
    case 'cancel':
      handleRunCancel(db, run, triggeredBy);
      break;
    case 'timeout':
      handleRunTimeout(db, run);
      break;
    case 'resume':
      // No-op stub — pause/resume is WP11
      log.info({ runId }, 'Run resume not yet implemented (WP11)');
      break;
    default:
      log.warn({ runId, action }, 'Unknown run action');
  }
}

/**
 * Handle the 'start' action for a run.
 * Clones/fetches the repo, creates a worktree, and advances run state.
 */
async function handleRunStart(
  db: ReturnType<typeof getDatabase>,
  run: Run
): Promise<void> {
  const { runId, projectId, repoId, baseBranch } = run;

  log.info({ runId, projectId, repoId }, 'Starting run');

  // 1. Check if worktree already exists (idempotency)
  const existingWorktree = getWorktreeForRun(db, runId);
  if (existingWorktree !== null) {
    log.info({ runId, worktreeId: existingWorktree.worktreeId }, 'Worktree already exists for run');
    // Update git state (branch/head_sha) directly — not a phase change
    db.prepare(
      'UPDATE runs SET branch = ?, head_sha = ?, updated_at = ? WHERE run_id = ?'
    ).run(existingWorktree.branchName, existingWorktree.baseCommit, new Date().toISOString(), runId);
    // Advance phase via orchestrator
    const result = transitionPhase(db, {
      runId,
      toPhase: 'planning',
      toStep: 'route',
      triggeredBy: 'system',
      reason: 'Worktree ready (existing)',
    });
    if (!result.success) {
      log.warn({ runId, error: result.error }, 'Phase transition failed (idempotency — may already be advanced)');
    }
    return;
  }

  // 2. Look up repo
  const repo = getRepo(db, repoId);
  if (repo === null) {
    markRunFailed(db, runId, `Repo ${repoId} not found`);
    return;
  }

  // 3. Look up installation ID from project
  const projectStmt = db.prepare('SELECT github_installation_id FROM projects WHERE project_id = ?');
  const projectRow = projectStmt.get(projectId) as { github_installation_id: number | null } | undefined;

  const installationId = projectRow?.github_installation_id;
  if (installationId === undefined || installationId === null) {
    markRunFailed(db, runId, `No GitHub installation found for project ${projectId}`);
    return;
  }

  // 4. Get installation token
  let installationToken: string;
  try {
    installationToken = await getInstallationToken(installationId);
  } catch (err) {
    markRunFailed(db, runId, `Failed to get installation token: ${err instanceof Error ? err.message : 'Unknown error'}`);
    return;
  }

  // 5. Clone or fetch repo
  try {
    cloneOrFetchRepo(db, {
      projectId,
      repoId,
      githubOwner: repo.githubOwner,
      githubName: repo.githubName,
      installationToken,
    });
  } catch (err) {
    markRunFailed(db, runId, `Failed to clone/fetch repo: ${err instanceof Error ? err.message : 'Unknown error'}`);
    return;
  }

  // 6. Create worktree
  let worktree;
  try {
    worktree = createWorktree(db, {
      runId,
      projectId,
      repoId,
      baseBranch,
    });
  } catch (err) {
    markRunFailed(db, runId, `Failed to create worktree: ${err instanceof Error ? err.message : 'Unknown error'}`);
    return;
  }

  // 7. Update git state (branch/head_sha) — not a phase change
  db.prepare(
    'UPDATE runs SET branch = ?, head_sha = ?, updated_at = ? WHERE run_id = ?'
  ).run(worktree.branchName, worktree.baseCommit, new Date().toISOString(), runId);

  // 8. Advance phase via orchestrator
  const result = transitionPhase(db, {
    runId,
    toPhase: 'planning',
    toStep: 'route',
    triggeredBy: 'system',
    reason: 'Worktree ready',
  });

  if (!result.success) {
    log.error({ runId, error: result.error }, 'Failed to transition to planning');
    return;
  }

  log.info(
    { runId, worktreeId: worktree.worktreeId, branch: worktree.branchName, baseCommit: worktree.baseCommit },
    'Run started successfully'
  );
}

/**
 * Handle the 'cancel' action for a run.
 */
function handleRunCancel(
  db: ReturnType<typeof getDatabase>,
  run: Run,
  triggeredBy?: string
): void {
  const { runId } = run;

  log.info({ runId, triggeredBy }, 'Cancelling run');

  const result = transitionPhase(db, {
    runId,
    toPhase: 'cancelled',
    toStep: 'cleanup',
    triggeredBy: triggeredBy ?? 'system',
    result: 'cancelled',
  });

  if (!result.success) {
    log.error({ runId, error: result.error }, 'Failed to transition to cancelled');
    return;
  }

  // Best-effort worktree cleanup
  try {
    cleanupWorktree(db, runId);
  } catch (err) {
    log.warn(
      { runId, error: err instanceof Error ? err.message : 'Unknown' },
      'Worktree cleanup failed during cancel (janitor will reconcile)'
    );
  }

  log.info({ runId }, 'Run cancelled');
}

/**
 * Handle the 'timeout' action for a run.
 * Uses 'cancelled' since it's reachable from all non-terminal phases.
 */
function handleRunTimeout(
  db: ReturnType<typeof getDatabase>,
  run: Run
): void {
  const { runId } = run;

  log.info({ runId }, 'Timing out run');

  const result = transitionPhase(db, {
    runId,
    toPhase: 'cancelled',
    toStep: 'cleanup',
    triggeredBy: 'system',
    result: 'failure',
    resultReason: 'Run timed out',
  });

  if (!result.success) {
    log.error({ runId, error: result.error }, 'Failed to transition to cancelled (timeout)');
    return;
  }

  // Best-effort worktree cleanup
  try {
    cleanupWorktree(db, runId);
  } catch (err) {
    log.warn(
      { runId, error: err instanceof Error ? err.message : 'Unknown' },
      'Worktree cleanup failed during timeout (janitor will reconcile)'
    );
  }

  log.info({ runId }, 'Run timed out');
}

/**
 * Mark a run as blocked due to a failure.
 */
function markRunFailed(
  db: ReturnType<typeof getDatabase>,
  runId: string,
  reason: string
): void {
  const result = transitionPhase(db, {
    runId,
    toPhase: 'blocked',
    triggeredBy: 'system',
    blockedReason: reason,
    blockedContext: { error: reason },
  });

  if (!result.success) {
    log.error({ runId, reason, transitionError: result.error }, 'Failed to transition to blocked');
    return;
  }

  log.error({ runId, reason }, 'Run blocked due to failure');
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
  const { type, targetId } = job.data;
  log.info({ type, targetId }, 'Processing cleanup');

  const db = getDatabase();

  switch (type) {
    case 'worktree': {
      // targetId is the run_id for worktree cleanup
      if (targetId === undefined) {
        log.error({ type }, 'Worktree cleanup requires targetId (run_id)');
        throw new Error('Worktree cleanup requires targetId');
      }
      const cleaned = cleanupWorktree(db, targetId);
      if (cleaned) {
        log.info({ runId: targetId }, 'Worktree cleanup completed');
      } else {
        log.info({ runId: targetId }, 'No active worktree found for run');
      }
      break;
    }
    case 'expired_leases':
      // TODO: Implement lease cleanup in WP5+
      log.info({ targetId }, 'Expired leases cleanup not yet implemented');
      break;
    case 'old_jobs':
      // TODO: Implement old job cleanup
      log.info({ targetId }, 'Old jobs cleanup not yet implemented');
      break;
    default:
      log.warn({ type, targetId }, 'Unknown cleanup type');
  }

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

  // Initialize GitHub App (needed for processRun and processGitHubWrite)
  if (!isGitHubAppInitialized()) {
    initGitHubApp({
      appId: config.githubAppId,
      privateKey: config.githubPrivateKey,
      webhookSecret: config.githubWebhookSecret,
    });
    log.info('GitHub App initialized');
  }

  // Run janitor to reconcile DB and filesystem state before processing jobs
  log.info('Running worktree janitor');
  const janitorResult = runJanitor(getDatabase());
  log.info(
    {
      orphanedWorktreesMarked: janitorResult.orphanedWorktreesMarked,
      orphanedDirectoriesRemoved: janitorResult.orphanedDirectoriesRemoved,
      stalePortsReleased: janitorResult.stalePortsReleased,
      errors: janitorResult.errors.length,
    },
    'Janitor completed'
  );

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
