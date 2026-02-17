/**
 * Tests for rate-limit-retry handler: backoff schedule, retry cap,
 * env parsing, delay normalization, and return value contract.
 *
 * Uses injected mock deps following blocked-retry.test.ts patterns.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Run, getDatabase } from '@conductor/shared';
import type { RateLimitRetryDeps } from './rate-limit-retry.ts';
import { handleRateLimitRetry } from './rate-limit-retry.ts';

type Db = ReturnType<typeof getDatabase>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRun(overrides: Partial<Run> = {}): Run {
  return {
    runId: 'run_rl_test',
    taskId: 'task_1',
    projectId: 'proj_1',
    repoId: 'repo_1',
    runNumber: 1,
    phase: 'executing',
    step: 'implementer_apply_changes',
    policySetId: 'ps_1',
    lastEventSequence: 42,
    nextSequence: 43,
    baseBranch: 'main',
    branch: 'conductor/run_rl_test',
    headSha: '',
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    completedAt: undefined,
    result: undefined,
    resultReason: undefined,
    blockedReason: undefined,
    blockedContextJson: undefined,
    approvalCycle: 0,
    planRevisions: 0,
    reviewRounds: 0,
    testFixAttempts: 0,
    implementerBackend: 'raw',
    workflowEpoch: 0,
    ...overrides,
  } as Run;
}

function makeDeps(): RateLimitRetryDeps & {
  enqueueAgent: ReturnType<typeof vi.fn>;
  markRunFailed: ReturnType<typeof vi.fn>;
} {
  return {
    enqueueAgent: vi.fn<RateLimitRetryDeps['enqueueAgent']>().mockResolvedValue(undefined),
    markRunFailed: vi.fn<RateLimitRetryDeps['markRunFailed']>(),
  };
}

// We use a shared db placeholder — handler doesn't read from DB directly
const fakeDb = {} as Db;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('handleRateLimitRetry', () => {
  const savedEnv = process.env['CONDUCTOR_RATE_LIMIT_MAX_RETRIES'];

  beforeEach(() => {
    delete process.env['CONDUCTOR_RATE_LIMIT_MAX_RETRIES'];
  });

  afterEach(() => {
    if (savedEnv !== undefined) {
      process.env['CONDUCTOR_RATE_LIMIT_MAX_RETRIES'] = savedEnv;
    } else {
      delete process.env['CONDUCTOR_RATE_LIMIT_MAX_RETRIES'];
    }
  });

  it('retries with valid retryAfterMs', async () => {
    const deps = makeDeps();
    const run = makeRun();

    const result = await handleRateLimitRetry(fakeDb, run, 'implementer', 'apply_changes', 45_000, 0, deps);

    expect(result.retried).toBe(true);
    expect(result.delayMs).toBe(45_000);
    expect(deps.enqueueAgent).toHaveBeenCalledWith(
      'run_rl_test', 'implementer', 'apply_changes', 1, 45_000, 'executing', 42,
    );
    expect(deps.markRunFailed).not.toHaveBeenCalled();
  });

  it('retries without retryAfterMs using exponential backoff', async () => {
    const deps = makeDeps();
    const run = makeRun();

    // attempt 0 → 30s, 1 → 60s, 2 → 120s, 3 → 240s, 4 → 480s
    const expected = [30_000, 60_000, 120_000, 240_000, 480_000];
    for (let i = 0; i < expected.length; i++) {
      deps.enqueueAgent.mockClear();
      const result = await handleRateLimitRetry(fakeDb, run, 'implementer', 'apply_changes', undefined, i, deps);
      expect(result.retried).toBe(true);
      expect(result.delayMs).toBe(expected[i]);
    }
  });

  it('caps delay at 600s even with large retryAfterMs', async () => {
    const deps = makeDeps();
    const run = makeRun();

    const result = await handleRateLimitRetry(fakeDb, run, 'implementer', 'apply_changes', 900_000, 0, deps);

    expect(result.retried).toBe(true);
    expect(result.delayMs).toBe(600_000);
  });

  it('treats sub-1 retryAfterMs (0.5, 0, -1) as absent and falls back to backoff', async () => {
    const deps = makeDeps();
    const run = makeRun();

    for (const val of [0.5, 0, -1]) {
      deps.enqueueAgent.mockClear();
      const result = await handleRateLimitRetry(fakeDb, run, 'implementer', 'apply_changes', val, 0, deps);
      expect(result.retried).toBe(true);
      expect(result.delayMs).toBe(30_000); // BASE_DELAY_MS * 2^0
    }
  });

  it('treats non-finite retryAfterMs (NaN, Infinity) as absent', async () => {
    const deps = makeDeps();
    const run = makeRun();

    for (const val of [NaN, Infinity]) {
      deps.enqueueAgent.mockClear();
      const result = await handleRateLimitRetry(fakeDb, run, 'implementer', 'apply_changes', val, 0, deps);
      expect(result.retried).toBe(true);
      expect(result.delayMs).toBe(30_000);
    }
  });

  it('blocks run when retry cap is reached', async () => {
    const deps = makeDeps();
    const run = makeRun();

    // Default max is 5, so currentRetries=5 should fail
    const result = await handleRateLimitRetry(fakeDb, run, 'implementer', 'apply_changes', undefined, 5, deps);

    expect(result.retried).toBe(false);
    expect(result.delayMs).toBeUndefined();
    expect(deps.markRunFailed).toHaveBeenCalledWith(
      fakeDb,
      'run_rl_test',
      'rate_limit_exhausted',
      'rate_limit_exhausted',
      expect.objectContaining({
        agent: 'implementer',
        max_retries: 5,
        retries_exhausted: 5,
        error_detail: expect.stringContaining('Rate-limit retry budget exhausted') as string,
      }),
    );
    expect(deps.enqueueAgent).not.toHaveBeenCalled();
  });

  it('CONDUCTOR_RATE_LIMIT_MAX_RETRIES=0 blocks immediately', async () => {
    process.env['CONDUCTOR_RATE_LIMIT_MAX_RETRIES'] = '0';
    const deps = makeDeps();
    const run = makeRun();

    const result = await handleRateLimitRetry(fakeDb, run, 'implementer', 'apply_changes', undefined, 0, deps);

    expect(result.retried).toBe(false);
    expect(deps.markRunFailed).toHaveBeenCalledWith(
      fakeDb,
      'run_rl_test',
      'rate_limit_exhausted',
      'rate_limit_exhausted',
      expect.objectContaining({
        agent: 'implementer',
        max_retries: 0,
        retries_exhausted: 0,
        error_detail: expect.stringContaining('maxRetries=0') as string,
      }),
    );
  });

  it('CONDUCTOR_RATE_LIMIT_MAX_RETRIES=2 allows retries 0,1 and blocks 2', async () => {
    process.env['CONDUCTOR_RATE_LIMIT_MAX_RETRIES'] = '2';
    const deps = makeDeps();
    const run = makeRun();

    // Retry 0 and 1 should succeed
    const r0 = await handleRateLimitRetry(fakeDb, run, 'implementer', 'apply_changes', undefined, 0, deps);
    expect(r0.retried).toBe(true);

    const r1 = await handleRateLimitRetry(fakeDb, run, 'implementer', 'apply_changes', undefined, 1, deps);
    expect(r1.retried).toBe(true);

    // Retry 2 should block
    const r2 = await handleRateLimitRetry(fakeDb, run, 'implementer', 'apply_changes', undefined, 2, deps);
    expect(r2.retried).toBe(false);
    expect(deps.markRunFailed).toHaveBeenCalledTimes(1);
    expect(deps.markRunFailed).toHaveBeenCalledWith(
      fakeDb,
      'run_rl_test',
      'rate_limit_exhausted',
      'rate_limit_exhausted',
      expect.objectContaining({
        agent: 'implementer',
        max_retries: 2,
        retries_exhausted: 2,
        error_detail: expect.stringContaining('maxRetries=2') as string,
      }),
    );
  });

  it('falls back to default on invalid env values', async () => {
    for (const invalid of ['abc', '-1', '1.5', '', '  ']) {
      process.env['CONDUCTOR_RATE_LIMIT_MAX_RETRIES'] = invalid;
      const deps = makeDeps();
      const run = makeRun();

      // Default max is 5, so attempt 4 should succeed (< 5)
      const r4 = await handleRateLimitRetry(fakeDb, run, 'implementer', 'apply_changes', undefined, 4, deps);
      expect(r4.retried).toBe(true);

      // Attempt 5 should fail (>= 5)
      const r5 = await handleRateLimitRetry(fakeDb, run, 'implementer', 'apply_changes', undefined, 5, deps);
      expect(r5.retried).toBe(false);
    }
  });

  it('passes correct fromPhase and fromSequence from run', async () => {
    const deps = makeDeps();
    const run = makeRun({ phase: 'planning', lastEventSequence: 99 });

    await handleRateLimitRetry(fakeDb, run, 'planner', 'create_plan', undefined, 0, deps);

    expect(deps.enqueueAgent).toHaveBeenCalledWith(
      'run_rl_test', 'planner', 'create_plan', 1, 30_000, 'planning', 99,
    );
  });

  it('returns retried: false when cap reached and retried: true with delayMs when retrying', async () => {
    const deps = makeDeps();
    const run = makeRun();

    const success = await handleRateLimitRetry(fakeDb, run, 'implementer', 'apply_changes', 10_000, 0, deps);
    expect(success).toEqual({ retried: true, delayMs: 10_000 });

    const failure = await handleRateLimitRetry(fakeDb, run, 'implementer', 'apply_changes', undefined, 5, deps);
    expect(failure).toEqual({ retried: false });
  });
});
