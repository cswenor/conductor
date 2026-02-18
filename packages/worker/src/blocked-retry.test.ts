/**
 * Tests for blocked-retry handler: phase restore, agent routing,
 * legacy fallback, and rollback-on-enqueue-failure.
 *
 * Uses a real in-memory SQLite database for transitions and events.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  initDatabase,
  closeDatabase,
  getDatabase,
  createRun,
  getRun,
  transitionPhase,
  type Run,
} from '@conductor/shared';
import {
  handleBlockedRetry,
  resolvePriorPhase,
  resolvePriorStep,
} from './blocked-retry.ts';

type Db = ReturnType<typeof getDatabase>;
let db: Db;

/** Assert run exists and return it (avoids non-null assertions). */
function mustGetRun(db: Db, runId: string): Run {
  const run = getRun(db, runId);
  if (run === null) throw new Error(`Run ${runId} not found`);
  return run;
}

function seedTestData(db: Db) {
  const now = new Date().toISOString();
  const userId = 'user_retry';
  const projectId = 'proj_retry';
  const repoId = 'repo_retry';
  const taskId = 'task_retry';

  db.prepare(`
    INSERT OR IGNORE INTO users (user_id, github_id, github_node_id, github_login, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'active', ?, ?)
  `).run(userId, 800, 'U_retry', 'retryuser', now, now);

  db.prepare(`
    INSERT INTO projects (
      project_id, user_id, name, github_org_id, github_org_node_id, github_org_name,
      github_installation_id, default_profile_id, default_base_branch,
      port_range_start, port_range_end, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(projectId, userId, 'Retry Project', 800, 'O_retry', 'retryorg',
    80000, 'default', 'main', 3200, 3299, now, now);

  db.prepare(`
    INSERT INTO repos (
      repo_id, project_id, github_node_id, github_numeric_id,
      github_owner, github_name, github_full_name, github_default_branch,
      profile_id, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(repoId, projectId, 'R_retry', 800,
    'retryowner', 'retryrepo', 'retryowner/retryrepo', 'main',
    'default', 'active', now, now);

  db.prepare(`
    INSERT INTO tasks (
      task_id, project_id, repo_id, github_node_id, github_issue_number,
      github_type, github_title, github_body, github_state, github_labels_json,
      github_synced_at, created_at, updated_at, last_activity_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(taskId, projectId, repoId, 'I_retry', 1,
    'issue', 'Retry Task', 'Body', 'open', '[]',
    now, now, now, now);

  return { userId, projectId, repoId, taskId };
}

function createTestRun(db: Db, seed: ReturnType<typeof seedTestData>) {
  return createRun(db, {
    taskId: seed.taskId,
    projectId: seed.projectId,
    repoId: seed.repoId,
    baseBranch: 'main',
  });
}

/** Advance run to planning/planner_create_plan, then block it. */
function advanceToBlockedFromPlanning(
  db: Db,
  runId: string,
  blockedContext?: Record<string, unknown>,
) {
  transitionPhase(db, {
    runId,
    toPhase: 'planning',
    toStep: 'planner_create_plan',
    triggeredBy: 'system',
  });
  transitionPhase(db, {
    runId,
    toPhase: 'blocked',
    triggeredBy: 'system',
    blockedReason: 'Test failure',
    blockedContext: blockedContext ?? {
      error: 'Test error',
      prior_phase: 'planning',
      prior_step: 'planner_create_plan',
    },
  });
}

const mockEnqueueAgent = vi.fn<(runId: string, agent: string, action: string) => Promise<void>>().mockResolvedValue(undefined);
const mockEnqueueRunJob = vi.fn<
  (runId: string, action: string, triggeredBy: string, fromPhase?: string, fromSequence?: number) => Promise<void>
>().mockResolvedValue(undefined);
const mockMirror = vi.fn();

beforeEach(() => {
  db = initDatabase({ path: ':memory:' });
  mockEnqueueAgent.mockReset().mockResolvedValue(undefined);
  mockEnqueueRunJob.mockReset().mockResolvedValue(undefined);
  mockMirror.mockReset();
});

afterEach(() => {
  closeDatabase(db);
});

// ---------------------------------------------------------------------------
// resolvePriorPhase
// ---------------------------------------------------------------------------

describe('resolvePriorPhase', () => {
  it('returns phase from blocked context when valid', () => {
    const seed = seedTestData(db);
    const run = createTestRun(db, seed);
    const result = resolvePriorPhase(db, run, { prior_phase: 'planning' });
    expect(result).toBe('planning');
  });

  it('rejects non-retryable phases', () => {
    const seed = seedTestData(db);
    const run = createTestRun(db, seed);
    const result = resolvePriorPhase(db, run, { prior_phase: 'completed' });
    expect(result).toBeUndefined();
  });

  it('falls back to last phase.transitioned event for legacy rows', () => {
    const seed = seedTestData(db);
    const run = createTestRun(db, seed);

    // Transition to planning, then to blocked (without prior_phase in context)
    transitionPhase(db, {
      runId: run.runId,
      toPhase: 'planning',
      toStep: 'planner_create_plan',
      triggeredBy: 'system',
    });
    transitionPhase(db, {
      runId: run.runId,
      toPhase: 'blocked',
      triggeredBy: 'system',
      blockedReason: 'Legacy failure',
    });

    const blockedRun = mustGetRun(db, run.runId);

    // No prior_phase in context
    const result = resolvePriorPhase(db, blockedRun, {});
    expect(result).toBe('planning');
  });

  it('returns undefined when no event fallback is available', () => {
    const seed = seedTestData(db);
    const run = createTestRun(db, seed);
    // No transitions, no context
    const result = resolvePriorPhase(db, run, {});
    expect(result).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// resolvePriorStep
// ---------------------------------------------------------------------------

describe('resolvePriorStep', () => {
  it('returns step from blocked context when valid', () => {
    const seed = seedTestData(db);
    const run = createTestRun(db, seed);
    const result = resolvePriorStep(run, { prior_step: 'planner_create_plan' });
    expect(result).toBe('planner_create_plan');
  });

  it('falls back to run.step when context has no prior_step', () => {
    const seed = seedTestData(db);
    const run = createTestRun(db, seed);

    // run.step starts as 'setup_worktree' (from createRun)
    const result = resolvePriorStep(run, {});
    expect(result).toBe('setup_worktree');
  });

  it('returns undefined for invalid step values', () => {
    const seed = seedTestData(db);
    const run = { ...createTestRun(db, seed), step: 'bogus_step' as never };
    const result = resolvePriorStep(run, { prior_step: 'also_bogus' });
    expect(result).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// handleBlockedRetry
// ---------------------------------------------------------------------------

describe('handleBlockedRetry', () => {
  const deps = {
    enqueueAgent: mockEnqueueAgent,
    enqueueRunJob: mockEnqueueRunJob,
    mirror: mockMirror,
  };

  it('transitions blocked → planning and enqueues planner agent', async () => {
    const seed = seedTestData(db);
    const run = createTestRun(db, seed);
    advanceToBlockedFromPlanning(db, run.runId);

    const blockedRun = mustGetRun(db, run.runId);
    expect(blockedRun.phase).toBe('blocked');

    const result = await handleBlockedRetry(db, blockedRun, 'operator_1', deps);

    expect(result.retried).toBe(true);
    expect(result.priorPhase).toBe('planning');
    expect(result.priorStep).toBe('planner_create_plan');

    // Run should now be in planning
    const updated = getRun(db, run.runId);
    expect(updated?.phase).toBe('planning');
    expect(updated?.step).toBe('planner_create_plan');

    // Planner agent enqueued
    expect(mockEnqueueAgent).toHaveBeenCalledWith(run.runId, 'planner', 'create_plan');
    expect(mockMirror).toHaveBeenCalled();
  });

  it('routes to implementer for implementer_apply_changes step', async () => {
    const seed = seedTestData(db);
    const run = createTestRun(db, seed);

    // Advance further: pending → planning → awaiting_plan_approval → executing → blocked
    transitionPhase(db, { runId: run.runId, toPhase: 'planning', toStep: 'planner_create_plan', triggeredBy: 'system' });
    transitionPhase(db, { runId: run.runId, toPhase: 'awaiting_plan_approval', toStep: 'wait_plan_approval', triggeredBy: 'system' });
    transitionPhase(db, { runId: run.runId, toPhase: 'executing', toStep: 'implementer_apply_changes', triggeredBy: 'system' });
    transitionPhase(db, {
      runId: run.runId,
      toPhase: 'blocked',
      triggeredBy: 'system',
      blockedReason: 'Agent error',
      blockedContext: { error: 'fail', prior_phase: 'executing', prior_step: 'implementer_apply_changes' },
    });

    const blockedRun = mustGetRun(db, run.runId);
    const result = await handleBlockedRetry(db, blockedRun, 'operator_1', deps);

    expect(result.retried).toBe(true);
    expect(mockEnqueueAgent).toHaveBeenCalledWith(run.runId, 'implementer', 'apply_changes');
  });

  it('routes to setup_worktree via enqueueRunJob', async () => {
    const seed = seedTestData(db);
    const run = createTestRun(db, seed);

    // Block directly from pending with setup_worktree step
    transitionPhase(db, {
      runId: run.runId,
      toPhase: 'blocked',
      triggeredBy: 'system',
      blockedReason: 'Clone failed',
      blockedContext: { error: 'fail', prior_phase: 'pending', prior_step: 'setup_worktree' },
    });

    const blockedRun = mustGetRun(db, run.runId);
    const result = await handleBlockedRetry(db, blockedRun, 'operator_1', deps);

    expect(result.retried).toBe(true);
    expect(mockEnqueueRunJob).toHaveBeenCalledWith(
      run.runId,
      'start',
      'operator_1',
      'pending',
      expect.any(Number),
    );
    expect(mockEnqueueAgent).not.toHaveBeenCalled();
  });

  it('routes create_pr to guarded run resume', async () => {
    const seed = seedTestData(db);
    const run = createTestRun(db, seed);

    transitionPhase(db, {
      runId: run.runId,
      toPhase: 'planning',
      toStep: 'planner_create_plan',
      triggeredBy: 'system',
    });
    transitionPhase(db, {
      runId: run.runId,
      toPhase: 'awaiting_plan_approval',
      toStep: 'wait_plan_approval',
      triggeredBy: 'system',
    });
    transitionPhase(db, {
      runId: run.runId,
      toPhase: 'executing',
      toStep: 'implementer_apply_changes',
      triggeredBy: 'system',
    });
    transitionPhase(db, {
      runId: run.runId,
      toPhase: 'awaiting_review',
      toStep: 'create_pr',
      triggeredBy: 'system',
    });
    transitionPhase(db, {
      runId: run.runId,
      toPhase: 'blocked',
      triggeredBy: 'system',
      blockedReason: 'PR retry test',
      blockedContext: { prior_phase: 'awaiting_review', prior_step: 'create_pr' },
    });

    const blockedRun = mustGetRun(db, run.runId);
    const result = await handleBlockedRetry(db, blockedRun, 'operator_1', deps);

    expect(result.retried).toBe(true);
    expect(mockEnqueueRunJob).toHaveBeenCalledWith(
      run.runId,
      'resume',
      'operator_1',
      'awaiting_review',
      expect.any(Number),
    );
    expect(mockEnqueueAgent).not.toHaveBeenCalled();
  });

  it('reverts to blocked when agent enqueue fails', async () => {
    const seed = seedTestData(db);
    const run = createTestRun(db, seed);
    advanceToBlockedFromPlanning(db, run.runId);

    const blockedRun = mustGetRun(db, run.runId);
    mockEnqueueAgent.mockRejectedValue(new Error('Redis down'));

    await expect(
      handleBlockedRetry(db, blockedRun, 'operator_1', deps)
    ).rejects.toThrow('Redis down');

    // Run should be back in blocked
    const updated = getRun(db, run.runId);
    expect(updated?.phase).toBe('blocked');
    expect(updated?.blockedReason).toBe('Test failure');
  });

  it('resolves via legacy fallback when prior_phase is missing from context', async () => {
    const seed = seedTestData(db);
    const run = createTestRun(db, seed);

    // Block with no prior_phase in context — pending→blocked transition event exists
    transitionPhase(db, {
      runId: run.runId,
      toPhase: 'blocked',
      triggeredBy: 'system',
      blockedReason: 'Unknown',
      blockedContext: { error: 'mystery' },
    });

    const blockedRun = mustGetRun(db, run.runId);

    // Legacy fallback finds pending→blocked transition, returns 'pending'
    const result = await handleBlockedRetry(db, blockedRun, 'operator_1', deps);
    expect(result.retried).toBe(true);
    expect(result.priorPhase).toBe('pending');
  });

  it('uses legacy fallback for blocked rows without blockedContextJson', async () => {
    const seed = seedTestData(db);
    const run = createTestRun(db, seed);

    // Advance to planning, then block without prior_phase in context
    transitionPhase(db, {
      runId: run.runId,
      toPhase: 'planning',
      toStep: 'planner_create_plan',
      triggeredBy: 'system',
    });
    transitionPhase(db, {
      runId: run.runId,
      toPhase: 'blocked',
      triggeredBy: 'system',
      blockedReason: 'Legacy error',
    });

    const blockedRun = mustGetRun(db, run.runId);
    // blockedContextJson is undefined — no prior_phase
    const result = await handleBlockedRetry(db, blockedRun, 'operator_1', deps);

    expect(result.retried).toBe(true);
    expect(result.priorPhase).toBe('planning');
    // Falls back to run.step which should still be planner_create_plan
    expect(result.priorStep).toBe('planner_create_plan');
    expect(mockEnqueueAgent).toHaveBeenCalledWith(run.runId, 'planner', 'create_plan');
  });

  it('resets plan_revisions and re-runs planner on max plan revisions retry', async () => {
    const seed = seedTestData(db);
    const run = createTestRun(db, seed);

    // Advance to planning, set plan_revisions to 3 (max), then block
    transitionPhase(db, {
      runId: run.runId,
      toPhase: 'planning',
      toStep: 'reviewer_review_plan',
      triggeredBy: 'system',
    });
    db.prepare('UPDATE runs SET plan_revisions = 3 WHERE run_id = ?').run(run.runId);
    transitionPhase(db, {
      runId: run.runId,
      toPhase: 'blocked',
      triggeredBy: 'system',
      blockedReason: 'Plan rejected after 3 revisions. Manual intervention required.',
      blockedContext: { error: 'Plan rejected', prior_phase: 'planning', prior_step: 'reviewer_review_plan', reason_code: 'max_plan_revisions' },
    });

    const blockedRun = mustGetRun(db, run.runId);
    expect(blockedRun.phase).toBe('blocked');
    expect(blockedRun.planRevisions).toBe(3);

    const result = await handleBlockedRetry(db, blockedRun, 'operator_1', deps);

    expect(result.retried).toBe(true);
    expect(result.priorPhase).toBe('planning');
    expect(result.priorStep).toBe('planner_create_plan');

    // Counter reset to 0
    const updated = mustGetRun(db, run.runId);
    expect(updated.phase).toBe('planning');
    expect(updated.step).toBe('planner_create_plan');
    expect(updated.planRevisions).toBe(0);

    // Planner (not reviewer) enqueued
    expect(mockEnqueueAgent).toHaveBeenCalledWith(run.runId, 'planner', 'create_plan');
  });

  it('resets review_rounds and re-runs implementer on max review rounds retry', async () => {
    const seed = seedTestData(db);
    const run = createTestRun(db, seed);

    // Advance through full pipeline to awaiting_review, then block
    transitionPhase(db, { runId: run.runId, toPhase: 'planning', toStep: 'planner_create_plan', triggeredBy: 'system' });
    transitionPhase(db, { runId: run.runId, toPhase: 'awaiting_plan_approval', toStep: 'wait_plan_approval', triggeredBy: 'system' });
    transitionPhase(db, { runId: run.runId, toPhase: 'executing', toStep: 'implementer_apply_changes', triggeredBy: 'system' });
    transitionPhase(db, { runId: run.runId, toPhase: 'awaiting_review', toStep: 'reviewer_review_code', triggeredBy: 'system' });
    db.prepare('UPDATE runs SET review_rounds = 3 WHERE run_id = ?').run(run.runId);
    transitionPhase(db, {
      runId: run.runId,
      toPhase: 'blocked',
      triggeredBy: 'system',
      blockedReason: 'Code rejected after 3 review rounds. Manual intervention required.',
      blockedContext: { error: 'Code rejected', prior_phase: 'awaiting_review', prior_step: 'reviewer_review_code', reason_code: 'max_review_rounds' },
    });

    const blockedRun = mustGetRun(db, run.runId);
    expect(blockedRun.phase).toBe('blocked');
    expect(blockedRun.reviewRounds).toBe(3);

    const result = await handleBlockedRetry(db, blockedRun, 'operator_1', deps);

    expect(result.retried).toBe(true);
    expect(result.priorPhase).toBe('executing');
    expect(result.priorStep).toBe('implementer_apply_changes');

    // Counter reset to 0
    const updated = mustGetRun(db, run.runId);
    expect(updated.phase).toBe('executing');
    expect(updated.step).toBe('implementer_apply_changes');
    expect(updated.reviewRounds).toBe(0);

    // Implementer (not reviewer) enqueued
    expect(mockEnqueueAgent).toHaveBeenCalledWith(run.runId, 'implementer', 'apply_changes');
  });

  it('retries rate_limit_exhausted from prior agent step (no counter reset)', async () => {
    const seed = seedTestData(db);
    const run = createTestRun(db, seed);

    // Advance through pipeline to executing, then block with rate_limit_exhausted
    transitionPhase(db, { runId: run.runId, toPhase: 'planning', toStep: 'planner_create_plan', triggeredBy: 'system' });
    transitionPhase(db, { runId: run.runId, toPhase: 'awaiting_plan_approval', toStep: 'wait_plan_approval', triggeredBy: 'system' });
    transitionPhase(db, { runId: run.runId, toPhase: 'executing', toStep: 'implementer_apply_changes', triggeredBy: 'system' });
    transitionPhase(db, {
      runId: run.runId,
      toPhase: 'blocked',
      triggeredBy: 'system',
      blockedReason: 'rate_limit_exhausted',
      blockedContext: {
        error: 'rate_limit_exhausted',
        prior_phase: 'executing',
        prior_step: 'implementer_apply_changes',
        reason_code: 'rate_limit_exhausted',
        agent: 'implementer',
        retries_exhausted: 5,
        max_retries: 5,
        error_detail: "Rate-limit retry budget exhausted for agent 'implementer' (maxRetries=5). Manual retry available.",
      },
    });

    const blockedRun = mustGetRun(db, run.runId);
    expect(blockedRun.phase).toBe('blocked');

    const result = await handleBlockedRetry(db, blockedRun, 'operator_1', deps);

    expect(result.retried).toBe(true);
    expect(result.priorPhase).toBe('executing');
    expect(result.priorStep).toBe('implementer_apply_changes');

    // Run should transition back to executing
    const updated = mustGetRun(db, run.runId);
    expect(updated.phase).toBe('executing');
    expect(updated.step).toBe('implementer_apply_changes');

    // Implementer agent enqueued
    expect(mockEnqueueAgent).toHaveBeenCalledWith(run.runId, 'implementer', 'apply_changes');

    // No counter reset — planRevisions and reviewRounds remain unchanged
    expect(updated.planRevisions).toBe(0);
    expect(updated.reviewRounds).toBe(0);
  });

  it('returns error when transition fails (stale)', async () => {
    const seed = seedTestData(db);
    const run = createTestRun(db, seed);
    advanceToBlockedFromPlanning(db, run.runId);

    const blockedRun = mustGetRun(db, run.runId);

    // Manually advance the run out of blocked (simulating concurrent processing)
    db.prepare('UPDATE runs SET phase = ? WHERE run_id = ?').run('planning', run.runId);

    const result = await handleBlockedRetry(db, blockedRun, 'operator_1', deps);

    expect(result.retried).toBe(false);
    expect(result.error).toBeDefined();
    expect(mockEnqueueAgent).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// reason_code contract guards
// ---------------------------------------------------------------------------

describe('reason_code contract guards', () => {
  const deps = {
    enqueueAgent: mockEnqueueAgent,
    enqueueRunJob: mockEnqueueRunJob,
    mirror: mockMirror,
  };

  it('does NOT reset counters when reason_code absent and no legacy text match', async () => {
    const seed = seedTestData(db);
    const run = createTestRun(db, seed);

    // Block from planning with NO reason_code — generic failure
    transitionPhase(db, {
      runId: run.runId,
      toPhase: 'planning',
      toStep: 'planner_create_plan',
      triggeredBy: 'system',
    });
    db.prepare('UPDATE runs SET plan_revisions = 2 WHERE run_id = ?').run(run.runId);
    transitionPhase(db, {
      runId: run.runId,
      toPhase: 'blocked',
      triggeredBy: 'system',
      blockedReason: 'Some random error',
      blockedContext: { error: 'fail', prior_phase: 'planning', prior_step: 'planner_create_plan' },
    });

    const blockedRun = mustGetRun(db, run.runId);
    await handleBlockedRetry(db, blockedRun, 'operator_1', deps);

    // Counter should NOT be reset
    const updated = mustGetRun(db, run.runId);
    expect(updated.planRevisions).toBe(2);
  });

  it('handles command-path retry_limit_exceeded with reason_code: max_plan_revisions', async () => {
    const seed = seedTestData(db);
    const run = createTestRun(db, seed);

    // Simulate the command path: blockedReason='retry_limit_exceeded', reason_code in context
    transitionPhase(db, {
      runId: run.runId,
      toPhase: 'planning',
      toStep: 'planner_create_plan',
      triggeredBy: 'system',
    });
    db.prepare('UPDATE runs SET plan_revisions = 3 WHERE run_id = ?').run(run.runId);
    transitionPhase(db, {
      runId: run.runId,
      toPhase: 'blocked',
      triggeredBy: 'system',
      blockedReason: 'retry_limit_exceeded',
      blockedContext: {
        prior_phase: 'planning',
        prior_step: 'planner_create_plan',
        revisions: 3,
        reason_code: 'max_plan_revisions',
      },
    });

    const blockedRun = mustGetRun(db, run.runId);
    const result = await handleBlockedRetry(db, blockedRun, 'operator_1', deps);

    expect(result.retried).toBe(true);
    expect(result.priorPhase).toBe('planning');
    expect(result.priorStep).toBe('planner_create_plan');

    const updated = mustGetRun(db, run.runId);
    expect(updated.planRevisions).toBe(0);
    expect(mockEnqueueAgent).toHaveBeenCalledWith(run.runId, 'planner', 'create_plan');
  });

  it('legacy text match still works when reason_code absent (backward compat)', async () => {
    const seed = seedTestData(db);
    const run = createTestRun(db, seed);

    // Old-format block: human-readable reason, NO reason_code in context
    transitionPhase(db, {
      runId: run.runId,
      toPhase: 'planning',
      toStep: 'reviewer_review_plan',
      triggeredBy: 'system',
    });
    db.prepare('UPDATE runs SET plan_revisions = 3 WHERE run_id = ?').run(run.runId);
    transitionPhase(db, {
      runId: run.runId,
      toPhase: 'blocked',
      triggeredBy: 'system',
      blockedReason: 'Plan rejected after 3 revisions. Manual intervention required.',
      blockedContext: { error: 'Plan rejected', prior_phase: 'planning', prior_step: 'reviewer_review_plan' },
      // NO reason_code — pre-existing blocked run
    });

    const blockedRun = mustGetRun(db, run.runId);
    const result = await handleBlockedRetry(db, blockedRun, 'operator_1', deps);

    // Legacy fallback should still trigger counter reset + planner reroute
    expect(result.retried).toBe(true);
    expect(result.priorPhase).toBe('planning');
    expect(result.priorStep).toBe('planner_create_plan');

    const updated = mustGetRun(db, run.runId);
    expect(updated.planRevisions).toBe(0);
    expect(mockEnqueueAgent).toHaveBeenCalledWith(run.runId, 'planner', 'create_plan');
  });

  it('reason_code takes precedence over legacy text match', async () => {
    const seed = seedTestData(db);
    const run = createTestRun(db, seed);

    // Contrived: reason_code says max_review_rounds, but text says "Plan rejected..."
    // reason_code should win
    transitionPhase(db, { runId: run.runId, toPhase: 'planning', toStep: 'planner_create_plan', triggeredBy: 'system' });
    transitionPhase(db, { runId: run.runId, toPhase: 'awaiting_plan_approval', toStep: 'wait_plan_approval', triggeredBy: 'system' });
    transitionPhase(db, { runId: run.runId, toPhase: 'executing', toStep: 'implementer_apply_changes', triggeredBy: 'system' });
    transitionPhase(db, { runId: run.runId, toPhase: 'awaiting_review', toStep: 'reviewer_review_code', triggeredBy: 'system' });
    db.prepare('UPDATE runs SET review_rounds = 3 WHERE run_id = ?').run(run.runId);
    transitionPhase(db, {
      runId: run.runId,
      toPhase: 'blocked',
      triggeredBy: 'system',
      blockedReason: 'Plan rejected after 3 revisions. Manual intervention required.',
      blockedContext: {
        prior_phase: 'awaiting_review',
        prior_step: 'reviewer_review_code',
        reason_code: 'max_review_rounds',
      },
    });

    const blockedRun = mustGetRun(db, run.runId);
    const result = await handleBlockedRetry(db, blockedRun, 'operator_1', deps);

    // reason_code wins: routes to implementer, not planner
    expect(result.retried).toBe(true);
    expect(result.priorPhase).toBe('executing');
    expect(result.priorStep).toBe('implementer_apply_changes');

    const updated = mustGetRun(db, run.runId);
    expect(updated.reviewRounds).toBe(0);
    expect(mockEnqueueAgent).toHaveBeenCalledWith(run.runId, 'implementer', 'apply_changes');
  });
});

// ---------------------------------------------------------------------------
// Write-path contract: reason_code persists through transitionPhase
// ---------------------------------------------------------------------------

describe('reason_code write-path contract', () => {
  it('persists reason_code in blocked_context_json via transitionPhase (worker markRunFailed shape)', () => {
    const seed = seedTestData(db);
    const run = createTestRun(db, seed);

    // Simulate what markRunFailed produces when called with reasonCode
    transitionPhase(db, {
      runId: run.runId,
      toPhase: 'blocked',
      triggeredBy: 'system',
      blockedReason: 'Plan rejected after 3 revisions. Manual intervention required.',
      blockedContext: {
        error: 'Plan rejected after 3 revisions. Manual intervention required.',
        prior_phase: 'pending',
        prior_step: 'setup_worktree',
        reason_code: 'max_plan_revisions',
      },
    });

    const blockedRun = mustGetRun(db, run.runId);
    expect(blockedRun.blockedContextJson).toBeDefined();

    const context = JSON.parse(blockedRun.blockedContextJson ?? '{}') as Record<string, unknown>;
    expect(context['reason_code']).toBe('max_plan_revisions');
    expect(context['prior_phase']).toBe('pending');
    expect(context['prior_step']).toBe('setup_worktree');
  });

  it('persists reason_code for max_review_rounds', () => {
    const seed = seedTestData(db);
    const run = createTestRun(db, seed);

    transitionPhase(db, { runId: run.runId, toPhase: 'planning', toStep: 'planner_create_plan', triggeredBy: 'system' });
    transitionPhase(db, { runId: run.runId, toPhase: 'awaiting_plan_approval', toStep: 'wait_plan_approval', triggeredBy: 'system' });
    transitionPhase(db, { runId: run.runId, toPhase: 'executing', toStep: 'implementer_apply_changes', triggeredBy: 'system' });
    transitionPhase(db, {
      runId: run.runId,
      toPhase: 'blocked',
      triggeredBy: 'system',
      blockedReason: 'Code rejected after 3 review rounds. Manual intervention required.',
      blockedContext: {
        error: 'Code rejected after 3 review rounds. Manual intervention required.',
        prior_phase: 'executing',
        prior_step: 'implementer_apply_changes',
        reason_code: 'max_review_rounds',
      },
    });

    const blockedRun = mustGetRun(db, run.runId);
    const context = JSON.parse(blockedRun.blockedContextJson ?? '{}') as Record<string, unknown>;
    expect(context['reason_code']).toBe('max_review_rounds');
  });

  it('persists rate_limit_exhausted with error_detail and retry metadata (markRunFailed shape)', () => {
    const seed = seedTestData(db);
    const run = createTestRun(db, seed);

    // Advance to executing so prior_phase/prior_step are meaningful
    transitionPhase(db, { runId: run.runId, toPhase: 'planning', toStep: 'planner_create_plan', triggeredBy: 'system' });
    transitionPhase(db, { runId: run.runId, toPhase: 'awaiting_plan_approval', toStep: 'wait_plan_approval', triggeredBy: 'system' });
    transitionPhase(db, { runId: run.runId, toPhase: 'executing', toStep: 'implementer_apply_changes', triggeredBy: 'system' });

    // Simulate what markRunFailed produces for rate_limit_exhausted:
    // blockedReason = short key, extraContext spread into blockedContext
    transitionPhase(db, {
      runId: run.runId,
      toPhase: 'blocked',
      triggeredBy: 'system',
      blockedReason: 'rate_limit_exhausted',
      blockedContext: {
        error: 'rate_limit_exhausted',
        prior_phase: 'executing',
        prior_step: 'implementer_apply_changes',
        // extraContext fields from handleRateLimitRetry:
        error_detail: "Rate-limit retry budget exhausted for agent 'implementer' (maxRetries=5). Manual retry available.",
        agent: 'implementer',
        action: 'apply_changes',
        retries_exhausted: 5,
        max_retries: 5,
        // reason_code set after spread:
        reason_code: 'rate_limit_exhausted',
      },
    });

    const blockedRun = mustGetRun(db, run.runId);
    expect(blockedRun.blockedReason).toBe('rate_limit_exhausted');

    const context = JSON.parse(blockedRun.blockedContextJson ?? '{}') as Record<string, unknown>;
    expect(context['reason_code']).toBe('rate_limit_exhausted');
    expect(context['error_detail']).toBe(
      "Rate-limit retry budget exhausted for agent 'implementer' (maxRetries=5). Manual retry available.",
    );
    expect(context['agent']).toBe('implementer');
    expect(context['action']).toBe('apply_changes');
    expect(context['retries_exhausted']).toBe(5);
    expect(context['max_retries']).toBe(5);
    expect(context['prior_phase']).toBe('executing');
    expect(context['prior_step']).toBe('implementer_apply_changes');
  });
});

// ---------------------------------------------------------------------------
// Baseline file cleanup during counter reset
// ---------------------------------------------------------------------------

describe('baseline file cleanup on counter reset', () => {
  const deps = {
    enqueueAgent: mockEnqueueAgent,
    enqueueRunJob: mockEnqueueRunJob,
    mirror: mockMirror,
  };
  const cleanupDirs: string[] = [];

  afterEach(() => {
    for (const dir of cleanupDirs) {
      try { rmSync(dir, { recursive: true }); } catch { /* benign */ }
    }
    cleanupDirs.length = 0;
  });

  function insertWorktreeRecord(db: Db, runId: string, path: string, seed: ReturnType<typeof seedTestData>) {
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO worktrees (worktree_id, run_id, project_id, repo_id, path, status, last_heartbeat_at, created_at)
      VALUES (?, ?, ?, ?, ?, 'active', ?, ?)
    `).run(`wt_${runId}`, runId, seed.projectId, seed.repoId, path, now, now);
  }

  it('clears baseline files when resetting plan_revisions', async () => {
    const seed = seedTestData(db);
    const run = createTestRun(db, seed);

    // Create temp dir simulating worktree parent + worktree
    const parentDir = mkdtempSync(join(tmpdir(), 'conductor-br-test-'));
    cleanupDirs.push(parentDir);
    const worktreePath = join(parentDir, 'worktree');
    // mkdirSync not needed — clearRunBaselineFiles reads the parent dir, not the worktree itself

    // Plant baseline file in parent dir (matches clearRunBaselineFiles naming)
    const baselineFile = join(parentDir, `.conductor-baseline-${run.runId}-planner-0`);
    writeFileSync(baselineFile, 'abc123abc123abc123abc123abc123abc123abcd');
    expect(existsSync(baselineFile)).toBe(true);

    // Insert worktree record so getWorktreeForRun finds it
    insertWorktreeRecord(db, run.runId, worktreePath, seed);

    // Advance to planning, set plan_revisions to 3, then block
    transitionPhase(db, {
      runId: run.runId,
      toPhase: 'planning',
      toStep: 'reviewer_review_plan',
      triggeredBy: 'system',
    });
    db.prepare('UPDATE runs SET plan_revisions = 3 WHERE run_id = ?').run(run.runId);
    transitionPhase(db, {
      runId: run.runId,
      toPhase: 'blocked',
      triggeredBy: 'system',
      blockedReason: 'Plan rejected after 3 revisions.',
      blockedContext: { error: 'Plan rejected', prior_phase: 'planning', prior_step: 'reviewer_review_plan', reason_code: 'max_plan_revisions' },
    });

    const blockedRun = mustGetRun(db, run.runId);
    await handleBlockedRetry(db, blockedRun, 'operator_1', deps);

    // Baseline file should be cleared by counterReset
    expect(existsSync(baselineFile)).toBe(false);
  });

  it('clears baseline files when resetting review_rounds', async () => {
    const seed = seedTestData(db);
    const run = createTestRun(db, seed);

    // Create temp dir simulating worktree parent + worktree
    const parentDir = mkdtempSync(join(tmpdir(), 'conductor-br-test-'));
    cleanupDirs.push(parentDir);
    const worktreePath = join(parentDir, 'worktree');

    // Plant baseline file
    const baselineFile = join(parentDir, `.conductor-baseline-${run.runId}-reviewerCode-0`);
    writeFileSync(baselineFile, 'def456def456def456def456def456def456defc');
    expect(existsSync(baselineFile)).toBe(true);

    // Insert worktree record
    insertWorktreeRecord(db, run.runId, worktreePath, seed);

    // Advance through pipeline to awaiting_review, then block
    transitionPhase(db, { runId: run.runId, toPhase: 'planning', toStep: 'planner_create_plan', triggeredBy: 'system' });
    transitionPhase(db, { runId: run.runId, toPhase: 'awaiting_plan_approval', toStep: 'wait_plan_approval', triggeredBy: 'system' });
    transitionPhase(db, { runId: run.runId, toPhase: 'executing', toStep: 'implementer_apply_changes', triggeredBy: 'system' });
    transitionPhase(db, { runId: run.runId, toPhase: 'awaiting_review', toStep: 'reviewer_review_code', triggeredBy: 'system' });
    db.prepare('UPDATE runs SET review_rounds = 3 WHERE run_id = ?').run(run.runId);
    transitionPhase(db, {
      runId: run.runId,
      toPhase: 'blocked',
      triggeredBy: 'system',
      blockedReason: 'Code rejected after 3 review rounds.',
      blockedContext: { error: 'Code rejected', prior_phase: 'awaiting_review', prior_step: 'reviewer_review_code', reason_code: 'max_review_rounds' },
    });

    const blockedRun = mustGetRun(db, run.runId);
    await handleBlockedRetry(db, blockedRun, 'operator_1', deps);

    // Baseline file should be cleared by counterReset
    expect(existsSync(baselineFile)).toBe(false);
  });
});
