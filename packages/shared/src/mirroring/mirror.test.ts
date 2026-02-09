import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Database } from 'better-sqlite3';
import { initDatabase, closeDatabase } from '../db/index.ts';
import type { TransitionResult } from '../orchestrator/index.ts';
import {
  mirrorPhaseTransition,
  mirrorPlanArtifact,
  mirrorApprovalDecision,
  mirrorFailure,
  type MirrorContext,
} from './mirror.ts';

describe('mirror', () => {
  let db: Database;

  beforeEach(() => {
    db = initDatabase({ path: ':memory:' });
    seedTestData();
  });

  afterEach(() => {
    closeDatabase(db);
  });

  function seedTestData(): void {
    const now = new Date().toISOString();
    db.prepare(`
      INSERT OR IGNORE INTO users (user_id, github_id, github_node_id, github_login, status, created_at, updated_at)
      VALUES ('user_1', 100, 'U_1', 'testuser', 'active', ?, ?)
    `).run(now, now);
    db.prepare(`
      INSERT INTO projects (
        project_id, user_id, name, github_org_id, github_org_node_id, github_org_name,
        github_installation_id, default_profile_id, default_base_branch,
        port_range_start, port_range_end, created_at, updated_at
      ) VALUES ('proj_1', 'user_1', 'Test', 1, 'O_1', 'testorg', 12345, 'default', 'main', 3100, 3199, ?, ?)
    `).run(now, now);
    db.prepare(`
      INSERT INTO repos (repo_id, project_id, github_node_id, github_numeric_id, github_owner, github_name, github_full_name, github_default_branch, profile_id, status, created_at, updated_at)
      VALUES ('repo_1', 'proj_1', 'R_1', 1, 'octocat', 'hello-world', 'octocat/hello-world', 'main', 'default', 'active', ?, ?)
    `).run(now, now);
    db.prepare(`
      INSERT INTO policy_sets (policy_set_id, project_id, config_hash, created_by, created_at)
      VALUES ('ps_1', 'proj_1', 'hash123', 'system', ?)
    `).run(now);
    db.prepare(`
      INSERT INTO tasks (task_id, project_id, repo_id, github_node_id, github_issue_number, github_type, github_title, github_body, github_state, github_labels_json, github_synced_at, created_at, updated_at, last_activity_at)
      VALUES ('task_1', 'proj_1', 'repo_1', 'I_issue123', 42, 'issue', 'Fix bug', 'Description', 'open', '[]', ?, ?, ?, ?)
    `).run(now, now, now, now);
    db.prepare(`
      INSERT INTO runs (run_id, task_id, project_id, repo_id, run_number, phase, step, policy_set_id, last_event_sequence, next_sequence, base_branch, branch, started_at, updated_at, plan_revisions, test_fix_attempts, review_rounds)
      VALUES ('run_1', 'task_1', 'proj_1', 'repo_1', 7, 'planning', 'planner_create_plan', 'ps_1', 1, 2, 'main', 'run-branch', ?, ?, 0, 0, 0)
    `).run(now, now);
  }

  // Mock QueueManager
  function createMockQueueManager() {
    const jobs: Array<{ queue: string; id: string; data: unknown }> = [];
    return {
      jobs,
      addJob: vi.fn(async (queue: string, id: string, data: unknown) => {
        jobs.push({ queue, id, data });
      }),
      // Stubs for interface conformance
      getQueue: vi.fn(),
      createWorker: vi.fn(),
      close: vi.fn(),
    };
  }

  function createCtx(overrides?: Partial<MirrorContext>): MirrorContext & { queueManager: ReturnType<typeof createMockQueueManager> } {
    const qm = createMockQueueManager();
    return {
      db,
      queueManager: qm as unknown as MirrorContext['queueManager'] & ReturnType<typeof createMockQueueManager>,
      conductorBaseUrl: 'https://conductor.test',
      ...overrides,
    } as MirrorContext & { queueManager: ReturnType<typeof createMockQueueManager> };
  }

  describe('mirrorPhaseTransition', () => {
    it('enqueues a comment for a successful transition', () => {
      const ctx = createCtx();
      const transitionResult: TransitionResult = {
        success: true,
        run: {
          runId: 'run_1', taskId: 'task_1', projectId: 'proj_1', repoId: 'repo_1',
          runNumber: 7, phase: 'planning', step: 'planner_create_plan',
          policySetId: 'ps_1', lastEventSequence: 1, nextSequence: 2,
          baseBranch: 'main', branch: 'run-branch',
          planRevisions: 0, testFixAttempts: 0, reviewRounds: 0,
          startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        },
        event: {
          eventId: 'evt_1',
          projectId: 'proj_1',
          type: 'phase.transitioned',
          class: 'decision',
          payload: { from: 'pending', to: 'planning', triggeredBy: 'system' },
          sequence: 1,
          idempotencyKey: 'phase:run_1:1',
          createdAt: new Date().toISOString(),
          source: 'orchestrator',
        },
      };

      const result = mirrorPhaseTransition(ctx, {
        runId: 'run_1',
        toPhase: 'planning',
        triggeredBy: 'system',
        reason: 'Worktree ready',
      }, transitionResult);

      expect(result.enqueued).toBe(true);
      expect(result.deferred).toBe(false);

      // Verify a github_write was created
      const writes = db.prepare(
        "SELECT * FROM github_writes WHERE run_id = 'run_1' AND kind = 'comment'"
      ).all() as Array<Record<string, unknown>>;
      expect(writes.length).toBe(1);

      const payload = JSON.parse(writes[0]?.['payload_json'] as string) as Record<string, unknown>;
      expect(payload['owner']).toBe('octocat');
      expect(payload['repo']).toBe('hello-world');
      expect(payload['issueNumber']).toBe(42);
      expect(typeof payload['body']).toBe('string');
      expect((payload['body'] as string)).toContain('Worktree ready');
    });

    it('returns no-op for failed transition', () => {
      const ctx = createCtx();
      const result = mirrorPhaseTransition(ctx, {
        runId: 'run_1',
        toPhase: 'planning',
        triggeredBy: 'system',
      }, { success: false, error: 'Test failure' });

      expect(result.enqueued).toBe(false);
      expect(result.deferred).toBe(false);
    });

    it('returns no-op when task has no issue', () => {
      // Clear issue info
      db.prepare("UPDATE tasks SET github_issue_number = 0, github_node_id = '' WHERE task_id = 'task_1'").run();

      const ctx = createCtx();
      const result = mirrorPhaseTransition(ctx, {
        runId: 'run_1',
        toPhase: 'planning',
        triggeredBy: 'system',
      }, {
        success: true,
        event: {
          eventId: 'evt_1', projectId: 'proj_1', type: 'phase.transitioned',
          class: 'decision', payload: { from: 'pending', to: 'planning' },
          sequence: 1, idempotencyKey: 'phase:run_1:1',
          createdAt: new Date().toISOString(), source: 'orchestrator',
        },
      });

      expect(result.enqueued).toBe(false);
    });

    it('uses deterministic idempotency key based on sequence', () => {
      const ctx = createCtx();
      mirrorPhaseTransition(ctx, {
        runId: 'run_1',
        toPhase: 'planning',
        triggeredBy: 'system',
      }, {
        success: true,
        event: {
          eventId: 'evt_1', projectId: 'proj_1', type: 'phase.transitioned',
          class: 'decision', payload: { from: 'pending', to: 'planning' },
          sequence: 5, idempotencyKey: 'phase:run_1:5',
          createdAt: new Date().toISOString(), source: 'orchestrator',
        },
      });

      const writes = db.prepare(
        "SELECT idempotency_key FROM github_writes WHERE run_id = 'run_1'"
      ).all() as Array<Record<string, unknown>>;
      expect(writes[0]?.['idempotency_key']).toBe('run_1:mirror:phase:5');
    });

    it('handles errors gracefully', () => {
      const ctx = createCtx();
      // Close the DB to force an error
      closeDatabase(db);

      const result = mirrorPhaseTransition(ctx, {
        runId: 'run_nonexistent',
        toPhase: 'planning',
        triggeredBy: 'system',
      }, {
        success: true,
        event: {
          eventId: 'evt_1', projectId: 'proj_1', type: 'phase.transitioned',
          class: 'decision', payload: { from: 'pending', to: 'planning' },
          sequence: 1, idempotencyKey: 'test', createdAt: '', source: 'orchestrator',
        },
      });

      expect(result.enqueued).toBe(false);
      expect(result.error).toBeDefined();

      // Re-open for afterEach
      db = initDatabase({ path: ':memory:' });
    });
  });

  describe('mirrorPlanArtifact', () => {
    it('enqueues a comment with plan content', () => {
      // Create a plan artifact
      db.prepare(`
        INSERT INTO artifacts (artifact_id, run_id, type, version, content_markdown, size_bytes, checksum_sha256, validation_status, created_by, created_at)
        VALUES ('art_1', 'run_1', 'plan', 1, '## My Plan\n\n1. Do thing\n2. Do other thing', 100, 'abc123', 'valid', 'system', datetime('now'))
      `).run();

      const ctx = createCtx();
      const result = mirrorPlanArtifact(ctx, 'run_1');

      expect(result.enqueued).toBe(true);

      const writes = db.prepare(
        "SELECT * FROM github_writes WHERE run_id = 'run_1' AND kind = 'comment'"
      ).all() as Array<Record<string, unknown>>;
      const payload = JSON.parse(writes[0]?.['payload_json'] as string) as Record<string, unknown>;
      const body = payload['body'] as string;
      expect(body).toContain('Plan Ready for Review');
      expect(body).toContain('My Plan');
      expect(body).toContain('View Plan');
    });

    it('uses plan version for idempotency', () => {
      db.prepare(`
        INSERT INTO artifacts (artifact_id, run_id, type, version, content_markdown, size_bytes, checksum_sha256, validation_status, created_by, created_at)
        VALUES ('art_2', 'run_1', 'plan', 3, 'Plan v3', 10, 'abc', 'valid', 'system', datetime('now'))
      `).run();

      const ctx = createCtx();
      mirrorPlanArtifact(ctx, 'run_1');

      const writes = db.prepare(
        "SELECT idempotency_key FROM github_writes WHERE run_id = 'run_1'"
      ).all() as Array<Record<string, unknown>>;
      expect(writes[0]?.['idempotency_key']).toBe('run_1:mirror:plan:3');
    });
  });

  describe('mirrorApprovalDecision', () => {
    it('formats approve_plan correctly', () => {
      const ctx = createCtx();
      const result = mirrorApprovalDecision(ctx, {
        runId: 'run_1',
        operatorActionId: 'oa_abc123',
        action: 'approve_plan',
        actorId: 'user_1',
        fromPhase: 'awaiting_plan_approval',
        toPhase: 'executing',
      });

      expect(result.enqueued).toBe(true);

      const writes = db.prepare(
        "SELECT * FROM github_writes WHERE run_id = 'run_1'"
      ).all() as Array<Record<string, unknown>>;
      const payload = JSON.parse(writes[0]?.['payload_json'] as string) as Record<string, unknown>;
      const body = payload['body'] as string;
      expect(body).toContain('Plan approved by user_1');
      expect(body).toContain('Operator Decision');
    });

    it('formats reject_run with comment', () => {
      const ctx = createCtx();
      mirrorApprovalDecision(ctx, {
        runId: 'run_1',
        operatorActionId: 'oa_def456',
        action: 'reject_run',
        actorId: 'user_1',
        fromPhase: 'awaiting_plan_approval',
        toPhase: 'cancelled',
        comment: 'Plan is not suitable',
      });

      const writes = db.prepare(
        "SELECT * FROM github_writes WHERE run_id = 'run_1'"
      ).all() as Array<Record<string, unknown>>;
      const payload = JSON.parse(writes[0]?.['payload_json'] as string) as Record<string, unknown>;
      const body = payload['body'] as string;
      expect(body).toContain('Run rejected by user_1');
      expect(body).toContain('Plan is not suitable');
    });

    it('uses operatorActionId for idempotency', () => {
      const ctx = createCtx();
      mirrorApprovalDecision(ctx, {
        runId: 'run_1',
        operatorActionId: 'oa_unique123',
        action: 'approve_plan',
        actorId: 'user_1',
        fromPhase: 'awaiting_plan_approval',
        toPhase: 'executing',
      });

      const writes = db.prepare(
        "SELECT idempotency_key FROM github_writes WHERE run_id = 'run_1'"
      ).all() as Array<Record<string, unknown>>;
      expect(writes[0]?.['idempotency_key']).toBe('run_1:mirror:approval:oa_unique123');
    });
  });

  describe('mirrorFailure', () => {
    it('formats gate_failed with gate info', () => {
      const ctx = createCtx();
      const result = mirrorFailure(ctx, {
        runId: 'run_1',
        blockedReason: 'gate_failed',
        blockedContext: {
          prior_phase: 'executing',
          gate_id: 'tests_pass',
          gate_status: 'failed',
        },
      });

      expect(result.enqueued).toBe(true);

      const writes = db.prepare(
        "SELECT * FROM github_writes WHERE run_id = 'run_1'"
      ).all() as Array<Record<string, unknown>>;
      const payload = JSON.parse(writes[0]?.['payload_json'] as string) as Record<string, unknown>;
      const body = payload['body'] as string;
      expect(body).toContain("gate 'tests_pass' failed");
      expect(body).toContain('Run Blocked');
    });

    it('formats policy_exception_required', () => {
      const ctx = createCtx();
      mirrorFailure(ctx, {
        runId: 'run_1',
        blockedReason: 'policy_exception_required',
        blockedContext: { policy_id: 'worktree_boundary' },
      });

      const writes = db.prepare(
        "SELECT * FROM github_writes WHERE run_id = 'run_1'"
      ).all() as Array<Record<string, unknown>>;
      const payload = JSON.parse(writes[0]?.['payload_json'] as string) as Record<string, unknown>;
      const body = payload['body'] as string;
      expect(body).toContain('policy exception required');
    });

    it('formats generic blocked reason', () => {
      const ctx = createCtx();
      mirrorFailure(ctx, {
        runId: 'run_1',
        blockedReason: 'Repo not found',
      });

      const writes = db.prepare(
        "SELECT * FROM github_writes WHERE run_id = 'run_1'"
      ).all() as Array<Record<string, unknown>>;
      const payload = JSON.parse(writes[0]?.['payload_json'] as string) as Record<string, unknown>;
      const body = payload['body'] as string;
      expect(body).toContain('Repo not found');
    });

    it('includes test results when available for gate_failed', () => {
      // Create a test_results artifact
      db.prepare(`
        INSERT INTO artifacts (artifact_id, run_id, type, version, content_markdown, size_bytes, checksum_sha256, validation_status, created_by, created_at)
        VALUES ('art_test', 'run_1', 'test_report', 1, '## Test Output\n\nFAILED: test_something\n  Expected 1 got 2', 100, 'abc', 'valid', 'system', datetime('now'))
      `).run();

      const ctx = createCtx();
      mirrorFailure(ctx, {
        runId: 'run_1',
        blockedReason: 'gate_failed',
        blockedContext: { gate_id: 'tests_pass', gate_status: 'failed' },
      });

      const writes = db.prepare(
        "SELECT * FROM github_writes WHERE run_id = 'run_1'"
      ).all() as Array<Record<string, unknown>>;
      const payload = JSON.parse(writes[0]?.['payload_json'] as string) as Record<string, unknown>;
      const body = payload['body'] as string;
      expect(body).toContain('Test Output');
      expect(body).toContain('Test Results');
    });
  });
});
