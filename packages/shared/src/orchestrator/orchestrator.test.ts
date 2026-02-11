/**
 * Orchestrator Module Tests
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Database as DatabaseType } from 'better-sqlite3';
import { initDatabase, closeDatabase } from '../db/index.ts';
import { createRun } from '../runs/index.ts';
import { updateTaskActiveRun } from '../tasks/index.ts';
import { createEvent, listRunEvents } from '../events/index.ts';
import {
  transitionPhase,
  isValidTransition,
  VALID_TRANSITIONS,
  TERMINAL_PHASES,
  getRunGateConfig,
  evaluateGatesForPhase,
  areGatesPassed,
  evaluateGatesAndTransition,
} from './index.ts';
import { ensureBuiltInGateDefinitions } from '../gates/gate-definitions.ts';
import { createGateEvaluation } from '../gates/gate-evaluations.ts';
import { getRun } from '../runs/index.ts';

let db: DatabaseType;

interface SeedResult {
  userId: string;
  projectId: string;
  repoId: string;
  taskId: string;
}

function seedTestData(db: DatabaseType, suffix = ''): SeedResult {
  const s = suffix;
  const now = new Date().toISOString();
  const userId = `user_test${s}`;
  const projectId = `proj_test${s}`;
  const repoId = `repo_test${s}`;
  const taskId = `task_test${s}`;

  db.prepare(`
    INSERT OR IGNORE INTO users (user_id, github_id, github_node_id, github_login, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'active', ?, ?)
  `).run(userId, 100 + Number(s || 0), `U_test${s}`, `testuser${s}`, now, now);

  db.prepare(`
    INSERT INTO projects (
      project_id, user_id, name, github_org_id, github_org_node_id, github_org_name,
      github_installation_id, default_profile_id, default_base_branch,
      port_range_start, port_range_end, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(projectId, userId, `Test Project${s}`, 1 + Number(s || 0), `O_test${s}`, `testorg${s}`,
    12345 + Number(s || 0), 'default', 'main', 3100, 3199, now, now);

  db.prepare(`
    INSERT INTO repos (
      repo_id, project_id, github_node_id, github_numeric_id,
      github_owner, github_name, github_full_name, github_default_branch,
      profile_id, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(repoId, projectId, `R_test${s}`, 100 + Number(s || 0),
    'testowner', `testrepo${s}`, `testowner/testrepo${s}`, 'main',
    'default', 'active', now, now);

  db.prepare(`
    INSERT INTO tasks (
      task_id, project_id, repo_id, github_node_id, github_issue_number,
      github_type, github_title, github_body, github_state, github_labels_json,
      github_synced_at, created_at, updated_at, last_activity_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(taskId, projectId, repoId, `I_test${s}`, 42,
    'issue', 'Test Task', 'Body', 'open', '[]',
    now, now, now, now);

  return { userId, projectId, repoId, taskId };
}

function createTestRun(db: DatabaseType, seed: SeedResult) {
  const run = createRun(db, {
    taskId: seed.taskId,
    projectId: seed.projectId,
    repoId: seed.repoId,
    baseBranch: 'main',
  });
  updateTaskActiveRun(db, seed.taskId, run.runId);
  return run;
}

beforeEach(() => {
  db = initDatabase({ path: ':memory:' });
});

afterEach(() => {
  closeDatabase(db);
});

describe('isValidTransition', () => {
  it('accepts all valid transitions', () => {
    for (const [from, targets] of Object.entries(VALID_TRANSITIONS)) {
      for (const to of targets) {
        expect(isValidTransition(from as never, to)).toBe(true);
      }
    }
  });

  it('rejects invalid transitions', () => {
    expect(isValidTransition('pending', 'completed')).toBe(false);
    expect(isValidTransition('pending', 'executing')).toBe(false);
    expect(isValidTransition('planning', 'completed')).toBe(false);
  });

  it('rejects transitions from terminal states', () => {
    expect(isValidTransition('completed', 'pending')).toBe(false);
    expect(isValidTransition('completed', 'cancelled')).toBe(false);
    expect(isValidTransition('cancelled', 'pending')).toBe(false);
    expect(isValidTransition('cancelled', 'completed')).toBe(false);
  });
});

describe('TERMINAL_PHASES', () => {
  it('contains completed and cancelled', () => {
    expect(TERMINAL_PHASES.has('completed')).toBe(true);
    expect(TERMINAL_PHASES.has('cancelled')).toBe(true);
    expect(TERMINAL_PHASES.has('pending')).toBe(false);
    expect(TERMINAL_PHASES.has('blocked')).toBe(false);
  });
});

describe('transitionPhase', () => {
  it('succeeds for valid transition (pending → planning)', () => {
    const seed = seedTestData(db);
    const run = createTestRun(db, seed);

    const result = transitionPhase(db, {
      runId: run.runId,
      toPhase: 'planning',
      toStep: 'route',
      triggeredBy: 'system',
      reason: 'Worktree ready',
    });

    expect(result.success).toBe(true);
    expect(result.run).toBeDefined();
    expect(result.run!.phase).toBe('planning');
    expect(result.run!.step).toBe('route');
    expect(result.event).toBeDefined();
  });

  it('rejects invalid transition (pending → completed)', () => {
    const seed = seedTestData(db);
    const run = createTestRun(db, seed);

    const result = transitionPhase(db, {
      runId: run.runId,
      toPhase: 'completed',
      triggeredBy: 'system',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid transition');
  });

  it('rejects transition from terminal state', () => {
    const seed = seedTestData(db);
    const run = createTestRun(db, seed);

    // Move to planning, then cancelled
    transitionPhase(db, { runId: run.runId, toPhase: 'planning', toStep: 'route', triggeredBy: 'system' });
    transitionPhase(db, { runId: run.runId, toPhase: 'cancelled', toStep: 'cleanup', triggeredBy: 'user', result: 'cancelled' });

    const result = transitionPhase(db, {
      runId: run.runId,
      toPhase: 'pending',
      triggeredBy: 'system',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid transition');
  });

  it('returns error for missing run', () => {
    const result = transitionPhase(db, {
      runId: 'run_nonexistent',
      toPhase: 'planning',
      triggeredBy: 'system',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('not found');
  });

  it('allocates monotonic sequence numbers', () => {
    const seed = seedTestData(db);
    const run = createTestRun(db, seed);

    const r1 = transitionPhase(db, { runId: run.runId, toPhase: 'planning', toStep: 'route', triggeredBy: 'system' });
    expect(r1.event!.sequence).toBe(1);

    const r2 = transitionPhase(db, { runId: run.runId, toPhase: 'blocked', triggeredBy: 'system', blockedReason: 'test' });
    expect(r2.event!.sequence).toBe(2);

    const r3 = transitionPhase(db, { runId: run.runId, toPhase: 'cancelled', toStep: 'cleanup', triggeredBy: 'system', result: 'cancelled' });
    expect(r3.event!.sequence).toBe(3);

    // Verify updated run.nextSequence
    expect(r3.run!.nextSequence).toBe(4);
    expect(r3.run!.lastEventSequence).toBe(3);
  });

  it('creates event with correct payload', () => {
    const seed = seedTestData(db);
    const run = createTestRun(db, seed);

    transitionPhase(db, {
      runId: run.runId,
      toPhase: 'planning',
      toStep: 'route',
      triggeredBy: 'system',
      reason: 'Worktree ready',
    });

    const events = listRunEvents(db, run.runId);
    expect(events).toHaveLength(1);

    const evt = events[0];
    expect(evt.type).toBe('phase.transitioned');
    expect(evt.class).toBe('decision');
    expect(evt.source).toBe('orchestrator');
    expect(evt.payload).toEqual({
      from: 'pending',
      to: 'planning',
      triggeredBy: 'system',
      reason: 'Worktree ready',
      step: 'route',
    });
  });

  it('handles optimistic lock (concurrent phase change)', () => {
    const seed = seedTestData(db);
    const run = createTestRun(db, seed);

    // Simulate another process changing the phase
    db.prepare('UPDATE runs SET phase = ? WHERE run_id = ?').run('planning', run.runId);

    // Now try to transition from pending (stale)
    const result = transitionPhase(db, {
      runId: run.runId,
      toPhase: 'planning',
      toStep: 'route',
      triggeredBy: 'system',
    });

    // The read will see 'planning', and planning → planning is invalid
    expect(result.success).toBe(false);
  });

  it('sets completed_at and result for terminal phases', () => {
    const seed = seedTestData(db);
    const run = createTestRun(db, seed);

    transitionPhase(db, { runId: run.runId, toPhase: 'planning', toStep: 'route', triggeredBy: 'system' });
    const result = transitionPhase(db, {
      runId: run.runId,
      toPhase: 'cancelled',
      toStep: 'cleanup',
      triggeredBy: 'user_test',
      result: 'cancelled',
    });

    expect(result.run!.phase).toBe('cancelled');
    expect(result.run!.completedAt).toBeDefined();
    expect(result.run!.result).toBe('cancelled');
  });

  it('sets blocked_reason and blocked_context for blocked phase', () => {
    const seed = seedTestData(db);
    const run = createTestRun(db, seed);

    transitionPhase(db, { runId: run.runId, toPhase: 'planning', toStep: 'route', triggeredBy: 'system' });
    const result = transitionPhase(db, {
      runId: run.runId,
      toPhase: 'blocked',
      triggeredBy: 'system',
      blockedReason: 'Clone failed',
      blockedContext: { error: 'timeout' },
    });

    expect(result.run!.phase).toBe('blocked');
    expect(result.run!.blockedReason).toBe('Clone failed');
    expect(result.run!.blockedContextJson).toBe('{"error":"timeout"}');
  });

  it('clears tasks.active_run_id on terminal transition', () => {
    const seed = seedTestData(db);
    const run = createTestRun(db, seed);

    transitionPhase(db, { runId: run.runId, toPhase: 'planning', toStep: 'route', triggeredBy: 'system' });
    transitionPhase(db, { runId: run.runId, toPhase: 'cancelled', toStep: 'cleanup', triggeredBy: 'user', result: 'cancelled' });

    const taskRow = db.prepare('SELECT active_run_id FROM tasks WHERE task_id = ?').get(seed.taskId) as { active_run_id: string | null };
    expect(taskRow.active_run_id).toBeNull();
  });

  it('does NOT clear tasks.active_run_id on non-terminal transition', () => {
    const seed = seedTestData(db);
    const run = createTestRun(db, seed);

    transitionPhase(db, { runId: run.runId, toPhase: 'planning', toStep: 'route', triggeredBy: 'system' });

    const taskRow = db.prepare('SELECT active_run_id FROM tasks WHERE task_id = ?').get(seed.taskId) as { active_run_id: string | null };
    expect(taskRow.active_run_id).toBe(run.runId);
  });
});

describe('phase.transitioned event exclusivity', () => {
  it('rejects phase.transitioned events from non-orchestrator sources via createEvent', () => {
    const seed = seedTestData(db);

    expect(() =>
      createEvent(db, {
        projectId: seed.projectId,
        runId: 'run_fake',
        type: 'phase.transitioned',
        class: 'decision',
        payload: { from: 'pending', to: 'planning' },
        idempotencyKey: 'bypass:1',
        source: 'webhook',
      })
    ).toThrow('phase.transitioned events can only be created with source=orchestrator');
  });

  it('rejects phase.transitioned events from tool_layer source', () => {
    const seed = seedTestData(db);

    expect(() =>
      createEvent(db, {
        projectId: seed.projectId,
        runId: 'run_fake',
        type: 'phase.transitioned',
        class: 'decision',
        payload: { from: 'pending', to: 'planning' },
        idempotencyKey: 'bypass:2',
        source: 'tool_layer',
      })
    ).toThrow('phase.transitioned events can only be created with source=orchestrator');
  });

  it('rejects phase.transitioned events from operator source', () => {
    const seed = seedTestData(db);

    expect(() =>
      createEvent(db, {
        projectId: seed.projectId,
        runId: 'run_fake',
        type: 'phase.transitioned',
        class: 'decision',
        payload: { from: 'pending', to: 'planning' },
        idempotencyKey: 'bypass:3',
        source: 'operator',
      })
    ).toThrow('phase.transitioned events can only be created with source=orchestrator');
  });
});

describe('getRunGateConfig', () => {
  it('returns default gates when no routing decision exists', () => {
    const seed = seedTestData(db);
    const run = createTestRun(db, seed);

    const config = getRunGateConfig(db, run.runId);
    expect(config.requiredGates).toContain('plan_approval');
    expect(config.requiredGates).toContain('tests_pass');
    expect(config.requiredGates).toContain('code_review');
    expect(config.requiredGates).toContain('merge_wait');
    expect(config.optionalGates).toHaveLength(0);
  });

  it('returns gates from routing decision when available', () => {
    const seed = seedTestData(db);
    const run = createTestRun(db, seed);
    const now = new Date().toISOString();

    db.prepare(`
      INSERT INTO routing_decisions (
        routing_decision_id, run_id, inputs_json, agent_graph_json,
        required_gates_json, optional_gates_json, reasoning, decided_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'rd_test', run.runId, '{}', '{}',
      '["plan_approval","tests_pass"]', '["code_review"]',
      'Custom routing', now
    );

    const config = getRunGateConfig(db, run.runId);
    expect(config.requiredGates).toEqual(['plan_approval', 'tests_pass']);
    expect(config.optionalGates).toEqual(['code_review']);
  });
});

describe('evaluateGatesForPhase', () => {
  it('returns allPassed=true when no gates apply for phase', () => {
    const seed = seedTestData(db);
    const run = createTestRun(db, seed);
    ensureBuiltInGateDefinitions(db);

    const runObj = getRun(db, run.runId);
    const result = evaluateGatesForPhase(db, runObj!, 'planning');
    expect(result.allPassed).toBe(true);
    expect(Object.keys(result.results)).toHaveLength(0);
  });

  it('evaluates plan_approval gate for awaiting_plan_approval phase', () => {
    const seed = seedTestData(db);
    const run = createTestRun(db, seed);
    ensureBuiltInGateDefinitions(db);

    // Move to awaiting_plan_approval
    transitionPhase(db, { runId: run.runId, toPhase: 'planning', triggeredBy: 'system' });
    transitionPhase(db, { runId: run.runId, toPhase: 'awaiting_plan_approval', triggeredBy: 'system' });

    const runObj = getRun(db, run.runId);
    const result = evaluateGatesForPhase(db, runObj!, 'awaiting_plan_approval');

    expect(result.results['plan_approval']).toBeDefined();
    // Without any artifacts or actions, plan_approval should be pending
    expect(result.results['plan_approval'].status).toBe('pending');
    expect(result.allPassed).toBe(false);
  });
});

describe('areGatesPassed', () => {
  it('returns passed=true when no gates for the phase', () => {
    const seed = seedTestData(db);
    const run = createTestRun(db, seed);
    ensureBuiltInGateDefinitions(db);

    const result = areGatesPassed(db, run.runId, 'planning');
    expect(result.passed).toBe(true);
  });

  it('returns passed=false when gate evaluation is pending', () => {
    const seed = seedTestData(db);
    const run = createTestRun(db, seed);
    ensureBuiltInGateDefinitions(db);

    // No gate evaluations recorded yet
    const result = areGatesPassed(db, run.runId, 'awaiting_plan_approval');
    expect(result.passed).toBe(false);
    expect(result.blockedBy).toBe('plan_approval');
  });

  it('returns passed=true when gate evaluation is passed', () => {
    const seed = seedTestData(db);
    const run = createTestRun(db, seed);
    ensureBuiltInGateDefinitions(db);

    // Move to awaiting_plan_approval to get an event for causation
    transitionPhase(db, { runId: run.runId, toPhase: 'planning', triggeredBy: 'system' });
    const result2 = transitionPhase(db, { runId: run.runId, toPhase: 'awaiting_plan_approval', triggeredBy: 'system' });

    // Create a passed gate evaluation
    createGateEvaluation(db, {
      runId: run.runId,
      gateId: 'plan_approval',
      kind: 'human',
      status: 'passed',
      reason: 'Operator approved',
      causationEventId: result2.event?.eventId ?? 'evt_test',
    });

    const check = areGatesPassed(db, run.runId, 'awaiting_plan_approval');
    expect(check.passed).toBe(true);
  });
});

describe('transitionPhase sequence floor', () => {
  it('skips sequences already used by worker-emitted events', () => {
    const seed = seedTestData(db, '10');
    const run = createTestRun(db, seed);

    // Transition pending → planning (uses sequence 1)
    transitionPhase(db, {
      runId: run.runId,
      toPhase: 'planning',
      toStep: 'planner_create_plan',
      triggeredBy: 'system',
    });

    // Simulate worker emitting agent events (auto-allocated sequences 2, 3)
    createEvent(db, {
      projectId: seed.projectId,
      runId: run.runId,
      type: 'agent.started',
      class: 'signal',
      payload: { agent: 'planner', action: 'create_plan' },
      idempotencyKey: `agent.started:${run.runId}:1`,
      source: 'worker',
    });
    createEvent(db, {
      projectId: seed.projectId,
      runId: run.runId,
      type: 'agent.failed',
      class: 'decision',
      payload: { agent: 'planner', action: 'create_plan', errorCode: 'auth_error' },
      idempotencyKey: `agent.failed:${run.runId}:1`,
      source: 'worker',
    });

    // runs.next_sequence is still 2 (only updated by transitionPhase),
    // but events table has sequences 1, 2, 3.
    // Without the floor fix, transitionPhase would try sequence 2 and collide.
    const result = transitionPhase(db, {
      runId: run.runId,
      toPhase: 'blocked',
      triggeredBy: 'system',
      blockedReason: 'Auth error',
    });

    expect(result.success).toBe(true);
    // Sequence should be 4 (max(3) + 1), not 2
    expect(result.event!.sequence).toBe(4);
  });

  it('uses runs.next_sequence when it is already ahead of events', () => {
    const seed = seedTestData(db, '11');
    const run = createTestRun(db, seed);

    // Normal sequential transitions — no worker events in between
    const r1 = transitionPhase(db, {
      runId: run.runId,
      toPhase: 'planning',
      toStep: 'planner_create_plan',
      triggeredBy: 'system',
    });
    expect(r1.event!.sequence).toBe(1);

    const r2 = transitionPhase(db, {
      runId: run.runId,
      toPhase: 'blocked',
      triggeredBy: 'system',
      blockedReason: 'test',
    });
    // next_sequence=2, max(events.sequence)=1+1=2, so Math.max(2,2)=2
    expect(r2.event!.sequence).toBe(2);
  });
});

describe('evaluateGatesAndTransition sequence floor', () => {
  it('uses sequence floor when worker events advance beyond nextSequence', () => {
    const seed = seedTestData(db, '12');
    const run = createTestRun(db, seed);
    ensureBuiltInGateDefinitions(db);

    // Move to planning (sequence 1, nextSequence becomes 2)
    transitionPhase(db, {
      runId: run.runId,
      toPhase: 'planning',
      triggeredBy: 'system',
    });

    // Simulate worker events that auto-allocate sequences 2, 3
    createEvent(db, {
      projectId: seed.projectId,
      runId: run.runId,
      type: 'agent.started',
      class: 'signal',
      payload: { agent: 'planner', action: 'create_plan' },
      idempotencyKey: `agent.started:${run.runId}:gate_test`,
      source: 'worker',
    });
    createEvent(db, {
      projectId: seed.projectId,
      runId: run.runId,
      type: 'agent.completed',
      class: 'decision',
      payload: { agent: 'planner', action: 'create_plan' },
      idempotencyKey: `agent.completed:${run.runId}:gate_test`,
      source: 'worker',
    });

    // evaluateGatesAndTransition with no applicable gates (planning phase
    // has no gates) will attempt a transition. Without the floor fix,
    // it would try sequence 2 (from nextSequence) and collide.
    const runObj = getRun(db, run.runId)!;
    const { transition: txnResult } = evaluateGatesAndTransition(
      db, runObj, 'planning',
      {
        runId: run.runId,
        toPhase: 'blocked',
        triggeredBy: 'system',
        blockedReason: 'test',
      },
    );

    expect(txnResult?.success).toBe(true);
    // Verify all event sequences are unique
    const events = listRunEvents(db, run.runId);
    const sequences = events.map(e => e.sequence).filter((s): s is number => s !== undefined);
    const uniqueSeqs = new Set(sequences);
    expect(uniqueSeqs.size).toBe(sequences.length);
    // The transition event should have sequence 4 (max(3) + 1)
    expect(txnResult?.event?.sequence).toBe(4);
  });
});
