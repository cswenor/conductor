import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, unlinkSync } from 'node:fs';
import { initDatabase, closeDatabase } from '../db/index';
import { normalizeWebhook, createEvent, getEvent } from './index';

const TEST_DB_PATH = './test-events.db';

function cleanupTestDb() {
  const paths = [TEST_DB_PATH, `${TEST_DB_PATH}-wal`, `${TEST_DB_PATH}-shm`];
  for (const path of paths) {
    if (existsSync(path)) {
      unlinkSync(path);
    }
  }
}

describe('Events Module', () => {
  afterEach(() => {
    cleanupTestDb();
  });

  describe('normalizeWebhook', () => {
    it('should normalize issue.opened webhook', () => {
      const result = normalizeWebhook(
        'delivery-123',
        'issues',
        'opened',
        {
          action: 'opened',
          issue: {
            node_id: 'I_123',
            number: 42,
            title: 'Test issue',
            state: 'open',
          },
          repository: {
            node_id: 'R_456',
            full_name: 'owner/repo',
          },
        }
      );

      expect(result).not.toBeNull();
      expect(result?.eventType).toBe('issue.opened');
      expect(result?.class).toBe('fact');
      expect(result?.repoNodeId).toBe('R_456');
      expect(result?.issueNodeId).toBe('I_123');
      expect(result?.idempotencyKey).toBe('webhook:delivery-123:issue:opened');
    });

    it('should normalize issue_comment.created webhook', () => {
      const result = normalizeWebhook(
        'delivery-456',
        'issue_comment',
        'created',
        {
          action: 'created',
          issue: {
            node_id: 'I_123',
            number: 42,
          },
          comment: {
            id: 789,
            node_id: 'IC_789',
          },
          repository: {
            node_id: 'R_456',
          },
        }
      );

      expect(result).not.toBeNull();
      expect(result?.eventType).toBe('issue_comment.created');
      expect(result?.idempotencyKey).toBe('webhook:delivery-456:comment:789');
    });

    it('should normalize pr.opened webhook', () => {
      const result = normalizeWebhook(
        'delivery-789',
        'pull_request',
        'opened',
        {
          action: 'opened',
          pull_request: {
            node_id: 'PR_123',
            number: 10,
            title: 'Test PR',
            state: 'open',
            merged: false,
          },
          repository: {
            node_id: 'R_456',
          },
        }
      );

      expect(result).not.toBeNull();
      expect(result?.eventType).toBe('pr.opened');
      expect(result?.prNodeId).toBe('PR_123');
    });

    it('should normalize pr.merged webhook (closed + merged)', () => {
      const result = normalizeWebhook(
        'delivery-merged',
        'pull_request',
        'closed',
        {
          action: 'closed',
          pull_request: {
            node_id: 'PR_123',
            number: 10,
            state: 'closed',
            merged: true,
          },
          repository: {
            node_id: 'R_456',
          },
        }
      );

      expect(result).not.toBeNull();
      expect(result?.eventType).toBe('pr.merged');
    });

    it('should normalize push webhook', () => {
      const result = normalizeWebhook(
        'delivery-push',
        'push',
        undefined,
        {
          ref: 'refs/heads/main',
          before: 'abc123',
          after: 'def456',
          commits_count: 3,
          repository: {
            node_id: 'R_456',
          },
        }
      );

      expect(result).not.toBeNull();
      expect(result?.eventType).toBe('push.received');
      expect(result?.payload['ref']).toBe('refs/heads/main');
      expect(result?.payload['commits_count']).toBe(3);
    });

    it('should normalize installation.created webhook', () => {
      const result = normalizeWebhook(
        'delivery-install',
        'installation',
        'created',
        {
          action: 'created',
          installation: {
            id: 12345,
            node_id: 'MDI_123',
            account: {
              login: 'test-org',
              type: 'Organization',
            },
          },
          sender: {
            login: 'user123',
          },
        }
      );

      expect(result).not.toBeNull();
      expect(result?.eventType).toBe('installation.created');
      expect(result?.idempotencyKey).toBe('webhook:delivery-install:installation:12345:created');
    });

    it('should normalize installation_repositories.added webhook', () => {
      const result = normalizeWebhook(
        'delivery-repos',
        'installation_repositories',
        'added',
        {
          action: 'added',
          installation: {
            id: 12345,
          },
          repositories_added: [
            { id: 1, node_id: 'R_1', name: 'repo1', full_name: 'org/repo1' },
            { id: 2, node_id: 'R_2', name: 'repo2', full_name: 'org/repo2' },
          ],
        }
      );

      expect(result).not.toBeNull();
      expect(result?.eventType).toBe('installation_repositories.added');
      expect(result?.payload['repositories_added']).toHaveLength(2);
    });

    it('should return null for unhandled event types', () => {
      const result = normalizeWebhook(
        'delivery-unknown',
        'unknown_event',
        'unknown',
        {}
      );

      expect(result).toBeNull();
    });

    it('should return null for unhandled actions', () => {
      const result = normalizeWebhook(
        'delivery-unhandled',
        'issues',
        'unknown_action',
        {
          issue: { node_id: 'I_123' },
        }
      );

      expect(result).toBeNull();
    });

    it('should return null for check_run without completed action', () => {
      const result = normalizeWebhook(
        'delivery-check',
        'check_run',
        'created', // Not 'completed'
        {
          check_run: { id: 123 },
        }
      );

      expect(result).toBeNull();
    });
  });

  describe('Event Persistence', () => {
    it('should create and retrieve an event', () => {
      cleanupTestDb();
      const db = initDatabase({ path: TEST_DB_PATH });

      // Create user (required for project FK)
      db.prepare(`
        INSERT INTO users (user_id, github_id, github_node_id, github_login, github_name, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run('user_123', 123, 'U_test123', 'testuser', 'Test User', new Date().toISOString(), new Date().toISOString());

      // Need a project first (required FK)
      db.prepare(`
        INSERT INTO projects (
          project_id, name, user_id, github_org_id, github_org_node_id, github_org_name,
          github_installation_id, default_profile_id, default_base_branch,
          port_range_start, port_range_end, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        'proj_123', 'Test Project', 'user_123', 1, 'O_123', 'test-org',
        12345, 'default', 'main', 3000, 4000,
        new Date().toISOString(), new Date().toISOString()
      );

      const event = createEvent(db, {
        projectId: 'proj_123',
        type: 'issue.opened',
        class: 'fact',
        payload: { test: true },
        idempotencyKey: 'test-key-1',
        source: 'webhook',
      });

      expect(event).not.toBeNull();
      expect(event?.type).toBe('issue.opened');
      expect(event?.class).toBe('fact');

      // Retrieve it
      const retrieved = getEvent(db, event!.eventId);
      expect(retrieved).not.toBeNull();
      expect(retrieved?.type).toBe('issue.opened');
      expect(retrieved?.payload['test']).toBe(true);

      closeDatabase(db);
    });

    it('should be idempotent (duplicate idempotency key returns null)', () => {
      cleanupTestDb();
      const db = initDatabase({ path: TEST_DB_PATH });

      // Create user (required for project FK)
      db.prepare(`
        INSERT INTO users (user_id, github_id, github_node_id, github_login, github_name, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run('user_123', 123, 'U_test123', 'testuser', 'Test User', new Date().toISOString(), new Date().toISOString());

      // Create project
      db.prepare(`
        INSERT INTO projects (
          project_id, name, user_id, github_org_id, github_org_node_id, github_org_name,
          github_installation_id, default_profile_id, default_base_branch,
          port_range_start, port_range_end, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        'proj_123', 'Test Project', 'user_123', 1, 'O_123', 'test-org',
        12345, 'default', 'main', 3000, 4000,
        new Date().toISOString(), new Date().toISOString()
      );

      const event1 = createEvent(db, {
        projectId: 'proj_123',
        type: 'issue.opened',
        class: 'fact',
        payload: { first: true },
        idempotencyKey: 'duplicate-key',
        source: 'webhook',
      });

      const event2 = createEvent(db, {
        projectId: 'proj_123',
        type: 'issue.opened',
        class: 'fact',
        payload: { second: true },
        idempotencyKey: 'duplicate-key', // Same key
        source: 'webhook',
      });

      expect(event1).not.toBeNull();
      expect(event2).toBeNull(); // Duplicate returns null

      closeDatabase(db);
    });
  });
});
