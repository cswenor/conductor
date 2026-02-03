import { describe, it, expect, afterEach, vi } from 'vitest';
import { existsSync, unlinkSync } from 'node:fs';
import { initDatabase, closeDatabase } from '../db/index';
import {
  enqueueWrite,
  getWrite,
  listPendingWrites,
  markWriteProcessing,
  markWriteCompleted,
  markWriteFailed,
  generateIdempotencyKey,
  computeWritePayloadHash,
} from './index';
import type { CommentWritePayload } from './index';

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
  // Create project
  db.prepare(`
    INSERT INTO projects (
      project_id, name, github_org_id, github_org_node_id, github_org_name,
      github_installation_id, default_profile_id, default_base_branch,
      port_range_start, port_range_end, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'proj_test', 'Test Project', 1, 'O_123', 'test-org',
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
