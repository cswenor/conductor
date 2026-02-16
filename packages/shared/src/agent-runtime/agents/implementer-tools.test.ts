/**
 * Implementer Tools Integration Tests
 *
 * Tests maxTokens wiring through runImplementerWithTools with a mock provider.
 * Kept separate from implementer.test.ts to avoid mixing unit and integration concerns.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Database as DatabaseType } from 'better-sqlite3';
import { initDatabase, closeDatabase } from '../../db/index.ts';
import { createRun } from '../../runs/index.ts';
import type { AgentInput, AgentOutput, AgentProvider } from '../provider.ts';
import { runImplementerWithTools } from './implementer.ts';

// =============================================================================
// Test Helpers
// =============================================================================

function seedTestData(database: DatabaseType): { runId: string; projectId: string } {
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

function createCapturingProvider() {
  const capturedMaxTokens: (number | undefined)[] = [];
  const provider: AgentProvider = {
    async invoke(input: AgentInput): Promise<AgentOutput> {
      capturedMaxTokens.push(input.maxTokens);
      return {
        content: 'Done.',
        tokensInput: 100,
        tokensOutput: 50,
        stopReason: 'end_turn',
        durationMs: 100,
        rawContentBlocks: [{ type: 'text' as const, text: 'Done.', citations: null }],
      };
    },
  };
  return { provider, capturedMaxTokens };
}

// =============================================================================
// Tests
// =============================================================================

describe('runImplementerWithTools maxTokens', () => {
  let db: DatabaseType;
  let runId: string;
  let worktreePath: string;

  beforeEach(() => {
    db = initDatabase({ path: ':memory:' });
    const seed = seedTestData(db);
    runId = seed.runId;

    // Create temp dir with git init for assembleContext file tree
    worktreePath = mkdtempSync(join(tmpdir(), 'conductor-impl-tools-test-'));
    execFileSync('git', ['init'], { cwd: worktreePath });
    execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: worktreePath });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: worktreePath });
    execFileSync('git', ['-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-m', 'init'], { cwd: worktreePath });
  });

  afterEach(() => {
    closeDatabase(db);
    delete process.env['CONDUCTOR_IMPLEMENTER_MAX_TOKENS'];
    rmSync(worktreePath, { recursive: true, force: true });
  });

  it('passes maxTokens=8192 to provider by default', async () => {
    const { provider, capturedMaxTokens } = createCapturingProvider();
    await runImplementerWithTools(db, { runId, worktreePath, provider });
    expect(capturedMaxTokens[0]).toBe(8192);
  });

  it('CONDUCTOR_IMPLEMENTER_MAX_TOKENS overrides maxTokens', async () => {
    process.env['CONDUCTOR_IMPLEMENTER_MAX_TOKENS'] = '4096';
    const { provider, capturedMaxTokens } = createCapturingProvider();
    await runImplementerWithTools(db, { runId, worktreePath, provider });
    expect(capturedMaxTokens[0]).toBe(4096);
  });

  it('invalid CONDUCTOR_IMPLEMENTER_MAX_TOKENS falls back to default', async () => {
    process.env['CONDUCTOR_IMPLEMENTER_MAX_TOKENS'] = 'garbage';
    const { provider, capturedMaxTokens } = createCapturingProvider();
    await runImplementerWithTools(db, { runId, worktreePath, provider });
    expect(capturedMaxTokens[0]).toBe(8192);
  });

  it('below-floor CONDUCTOR_IMPLEMENTER_MAX_TOKENS is clamped to floor', async () => {
    process.env['CONDUCTOR_IMPLEMENTER_MAX_TOKENS'] = '512'; // below floor of 1024
    const { provider, capturedMaxTokens } = createCapturingProvider();
    await runImplementerWithTools(db, { runId, worktreePath, provider });
    expect(capturedMaxTokens[0]).toBe(1024);
  });
});
