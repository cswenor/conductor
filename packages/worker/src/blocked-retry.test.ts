/**
 * Tests for blocked-retry handler: phase restore, agent routing,
 * legacy fallback, and rollback-on-enqueue-failure.
 *
 * Uses a real in-memory SQLite database for transitions and events.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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
