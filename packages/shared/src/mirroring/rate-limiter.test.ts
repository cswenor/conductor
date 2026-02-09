import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { initDatabase, closeDatabase } from '../db/index.ts';
import type { Database } from 'better-sqlite3';
import type { EnqueueWriteResult } from '../outbox/index.ts';
import { checkAndMirror } from './rate-limiter.ts';

describe('rate-limiter', () => {
  let db: Database;

  beforeEach(() => {
    db = initDatabase({ path: ':memory:' });
  });

  afterEach(() => {
    closeDatabase(db);
  });

  function seedRun(runId: string): void {
    const now = new Date().toISOString();
    // Seed minimal data for FK chain: user -> project -> repo -> task -> run
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
      VALUES ('repo_1', 'proj_1', 'R_1', 1, 'owner', 'repo', 'owner/repo', 'main', 'default', 'active', ?, ?)
    `).run(now, now);
    db.prepare(`
      INSERT INTO policy_sets (policy_set_id, project_id, config_hash, created_by, created_at)
      VALUES ('ps_1', 'proj_1', 'hash123', 'system', ?)
    `).run(now);
    db.prepare(`
      INSERT INTO tasks (task_id, project_id, repo_id, github_node_id, github_issue_number, github_type, github_title, github_body, github_state, github_labels_json, github_synced_at, created_at, updated_at, last_activity_at)
      VALUES ('task_1', 'proj_1', 'repo_1', 'I_1', 1, 'issue', 'Test', 'Body', 'open', '[]', ?, ?, ?, ?)
    `).run(now, now, now, now);
    db.prepare(`
      INSERT INTO runs (run_id, task_id, project_id, repo_id, run_number, phase, step, policy_set_id, last_event_sequence, next_sequence, base_branch, branch, started_at, updated_at, plan_revisions, test_fix_attempts, review_rounds)
      VALUES (?, 'task_1', 'proj_1', 'repo_1', 1, 'planning', 'planner_create_plan', 'ps_1', 0, 1, 'main', 'run-branch', ?, ?, 0, 0, 0)
    `).run(runId, now, now);
  }

  function createMockEnqueue(): {
    fn: (body: string, idempotencyKey: string) => EnqueueWriteResult;
    calls: Array<{ body: string; idempotencyKey: string }>;
  } {
    const calls: Array<{ body: string; idempotencyKey: string }> = [];
    const fn = (body: string, idempotencyKey: string): EnqueueWriteResult => {
      calls.push({ body, idempotencyKey });
      return {
        githubWriteId: `ghw_${calls.length}`,
        isNew: true,
        status: 'queued',
      };
    };
    return { fn, calls };
  }

  it('allows first comment (no prior comments)', () => {
    const runId = 'run_test1';
    seedRun(runId);

    const enqueue = createMockEnqueue();
    const result = checkAndMirror(db, runId, {
      eventType: 'phase_transition',
      formattedBody: 'Phase changed',
      summary: 'Phase changed',
      idempotencySuffix: `${runId}:mirror:phase:1`,
    }, enqueue.fn);

    expect(result.enqueued).toBe(true);
    expect(result.deferred).toBe(false);
    expect(enqueue.calls).toHaveLength(1);
    expect(enqueue.calls[0]?.body).toBe('Phase changed');
  });

  it('defers when within 30s window', () => {
    const runId = 'run_test2';
    seedRun(runId);

    // Insert a recent comment
    db.prepare(`
      INSERT INTO github_writes (github_write_id, run_id, kind, target_node_id, target_type, idempotency_key, payload_hash, payload_hash_scheme, status, created_at, retry_count)
      VALUES ('ghw_recent', ?, 'comment', 'I_1', 'issue', 'key1', 'hash1', 'sha256:cjson:v1', 'completed', datetime('now'), 0)
    `).run(runId);

    const enqueue = createMockEnqueue();
    const result = checkAndMirror(db, runId, {
      eventType: 'phase_transition',
      formattedBody: 'Another phase change',
      summary: 'Another phase change',
      idempotencySuffix: `${runId}:mirror:phase:2`,
    }, enqueue.fn);

    expect(result.enqueued).toBe(false);
    expect(result.deferred).toBe(true);
    expect(enqueue.calls).toHaveLength(0);
  });

  it('allows comment after 30s window expires', () => {
    const runId = 'run_test3';
    seedRun(runId);

    // Insert an old comment (more than 30s ago)
    const oldTime = new Date(Date.now() - 60_000).toISOString();
    db.prepare(`
      INSERT INTO github_writes (github_write_id, run_id, kind, target_node_id, target_type, idempotency_key, payload_hash, payload_hash_scheme, status, created_at, retry_count)
      VALUES ('ghw_old', ?, 'comment', 'I_1', 'issue', 'key2', 'hash2', 'sha256:cjson:v1', 'completed', ?, 0)
    `).run(runId, oldTime);

    const enqueue = createMockEnqueue();
    const result = checkAndMirror(db, runId, {
      eventType: 'phase_transition',
      formattedBody: 'Phase after wait',
      summary: 'Phase after wait',
      idempotencySuffix: `${runId}:mirror:phase:3`,
    }, enqueue.fn);

    expect(result.enqueued).toBe(true);
    expect(result.deferred).toBe(false);
  });

  it('coalesces deferred events with current event', () => {
    const runId = 'run_test4';
    seedRun(runId);

    // Insert deferred events
    db.prepare(`
      INSERT INTO mirror_deferred_events (deferred_event_id, run_id, event_type, formatted_body, summary, idempotency_suffix, created_at)
      VALUES ('def_1', ?, 'phase_transition', 'First deferred', 'First deferred', 'key_def1', datetime('now', '-10 seconds'))
    `).run(runId);
    db.prepare(`
      INSERT INTO mirror_deferred_events (deferred_event_id, run_id, event_type, formatted_body, summary, idempotency_suffix, created_at)
      VALUES ('def_2', ?, 'phase_transition', 'Second deferred', 'Second deferred', 'key_def2', datetime('now', '-5 seconds'))
    `).run(runId);

    const enqueue = createMockEnqueue();
    const result = checkAndMirror(db, runId, {
      eventType: 'phase_transition',
      formattedBody: 'Current event',
      summary: 'Current event',
      idempotencySuffix: `${runId}:mirror:phase:5`,
    }, enqueue.fn);

    expect(result.enqueued).toBe(true);
    expect(result.deferred).toBe(false);
    expect(enqueue.calls).toHaveLength(1);

    // All three bodies should be coalesced
    const postedBody = enqueue.calls[0]?.body ?? '';
    expect(postedBody).toContain('First deferred');
    expect(postedBody).toContain('Second deferred');
    expect(postedBody).toContain('Current event');
  });

  it('clears deferred events after flush', () => {
    const runId = 'run_test5';
    seedRun(runId);

    db.prepare(`
      INSERT INTO mirror_deferred_events (deferred_event_id, run_id, event_type, formatted_body, summary, idempotency_suffix, created_at)
      VALUES ('def_3', ?, 'phase_transition', 'Will be flushed', 'Will be flushed', 'key_def3', datetime('now'))
    `).run(runId);

    const enqueue = createMockEnqueue();
    checkAndMirror(db, runId, {
      eventType: 'phase_transition',
      formattedBody: 'Flush trigger',
      summary: 'Flush trigger',
      idempotencySuffix: `${runId}:mirror:phase:6`,
    }, enqueue.fn);

    // Verify deferred events were cleaned up
    const remaining = db.prepare(
      'SELECT COUNT(*) as count FROM mirror_deferred_events WHERE run_id = ?'
    ).get(runId) as { count: number };
    expect(remaining.count).toBe(0);
  });

  it('never drops events — deferred events are always stored', () => {
    const runId = 'run_test6';
    seedRun(runId);

    // Recent comment to trigger rate limit
    db.prepare(`
      INSERT INTO github_writes (github_write_id, run_id, kind, target_node_id, target_type, idempotency_key, payload_hash, payload_hash_scheme, status, created_at, retry_count)
      VALUES ('ghw_recent2', ?, 'comment', 'I_1', 'issue', 'key3', 'hash3', 'sha256:cjson:v1', 'completed', datetime('now'), 0)
    `).run(runId);

    const enqueue = createMockEnqueue();

    // Post multiple events rapidly
    checkAndMirror(db, runId, {
      eventType: 'phase_transition',
      formattedBody: 'Event 1',
      summary: 'Event 1',
      idempotencySuffix: `${runId}:evt1`,
    }, enqueue.fn);

    checkAndMirror(db, runId, {
      eventType: 'phase_transition',
      formattedBody: 'Event 2',
      summary: 'Event 2',
      idempotencySuffix: `${runId}:evt2`,
    }, enqueue.fn);

    // Nothing should be enqueued
    expect(enqueue.calls).toHaveLength(0);

    // But events should be stored as deferred
    const deferred = db.prepare(
      'SELECT COUNT(*) as count FROM mirror_deferred_events WHERE run_id = ?'
    ).get(runId) as { count: number };
    expect(deferred.count).toBe(2);
  });

  it('ignores cancelled writes when checking rate limit', () => {
    const runId = 'run_test7';
    seedRun(runId);

    // Insert a cancelled comment (should be ignored)
    db.prepare(`
      INSERT INTO github_writes (github_write_id, run_id, kind, target_node_id, target_type, idempotency_key, payload_hash, payload_hash_scheme, status, created_at, retry_count)
      VALUES ('ghw_cancelled', ?, 'comment', 'I_1', 'issue', 'key4', 'hash4', 'sha256:cjson:v1', 'cancelled', datetime('now'), 0)
    `).run(runId);

    const enqueue = createMockEnqueue();
    const result = checkAndMirror(db, runId, {
      eventType: 'phase_transition',
      formattedBody: 'After cancelled',
      summary: 'After cancelled',
      idempotencySuffix: `${runId}:mirror:phase:7`,
    }, enqueue.fn);

    expect(result.enqueued).toBe(true);
    expect(result.deferred).toBe(false);
  });

  it('prevents duplicate deferrals via idempotency_suffix UNIQUE', () => {
    const runId = 'run_test8';
    seedRun(runId);

    // Recent comment to trigger rate limit
    db.prepare(`
      INSERT INTO github_writes (github_write_id, run_id, kind, target_node_id, target_type, idempotency_key, payload_hash, payload_hash_scheme, status, created_at, retry_count)
      VALUES ('ghw_recent3', ?, 'comment', 'I_1', 'issue', 'key5', 'hash5', 'sha256:cjson:v1', 'completed', datetime('now'), 0)
    `).run(runId);

    const enqueue = createMockEnqueue();
    const suffix = `${runId}:mirror:phase:same`;

    // First deferral
    const r1 = checkAndMirror(db, runId, {
      eventType: 'phase_transition',
      formattedBody: 'Duplicate event',
      summary: 'Duplicate event',
      idempotencySuffix: suffix,
    }, enqueue.fn);
    expect(r1.deferred).toBe(true);

    // Second deferral with same suffix — should not duplicate
    const r2 = checkAndMirror(db, runId, {
      eventType: 'phase_transition',
      formattedBody: 'Duplicate event',
      summary: 'Duplicate event',
      idempotencySuffix: suffix,
    }, enqueue.fn);
    expect(r2.deferred).toBe(true);

    // Only one deferred event should exist
    const count = db.prepare(
      'SELECT COUNT(*) as count FROM mirror_deferred_events WHERE run_id = ?'
    ).get(runId) as { count: number };
    expect(count.count).toBe(1);
  });

  it('preserves deferred events when enqueue returns idempotent duplicate', () => {
    const runId = 'run_test9';
    seedRun(runId);

    // Insert a deferred event
    db.prepare(`
      INSERT INTO mirror_deferred_events (deferred_event_id, run_id, event_type, formatted_body, summary, idempotency_suffix, created_at)
      VALUES ('def_dup', ?, 'phase_transition', 'Deferred body', 'Deferred summary', 'key_dup', datetime('now'))
    `).run(runId);

    // Mock enqueue that returns isNew: false (idempotent duplicate)
    const calls: Array<{ body: string; idempotencyKey: string }> = [];
    const duplicateEnqueue = (body: string, idempotencyKey: string): EnqueueWriteResult => {
      calls.push({ body, idempotencyKey });
      return { githubWriteId: 'ghw_existing', isNew: false, status: 'queued' };
    };

    const result = checkAndMirror(db, runId, {
      eventType: 'phase_transition',
      formattedBody: 'Current body',
      summary: 'Current summary',
      idempotencySuffix: `${runId}:mirror:phase:10`,
    }, duplicateEnqueue);

    // Enqueue was called but returned duplicate
    expect(result.enqueued).toBe(false);
    expect(calls).toHaveLength(1);

    // Deferred events must be preserved (not deleted)
    const remaining = db.prepare(
      'SELECT COUNT(*) as count FROM mirror_deferred_events WHERE run_id = ?'
    ).get(runId) as { count: number };
    expect(remaining.count).toBe(1);
  });
});
