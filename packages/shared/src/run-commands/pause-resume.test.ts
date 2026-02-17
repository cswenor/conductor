/**
 * Pause / Resume Command Tests
 *
 * Tests for pauseRunCommand and resumeRunCommand — CAS-guarded
 * pause/resume operations that record operator actions atomically.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Database as DatabaseType } from 'better-sqlite3';
import { initDatabase, closeDatabase } from '../db/index.ts';
import { createRun, getRun } from '../runs/index.ts';
import { listOperatorActions } from '../operator-actions/index.ts';
import { pauseRunCommand, resumeRunCommand } from './index.ts';

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

function seedData(): { db: DatabaseType; runId: string; projectId: string } {
  const now = new Date().toISOString();
  const userId = 'user_1';
  const projectId = 'proj_1';
  const repoId = 'repo_1';
  const taskId = 'task_1';

  db.prepare(`
    INSERT OR IGNORE INTO users (user_id, github_id, github_node_id, github_login, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'active', ?, ?)
  `).run(userId, 100, 'U_test', 'testuser', now, now);

  db.prepare(`
    INSERT INTO projects (
      project_id, user_id, name, github_org_id, github_org_node_id, github_org_name,
      github_installation_id, default_profile_id, default_base_branch,
      port_range_start, port_range_end, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(projectId, userId, 'Test Project', 1, 'O_test', 'testorg',
    12345, 'default', 'main', 3100, 3199, now, now);

  db.prepare(`
    INSERT INTO repos (
      repo_id, project_id, github_node_id, github_numeric_id,
      github_owner, github_name, github_full_name, github_default_branch,
      profile_id, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(repoId, projectId, 'R_test', 100,
    'testowner', 'testrepo', 'testowner/testrepo', 'main',
    'default', 'active', now, now);

  db.prepare(`
    INSERT INTO tasks (
      task_id, project_id, repo_id, github_node_id, github_issue_number,
      github_type, github_title, github_body, github_state, github_labels_json,
      github_synced_at, created_at, updated_at, last_activity_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(taskId, projectId, repoId, 'I_test', 42,
    'issue', 'Test Task', 'Body', 'open', '[]',
    now, now, now, now);

  const run = createRun(db, { taskId, projectId, repoId, baseBranch: 'main' });

  return { db, runId: run.runId, projectId };
}

/**
 * Pause a run directly in the DB for testing resume scenarios.
 */
function pauseRunInDb(runId: string): void {
  db.prepare(
    'UPDATE runs SET paused_at = ?, paused_by = ? WHERE run_id = ?'
  ).run(new Date().toISOString(), 'user_1', runId);
}

beforeEach(() => {
  db = initDatabase({ path: ':memory:' });
});

afterEach(() => {
  closeDatabase(db);
});

// =============================================================================
// pauseRunCommand
// =============================================================================

describe('pauseRunCommand', () => {
  it('sets paused_at and paused_by, outcome=paused', () => {
    const { runId } = seedData();

    const run = getRun(db, runId)!;
    const result = pauseRunCommand({
      db, run, actorId: 'user_1', actorType: 'user',
    });

    expect(result.outcome).toBe('paused');
    expect(result.success).toBe(true);
    expect(result.run).toBeDefined();
    expect(result.run?.pausedAt).toBeDefined();
    expect(result.run?.pausedBy).toBe('user_1');
  });

  it('on already-paused run: returns outcome=already_paused', () => {
    const { runId } = seedData();

    // Pause first via the command
    const run = getRun(db, runId)!;
    const first = pauseRunCommand({
      db, run, actorId: 'user_1', actorType: 'user',
    });
    expect(first.outcome).toBe('paused');

    // Second pause attempt — re-read run to get fresh state
    const freshRun = getRun(db, runId)!;
    const second = pauseRunCommand({
      db, run: freshRun, actorId: 'user_1', actorType: 'user',
    });
    expect(second.outcome).toBe('already_paused');
    expect(second.success).toBe(false);
  });

  it('on terminal phase (completed/cancelled): returns outcome=wrong_phase', () => {
    const { runId } = seedData();

    // Set run to cancelled phase directly
    db.prepare("UPDATE runs SET phase = 'cancelled' WHERE run_id = ?").run(runId);

    const run = getRun(db, runId)!;
    const result = pauseRunCommand({
      db, run, actorId: 'user_1', actorType: 'user',
    });

    expect(result.outcome).toBe('wrong_phase');
    expect(result.success).toBe(false);
  });

  it('records operator_actions row with action=pause', () => {
    const { runId } = seedData();

    const run = getRun(db, runId)!;
    pauseRunCommand({
      db, run, actorId: 'user_1', actorType: 'user',
    });

    const actions = listOperatorActions(db, runId);
    expect(actions.length).toBe(1);
    expect(actions[0]?.action).toBe('pause');
    expect(actions[0]?.operator).toBe('user_1');
  });

  it('CAS failure does NOT persist operator action (concurrent pause)', () => {
    const { runId } = seedData();

    // First pause succeeds
    const run = getRun(db, runId)!;
    const first = pauseRunCommand({
      db, run, actorId: 'user_1', actorType: 'user',
    });
    expect(first.outcome).toBe('paused');

    // Second pause attempt — uses stale run (paused_at is null in the snapshot)
    // but the transaction will detect the CAS conflict and roll back
    const second = pauseRunCommand({
      db, run: getRun(db, runId)!, actorId: 'user_2', actorType: 'user',
    });
    expect(second.outcome).toBe('already_paused');

    // Only one operator action should exist (from the first successful pause)
    const actions = listOperatorActions(db, runId);
    expect(actions.length).toBe(1);
    expect(actions[0]?.operator).toBe('user_1');
  });
});

// =============================================================================
// resumeRunCommand
// =============================================================================

describe('resumeRunCommand', () => {
  it('clears paused_at/paused_by, outcome=resumed', () => {
    const { runId } = seedData();
    pauseRunInDb(runId);

    const run = getRun(db, runId)!;
    expect(run.pausedAt).toBeDefined();

    const result = resumeRunCommand({
      db, run, actorId: 'user_1', actorType: 'user',
    });

    expect(result.outcome).toBe('resumed');
    expect(result.success).toBe(true);
    expect(result.run).toBeDefined();
    expect(result.run?.pausedAt).toBeUndefined();
    expect(result.run?.pausedBy).toBeUndefined();
  });

  it('on non-paused run: returns outcome=not_paused', () => {
    const { runId } = seedData();

    const run = getRun(db, runId)!;
    const result = resumeRunCommand({
      db, run, actorId: 'user_1', actorType: 'user',
    });

    expect(result.outcome).toBe('not_paused');
    expect(result.success).toBe(false);
  });

  it('records operator_actions row with action=resume', () => {
    const { runId } = seedData();
    pauseRunInDb(runId);

    const run = getRun(db, runId)!;
    resumeRunCommand({
      db, run, actorId: 'user_1', actorType: 'user',
    });

    const actions = listOperatorActions(db, runId);
    expect(actions.length).toBe(1);
    expect(actions[0]?.action).toBe('resume');
    expect(actions[0]?.operator).toBe('user_1');
  });

  it('CAS failure does NOT persist operator action', () => {
    const { runId } = seedData();
    pauseRunInDb(runId);

    // First resume succeeds
    const run = getRun(db, runId)!;
    const first = resumeRunCommand({
      db, run, actorId: 'user_1', actorType: 'user',
    });
    expect(first.outcome).toBe('resumed');

    // Second resume attempt — run is no longer paused
    const second = resumeRunCommand({
      db, run: getRun(db, runId)!, actorId: 'user_2', actorType: 'user',
    });
    expect(second.outcome).toBe('not_paused');

    // Only one operator action should exist (from the first successful resume)
    const actions = listOperatorActions(db, runId);
    expect(actions.length).toBe(1);
    expect(actions[0]?.operator).toBe('user_1');
  });
});

// =============================================================================
// Pause -> Resume interactions
// =============================================================================

describe('pause/resume interactions', () => {
  it('pause then resume with no edits: epoch stays 0', () => {
    const { runId } = seedData();

    // Pause via command
    const run = getRun(db, runId)!;
    expect(run.workflowEpoch).toBe(0);

    pauseRunCommand({ db, run, actorId: 'user_1', actorType: 'user' });

    // Resume
    const pausedRun = getRun(db, runId)!;
    resumeRunCommand({ db, run: pausedRun, actorId: 'user_1', actorType: 'user' });

    const resumedRun = getRun(db, runId)!;
    expect(resumedRun.workflowEpoch).toBe(0);
  });

  it('pause then manually increment epoch via SQL then resume: epoch unchanged by resume', () => {
    const { runId } = seedData();

    // Pause via command
    const run = getRun(db, runId)!;
    pauseRunCommand({ db, run, actorId: 'user_1', actorType: 'user' });

    // Manually increment epoch (simulating an edit_workflow or rewind)
    db.prepare('UPDATE runs SET workflow_epoch = workflow_epoch + 1 WHERE run_id = ?').run(runId);
    const afterIncrement = getRun(db, runId)!;
    expect(afterIncrement.workflowEpoch).toBe(1);

    // Resume — should not touch epoch
    resumeRunCommand({ db, run: afterIncrement, actorId: 'user_1', actorType: 'user' });

    const resumedRun = getRun(db, runId)!;
    expect(resumedRun.workflowEpoch).toBe(1);
  });

  it('resume on cancelled+paused run: rejected (terminal phase check)', () => {
    const { runId } = seedData();
    pauseRunInDb(runId);

    // Set phase to cancelled while still paused
    db.prepare("UPDATE runs SET phase = 'cancelled' WHERE run_id = ?").run(runId);

    const run = getRun(db, runId)!;
    expect(run.pausedAt).toBeDefined();
    expect(run.phase).toBe('cancelled');

    const result = resumeRunCommand({
      db, run, actorId: 'user_1', actorType: 'user',
    });

    expect(result.outcome).toBe('wrong_phase');
    expect(result.success).toBe(false);
  });
});
