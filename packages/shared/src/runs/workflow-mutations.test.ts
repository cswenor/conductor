/**
 * Workflow Mutations Service Tests
 *
 * Tests for applyWorkflowOverlay and rewindRun — pause-only mutations
 * that enforce CAS guards and active-invocation checks.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Database as DatabaseType } from 'better-sqlite3';
import { initDatabase, closeDatabase } from '../db/index.ts';
import { createRun, getRun } from './index.ts';
import { listOperatorActions } from '../operator-actions/index.ts';
import { listRunEvents } from '../events/index.ts';
import { applyWorkflowOverlay, rewindRun, rewindToCheckpoint } from './workflow-mutations.ts';

// Mock pubsub to prevent actual Redis calls
vi.mock('../pubsub/index.ts', () => ({
  publishOperatorActionEvent: vi.fn(),
  publishRunUpdatedEvent: vi.fn(),
  publishTransitionEvent: vi.fn(),
  initPublisher: vi.fn(),
  publishGateEvaluatedEvent: vi.fn(),
  publishAgentInvocationEvent: vi.fn(),
  publishProjectUpdatedEvent: vi.fn(),
}));

let db: DatabaseType;

function seedTestData(database: DatabaseType): {
  runId: string;
  projectId: string;
  repoId: string;
  taskId: string;
} {
  const now = new Date().toISOString();
  const userId = 'user_1';
  const projectId = 'proj_1';
  const repoId = 'repo_1';
  const taskId = 'task_1';

  database.prepare(`
    INSERT OR IGNORE INTO users (user_id, github_id, github_node_id, github_login, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'active', ?, ?)
  `).run(userId, 100, 'U_test', 'testuser', now, now);

  database.prepare(`
    INSERT INTO projects (
      project_id, user_id, name, github_org_id, github_org_node_id, github_org_name,
      github_installation_id, default_profile_id, default_base_branch,
      port_range_start, port_range_end, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(projectId, userId, 'Test Project', 1, 'O_test', 'testorg',
    12345, 'default', 'main', 3100, 3199, now, now);

  database.prepare(`
    INSERT INTO repos (
      repo_id, project_id, github_node_id, github_numeric_id,
      github_owner, github_name, github_full_name, github_default_branch,
      profile_id, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(repoId, projectId, 'R_test', 100,
    'testowner', 'testrepo', 'testowner/testrepo', 'main',
    'default', 'active', now, now);

  database.prepare(`
    INSERT INTO tasks (
      task_id, project_id, repo_id, github_node_id, github_issue_number,
      github_type, github_title, github_body, github_state, github_labels_json,
      github_synced_at, created_at, updated_at, last_activity_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(taskId, projectId, repoId, 'I_test', 42,
    'issue', 'Test Task', 'Body', 'open', '[]',
    now, now, now, now);

  const run = createRun(database, { taskId, projectId, repoId, baseBranch: 'main' });

  return { runId: run.runId, projectId, repoId, taskId };
}

/**
 * Pause a run directly in the DB for testing.
 */
function pauseRun(database: DatabaseType, runId: string): void {
  database.prepare(
    'UPDATE runs SET paused_at = ?, paused_by = ? WHERE run_id = ?'
  ).run(new Date().toISOString(), 'user_1', runId);
}

/**
 * Insert an active agent invocation for a run.
 */
function createActiveInvocation(database: DatabaseType, runId: string): void {
  database.prepare(
    'INSERT INTO agent_invocations (agent_invocation_id, run_id, agent, action, status, started_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run('ai_1', runId, 'planner', 'create_plan', 'running', new Date().toISOString());
}

beforeEach(() => {
  db = initDatabase({ path: ':memory:' });
});

afterEach(() => {
  closeDatabase(db);
});

// =============================================================================
// applyWorkflowOverlay
// =============================================================================

describe('applyWorkflowOverlay', () => {
  it('saves overlay and increments epoch from 0 to 1 when paused', () => {
    const { runId } = seedTestData(db);
    pauseRun(db, runId);

    const runBefore = getRun(db, runId);
    expect(runBefore?.workflowEpoch).toBe(0);

    const result = applyWorkflowOverlay(db, runId, { planner: { model: 'claude-sonnet-4-20250514' } }, 'user_1');

    expect(result.success).toBe(true);
    expect(result.error).toBeUndefined();
    expect(result.run).toBeDefined();
    expect(result.run?.workflowEpoch).toBe(1);
    expect(result.run?.workflowOverlayJson).toBe(JSON.stringify({ planner: { model: 'claude-sonnet-4-20250514' } }));
  });

  it('returns error when run is not paused', () => {
    const { runId } = seedTestData(db);
    // Run is NOT paused — pre-validation returns structured error

    const result = applyWorkflowOverlay(db, runId, { planner: { model: 'claude-sonnet-4-20250514' } }, 'user_1');

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/paused/i);
  });

  it('returns validation errors for invalid overlay', () => {
    const { runId } = seedTestData(db);
    pauseRun(db, runId);

    const result = applyWorkflowOverlay(db, runId, { unknown_step: {} }, 'user_1');

    expect(result.success).toBe(false);
    expect(result.error).toBe('Invalid workflow config');
    expect(result.details).toBeDefined();
    expect(result.details?.length).toBeGreaterThan(0);
    expect(result.details?.some(d => d.includes('unknown_step'))).toBe(true);
  });

  it('returns error when an active agent invocation exists', () => {
    const { runId } = seedTestData(db);
    pauseRun(db, runId);
    createActiveInvocation(db, runId);

    const result = applyWorkflowOverlay(db, runId, { planner: { model: 'claude-sonnet-4-20250514' } }, 'user_1');

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/agent invocation/i);
  });

  it('records operator_actions row with action edit_workflow', () => {
    const { runId } = seedTestData(db);
    pauseRun(db, runId);

    applyWorkflowOverlay(db, runId, { planner: { temperature: 0.5 } }, 'user_1');

    const actions = listOperatorActions(db, runId);
    expect(actions.length).toBe(1);
    expect(actions[0]?.action).toBe('edit_workflow');
    expect(actions[0]?.operator).toBe('user_1');
  });
});

// =============================================================================
// rewindRun
// =============================================================================

describe('rewindRun', () => {
  it('updates step/phase and increments epoch when paused', () => {
    const { runId } = seedTestData(db);
    // Set the run to an advanced step so rewind is meaningful
    db.prepare("UPDATE runs SET step = 'implementer_apply_changes', phase = 'executing' WHERE run_id = ?").run(runId);
    pauseRun(db, runId);

    const runBefore = getRun(db, runId);
    expect(runBefore?.workflowEpoch).toBe(0);

    const result = rewindRun(db, runId, 'planner_create_plan', 'user_1');

    expect(result.success).toBe(true);
    expect(result.error).toBeUndefined();
    expect(result.run).toBeDefined();
    expect(result.run?.step).toBe('planner_create_plan');
    expect(result.run?.phase).toBe('planning');
    expect(result.run?.workflowEpoch).toBe(1);
  });

  it('returns error when run is not paused', () => {
    const { runId } = seedTestData(db);

    const result = rewindRun(db, runId, 'planner_create_plan', 'user_1');

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/paused/i);
  });

  it('returns error for invalid step (wait_pr_merge)', () => {
    const { runId } = seedTestData(db);
    pauseRun(db, runId);

    const result = rewindRun(db, runId, 'wait_pr_merge', 'user_1');

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/wait_pr_merge/);
  });

  it('creates event with correct type operator.action and rewind payload', () => {
    const { runId } = seedTestData(db);
    db.prepare("UPDATE runs SET step = 'implementer_apply_changes', phase = 'executing' WHERE run_id = ?").run(runId);
    pauseRun(db, runId);

    rewindRun(db, runId, 'planner_create_plan', 'user_1');

    const events = listRunEvents(db, runId);
    const rewindEvent = events.find(e => e.type === 'operator.action');
    expect(rewindEvent).toBeDefined();
    expect(rewindEvent?.payload).toEqual(expect.objectContaining({
      action: 'rewind',
      fromStep: 'implementer_apply_changes',
      fromPhase: 'executing',
      toStep: 'planner_create_plan',
      toPhase: 'planning',
      triggeredBy: 'user_1',
    }));
  });

  it('creates event with source operator', () => {
    const { runId } = seedTestData(db);
    db.prepare("UPDATE runs SET step = 'implementer_apply_changes', phase = 'executing' WHERE run_id = ?").run(runId);
    pauseRun(db, runId);

    rewindRun(db, runId, 'planner_create_plan', 'user_1');

    const events = listRunEvents(db, runId);
    const rewindEvent = events.find(e => e.type === 'operator.action');
    expect(rewindEvent).toBeDefined();
    expect(rewindEvent?.source).toBe('operator');
  });

  it('returns error when an active agent invocation exists', () => {
    const { runId } = seedTestData(db);
    db.prepare("UPDATE runs SET step = 'implementer_apply_changes', phase = 'executing' WHERE run_id = ?").run(runId);
    pauseRun(db, runId);
    createActiveInvocation(db, runId);

    const result = rewindRun(db, runId, 'planner_create_plan', 'user_1');

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/agent invocation/i);
  });

  it('records operator_actions row with action rewind', () => {
    const { runId } = seedTestData(db);
    db.prepare("UPDATE runs SET step = 'implementer_apply_changes', phase = 'executing' WHERE run_id = ?").run(runId);
    pauseRun(db, runId);

    rewindRun(db, runId, 'planner_create_plan', 'user_1');

    const actions = listOperatorActions(db, runId);
    expect(actions.length).toBe(1);
    expect(actions[0]?.action).toBe('rewind');
    expect(actions[0]?.operator).toBe('user_1');
  });

  it('sequence fields match formula (next_sequence = sequence + 1, last_event_sequence = sequence)', () => {
    const { runId } = seedTestData(db);
    db.prepare("UPDATE runs SET step = 'implementer_apply_changes', phase = 'executing' WHERE run_id = ?").run(runId);
    pauseRun(db, runId);

    const runBefore = getRun(db, runId);
    // Before rewind: nextSequence and lastEventSequence are at initial values.
    // The rewind allocates: sequence = max(nextSequence, maxEventSeq + 1)
    // Then sets: next_sequence = sequence + 1, last_event_sequence = sequence
    const expectedSequence = Math.max(
      runBefore?.nextSequence ?? 0,
      1, // maxEventSeq + 1 when no events exist yet
    );

    rewindRun(db, runId, 'planner_create_plan', 'user_1');

    const runAfter = getRun(db, runId);
    expect(runAfter?.nextSequence).toBe(expectedSequence + 1);
    expect(runAfter?.lastEventSequence).toBe(expectedSequence);

    // Also verify the event itself has the correct sequence
    const events = listRunEvents(db, runId);
    const rewindEvent = events.find(e => e.type === 'operator.action');
    expect(rewindEvent?.sequence).toBe(expectedSequence);
  });

  it('accepts options without breaking backward compat (options param is optional)', () => {
    const { runId } = seedTestData(db);
    db.prepare("UPDATE runs SET step = 'implementer_apply_changes', phase = 'executing' WHERE run_id = ?").run(runId);
    pauseRun(db, runId);

    // Call without options — should still work
    const result = rewindRun(db, runId, 'planner_create_plan', 'user_1');
    expect(result.success).toBe(true);
    expect(result.run?.rewindContextMode).toBeUndefined();
    expect(result.run?.rewindContextSummary).toBeUndefined();
  });

  it('stores contextMode and contextSummary when provided', () => {
    const { runId } = seedTestData(db);
    db.prepare("UPDATE runs SET step = 'implementer_apply_changes', phase = 'executing' WHERE run_id = ?").run(runId);
    pauseRun(db, runId);

    const result = rewindRun(db, runId, 'planner_create_plan', 'user_1', {
      contextMode: 'preserve',
      contextSummary: 'Summary of prior work',
    });

    expect(result.success).toBe(true);
    expect(result.run?.rewindContextMode).toBe('preserve');
    expect(result.run?.rewindContextSummary).toBe('Summary of prior work');
  });

  it('stores truncate mode with null summary', () => {
    const { runId } = seedTestData(db);
    db.prepare("UPDATE runs SET step = 'implementer_apply_changes', phase = 'executing' WHERE run_id = ?").run(runId);
    pauseRun(db, runId);

    const result = rewindRun(db, runId, 'planner_create_plan', 'user_1', {
      contextMode: 'truncate',
    });

    expect(result.success).toBe(true);
    expect(result.run?.rewindContextMode).toBe('truncate');
    expect(result.run?.rewindContextSummary).toBeUndefined();
  });

  it('enriches event payload with checkpoint/contextMode/reason', () => {
    const { runId } = seedTestData(db);
    db.prepare("UPDATE runs SET step = 'implementer_apply_changes', phase = 'executing' WHERE run_id = ?").run(runId);
    pauseRun(db, runId);

    rewindRun(db, runId, 'planner_create_plan', 'user_1', {
      checkpoint: 'planning:start',
      contextMode: 'preserve',
      reason: 'Test reason',
    });

    const events = listRunEvents(db, runId);
    const rewindEvent = events.find(e => e.type === 'operator.action');
    expect(rewindEvent?.payload).toEqual(expect.objectContaining({
      checkpoint: 'planning:start',
      contextMode: 'preserve',
      reason: 'Test reason',
    }));
  });

  it('uses reason as operator action comment when provided', () => {
    const { runId } = seedTestData(db);
    db.prepare("UPDATE runs SET step = 'implementer_apply_changes', phase = 'executing' WHERE run_id = ?").run(runId);
    pauseRun(db, runId);

    rewindRun(db, runId, 'planner_create_plan', 'user_1', {
      reason: 'Custom reason',
    });

    const actions = listOperatorActions(db, runId);
    expect(actions.length).toBe(1);
    expect(actions[0]?.comment).toBe('Custom reason');
  });
});

// =============================================================================
// rewindToCheckpoint
// =============================================================================

describe('rewindToCheckpoint', () => {
  it('succeeds when paused with valid checkpoint', () => {
    const { runId } = seedTestData(db);
    db.prepare("UPDATE runs SET step = 'implementer_apply_changes', phase = 'executing' WHERE run_id = ?").run(runId);
    pauseRun(db, runId);

    const result = rewindToCheckpoint(db, runId, 'planning:start', 'user_1');

    expect(result.success).toBe(true);
    expect(result.run?.step).toBe('planner_create_plan');
    expect(result.run?.phase).toBe('planning');
  });

  it('returns error for completed (non-rewindable)', () => {
    const { runId } = seedTestData(db);
    pauseRun(db, runId);

    const result = rewindToCheckpoint(db, runId, 'completed', 'user_1');

    expect(result.success).toBe(false);
    expect(result.error).toContain('non-rewindable');
  });

  it('returns error for unknown checkpoint', () => {
    const { runId } = seedTestData(db);
    pauseRun(db, runId);

    const result = rewindToCheckpoint(db, runId, 'garbage', 'user_1');

    expect(result.success).toBe(false);
    expect(result.error).toContain('Unknown');
  });

  it('preserve mode stores non-empty summary on run', () => {
    const { runId } = seedTestData(db);
    db.prepare("UPDATE runs SET step = 'implementer_apply_changes', phase = 'executing' WHERE run_id = ?").run(runId);
    pauseRun(db, runId);

    // Add an invocation so the summary has content
    db.prepare(
      'INSERT INTO agent_invocations (agent_invocation_id, run_id, agent, action, status, started_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run('ai_1', runId, 'planner', 'create_plan', 'completed', new Date().toISOString());

    const result = rewindToCheckpoint(db, runId, 'planning:start', 'user_1', 'preserve');

    expect(result.success).toBe(true);
    expect(result.run?.rewindContextMode).toBe('preserve');
    expect(result.run?.rewindContextSummary).toBeDefined();
    expect(result.run?.rewindContextSummary?.length).toBeGreaterThan(0);
    expect(result.run?.rewindContextSummary).toContain('planner:create_plan');
  });

  it('truncate mode stores mode with no summary', () => {
    const { runId } = seedTestData(db);
    db.prepare("UPDATE runs SET step = 'implementer_apply_changes', phase = 'executing' WHERE run_id = ?").run(runId);
    pauseRun(db, runId);

    const result = rewindToCheckpoint(db, runId, 'planning:start', 'user_1', 'truncate');

    expect(result.success).toBe(true);
    expect(result.run?.rewindContextMode).toBe('truncate');
    expect(result.run?.rewindContextSummary).toBeUndefined();
  });

  it('defaults contextMode to truncate when not provided', () => {
    const { runId } = seedTestData(db);
    db.prepare("UPDATE runs SET step = 'implementer_apply_changes', phase = 'executing' WHERE run_id = ?").run(runId);
    pauseRun(db, runId);

    const result = rewindToCheckpoint(db, runId, 'planning:start', 'user_1');

    expect(result.success).toBe(true);
    expect(result.run?.rewindContextMode).toBe('truncate');
  });

  it('event payload includes checkpoint and contextMode', () => {
    const { runId } = seedTestData(db);
    db.prepare("UPDATE runs SET step = 'implementer_apply_changes', phase = 'executing' WHERE run_id = ?").run(runId);
    pauseRun(db, runId);

    rewindToCheckpoint(db, runId, 'executing:start', 'user_1', 'preserve', 'Operator wants redo');

    const events = listRunEvents(db, runId);
    const rewindEvent = events.find(e => e.type === 'operator.action');
    expect(rewindEvent?.payload).toEqual(expect.objectContaining({
      checkpoint: 'executing:start',
      contextMode: 'preserve',
      reason: 'Operator wants redo',
    }));
  });
});
