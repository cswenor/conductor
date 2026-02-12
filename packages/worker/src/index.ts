/**
 * Conductor Worker
 *
 * Standalone process that consumes jobs from BullMQ queues and executes
 * orchestration logic.
 */

import { config as loadEnv } from 'dotenv';
import { resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

// Load .env.local from monorepo root (same file Next.js reads in the web package).
// __dirname → packages/worker/src (dev) or packages/worker/dist (compiled);
// ../../.. always reaches the monorepo root in both cases.
const __dirname = fileURLToPath(new URL('.', import.meta.url));
const monorepoRoot = resolve(__dirname, '../../..');
loadEnv({ path: resolve(monorepoRoot, '.env.local') });

import { Worker, Job } from 'bullmq';
import { execFileSync } from 'node:child_process';
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
  releaseExpiredPortLeases,
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
  // Agent Runtime (WP6)
  generateAgentInvocationId,
  runPlanner,
  runPlanReviewer,
  runCodeReviewer,
  runImplementerWithTools,
  AgentError,
  AgentAuthError,
  AgentRateLimitError,
  AgentTimeoutError,
  AgentCancelledError,
  registerCancellable,
  unregisterCancellable,
  signalCancellation,
  // Agent Runtime (WP7) - Tool-use mode
  resolveCredentials,
  createProvider,
  // Gates (WP8)
  ensureBuiltInGateDefinitions,
  ensureBuiltInPolicyDefinitions,
  evaluateGatesForPhase,
  evaluateGatesAndTransition,
  persistGateEvaluations,
  // Mirroring (WP9)
  mirrorPhaseTransition,
  mirrorPlanArtifact,
  mirrorFailure,
  flushStaleDeferredEvents,
  enqueueWrite,
  getTask,
  type MirrorContext,
  // Pub/Sub (SSE push)
  initPublisher,
  closePublisher,
  publishTransitionEvent,
} from '@conductor/shared';
import { handlePrCreation } from './pr-creation.ts';
import { cleanOldJobs } from './old-jobs-cleanup.ts';
import { casUpdateRunStep, isStaleRunJob } from './run-helpers.ts';
import { dispatchPrWebhook } from './webhook-dispatch.ts';
import { handleBlockedRetry } from './blocked-retry.ts';

const log = createLogger({ name: 'conductor:worker' });

/** Max planner revision cycles before blocking */
const MAX_PLAN_REVISIONS = 3;

/** Max code review rounds before blocking */
const MAX_REVIEW_ROUNDS = 3;

/**
 * Enqueue an agent job on the agents queue.
 */
async function enqueueAgentJob(
  runId: string,
  agent: string,
  action: string,
  context: Record<string, unknown> = {}
): Promise<void> {
  const qm = getQueueManager();
  const agentInvocationId = generateAgentInvocationId();
  await qm.addJob('agents', `agent-${runId}-${agent}-${action}-${Date.now()}`, {
    runId,
    agentInvocationId,
    agent,
    action,
    context,
  });
  log.info({ runId, agent, action, agentInvocationId }, 'Agent job enqueued');
}

/**
 * Update the run step without changing phase (intra-phase step tracking).
 */
function updateRunStep(
  db: ReturnType<typeof getDatabase>,
  runId: string,
  step: string
): void {
  db.prepare('UPDATE runs SET step = ?, updated_at = ? WHERE run_id = ?')
    .run(step, new Date().toISOString(), runId);
}


/**
 * Build a MirrorContext for posting comments on linked GitHub issues.
 */
function getMirrorCtx(): MirrorContext {
  return {
    db: getDatabase(),
    queueManager: getQueueManager(),
    conductorBaseUrl: process.env['CONDUCTOR_BASE_URL'],
  };
}

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
  const rawDatabasePath = getEnv({
    name: 'DATABASE_PATH',
    type: 'path',
    required: false,
    default: './conductor.db',
    description: 'SQLite database file path',
  });

  // Resolve relative paths against monorepo root so web and worker share the
  // same database file regardless of which package's cwd they run from.
  const databasePath = isAbsolute(rawDatabasePath)
    ? rawDatabasePath
    : resolve(monorepoRoot, rawDatabasePath);

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
    required: false,
    default: '',
    description: 'GitHub App ID',
  });

  const githubPrivateKey = getEnv({
    name: 'GITHUB_PRIVATE_KEY',
    type: 'string',
    required: false,
    default: '',
    description: 'GitHub App private key (PEM format or base64)',
  });

  const githubWebhookSecret = getEnv({
    name: 'GITHUB_WEBHOOK_SECRET',
    type: 'string',
    required: false,
    default: '',
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

  // Look up the project that owns this repository
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
    type: normalized.eventType,
    class: normalized.class,
    payload: normalized.payload,
    idempotencyKey: normalized.idempotencyKey,
    source: 'webhook',
  });

  if (event !== null) {
    log.info(
      { deliveryId, eventId: event.eventId, eventType: normalized.eventType },
      'Webhook processed successfully'
    );
  } else {
    log.info({ deliveryId }, 'Webhook already processed (duplicate event)');
  }

  // --- WP10.4-10.6: Dispatch PR state changes ---
  // Runs regardless of whether event was new or duplicate (crash-retry safety).
  // Both handlePrMerged and handlePrStateChange are internally idempotent.
  await dispatchPrWebhook(db, normalized, (input, result) => {
    try { mirrorPhaseTransition(getMirrorCtx(), input, result); } catch { /* non-fatal */ }
  }, async (runId) => {
    const qm = getQueueManager();
    await qm.addJob('cleanup', `cleanup-merge-${runId}`, {
      type: 'worktree',
      targetId: runId,
    });
  });

  // Mark webhook as processed after all dispatch work completes.
  // If dispatch throws, BullMQ retries with delivery still in 'pending' state.
  updateWebhookStatus(db, deliveryId, 'processed', {
    processedAt: new Date().toISOString(),
  });
}

/**
 * Process run jobs (start, resume, cancel, timeout)
 */
async function processRun(job: Job<RunJobData>): Promise<void> {
  const { runId, action, triggeredBy } = job.data;
  log.info({ runId, action, triggeredBy }, 'Processing run');

  // For cancel/timeout, fire abort signal immediately regardless of current phase.
  // Single call site — handleRunCancel/handleRunTimeout do not duplicate this.
  if (action === 'cancel' || action === 'timeout') {
    signalCancellation(runId);
  }

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

  // Staleness guard: skip jobs when the run has moved on since dispatch.
  // fromPhase checks the phase hasn't changed; fromSequence checks the exact
  // event epoch so a re-blocked run isn't confused with the original episode.
  const staleReason = isStaleRunJob(run, job.data.fromPhase, job.data.fromSequence);
  if (staleReason !== undefined) {
    log.info({ runId, action, reason: staleReason }, 'Stale run job skipped');
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
      await handleRunResume(db, run, triggeredBy);
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
    const transitionInput = {
      runId,
      toPhase: 'planning' as const,
      toStep: 'planner_create_plan' as const,
      triggeredBy: 'system',
      reason: 'Worktree ready (existing)',
    };
    const result = transitionPhase(db, transitionInput);
    if (!result.success) {
      log.warn({ runId, error: result.error }, 'Phase transition failed (idempotency — may already be advanced)');
      return;
    }
    publishTransitionEvent(run.projectId, runId, run.phase, 'planning');
    try { mirrorPhaseTransition(getMirrorCtx(), transitionInput, result); } catch { /* non-fatal */ }
    // Enqueue planner agent
    await enqueueAgentJob(runId, 'planner', 'create_plan');
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
  const startTransitionInput = {
    runId,
    toPhase: 'planning' as const,
    toStep: 'planner_create_plan' as const,
    triggeredBy: 'system',
    reason: 'Worktree ready',
  };
  const result = transitionPhase(db, startTransitionInput);

  if (!result.success) {
    log.error({ runId, error: result.error }, 'Failed to transition to planning');
    return;
  }

  publishTransitionEvent(run.projectId, runId, run.phase, 'planning');
  try { mirrorPhaseTransition(getMirrorCtx(), startTransitionInput, result); } catch { /* non-fatal */ }

  // 9. Enqueue planner agent
  await enqueueAgentJob(runId, 'planner', 'create_plan');

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

  const cancelInput = {
    runId,
    toPhase: 'cancelled' as const,
    toStep: 'cleanup' as const,
    triggeredBy: triggeredBy ?? 'system',
    result: 'cancelled',
  };
  const result = transitionPhase(db, cancelInput);

  if (!result.success) {
    log.error({ runId, error: result.error }, 'Failed to transition to cancelled');
    return;
  }

  publishTransitionEvent(run.projectId, runId, run.phase, 'cancelled');
  try { mirrorPhaseTransition(getMirrorCtx(), cancelInput, result); } catch { /* non-fatal */ }

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

  const timeoutInput = {
    runId,
    toPhase: 'cancelled' as const,
    toStep: 'cleanup' as const,
    triggeredBy: 'system',
    result: 'failure',
    resultReason: 'Run timed out',
  };
  const result = transitionPhase(db, timeoutInput);

  if (!result.success) {
    log.error({ runId, error: result.error }, 'Failed to transition to cancelled (timeout)');
    return;
  }

  publishTransitionEvent(run.projectId, runId, run.phase, 'cancelled');
  try { mirrorPhaseTransition(getMirrorCtx(), timeoutInput, result); } catch { /* non-fatal */ }

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
  const currentRun = getRun(db, runId);
  const priorPhase = currentRun?.phase ?? 'pending';
  const priorStep = currentRun?.step ?? 'setup_worktree';

  const failedInput = {
    runId,
    toPhase: 'blocked' as const,
    triggeredBy: 'system',
    blockedReason: reason,
    blockedContext: { error: reason, prior_phase: priorPhase, prior_step: priorStep },
  };
  const result = transitionPhase(db, failedInput);

  if (!result.success) {
    log.error({ runId, reason, transitionError: result.error }, 'Failed to transition to blocked');
    return;
  }

  publishTransitionEvent(currentRun?.projectId ?? '', runId, priorPhase, 'blocked');
  try {
    const ctx = getMirrorCtx();
    mirrorPhaseTransition(ctx, failedInput, result);
    mirrorFailure(ctx, { runId, blockedReason: reason, blockedContext: failedInput.blockedContext, eventSequence: result.event?.sequence });
  } catch { /* non-fatal */ }

  log.error({ runId, reason }, 'Run blocked due to failure');
}

/**
 * Handle the 'resume' action for a run.
 * Used when an operator approves a plan (awaiting_plan_approval → executing)
 * or when retrying from blocked state.
 */
async function handleRunResume(
  db: ReturnType<typeof getDatabase>,
  run: Run,
  triggeredBy?: string
): Promise<void> {
  const { runId, phase } = run;

  if (phase === 'awaiting_plan_approval') {
    // Evaluate gate + transition atomically via orchestrator boundary.
    // This ensures gate.evaluated events have source='orchestrator' and
    // gate persistence + phase transition happen in a single transaction.
    const { gateCheck, transition: txnResult } = evaluateGatesAndTransition(
      db, run, 'awaiting_plan_approval',
      {
        runId,
        toPhase: 'executing',
        toStep: 'implementer_apply_changes',
        triggeredBy: triggeredBy ?? 'system',
        reason: 'Plan approved by operator',
      },
    );

    if (!gateCheck.allPassed) {
      log.warn(
        { runId, blockedBy: gateCheck.blockedBy },
        'Cannot resume — plan_approval gate not passed'
      );
      return;
    }

    if (txnResult?.success !== true) {
      log.error({ runId, error: txnResult?.error }, 'Failed to transition to executing');
      return;
    }

    publishTransitionEvent(run.projectId, runId, run.phase, 'executing');
    try {
      mirrorPhaseTransition(getMirrorCtx(), {
        runId,
        toPhase: 'executing',
        toStep: 'implementer_apply_changes',
        triggeredBy: triggeredBy ?? 'system',
        reason: 'Plan approved by operator',
      }, txnResult);
    } catch { /* non-fatal */ }

    // Enqueue implementer agent
    await enqueueAgentJob(runId, 'implementer', 'apply_changes');
    log.info({ runId }, 'Run resumed — implementer enqueued');
  } else if (phase === 'blocked') {
    // Delegate to extracted blocked-retry handler
    await handleBlockedRetry(db, run, triggeredBy, {
      enqueueAgent: enqueueAgentJob,
      enqueueRunJob: async (
        retryRunId,
        retryAction,
        retryTriggeredBy,
        fromPhase,
        fromSequence,
      ) => {
        const qm = getQueueManager();
        const jobId = retryAction === 'start'
          ? `run-restart-${retryRunId}-${Date.now()}`
          : `run-pr-retry-${retryRunId}-${Date.now()}`;
        await qm.addJob('runs', jobId, {
          runId: retryRunId,
          action: retryAction as 'start' | 'resume',
          triggeredBy: retryTriggeredBy,
          fromPhase,
          fromSequence,
        });
      },
      mirror: (input, result) => mirrorPhaseTransition(getMirrorCtx(), input, result),
    });
  } else if (phase === 'awaiting_review' && run.step === 'create_pr') {
    // Retry PR creation (e.g. after in-flight write delay)
    log.info({ runId, triggeredBy }, 'Retrying PR creation from awaiting_review/create_pr');
    await handlePrCreation(db, run, markRunFailed, async (retryRunId, delayMs) => {
      const qm = getQueueManager();
      await qm.addJob('runs', `run-pr-retry-${retryRunId}-${Date.now()}`, {
        runId: retryRunId,
        action: 'resume',
        triggeredBy: 'pr-creation-retry',
        fromPhase: 'awaiting_review',
        fromSequence: run.lastEventSequence,
      }, { delay: delayMs });
    });
  } else {
    log.warn({ runId, phase }, 'Resume not valid from this phase');
  }
}

// =============================================================================
// Agent Handlers
// =============================================================================

/**
 * Handle planner agent: create/revise plan, then enqueue plan reviewer.
 */
async function handlePlannerAgent(
  db: ReturnType<typeof getDatabase>,
  run: Run,
  worktreePath?: string
): Promise<void> {
  const { runId } = run;

  updateRunStep(db, runId, 'planner_create_plan');

  const planResult = await runPlanner(db, { runId, worktreePath });

  log.info(
    { runId, artifactId: planResult.artifactId, invocationId: planResult.agentInvocationId },
    'Planner completed'
  );

  // Enqueue plan reviewer
  updateRunStep(db, runId, 'reviewer_review_plan');
  await enqueueAgentJob(runId, 'reviewer', 'review_plan');
}

/**
 * Handle plan reviewer: approve → awaiting_plan_approval, reject → re-run planner.
 */
async function handlePlanReviewerAgent(
  db: ReturnType<typeof getDatabase>,
  run: Run,
  worktreePath?: string
): Promise<void> {
  const { runId } = run;

  const reviewResult = await runPlanReviewer(db, { runId, worktreePath });

  log.info(
    { runId, approved: reviewResult.approved, artifactId: reviewResult.artifactId },
    'Plan reviewer completed'
  );

  if (reviewResult.approved) {
    // Transition to awaiting_plan_approval (human gate)
    const planApprovalInput = {
      runId,
      toPhase: 'awaiting_plan_approval' as const,
      toStep: 'wait_plan_approval' as const,
      triggeredBy: 'system',
      reason: 'Plan approved by AI reviewer',
    };
    const result = transitionPhase(db, planApprovalInput);

    if (!result.success) {
      log.error({ runId, error: result.error }, 'Failed to transition to awaiting_plan_approval');
    } else {
      publishTransitionEvent(run.projectId, runId, run.phase, 'awaiting_plan_approval');
      try {
        const ctx = getMirrorCtx();
        mirrorPhaseTransition(ctx, planApprovalInput, result);
        mirrorPlanArtifact(ctx, runId);
      } catch { /* non-fatal */ }
    }
  } else {
    // Re-read run to get current plan_revisions
    const currentRun = getRun(db, runId);
    if (currentRun !== null && currentRun.planRevisions >= MAX_PLAN_REVISIONS) {
      // Too many revisions — block the run
      markRunFailed(db, runId, `Plan rejected after ${MAX_PLAN_REVISIONS} revisions. Manual intervention required.`);
      return;
    }

    // Re-run planner with review feedback
    log.info({ runId, planRevisions: currentRun?.planRevisions }, 'Plan rejected, re-running planner');
    updateRunStep(db, runId, 'planner_create_plan');
    await enqueueAgentJob(runId, 'planner', 'create_plan');
  }
}

/**
 * Handle implementer agent: apply code changes via tools, git commit, enqueue code reviewer.
 */
async function handleImplementerAgent(
  db: ReturnType<typeof getDatabase>,
  run: Run,
  worktreePath?: string
): Promise<void> {
  const { runId } = run;

  if (worktreePath === undefined) {
    markRunFailed(db, runId, 'No worktree available for implementer');
    return;
  }

  // Resolve credentials and create provider for tool-use mode
  let creds: Awaited<ReturnType<typeof resolveCredentials>>;
  try {
    creds = await resolveCredentials(db, {
      runId,
      step: 'implementer_apply_changes',
    });
  } catch (credErr) {
    const msg = credErr instanceof Error ? credErr.message : 'Credential resolution failed';
    markRunFailed(db, runId, msg);
    return;
  }

  if (creds.mode !== 'ai_provider') {
    markRunFailed(db, runId, `Implementer requires AI provider credentials (got: ${creds.mode})`);
    return;
  }

  const provider = createProvider(creds.provider, creds.apiKey);

  const implResult = await runImplementerWithTools(db, { runId, worktreePath, provider });

  log.info(
    { runId, fileCount: implResult.files.length, artifactId: implResult.artifactId },
    'Implementer completed (tool-use mode)'
  );

  // Tools already wrote files to disk — just git add + commit
  if (implResult.files.length > 0) {
    try {
      execFileSync('git', ['add', '-A'], { cwd: worktreePath });
      execFileSync('git', ['commit', '-m', `conductor: implement changes for run ${runId}`], {
        cwd: worktreePath,
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: 'Conductor',
          GIT_AUTHOR_EMAIL: 'conductor@noreply',
          GIT_COMMITTER_NAME: 'Conductor',
          GIT_COMMITTER_EMAIL: 'conductor@noreply',
        },
      });

      // Update head_sha
      const newSha = execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: worktreePath,
        encoding: 'utf8',
      }).trim();
      db.prepare('UPDATE runs SET head_sha = ?, updated_at = ? WHERE run_id = ?')
        .run(newSha, new Date().toISOString(), runId);

      log.info({ runId, headSha: newSha }, 'Implementation committed');
    } catch (err) {
      markRunFailed(db, runId, `Git commit failed: ${err instanceof Error ? err.message : 'Unknown error'}`);
      return;
    }
  } else {
    log.warn({ runId }, 'Implementer produced no file operations');
  }

  // Evaluate tests_pass gate before transitioning
  const freshRun = getRun(db, runId);
  if (freshRun !== null) {
    const gateCheck = evaluateGatesForPhase(db, freshRun, 'executing');

    // Persist gate evaluation results via orchestrator boundary
    persistGateEvaluations(db, freshRun, gateCheck.results);

    if (!gateCheck.allPassed) {
      const failedGate = gateCheck.blockedBy ?? 'unknown';
      const gateResult = gateCheck.results[failedGate];

      // Distinguish pending (retries remaining) from failed (exhausted)
      if (gateResult?.status === 'pending') {
        // Only increment test_fix_attempts when tests actually failed
        // (details contain testFixAttempts). Don't increment for "tests not
        // yet run" or "cannot verify" — those indicate missing artifacts,
        // not actual test failures.
        const isActualTestFailure = gateResult.details?.['testFixAttempts'] !== undefined;

        if (isActualTestFailure) {
          db.prepare(
            'UPDATE runs SET test_fix_attempts = test_fix_attempts + 1, updated_at = ? WHERE run_id = ?'
          ).run(new Date().toISOString(), runId);
        }

        log.info(
          { runId, gate: failedGate, reason: gateResult.reason, isActualTestFailure },
          'Gate pending — re-enqueuing implementer'
        );
        await enqueueAgentJob(runId, 'implementer', 'apply_changes', {
          retry_reason: gateResult.reason,
        });
        return;
      }

      // Gate failed with escalation (retries exhausted) — block for operator
      const blockInput = {
        runId,
        toPhase: 'blocked' as const,
        triggeredBy: 'system' as const,
        blockedReason: 'gate_failed',
        blockedContext: {
          prior_phase: 'executing',
          prior_step: freshRun.step,
          gate_id: failedGate,
          gate_status: gateResult?.status ?? 'failed',
          escalate: gateResult?.escalate ?? false,
        },
      };
      const blockResult = transitionPhase(db, blockInput);
      if (blockResult.success) {
        publishTransitionEvent(run.projectId, runId, run.phase, 'blocked');
        log.info(
          { runId, gate: failedGate, status: gateResult?.status, escalate: gateResult?.escalate },
          'Run blocked — gate failed with escalation'
        );
        try {
          const ctx = getMirrorCtx();
          mirrorPhaseTransition(ctx, blockInput, blockResult);
          mirrorFailure(ctx, {
            runId,
            blockedReason: 'gate_failed',
            blockedContext: blockInput.blockedContext,
            eventSequence: blockResult.event?.sequence,
          });
        } catch { /* non-fatal */ }
      }
      return;
    }
  }

  // Transition to awaiting_review
  const reviewTransitionInput = {
    runId,
    toPhase: 'awaiting_review' as const,
    toStep: 'reviewer_review_code' as const,
    triggeredBy: 'system' as const,
    reason: 'Implementation complete',
  };
  const result = transitionPhase(db, reviewTransitionInput);

  if (!result.success) {
    log.error({ runId, error: result.error }, 'Failed to transition to awaiting_review');
    return;
  }
  publishTransitionEvent(run.projectId, runId, run.phase, 'awaiting_review');
  try { mirrorPhaseTransition(getMirrorCtx(), reviewTransitionInput, result); } catch { /* non-fatal */ }

  // Enqueue code reviewer
  await enqueueAgentJob(runId, 'reviewer', 'review_code');
}

/**
 * Handle code reviewer: approve → create_pr + push, reject → re-run implementer.
 */
async function handleCodeReviewerAgent(
  db: ReturnType<typeof getDatabase>,
  run: Run,
  worktreePath?: string
): Promise<void> {
  const { runId } = run;

  const reviewResult = await runCodeReviewer(db, { runId, worktreePath });

  log.info(
    { runId, approved: reviewResult.approved, artifactId: reviewResult.artifactId },
    'Code reviewer completed'
  );

  if (reviewResult.approved) {
    // Atomic CAS: only advance step if run is still in the expected state.
    // Closes the race window where another worker could transition the run
    // between a guard read and the step write.
    const stepped = casUpdateRunStep(db, runId, 'awaiting_review', 'reviewer_review_code', 'create_pr');
    if (!stepped) {
      log.warn({ runId }, 'CAS failed: run no longer in awaiting_review/reviewer_review_code, skipping push');
      return;
    }

    await handlePrCreation(db, run, markRunFailed, async (retryRunId, delayMs) => {
      const qm = getQueueManager();
      await qm.addJob('runs', `run-pr-retry-${retryRunId}-${Date.now()}`, {
        runId: retryRunId,
        action: 'resume',
        triggeredBy: 'pr-creation-retry',
        fromPhase: 'awaiting_review',
        fromSequence: run.lastEventSequence,
      }, { delay: delayMs });
    });
  } else {
    // Re-read run to get current review_rounds
    const currentRun = getRun(db, runId);
    if (currentRun !== null && currentRun.reviewRounds >= MAX_REVIEW_ROUNDS) {
      markRunFailed(db, runId, `Code rejected after ${MAX_REVIEW_ROUNDS} review rounds. Manual intervention required.`);
      return;
    }

    // Re-run implementer (back to executing)
    log.info({ runId, reviewRounds: currentRun?.reviewRounds }, 'Code rejected, re-running implementer');

    const rejectInput = {
      runId,
      toPhase: 'executing' as const,
      toStep: 'implementer_apply_changes' as const,
      triggeredBy: 'system' as const,
      reason: 'Code changes requested by reviewer',
    };
    const result = transitionPhase(db, rejectInput);

    if (!result.success) {
      log.error({ runId, error: result.error }, 'Failed to transition back to executing');
      return;
    }
    publishTransitionEvent(run.projectId, runId, run.phase, 'executing');
    try { mirrorPhaseTransition(getMirrorCtx(), rejectInput, result); } catch { /* non-fatal */ }

    await enqueueAgentJob(runId, 'implementer', 'apply_changes');
  }
}

/**
 * Handle agent errors: categorize and either block or retry.
 */
async function handleAgentError(
  db: ReturnType<typeof getDatabase>,
  run: Run,
  agent: string,
  action: string,
  err: unknown
): Promise<void> {
  const { runId } = run;

  if (err instanceof AgentCancelledError) {
    log.info({ runId, agent, action }, 'Agent cancelled (already transitioned)');
    return;
  }

  if (err instanceof AgentTimeoutError) {
    log.error({ runId, agent, action, timeoutMs: err.timeoutMs }, 'Agent timed out');
    markRunFailed(db, runId, `Agent '${agent}' timed out after ${Math.round(err.timeoutMs / 1000)}s`);
    return;
  }

  if (err instanceof AgentAuthError) {
    log.error({ runId, agent, action }, 'Agent auth error (invalid API key)');
    markRunFailed(db, runId, `Authentication failed for agent '${agent}': ${err.message}`);
    return;
  }

  if (err instanceof AgentRateLimitError) {
    log.warn({ runId, agent, action, retryAfterMs: err.retryAfterMs }, 'Agent rate limited');
    // Re-enqueue with delay
    const delay = err.retryAfterMs ?? 60_000;
    const qm = getQueueManager();
    await qm.addJob('agents', `agent-${runId}-${agent}-${action}-retry-${Date.now()}`, {
      runId,
      agentInvocationId: generateAgentInvocationId(),
      agent,
      action,
      context: {},
    }, { delay });
    log.info({ runId, agent, delayMs: delay }, 'Agent job re-enqueued after rate limit');
    return;
  }

  if (err instanceof AgentError) {
    log.error({ runId, agent, action, code: err.code, error: err.message }, 'Agent error');
    markRunFailed(db, runId, `Agent '${agent}' failed: ${err.message}`);
    return;
  }

  // Unknown error
  const message = err instanceof Error ? err.message : 'Unknown error';
  log.error({ runId, agent, action, error: message }, 'Unexpected agent error');
  markRunFailed(db, runId, `Agent '${agent}' failed unexpectedly: ${message}`);
}

/**
 * Emit an agent lifecycle event (agent.started, agent.completed, agent.failed).
 */
function emitAgentEvent(
  db: ReturnType<typeof getDatabase>,
  run: Run,
  type: 'agent.started' | 'agent.completed' | 'agent.failed',
  agent: string,
  action: string,
  payload: Record<string, unknown> = {}
): void {
  try {
    createEvent(db, {
      projectId: run.projectId,
      runId: run.runId,
      type,
      class: type === 'agent.started' ? 'signal' : 'decision',
      payload: { agent, action, ...payload },
      idempotencyKey: `${type}:${run.runId}:${agent}:${action}:${Date.now()}`,
      source: 'worker',
    });
  } catch (err) {
    log.warn(
      { runId: run.runId, type, agent, error: err instanceof Error ? err.message : 'Unknown' },
      'Failed to emit agent event (non-fatal)'
    );
  }
}

/**
 * Process agent invocation jobs
 */
async function processAgent(job: Job<AgentJobData>): Promise<void> {
  const { runId, agent, action } = job.data;
  log.info({ runId, agent, action }, 'Processing agent');

  const db = getDatabase();

  // Fetch run
  const run = getRun(db, runId);
  if (run === null) {
    log.error({ runId }, 'Run not found for agent job');
    return;
  }

  // Idempotency: skip if terminal
  if (TERMINAL_PHASES.has(run.phase)) {
    log.info({ runId, phase: run.phase }, 'Run in terminal state, skipping agent');
    return;
  }

  // Emit agent.started event
  emitAgentEvent(db, run, 'agent.started', agent, action);

  // Get worktree path
  const worktree = getWorktreeForRun(db, runId);
  const worktreePath = worktree?.path;

  registerCancellable(runId);

  try {
    const routeKey = `${agent}:${action}`;
    switch (routeKey) {
      case 'planner:create_plan':
        await handlePlannerAgent(db, run, worktreePath);
        break;
      case 'reviewer:review_plan':
        await handlePlanReviewerAgent(db, run, worktreePath);
        break;
      case 'implementer:apply_changes':
        await handleImplementerAgent(db, run, worktreePath);
        break;
      case 'reviewer:review_code':
        await handleCodeReviewerAgent(db, run, worktreePath);
        break;
      default:
        // Unknown routes fail deterministically rather than leaving runs hanging
        emitAgentEvent(db, run, 'agent.failed', agent, action, {
          errorCode: 'unknown_route',
          errorMessage: `Unknown agent:action combination '${routeKey}'`,
        });
        markRunFailed(db, runId, `Unknown agent:action combination '${routeKey}'`);
        return;
    }

    // Emit agent.completed event
    emitAgentEvent(db, run, 'agent.completed', agent, action);
  } catch (err) {
    if (err instanceof AgentCancelledError) {
      log.info({ runId, agent, action }, 'Agent cancelled mid-execution');
      emitAgentEvent(db, run, 'agent.failed', agent, action, {
        errorCode: 'cancelled',
        errorMessage: 'Agent cancelled by operator',
      });
      return;
    }
    // Emit agent.failed event
    emitAgentEvent(db, run, 'agent.failed', agent, action, {
      errorCode: err instanceof AgentError ? err.code : 'unknown',
      errorMessage: err instanceof Error ? err.message : 'Unknown error',
    });
    await handleAgentError(db, run, agent, action, err);
  } finally {
    unregisterCancellable(runId);
  }
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
    case 'expired_leases': {
      const released = releaseExpiredPortLeases(db);
      log.info({ released }, 'Expired leases cleanup completed');
      break;
    }
    case 'old_jobs': {
      const qm = getQueueManager();
      const result = await cleanOldJobs(qm, QUEUES);
      log.info(result, 'Old jobs cleanup completed');
      break;
    }
    case 'mirror_flush': {
      // Flush stale deferred mirroring events for runs that haven't had a mirror call
      const flushed = flushStaleDeferredEvents(db, (runId) => {
        const run = getRun(db, runId);
        if (run === null) return null;
        const task = getTask(db, run.taskId);
        if (task === null || task.githubIssueNumber === 0 || task.githubNodeId === '') return null;
        const repo = getRepo(db, run.repoId);
        if (repo === null) return null;

        return (body: string, idempotencyKey: string) => {
          return enqueueWrite(db, {
            runId,
            kind: 'comment',
            targetNodeId: task.githubNodeId,
            targetType: 'issue',
            payload: {
              owner: repo.githubOwner,
              repo: repo.githubName,
              issueNumber: task.githubIssueNumber,
              body,
            },
            idempotencyKey,
          }, getQueueManager());
        };
      });
      log.info({ flushedRuns: flushed }, 'Mirror deferred events flush completed');
      break;
    }
    default:
      log.warn({ type, targetId }, 'Unknown cleanup type');
  }
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
let mirrorFlushTimer: ReturnType<typeof setInterval> | undefined;
let leaseCleanupTimer: ReturnType<typeof setInterval> | undefined;
let oldJobsCleanupTimer: ReturnType<typeof setInterval> | undefined;

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

  // Stop periodic timers
  if (mirrorFlushTimer !== undefined) {
    clearInterval(mirrorFlushTimer);
  }
  if (leaseCleanupTimer !== undefined) {
    clearInterval(leaseCleanupTimer);
  }
  if (oldJobsCleanupTimer !== undefined) {
    clearInterval(oldJobsCleanupTimer);
  }

  // Close all workers (waits for current jobs to complete)
  log.info('Closing workers');
  await Promise.all(workers.map(w => w.close()));

  // Close pub/sub publisher
  await closePublisher();

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

  // Initialize pub/sub publisher for SSE push events
  initPublisher(config.redisUrl);

  // Seed built-in definitions (idempotent)
  ensureBuiltInGateDefinitions(getDatabase());
  ensureBuiltInPolicyDefinitions(getDatabase());
  log.info('Built-in gate and policy definitions seeded');

  // Initialize GitHub App (needed for processRun and processGitHubWrite)
  if (!isGitHubAppInitialized()) {
    if (config.githubAppId !== '' && config.githubPrivateKey !== '' && config.githubWebhookSecret !== '') {
      initGitHubApp({
        appId: config.githubAppId,
        privateKey: config.githubPrivateKey,
        webhookSecret: config.githubWebhookSecret,
      });
      log.info('GitHub App initialized');
    } else {
      log.warn('GitHub App credentials not configured — webhook/run processing will fail until set');
    }
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

  // Schedule periodic mirror deferred events flush (every 60s)
  mirrorFlushTimer = setInterval(() => {
    void queueManager.addJob('cleanup', `cleanup:mirror_flush:${Date.now()}`, {
      type: 'mirror_flush',
    });
  }, 60_000);

  // Schedule periodic expired lease cleanup (every 5 minutes)
  leaseCleanupTimer = setInterval(() => {
    void queueManager.addJob('cleanup', `cleanup:expired_leases:${Date.now()}`, {
      type: 'expired_leases',
    });
  }, 300_000);

  // Schedule periodic old jobs cleanup (every 6 hours)
  oldJobsCleanupTimer = setInterval(() => {
    void queueManager.addJob('cleanup', `cleanup:old_jobs:${Date.now()}`, {
      type: 'old_jobs',
    });
  }, 21_600_000);

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
