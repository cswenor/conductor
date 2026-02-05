/**
 * Policy Definitions Seeder Tests
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Database as DatabaseType } from 'better-sqlite3';
import { initDatabase, closeDatabase } from '../db/index.js';
import { createRun } from '../runs/index.js';
import { createAgentInvocation } from './invocations.js';
import { ensureBuiltInPolicyDefinitions, BUILT_IN_POLICIES } from './policy-definitions.js';
import { createToolInvocation, getToolInvocation } from './tool-invocations.js';

let db: DatabaseType;

function seedTestData(database: DatabaseType): { runId: string; agentInvocationId: string } {
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
  const inv = createAgentInvocation(database, {
    runId: run.runId,
    agent: 'implementer',
    action: 'apply_changes',
  });

  return { runId: run.runId, agentInvocationId: inv.agentInvocationId };
}

beforeEach(() => {
  db = initDatabase({ path: ':memory:' });
});

afterEach(() => {
  closeDatabase(db);
});

describe('ensureBuiltInPolicyDefinitions', () => {
  it('inserts all 4 built-in policy definitions', () => {
    ensureBuiltInPolicyDefinitions(db);

    const rows = db.prepare('SELECT * FROM policy_definitions ORDER BY policy_id').all() as Array<{
      policy_id: string;
      severity: string;
      description: string;
    }>;

    expect(rows).toHaveLength(4);
    const ids = rows.map((r) => r.policy_id);
    expect(ids).toContain('worktree_boundary');
    expect(ids).toContain('dotgit_protection');
    expect(ids).toContain('sensitive_file_write');
    expect(ids).toContain('shell_injection');
  });

  it('is idempotent — second call does not fail or duplicate', () => {
    ensureBuiltInPolicyDefinitions(db);
    ensureBuiltInPolicyDefinitions(db);

    const rows = db.prepare('SELECT * FROM policy_definitions').all();
    expect(rows).toHaveLength(4);
  });

  it('allows createToolInvocation with policyId after seeding', () => {
    ensureBuiltInPolicyDefinitions(db);
    const { runId, agentInvocationId } = seedTestData(db);

    const inv = createToolInvocation(db, {
      agentInvocationId,
      runId,
      tool: 'write_file',
      target: '.env',
      argsRedactedJson: '{"path":".env"}',
      argsFieldsRemovedJson: '[]',
      argsSecretsDetected: false,
      argsPayloadHash: 'abc',
      argsPayloadHashScheme: 'sha256:cjson:v1',
      policyDecision: 'block',
      policyId: 'sensitive_file_write',
    });

    expect(inv.policyId).toBe('sensitive_file_write');
  });

  it('round-trips policyId through create → get', () => {
    ensureBuiltInPolicyDefinitions(db);
    const { runId, agentInvocationId } = seedTestData(db);

    const inv = createToolInvocation(db, {
      agentInvocationId,
      runId,
      tool: 'read_file',
      target: '../escape',
      argsRedactedJson: '{"path":"../escape"}',
      argsFieldsRemovedJson: '[]',
      argsSecretsDetected: false,
      argsPayloadHash: 'def',
      argsPayloadHashScheme: 'sha256:cjson:v1',
      policyDecision: 'block',
      policyId: 'worktree_boundary',
    });

    const fetched = getToolInvocation(db, inv.toolInvocationId);
    expect(fetched).not.toBeNull();
    expect(fetched!.policyId).toBe('worktree_boundary');
  });
});
