/**
 * Operator Actions Service Tests
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Database as DatabaseType } from 'better-sqlite3';
import { initDatabase, closeDatabase } from '../db/index.ts';
import { createRun } from '../runs/index.ts';
import {
  generateOperatorActionId,
  isValidActionType,
  validateActionPhase,
  recordOperatorAction,
  getOperatorAction,
  listOperatorActions,
} from './index.ts';

let db: DatabaseType;

function seedTestData(database: DatabaseType): {
  runId: string;
  projectId: string;
} {
  const now = new Date().toISOString();
  const userId = 'user_test';
  const projectId = 'proj_test';
  const repoId = 'repo_test';
  const taskId = 'task_test';

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

  return { runId: run.runId, projectId };
}

/**
 * Helper to set a run's phase directly for testing.
 */
function setRunPhase(database: DatabaseType, runId: string, phase: string, extras?: {
  pausedAt?: string;
  blockedReason?: string;
}): void {
  database.prepare(`
    UPDATE runs SET phase = ?, paused_at = ?, blocked_reason = ?, updated_at = ?
    WHERE run_id = ?
  `).run(
    phase,
    extras?.pausedAt ?? null,
    extras?.blockedReason ?? null,
    new Date().toISOString(),
    runId,
  );
}

beforeEach(() => {
  db = initDatabase({ path: ':memory:' });
});

afterEach(() => {
  closeDatabase(db);
});

// =============================================================================
// ID Generation
// =============================================================================

describe('generateOperatorActionId', () => {
  it('produces ids with oa_ prefix', () => {
    const id = generateOperatorActionId();
    expect(id).toMatch(/^oa_/);
  });

  it('produces unique ids', () => {
    const ids = new Set(Array.from({ length: 100 }, () => generateOperatorActionId()));
    expect(ids.size).toBe(100);
  });
});

// =============================================================================
// Validation
// =============================================================================

describe('isValidActionType', () => {
  it('accepts valid action types', () => {
    expect(isValidActionType('approve_plan')).toBe(true);
    expect(isValidActionType('cancel')).toBe(true);
    expect(isValidActionType('retry')).toBe(true);
    expect(isValidActionType('grant_policy_exception')).toBe(true);
  });

  it('rejects invalid action types', () => {
    expect(isValidActionType('invalid')).toBe(false);
    expect(isValidActionType('')).toBe(false);
    expect(isValidActionType('CANCEL')).toBe(false);
  });
});

describe('validateActionPhase', () => {
  it('approve_plan valid in awaiting_plan_approval', () => {
    expect(validateActionPhase('approve_plan', 'awaiting_plan_approval')).toBeNull();
  });

  it('approve_plan invalid in executing', () => {
    expect(validateActionPhase('approve_plan', 'executing')).toBeTruthy();
  });

  it('revise_plan valid in awaiting_plan_approval', () => {
    expect(validateActionPhase('revise_plan', 'awaiting_plan_approval')).toBeNull();
  });

  it('revise_plan invalid in planning', () => {
    expect(validateActionPhase('revise_plan', 'planning')).toBeTruthy();
  });

  it('reject_run valid in awaiting_plan_approval', () => {
    expect(validateActionPhase('reject_run', 'awaiting_plan_approval')).toBeNull();
  });

  it('retry valid in blocked', () => {
    expect(validateActionPhase('retry', 'blocked')).toBeNull();
  });

  it('retry invalid in executing', () => {
    expect(validateActionPhase('retry', 'executing')).toBeTruthy();
  });

  it('pause valid in active non-blocked phases', () => {
    expect(validateActionPhase('pause', 'pending')).toBeNull();
    expect(validateActionPhase('pause', 'planning')).toBeNull();
    expect(validateActionPhase('pause', 'executing')).toBeNull();
    expect(validateActionPhase('pause', 'awaiting_plan_approval')).toBeNull();
    expect(validateActionPhase('pause', 'awaiting_review')).toBeNull();
  });

  it('pause invalid in terminal or blocked phases', () => {
    expect(validateActionPhase('pause', 'completed')).toBeTruthy();
    expect(validateActionPhase('pause', 'cancelled')).toBeTruthy();
    expect(validateActionPhase('pause', 'blocked')).toBeTruthy();
  });

  it('pause invalid when already paused', () => {
    expect(validateActionPhase('pause', 'executing', '2024-01-01T00:00:00Z')).toBeTruthy();
  });

  it('resume valid when paused', () => {
    expect(validateActionPhase('resume', 'executing', '2024-01-01T00:00:00Z')).toBeNull();
  });

  it('resume invalid when not paused', () => {
    expect(validateActionPhase('resume', 'executing')).toBeTruthy();
  });

  it('cancel valid in any non-terminal phase', () => {
    expect(validateActionPhase('cancel', 'pending')).toBeNull();
    expect(validateActionPhase('cancel', 'planning')).toBeNull();
    expect(validateActionPhase('cancel', 'executing')).toBeNull();
    expect(validateActionPhase('cancel', 'blocked')).toBeNull();
  });

  it('cancel invalid in terminal phases', () => {
    expect(validateActionPhase('cancel', 'completed')).toBeTruthy();
    expect(validateActionPhase('cancel', 'cancelled')).toBeTruthy();
  });

  it('grant_policy_exception valid in blocked', () => {
    expect(validateActionPhase('grant_policy_exception', 'blocked')).toBeNull();
  });

  it('deny_policy_exception valid in blocked', () => {
    expect(validateActionPhase('deny_policy_exception', 'blocked')).toBeNull();
  });

  it('grant_policy_exception invalid in executing', () => {
    expect(validateActionPhase('grant_policy_exception', 'executing')).toBeTruthy();
  });
});

// =============================================================================
// recordOperatorAction
// =============================================================================

describe('recordOperatorAction', () => {
  it('records action with all required fields', () => {
    const { runId } = seedTestData(db);
    // Run starts in 'pending', cancel is valid in any non-terminal phase
    const action = recordOperatorAction(db, {
      runId,
      action: 'cancel',
      actorId: 'user_test',
      actorType: 'operator',
      actorDisplayName: 'Test User',
      comment: 'Cancelling for test',
      fromPhase: 'pending',
      toPhase: 'cancelled',
    });

    expect(action.operatorActionId).toMatch(/^oa_/);
    expect(action.runId).toBe(runId);
    expect(action.action).toBe('cancel');
    expect(action.operator).toBe('user_test');
    expect(action.actorType).toBe('operator');
    expect(action.actorDisplayName).toBe('Test User');
    expect(action.comment).toBe('Cancelling for test');
    expect(action.fromPhase).toBe('pending');
    expect(action.toPhase).toBe('cancelled');
    expect(action.createdAt).toBeTruthy();
  });

  it('records action without optional fields', () => {
    const { runId } = seedTestData(db);
    const action = recordOperatorAction(db, {
      runId,
      action: 'cancel',
      actorId: 'user_test',
      actorType: 'operator',
    });

    expect(action.comment).toBeUndefined();
    expect(action.fromPhase).toBeUndefined();
    expect(action.toPhase).toBeUndefined();
  });

  it('falls back actorDisplayName to actorId when not provided', () => {
    const { runId } = seedTestData(db);
    const action = recordOperatorAction(db, {
      runId,
      action: 'cancel',
      actorId: 'user_test',
      actorType: 'operator',
    });

    expect(action.actorDisplayName).toBe('user_test');

    // Verify it persisted correctly via a read-back
    const fetched = getOperatorAction(db, runId, 'cancel');
    expect(fetched?.actorDisplayName).toBe('user_test');
    expect(fetched?.actorType).toBe('operator');
  });

  it('throws on invalid action type', () => {
    const { runId } = seedTestData(db);
    expect(() => recordOperatorAction(db, {
      runId,
      action: 'invalid' as never,
      actorId: 'user_test',
      actorType: 'operator',
    })).toThrow('Invalid action type');
  });

  it('throws on non-existent run', () => {
    expect(() => recordOperatorAction(db, {
      runId: 'run_nonexistent',
      action: 'cancel',
      actorId: 'user_test',
      actorType: 'operator',
    })).toThrow('Run not found');
  });

  it('throws when action incompatible with phase', () => {
    const { runId } = seedTestData(db);
    // Run is in 'pending' phase, approve_plan requires 'awaiting_plan_approval'
    expect(() => recordOperatorAction(db, {
      runId,
      action: 'approve_plan',
      actorId: 'user_test',
      actorType: 'operator',
    })).toThrow("Action 'approve_plan' is not valid in phase 'pending'");
  });

  it('allows approve_plan in awaiting_plan_approval phase', () => {
    const { runId } = seedTestData(db);
    setRunPhase(db, runId, 'awaiting_plan_approval');

    const action = recordOperatorAction(db, {
      runId,
      action: 'approve_plan',
      actorId: 'user_test',
      actorType: 'operator',
      comment: 'Looks good',
    });

    expect(action.action).toBe('approve_plan');
  });

  it('allows retry in blocked phase', () => {
    const { runId } = seedTestData(db);
    setRunPhase(db, runId, 'blocked', { blockedReason: 'gate_failed' });

    const action = recordOperatorAction(db, {
      runId,
      action: 'retry',
      actorId: 'user_test',
      actorType: 'operator',
    });

    expect(action.action).toBe('retry');
  });

  it('allows grant_policy_exception in blocked phase', () => {
    const { runId } = seedTestData(db);
    setRunPhase(db, runId, 'blocked', { blockedReason: 'policy_exception_required' });

    const action = recordOperatorAction(db, {
      runId,
      action: 'grant_policy_exception',
      actorId: 'user_test',
      actorType: 'operator',
      comment: 'Justified override',
    });

    expect(action.action).toBe('grant_policy_exception');
  });
});

// =============================================================================
// getOperatorAction
// =============================================================================

describe('getOperatorAction', () => {
  it('returns the latest action of a given type', () => {
    const { runId } = seedTestData(db);

    // Record two cancel actions
    recordOperatorAction(db, {
      runId,
      action: 'cancel',
      actorId: 'user_test',
      actorType: 'operator',
      comment: 'First cancel',
    });
    recordOperatorAction(db, {
      runId,
      action: 'cancel',
      actorId: 'user_test',
      actorType: 'operator',
      comment: 'Second cancel',
    });

    const latest = getOperatorAction(db, runId, 'cancel');
    expect(latest).not.toBeNull();
    expect(latest?.comment).toBe('Second cancel');
  });

  it('returns null when no actions of that type exist', () => {
    const { runId } = seedTestData(db);
    expect(getOperatorAction(db, runId, 'approve_plan')).toBeNull();
  });

  it('only returns actions of the requested type', () => {
    const { runId } = seedTestData(db);

    recordOperatorAction(db, {
      runId,
      action: 'cancel',
      actorId: 'user_test',
      actorType: 'operator',
    });

    expect(getOperatorAction(db, runId, 'approve_plan')).toBeNull();
    expect(getOperatorAction(db, runId, 'cancel')).not.toBeNull();
  });
});

// =============================================================================
// listOperatorActions
// =============================================================================

describe('listOperatorActions', () => {
  it('lists all actions ordered by created_at', () => {
    const { runId } = seedTestData(db);

    recordOperatorAction(db, {
      runId,
      action: 'cancel',
      actorId: 'user_test',
      actorType: 'operator',
      comment: 'First',
    });
    recordOperatorAction(db, {
      runId,
      action: 'cancel',
      actorId: 'user_test',
      actorType: 'operator',
      comment: 'Second',
    });

    const actions = listOperatorActions(db, runId);
    expect(actions).toHaveLength(2);
    expect(actions[0]?.comment).toBe('First');
    expect(actions[1]?.comment).toBe('Second');
  });

  it('returns empty array for run with no actions', () => {
    const { runId } = seedTestData(db);
    expect(listOperatorActions(db, runId)).toHaveLength(0);
  });
});
