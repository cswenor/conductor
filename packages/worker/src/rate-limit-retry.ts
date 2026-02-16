/**
 * Rate-limit retry handler: extracted for testability.
 *
 * Manages bounded re-enqueue of agent jobs after rate-limit errors,
 * with configurable max retries, exponential backoff, and delay capping.
 */

import {
  type Run,
  getDatabase,
  createLogger,
  type BlockedReasonCode,
} from '@conductor/shared';

type Db = ReturnType<typeof getDatabase>;
const log = createLogger({ name: 'conductor:worker:rate-limit-retry' });

export interface RateLimitRetryDeps {
  enqueueAgent: (
    runId: string,
    agent: string,
    action: string,
    rateLimitRetries: number,
    delay: number,
    fromPhase: string,
    fromSequence: number,
  ) => Promise<void>;
  markRunFailed: (db: Db, runId: string, reason: string, reasonCode: BlockedReasonCode) => void;
}

export interface RateLimitRetryResult {
  retried: boolean;
  delayMs?: number;
}

const DEFAULT_MAX_RETRIES = 5;
const BASE_DELAY_MS = 30_000;
const MAX_DELAY_MS = 600_000;

let warnedMaxRetries = false;

function resolveMaxRetries(): number {
  const raw = process.env['CONDUCTOR_RATE_LIMIT_MAX_RETRIES'];
  if (raw === undefined) return DEFAULT_MAX_RETRIES;
  // Guard: Number('') === 0, which would silently disable retries
  if (raw.trim() === '') {
    if (!warnedMaxRetries) {
      warnedMaxRetries = true;
      log.warn(
        { envKey: 'CONDUCTOR_RATE_LIMIT_MAX_RETRIES', envValue: raw },
        `Invalid CONDUCTOR_RATE_LIMIT_MAX_RETRIES, using default ${DEFAULT_MAX_RETRIES}`,
      );
    }
    return DEFAULT_MAX_RETRIES;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    if (!warnedMaxRetries) {
      warnedMaxRetries = true;
      log.warn(
        { envKey: 'CONDUCTOR_RATE_LIMIT_MAX_RETRIES', envValue: raw },
        `Invalid CONDUCTOR_RATE_LIMIT_MAX_RETRIES, using default ${DEFAULT_MAX_RETRIES}`,
      );
    }
    return DEFAULT_MAX_RETRIES;
  }
  return parsed; // 0 is valid = block immediately
}

export async function handleRateLimitRetry(
  db: Db,
  run: Run,
  agent: string,
  action: string,
  retryAfterMs: number | undefined,
  currentRetries: number,
  deps: RateLimitRetryDeps,
): Promise<RateLimitRetryResult> {
  const maxRetries = resolveMaxRetries();

  if (currentRetries >= maxRetries) {
    const reason = `Rate-limit retry budget exhausted for agent '${agent}' (maxRetries=${maxRetries}). Manual retry available.`;
    deps.markRunFailed(db, run.runId, reason, 'rate_limit_exhausted');
    log.warn({ runId: run.runId, agent, action, currentRetries, maxRetries }, reason);
    return { retried: false };
  }

  // Sanitize retryAfterMs: must be finite and >= 1
  const sanitizedRetryAfter =
    retryAfterMs !== undefined && Number.isFinite(retryAfterMs) && retryAfterMs >= 1
      ? retryAfterMs
      : undefined;

  // Compute delay: server-supplied or exponential backoff, capped
  const delay = Math.min(
    sanitizedRetryAfter ?? BASE_DELAY_MS * Math.pow(2, currentRetries),
    MAX_DELAY_MS,
  );

  await deps.enqueueAgent(
    run.runId,
    agent,
    action,
    currentRetries + 1,
    delay,
    run.phase,
    run.lastEventSequence,
  );

  log.info(
    { runId: run.runId, agent, action, attempt: currentRetries + 1, delayMs: delay, maxRetries },
    'Agent job re-enqueued after rate limit',
  );

  return { retried: true, delayMs: delay };
}
