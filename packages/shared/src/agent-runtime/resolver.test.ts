/**
 * Credential Resolution Service Tests
 *
 * Tests the resolveCredentials function with real DB state.
 * GitHub installation token tests are skipped (requires GitHub App init).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Database as DatabaseType } from 'better-sqlite3';
import { initDatabase, closeDatabase } from '../db/index.ts';
import { createRun } from '../runs/index.ts';
import { resolveCredentials } from './resolver.ts';
import { ApiKeyNotConfiguredError } from '../api-keys/index.ts';

let db: DatabaseType;

function seedTestData(db: DatabaseType): { runId: string; projectId: string; userId: string } {
  const now = new Date().toISOString();
  const userId = 'user_test';
  const projectId = 'proj_test';
  const repoId = 'repo_test';
  const taskId = 'task_test';

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
  return { runId: run.runId, projectId, userId };
}

beforeEach(() => {
  db = initDatabase({ path: ':memory:' });
});

afterEach(() => {
  closeDatabase(db);
});

describe('resolveCredentials', () => {
  it('returns mode=none for steps that need no credentials', async () => {
    const { runId } = seedTestData(db);

    const result = await resolveCredentials(db, { runId, step: 'route' });
    expect(result.mode).toBe('none');
  });

  it('returns mode=none for wait_plan_approval', async () => {
    const { runId } = seedTestData(db);

    const result = await resolveCredentials(db, { runId, step: 'wait_plan_approval' });
    expect(result.mode).toBe('none');
  });

  it('returns mode=none for cleanup', async () => {
    const { runId } = seedTestData(db);

    const result = await resolveCredentials(db, { runId, step: 'cleanup' });
    expect(result.mode).toBe('none');
  });

  it('throws ApiKeyNotConfiguredError when user has no API key', async () => {
    const { runId } = seedTestData(db);

    await expect(
      resolveCredentials(db, { runId, step: 'planner_create_plan' })
    ).rejects.toThrow(ApiKeyNotConfiguredError);

    await expect(
      resolveCredentials(db, { runId, step: 'planner_create_plan' })
    ).rejects.toThrow(/API key not configured/);
  });

  it('throws plain Error (not ApiKeyNotConfiguredError) for non-existent run', async () => {
    seedTestData(db);

    try {
      await resolveCredentials(db, { runId: 'run_nonexistent', step: 'planner_create_plan' });
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(ApiKeyNotConfiguredError);
    }
  });

  it('resolves ai_provider credentials when user has unencrypted API key', async () => {
    const { runId, userId } = seedTestData(db);
    const now = new Date().toISOString();

    // Insert an unencrypted user_api_keys record (key_encrypted=0)
    db.prepare(`
      INSERT INTO user_api_keys (
        user_id, provider, api_key, api_key_nonce, key_encrypted,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(userId, 'anthropic', 'sk-ant-test-key-12345', null, 0, now, now);

    const result = await resolveCredentials(db, { runId, step: 'planner_create_plan' });
    expect(result.mode).toBe('ai_provider');
    if (result.mode === 'ai_provider') {
      expect(result.provider).toBe('anthropic');
      expect(result.apiKey).toBe('sk-ant-test-key-12345');
    }
  });
});
