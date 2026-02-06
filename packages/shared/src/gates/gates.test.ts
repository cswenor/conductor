/**
 * Gates Module Tests
 *
 * Tests for gate definitions seeder and gate evaluations CRUD.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Database as DatabaseType } from 'better-sqlite3';
import { initDatabase, closeDatabase } from '../db/index.js';
import { createRun } from '../runs/index.js';
import { createEvent } from '../events/index.js';
import {
  ensureBuiltInGateDefinitions,
  BUILT_IN_GATES,
  getGateDefinition,
  listGateDefinitions,
} from './gate-definitions.js';
import {
  generateGateEvaluationId,
  createGateEvaluation,
  getLatestGateEvaluation,
  listGateEvaluations,
  deriveGateState,
  getRunsAwaitingGates,
} from './gate-evaluations.js';

let db: DatabaseType;

function seedTestData(database: DatabaseType): {
  runId: string;
  projectId: string;
  repoId: string;
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

  return { runId: run.runId, projectId, repoId };
}

/**
 * Helper to create a causation event for gate evaluation tests.
 */
function createCausationEvent(
  database: DatabaseType,
  runId: string,
  projectId: string,
  idempotencyKeySuffix: string,
  sequence?: number,
): string {
  const event = createEvent(database, {
    projectId,
    runId,
    type: 'gate.evaluated',
    class: 'decision',
    payload: { test: true },
    idempotencyKey: `test:gate:${runId}:${idempotencyKeySuffix}`,
    source: 'worker',
    sequence,
  });
  return event?.eventId ?? '';
}

beforeEach(() => {
  db = initDatabase({ path: ':memory:' });
  ensureBuiltInGateDefinitions(db);
});

afterEach(() => {
  closeDatabase(db);
});

// =============================================================================
// Gate Definitions Seeder
// =============================================================================

describe('ensureBuiltInGateDefinitions', () => {
  it('inserts all 4 built-in gate definitions', () => {
    const rows = db.prepare('SELECT * FROM gate_definitions ORDER BY gate_id').all() as Array<{
      gate_id: string;
      kind: string;
      description: string;
    }>;

    expect(rows).toHaveLength(4);
    const ids = rows.map((r) => r.gate_id);
    expect(ids).toContain('plan_approval');
    expect(ids).toContain('tests_pass');
    expect(ids).toContain('code_review');
    expect(ids).toContain('merge_wait');
  });

  it('is idempotent — second call does not fail or duplicate', () => {
    ensureBuiltInGateDefinitions(db);
    ensureBuiltInGateDefinitions(db);

    const rows = db.prepare('SELECT * FROM gate_definitions').all();
    expect(rows).toHaveLength(4);
  });

  it('stores correct kinds for each gate', () => {
    const planApproval = getGateDefinition(db, 'plan_approval');
    expect(planApproval?.kind).toBe('human');

    const testsPass = getGateDefinition(db, 'tests_pass');
    expect(testsPass?.kind).toBe('automatic');

    const codeReview = getGateDefinition(db, 'code_review');
    expect(codeReview?.kind).toBe('automatic');

    const mergeWait = getGateDefinition(db, 'merge_wait');
    expect(mergeWait?.kind).toBe('human');
  });

  it('stores config with timeout_hours and reminder_hours for plan_approval', () => {
    const gate = getGateDefinition(db, 'plan_approval');
    expect(gate).not.toBeNull();
    const config = JSON.parse(gate?.defaultConfigJson ?? '{}');
    expect(config.timeout_hours).toBe(72);
    expect(config.reminder_hours).toBe(24);
    expect(config.required).toBe(true);
  });

  it('stores config with allow_skip for tests_pass', () => {
    const gate = getGateDefinition(db, 'tests_pass');
    expect(gate).not.toBeNull();
    const config = JSON.parse(gate?.defaultConfigJson ?? '{}');
    expect(config.max_retries).toBe(3);
    expect(config.timeout_minutes).toBe(15);
    expect(config.allow_skip).toBe(false);
  });

  it('stores config with allow_accept_with_issues for code_review', () => {
    const gate = getGateDefinition(db, 'code_review');
    expect(gate).not.toBeNull();
    const config = JSON.parse(gate?.defaultConfigJson ?? '{}');
    expect(config.max_rounds).toBe(3);
    expect(config.allow_accept_with_issues).toBe(true);
  });
});

describe('getGateDefinition', () => {
  it('returns null for non-existent gate', () => {
    expect(getGateDefinition(db, 'nonexistent')).toBeNull();
  });

  it('returns the gate definition with all fields', () => {
    const gate = getGateDefinition(db, 'plan_approval');
    expect(gate).not.toBeNull();
    expect(gate?.gateId).toBe('plan_approval');
    expect(gate?.kind).toBe('human');
    expect(gate?.description).toContain('approval');
  });
});

describe('listGateDefinitions', () => {
  it('returns all gate definitions sorted by gate_id', () => {
    const gates = listGateDefinitions(db);
    expect(gates).toHaveLength(4);
    expect(gates[0]?.gateId).toBe('code_review');
    expect(gates[1]?.gateId).toBe('merge_wait');
    expect(gates[2]?.gateId).toBe('plan_approval');
    expect(gates[3]?.gateId).toBe('tests_pass');
  });
});

// =============================================================================
// Gate Evaluation ID Generation
// =============================================================================

describe('generateGateEvaluationId', () => {
  it('produces ids with ge_ prefix', () => {
    const id = generateGateEvaluationId();
    expect(id).toMatch(/^ge_/);
  });

  it('produces unique ids', () => {
    const ids = new Set(Array.from({ length: 100 }, () => generateGateEvaluationId()));
    expect(ids.size).toBe(100);
  });
});

// =============================================================================
// Gate Evaluations CRUD
// =============================================================================

describe('createGateEvaluation', () => {
  it('creates evaluation with all required fields', () => {
    const { runId, projectId } = seedTestData(db);
    const eventId = createCausationEvent(db, runId, projectId, 'create-1');

    const evaluation = createGateEvaluation(db, {
      runId,
      gateId: 'plan_approval',
      kind: 'human',
      status: 'pending',
      reason: 'Awaiting operator approval',
      causationEventId: eventId,
    });

    expect(evaluation.gateEvaluationId).toMatch(/^ge_/);
    expect(evaluation.runId).toBe(runId);
    expect(evaluation.gateId).toBe('plan_approval');
    expect(evaluation.kind).toBe('human');
    expect(evaluation.status).toBe('pending');
    expect(evaluation.reason).toBe('Awaiting operator approval');
    expect(evaluation.causationEventId).toBe(eventId);
    expect(evaluation.evaluatedAt).toBeTruthy();
  });

  it('creates evaluation with details JSON', () => {
    const { runId, projectId } = seedTestData(db);
    const eventId = createCausationEvent(db, runId, projectId, 'create-details');

    const evaluation = createGateEvaluation(db, {
      runId,
      gateId: 'tests_pass',
      kind: 'automatic',
      status: 'failed',
      reason: 'Tests failed',
      details: { failedTests: 3, totalTests: 42 },
      causationEventId: eventId,
      durationMs: 5000,
    });

    expect(evaluation.detailsJson).toBe('{"failedTests":3,"totalTests":42}');
    expect(evaluation.durationMs).toBe(5000);
  });
});

describe('getLatestGateEvaluation', () => {
  it('returns the latest evaluation by causation event sequence', () => {
    const { runId, projectId } = seedTestData(db);

    // Create two events with explicit sequences
    const event1Id = createCausationEvent(db, runId, projectId, 'latest-1', 1);
    const event2Id = createCausationEvent(db, runId, projectId, 'latest-2', 2);

    createGateEvaluation(db, {
      runId,
      gateId: 'plan_approval',
      kind: 'human',
      status: 'pending',
      reason: 'First evaluation',
      causationEventId: event1Id,
    });

    createGateEvaluation(db, {
      runId,
      gateId: 'plan_approval',
      kind: 'human',
      status: 'passed',
      reason: 'Approved by operator',
      causationEventId: event2Id,
    });

    const latest = getLatestGateEvaluation(db, runId, 'plan_approval');
    expect(latest).not.toBeNull();
    expect(latest?.status).toBe('passed');
    expect(latest?.reason).toBe('Approved by operator');
    expect(latest?.causationEventId).toBe(event2Id);
  });

  it('returns null when no evaluations exist', () => {
    const { runId } = seedTestData(db);
    const latest = getLatestGateEvaluation(db, runId, 'plan_approval');
    expect(latest).toBeNull();
  });

  it('returns evaluation for the correct gate only', () => {
    const { runId, projectId } = seedTestData(db);
    const event1Id = createCausationEvent(db, runId, projectId, 'gate-filter-1', 1);
    const event2Id = createCausationEvent(db, runId, projectId, 'gate-filter-2', 2);

    createGateEvaluation(db, {
      runId,
      gateId: 'plan_approval',
      kind: 'human',
      status: 'passed',
      causationEventId: event1Id,
    });

    createGateEvaluation(db, {
      runId,
      gateId: 'tests_pass',
      kind: 'automatic',
      status: 'failed',
      causationEventId: event2Id,
    });

    const planLatest = getLatestGateEvaluation(db, runId, 'plan_approval');
    expect(planLatest?.status).toBe('passed');

    const testsLatest = getLatestGateEvaluation(db, runId, 'tests_pass');
    expect(testsLatest?.status).toBe('failed');
  });
});

describe('listGateEvaluations', () => {
  it('lists all evaluations for a run ordered by sequence', () => {
    const { runId, projectId } = seedTestData(db);
    const event1Id = createCausationEvent(db, runId, projectId, 'list-1', 1);
    const event2Id = createCausationEvent(db, runId, projectId, 'list-2', 2);
    const event3Id = createCausationEvent(db, runId, projectId, 'list-3', 3);

    createGateEvaluation(db, {
      runId,
      gateId: 'plan_approval',
      kind: 'human',
      status: 'pending',
      causationEventId: event1Id,
    });
    createGateEvaluation(db, {
      runId,
      gateId: 'plan_approval',
      kind: 'human',
      status: 'passed',
      causationEventId: event2Id,
    });
    createGateEvaluation(db, {
      runId,
      gateId: 'tests_pass',
      kind: 'automatic',
      status: 'pending',
      causationEventId: event3Id,
    });

    const evaluations = listGateEvaluations(db, runId);
    expect(evaluations).toHaveLength(3);
    expect(evaluations[0]?.status).toBe('pending');
    expect(evaluations[0]?.gateId).toBe('plan_approval');
    expect(evaluations[1]?.status).toBe('passed');
    expect(evaluations[1]?.gateId).toBe('plan_approval');
    expect(evaluations[2]?.status).toBe('pending');
    expect(evaluations[2]?.gateId).toBe('tests_pass');
  });

  it('returns empty array for run with no evaluations', () => {
    const { runId } = seedTestData(db);
    expect(listGateEvaluations(db, runId)).toHaveLength(0);
  });
});

describe('deriveGateState', () => {
  it('returns map with latest status per gate', () => {
    const { runId, projectId } = seedTestData(db);
    const event1Id = createCausationEvent(db, runId, projectId, 'derive-1', 1);
    const event2Id = createCausationEvent(db, runId, projectId, 'derive-2', 2);
    const event3Id = createCausationEvent(db, runId, projectId, 'derive-3', 3);

    // plan_approval: pending → passed (latest should be passed)
    createGateEvaluation(db, {
      runId,
      gateId: 'plan_approval',
      kind: 'human',
      status: 'pending',
      causationEventId: event1Id,
    });
    createGateEvaluation(db, {
      runId,
      gateId: 'plan_approval',
      kind: 'human',
      status: 'passed',
      causationEventId: event2Id,
    });

    // tests_pass: failed (only one evaluation)
    createGateEvaluation(db, {
      runId,
      gateId: 'tests_pass',
      kind: 'automatic',
      status: 'failed',
      causationEventId: event3Id,
    });

    const state = deriveGateState(db, runId);
    expect(state['plan_approval']).toBe('passed');
    expect(state['tests_pass']).toBe('failed');
    expect(state['code_review']).toBeUndefined();
    expect(state['merge_wait']).toBeUndefined();
  });

  it('returns empty object for run with no evaluations', () => {
    const { runId } = seedTestData(db);
    const state = deriveGateState(db, runId);
    expect(Object.keys(state)).toHaveLength(0);
  });
});

describe('getRunsAwaitingGates', () => {
  it('returns runs in awaiting_plan_approval phase', () => {
    const { runId, projectId } = seedTestData(db);

    // Transition run to awaiting_plan_approval
    db.prepare(
      'UPDATE runs SET phase = ?, updated_at = ? WHERE run_id = ?'
    ).run('awaiting_plan_approval', new Date().toISOString(), runId);

    const runs = getRunsAwaitingGates(db, projectId);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.runId).toBe(runId);
    expect(runs[0]?.phase).toBe('awaiting_plan_approval');
  });

  it('returns runs in blocked phase', () => {
    const { runId, projectId } = seedTestData(db);

    db.prepare(
      'UPDATE runs SET phase = ?, blocked_reason = ?, updated_at = ? WHERE run_id = ?'
    ).run('blocked', 'gate_failed', new Date().toISOString(), runId);

    const runs = getRunsAwaitingGates(db, projectId);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.blockedReason).toBe('gate_failed');
  });

  it('does not return runs in other phases', () => {
    const { projectId } = seedTestData(db);
    // run starts in 'pending' phase — should not appear
    const runs = getRunsAwaitingGates(db, projectId);
    expect(runs).toHaveLength(0);
  });

  it('filters by project', () => {
    seedTestData(db);

    const runs = getRunsAwaitingGates(db, 'proj_other');
    expect(runs).toHaveLength(0);
  });

  it('returns runs sorted by updated_at ascending (oldest first)', () => {
    const now = new Date();
    const { projectId } = seedTestData(db);

    // Create a second task and run for the same project
    const taskId2 = 'task_test2';
    db.prepare(`
      INSERT INTO tasks (
        task_id, project_id, repo_id, github_node_id, github_issue_number,
        github_type, github_title, github_body, github_state, github_labels_json,
        github_synced_at, created_at, updated_at, last_activity_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(taskId2, projectId, 'repo_test', 'I_test2', 43,
      'issue', 'Test Task 2', 'Body 2', 'open', '[]',
      now.toISOString(), now.toISOString(), now.toISOString(), now.toISOString());

    const run2 = createRun(db, { taskId: taskId2, projectId, repoId: 'repo_test', baseBranch: 'main' });

    // First run: older timestamp
    const olderTime = new Date(now.getTime() - 60000).toISOString();
    db.prepare(
      'UPDATE runs SET phase = ?, updated_at = ? WHERE run_id = ?'
    ).run('awaiting_plan_approval', olderTime, run2.runId);

    // Second run: already in DB from seedTestData, newer timestamp
    const runs = db.prepare('SELECT run_id FROM runs').all() as Array<{ run_id: string }>;
    const firstRunId = runs.find((r) => r.run_id !== run2.runId)?.run_id ?? '';
    db.prepare(
      'UPDATE runs SET phase = ?, updated_at = ? WHERE run_id = ?'
    ).run('blocked', now.toISOString(), firstRunId);

    const awaiting = getRunsAwaitingGates(db, projectId);
    expect(awaiting).toHaveLength(2);
    expect(awaiting[0]?.runId).toBe(run2.runId); // older first
  });
});
