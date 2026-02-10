import { describe, it, expect, afterEach, vi } from 'vitest';
import { existsSync, unlinkSync } from 'node:fs';
import { initDatabase, closeDatabase } from '../db/index.ts';
import {
  enqueueWrite,
  getWrite,
  listPendingWrites,
  markWriteProcessing,
  markWriteCompleted,
  markWriteFailed,
  resetStalledWrite,
  generateIdempotencyKey,
  computeWritePayloadHash,
} from './index.ts';
import type { CommentWritePayload } from './index.ts';

const TEST_DB_PATH = './test-outbox.db';

function cleanupTestDb() {
  const paths = [TEST_DB_PATH, `${TEST_DB_PATH}-wal`, `${TEST_DB_PATH}-shm`];
  for (const path of paths) {
    if (existsSync(path)) {
      unlinkSync(path);
    }
  }
}

function setupTestData(db: ReturnType<typeof initDatabase>) {
  // Create user (required for project FK)
  db.prepare(`
    INSERT INTO users (user_id, github_id, github_node_id, github_login, github_name, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run('user_test', 123, 'U_test123', 'testuser', 'Test User', new Date().toISOString(), new Date().toISOString());

  // Create project
  db.prepare(`
    INSERT INTO projects (
      project_id, name, user_id, github_org_id, github_org_node_id, github_org_name,
      github_installation_id, default_profile_id, default_base_branch,
      port_range_start, port_range_end, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'proj_test', 'Test Project', 'user_test', 1, 'O_123', 'test-org',
    12345, 'default', 'main', 3000, 4000,
    new Date().toISOString(), new Date().toISOString()
  );

  // Create policy set (required for run)
  db.prepare(`
    INSERT INTO policy_sets (
      policy_set_id, project_id, config_hash, created_by, created_at
    ) VALUES (?, ?, ?, ?, ?)
  `).run('ps_test', 'proj_test', 'hash123', 'system', new Date().toISOString());

  // Create repo
  db.prepare(`
    INSERT INTO repos (
      repo_id, project_id, github_node_id, github_numeric_id,
      github_owner, github_name, github_full_name, github_default_branch,
      profile_id, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'repo_test', 'proj_test', 'R_123', 123,
    'test-org', 'test-repo', 'test-org/test-repo', 'main',
    'default', 'active', new Date().toISOString(), new Date().toISOString()
  );

  // Create task
  db.prepare(`
    INSERT INTO tasks (
      task_id, project_id, repo_id, github_node_id, github_issue_number,
      github_type, github_title, github_body, github_state, github_labels_json,
      github_synced_at, created_at, updated_at, last_activity_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'task_test', 'proj_test', 'repo_test', 'I_123', 42,
    'issue', 'Test Task', 'Body', 'open', '[]',
    new Date().toISOString(), new Date().toISOString(),
    new Date().toISOString(), new Date().toISOString()
  );

  // Create run
  db.prepare(`
    INSERT INTO runs (
      run_id, task_id, project_id, repo_id, phase, step,
      policy_set_id, base_branch, branch, started_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'run_test', 'task_test', 'proj_test', 'repo_test',
    'planning', 'init', 'ps_test', 'main', 'conductor/issue-42',
    new Date().toISOString(), new Date().toISOString()
  );
}

describe('Outbox Module', () => {
  afterEach(() => {
    cleanupTestDb();
  });

  describe('enqueueWrite', () => {
    it('should persist a write to the database', () => {
      cleanupTestDb();
      const db = initDatabase({ path: TEST_DB_PATH });
      setupTestData(db);

      const payload: CommentWritePayload = {
        owner: 'test-org',
        repo: 'test-repo',
        issueNumber: 42,
        body: 'Test comment',
      };

      const result = enqueueWrite(db, {
        runId: 'run_test',
        kind: 'comment',
        targetNodeId: 'I_123',
        targetType: 'issue',
        payload,
      });

      expect(result.isNew).toBe(true);
      expect(result.status).toBe('queued');
      expect(result.githubWriteId).toMatch(/^ghw_/);

      // Verify it's in the database
      const write = getWrite(db, result.githubWriteId);
      expect(write).not.toBeNull();
      expect(write?.kind).toBe('comment');
      expect(write?.status).toBe('queued');
      expect(write?.payload).toEqual(payload);

      closeDatabase(db);
    });

    it('should deduplicate writes with same idempotency key', () => {
      cleanupTestDb();
      const db = initDatabase({ path: TEST_DB_PATH });
      setupTestData(db);

      const payload: CommentWritePayload = {
        owner: 'test-org',
        repo: 'test-repo',
        issueNumber: 42,
        body: 'Test comment',
      };

      const customKey = 'custom-idempotency-key';

      const result1 = enqueueWrite(db, {
        runId: 'run_test',
        kind: 'comment',
        targetNodeId: 'I_123',
        targetType: 'issue',
        payload,
        idempotencyKey: customKey,
      });

      const result2 = enqueueWrite(db, {
        runId: 'run_test',
        kind: 'comment',
        targetNodeId: 'I_123',
        targetType: 'issue',
        payload,
        idempotencyKey: customKey, // Same key
      });

      expect(result1.isNew).toBe(true);
      expect(result2.isNew).toBe(false);
      expect(result1.githubWriteId).toBe(result2.githubWriteId);

      closeDatabase(db);
    });
  });

  describe('listPendingWrites', () => {
    it('should list queued and failed writes', () => {
      cleanupTestDb();
      const db = initDatabase({ path: TEST_DB_PATH });
      setupTestData(db);

      // Create some writes
      enqueueWrite(db, {
        runId: 'run_test',
        kind: 'comment',
        targetNodeId: 'I_1',
        targetType: 'issue',
        payload: { owner: 'o', repo: 'r', issueNumber: 1, body: 'a' },
      });

      enqueueWrite(db, {
        runId: 'run_test',
        kind: 'comment',
        targetNodeId: 'I_2',
        targetType: 'issue',
        payload: { owner: 'o', repo: 'r', issueNumber: 2, body: 'b' },
      });

      const pending = listPendingWrites(db);
      expect(pending.length).toBe(2);
      expect(pending.every(w => w.status === 'queued')).toBe(true);

      closeDatabase(db);
    });
  });

  describe('Write Status Transitions', () => {
    it('should transition through processing -> completed', () => {
      cleanupTestDb();
      const db = initDatabase({ path: TEST_DB_PATH });
      setupTestData(db);

      const result = enqueueWrite(db, {
        runId: 'run_test',
        kind: 'comment',
        targetNodeId: 'I_123',
        targetType: 'issue',
        payload: { owner: 'o', repo: 'r', issueNumber: 42, body: 'test' },
      });

      // Mark as processing
      const claimed = markWriteProcessing(db, result.githubWriteId);
      expect(claimed).toBe(true);

      let write = getWrite(db, result.githubWriteId);
      expect(write?.status).toBe('processing');

      // Mark as completed
      markWriteCompleted(db, result.githubWriteId, {
        githubId: 999,
        githubUrl: 'https://github.com/o/r/issues/42#issuecomment-999',
      });

      write = getWrite(db, result.githubWriteId);
      expect(write?.status).toBe('completed');
      expect(write?.githubId).toBe(999);
      expect(write?.githubUrl).toContain('issuecomment-999');

      closeDatabase(db);
    });

    it('should transition to failed with error message', () => {
      cleanupTestDb();
      const db = initDatabase({ path: TEST_DB_PATH });
      setupTestData(db);

      const result = enqueueWrite(db, {
        runId: 'run_test',
        kind: 'comment',
        targetNodeId: 'I_123',
        targetType: 'issue',
        payload: { owner: 'o', repo: 'r', issueNumber: 42, body: 'test' },
      });

      markWriteProcessing(db, result.githubWriteId);
      markWriteFailed(db, result.githubWriteId, 'Rate limit exceeded');

      const write = getWrite(db, result.githubWriteId);
      expect(write?.status).toBe('failed');
      expect(write?.error).toBe('Rate limit exceeded');
      expect(write?.retryCount).toBe(1);

      closeDatabase(db);
    });
  });

  describe('markWriteProcessing sets sent_at', () => {
    it('should set sent_at when transitioning to processing', () => {
      cleanupTestDb();
      const db = initDatabase({ path: TEST_DB_PATH });
      setupTestData(db);

      const result = enqueueWrite(db, {
        runId: 'run_test',
        kind: 'comment',
        targetNodeId: 'I_123',
        targetType: 'issue',
        payload: { owner: 'o', repo: 'r', issueNumber: 42, body: 'test' },
      });

      // Before processing, sent_at should not be set
      let write = getWrite(db, result.githubWriteId);
      expect(write?.sentAt).toBeFalsy();

      // Mark as processing
      markWriteProcessing(db, result.githubWriteId);

      // After processing, sent_at should be set
      write = getWrite(db, result.githubWriteId);
      expect(write?.status).toBe('processing');
      expect(write?.sentAt).toBeDefined();

      closeDatabase(db);
    });
  });

  describe('resetStalledWrite', () => {
    it('should reset a stalled processing write back to queued', () => {
      cleanupTestDb();
      const db = initDatabase({ path: TEST_DB_PATH });
      setupTestData(db);

      const result = enqueueWrite(db, {
        runId: 'run_test',
        kind: 'comment',
        targetNodeId: 'I_123',
        targetType: 'issue',
        payload: { owner: 'o', repo: 'r', issueNumber: 42, body: 'test' },
      });

      markWriteProcessing(db, result.githubWriteId);

      // Backdating sent_at to simulate a stale write (10 minutes ago)
      db.prepare(
        `UPDATE github_writes SET sent_at = ? WHERE github_write_id = ?`
      ).run(new Date(Date.now() - 10 * 60_000).toISOString(), result.githubWriteId);

      const wasReset = resetStalledWrite(db, result.githubWriteId);
      expect(wasReset).toBe(true);

      const write = getWrite(db, result.githubWriteId);
      expect(write?.status).toBe('queued');

      closeDatabase(db);
    });

    it('should NOT reset a recently-processing write', () => {
      cleanupTestDb();
      const db = initDatabase({ path: TEST_DB_PATH });
      setupTestData(db);

      const result = enqueueWrite(db, {
        runId: 'run_test',
        kind: 'comment',
        targetNodeId: 'I_123',
        targetType: 'issue',
        payload: { owner: 'o', repo: 'r', issueNumber: 42, body: 'test' },
      });

      markWriteProcessing(db, result.githubWriteId);
      // sent_at is just now — should NOT be considered stale

      const wasReset = resetStalledWrite(db, result.githubWriteId);
      expect(wasReset).toBe(false);

      const write = getWrite(db, result.githubWriteId);
      expect(write?.status).toBe('processing');

      closeDatabase(db);
    });

    it('should reset a legacy processing write with NULL sent_at', () => {
      cleanupTestDb();
      const db = initDatabase({ path: TEST_DB_PATH });
      setupTestData(db);

      const result = enqueueWrite(db, {
        runId: 'run_test',
        kind: 'comment',
        targetNodeId: 'I_123',
        targetType: 'issue',
        payload: { owner: 'o', repo: 'r', issueNumber: 42, body: 'test' },
      });

      // Simulate legacy row: set status to processing without setting sent_at
      db.prepare(
        `UPDATE github_writes SET status = 'processing', sent_at = NULL WHERE github_write_id = ?`
      ).run(result.githubWriteId);

      const wasReset = resetStalledWrite(db, result.githubWriteId);
      expect(wasReset).toBe(true);

      const write = getWrite(db, result.githubWriteId);
      expect(write?.status).toBe('queued');

      closeDatabase(db);
    });

    it('should NOT reset a write that is not in processing status', () => {
      cleanupTestDb();
      const db = initDatabase({ path: TEST_DB_PATH });
      setupTestData(db);

      const result = enqueueWrite(db, {
        runId: 'run_test',
        kind: 'comment',
        targetNodeId: 'I_123',
        targetType: 'issue',
        payload: { owner: 'o', repo: 'r', issueNumber: 42, body: 'test' },
      });

      // Write is in 'queued' status, not 'processing'
      const wasReset = resetStalledWrite(db, result.githubWriteId);
      expect(wasReset).toBe(false);

      const write = getWrite(db, result.githubWriteId);
      expect(write?.status).toBe('queued');

      closeDatabase(db);
    });

    it('should respect custom staleAfterMs threshold', () => {
      cleanupTestDb();
      const db = initDatabase({ path: TEST_DB_PATH });
      setupTestData(db);

      const result = enqueueWrite(db, {
        runId: 'run_test',
        kind: 'comment',
        targetNodeId: 'I_123',
        targetType: 'issue',
        payload: { owner: 'o', repo: 'r', issueNumber: 42, body: 'test' },
      });

      markWriteProcessing(db, result.githubWriteId);

      // Backdate sent_at by 2 minutes
      db.prepare(
        `UPDATE github_writes SET sent_at = ? WHERE github_write_id = ?`
      ).run(new Date(Date.now() - 2 * 60_000).toISOString(), result.githubWriteId);

      // With default 5-minute threshold, should NOT reset
      expect(resetStalledWrite(db, result.githubWriteId)).toBe(false);

      // With 1-minute threshold, SHOULD reset
      expect(resetStalledWrite(db, result.githubWriteId, 60_000)).toBe(true);

      const write = getWrite(db, result.githubWriteId);
      expect(write?.status).toBe('queued');

      closeDatabase(db);
    });
  });

  describe('Idempotency Key Generation', () => {
    it('should generate consistent idempotency keys', () => {
      const key1 = generateIdempotencyKey('run_1', 'comment', 'I_123', 'hash_abc');
      const key2 = generateIdempotencyKey('run_1', 'comment', 'I_123', 'hash_abc');
      expect(key1).toBe(key2);
      expect(key1).toBe('run_1:comment:I_123:hash_abc');
    });

    it('should generate different keys for different inputs', () => {
      const key1 = generateIdempotencyKey('run_1', 'comment', 'I_123', 'hash_abc');
      const key2 = generateIdempotencyKey('run_2', 'comment', 'I_123', 'hash_abc');
      expect(key1).not.toBe(key2);
    });
  });

  describe('Payload Hash', () => {
    it('should compute consistent hash for same payload', () => {
      const payload: CommentWritePayload = {
        owner: 'test-org',
        repo: 'test-repo',
        issueNumber: 42,
        body: 'Test',
      };

      const hash1 = computeWritePayloadHash(payload);
      const hash2 = computeWritePayloadHash(payload);
      expect(hash1).toBe(hash2);
    });

    it('should compute different hash for different payload', () => {
      const payload1: CommentWritePayload = {
        owner: 'test-org',
        repo: 'test-repo',
        issueNumber: 42,
        body: 'Test 1',
      };
      const payload2: CommentWritePayload = {
        owner: 'test-org',
        repo: 'test-repo',
        issueNumber: 42,
        body: 'Test 2',
      };

      const hash1 = computeWritePayloadHash(payload1);
      const hash2 = computeWritePayloadHash(payload2);
      expect(hash1).not.toBe(hash2);
    });
  });
});
