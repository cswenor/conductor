/**
 * Context Assembly Tests
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Database as DatabaseType } from 'better-sqlite3';
import { initDatabase, closeDatabase } from '../db/index.ts';
import { createRun } from '../runs/index.ts';
import { createArtifact } from './artifacts.ts';
import {
  isSensitiveFile,
  redactSecretPatterns,
  assembleFileTree,
  readRelevantFiles,
  assembleContext,
  formatContextForPrompt,
} from './context.ts';

let db: DatabaseType;

function seedTestData(db: DatabaseType): { runId: string; projectId: string } {
  const now = new Date().toISOString();

  db.prepare(`
    INSERT OR IGNORE INTO users (user_id, github_id, github_node_id, github_login, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'active', ?, ?)
  `).run('user_test', 100, 'U_test', 'testuser', now, now);

  db.prepare(`
    INSERT INTO projects (
      project_id, user_id, name, github_org_id, github_org_node_id, github_org_name,
      github_installation_id, default_profile_id, default_base_branch,
      port_range_start, port_range_end, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run('proj_test', 'user_test', 'Test Project', 1, 'O_test', 'testorg',
    12345, 'default', 'main', 3100, 3199, now, now);

  db.prepare(`
    INSERT INTO repos (
      repo_id, project_id, github_node_id, github_numeric_id,
      github_owner, github_name, github_full_name, github_default_branch,
      profile_id, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run('repo_test', 'proj_test', 'R_test', 100,
    'testowner', 'testrepo', 'testowner/testrepo', 'main',
    'default', 'active', now, now);

  db.prepare(`
    INSERT INTO tasks (
      task_id, project_id, repo_id, github_node_id, github_issue_number,
      github_type, github_title, github_body, github_state, github_labels_json,
      github_synced_at, created_at, updated_at, last_activity_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run('task_test', 'proj_test', 'repo_test', 'I_test', 42,
    'issue', 'Fix the login bug', 'Login fails when password has special characters',
    'open', '["bug","priority:high"]',
    now, now, now, now);

  const run = createRun(db, { taskId: 'task_test', projectId: 'proj_test', repoId: 'repo_test', baseBranch: 'main' });
  return { runId: run.runId, projectId: 'proj_test' };
}

let testDir: string;

function createTestWorktree(): string {
  testDir = join(tmpdir(), `conductor-test-${Date.now()}`);
  mkdirSync(testDir, { recursive: true });
  execFileSync('git', ['init'], { cwd: testDir });
  execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: testDir });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: testDir });
  execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: testDir });

  // Create some files
  writeFileSync(join(testDir, 'README.md'), '# Test');
  mkdirSync(join(testDir, 'src'), { recursive: true });
  writeFileSync(join(testDir, 'src/index.ts'), 'export const x = 1;');
  writeFileSync(join(testDir, 'package.json'), '{}');

  // Also create a .env file (sensitive)
  writeFileSync(join(testDir, '.env'), 'SECRET_KEY=abc123');
  writeFileSync(join(testDir, '.env.local'), 'DB_URL=postgres://...');

  // Create a key file
  writeFileSync(join(testDir, 'server.pem'), '-----BEGIN CERTIFICATE-----');
  writeFileSync(join(testDir, 'credentials.json'), '{"key":"secret"}');

  execFileSync('git', ['add', '-A'], { cwd: testDir });
  execFileSync('git', ['-c', 'commit.gpgsign=false', 'commit', '-m', 'init'], { cwd: testDir });

  return testDir;
}

beforeEach(() => {
  db = initDatabase({ path: ':memory:' });
});

afterEach(() => {
  closeDatabase(db);
  if (testDir) {
    try { rmSync(testDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

// =============================================================================
// isSensitiveFile
// =============================================================================

describe('isSensitiveFile', () => {
  it('detects .env', () => {
    expect(isSensitiveFile('.env')).toBe(true);
  });

  it('detects .env.local', () => {
    expect(isSensitiveFile('.env.local')).toBe(true);
  });

  it('detects .env.production', () => {
    expect(isSensitiveFile('.env.production')).toBe(true);
  });

  it('detects .npmrc', () => {
    expect(isSensitiveFile('.npmrc')).toBe(true);
  });

  it('detects .pem files', () => {
    expect(isSensitiveFile('server.pem')).toBe(true);
    expect(isSensitiveFile('path/to/cert.pem')).toBe(true);
  });

  it('detects .key files', () => {
    expect(isSensitiveFile('private.key')).toBe(true);
  });

  it('detects credentials.json', () => {
    expect(isSensitiveFile('credentials.json')).toBe(true);
    expect(isSensitiveFile('config/credentials.json')).toBe(true);
  });

  it('detects service-account files', () => {
    expect(isSensitiveFile('service-account.json')).toBe(true);
    expect(isSensitiveFile('service-account-key.json')).toBe(true);
  });

  it('does not flag normal files', () => {
    expect(isSensitiveFile('README.md')).toBe(false);
    expect(isSensitiveFile('src/index.ts')).toBe(false);
    expect(isSensitiveFile('package.json')).toBe(false);
    expect(isSensitiveFile('.eslintrc.json')).toBe(false);
  });
});

// =============================================================================
// redactSecretPatterns
// =============================================================================

describe('redactSecretPatterns', () => {
  it('redacts Anthropic API keys', () => {
    const content = 'const key = "sk-ant-api03-abcdef1234567890abcdef1234567890"';
    const redacted = redactSecretPatterns(content);
    expect(redacted).toContain('[REDACTED:anthropic_key]');
    expect(redacted).not.toContain('sk-ant-api03');
  });

  it('redacts AWS access keys', () => {
    const content = 'AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE';
    const redacted = redactSecretPatterns(content);
    expect(redacted).toContain('[REDACTED:aws_key]');
    expect(redacted).not.toContain('AKIAIOSFODNN7EXAMPLE');
  });

  it('redacts password= lines', () => {
    const content = 'database_password=my_super_secret_pass123';
    const redacted = redactSecretPatterns(content);
    expect(redacted).toContain('[REDACTED:config_secret]');
  });

  it('leaves normal code untouched', () => {
    const content = 'function hello() { return "world"; }';
    const redacted = redactSecretPatterns(content);
    expect(redacted).toBe(content);
  });

  it('redacts GitHub personal access tokens', () => {
    const content = 'token: ghp_ABCDEFghijklmnopqrstuvwxyz0123456789';
    const redacted = redactSecretPatterns(content);
    expect(redacted).toContain('[REDACTED:github_pat]');
  });
});

// =============================================================================
// assembleFileTree
// =============================================================================

describe('assembleFileTree', () => {
  it('lists tracked files excluding sensitive ones', () => {
    const wt = createTestWorktree();
    const tree = assembleFileTree(wt);

    expect(tree).toContain('README.md');
    expect(tree).toContain('src/index.ts');
    expect(tree).toContain('package.json');

    // Sensitive files should be excluded
    expect(tree).not.toContain('.env');
    expect(tree).not.toContain('.env.local');
    expect(tree).not.toContain('server.pem');
    expect(tree).not.toContain('credentials.json');
  });
});

// =============================================================================
// readRelevantFiles
// =============================================================================

describe('readRelevantFiles', () => {
  it('reads normal files', () => {
    const wt = createTestWorktree();
    const results = readRelevantFiles(wt, ['README.md']);

    expect(results).toHaveLength(1);
    expect(results[0]?.path).toBe('README.md');
    expect(results[0]?.content).toContain('# Test');
  });

  it('refuses .env files', () => {
    const wt = createTestWorktree();
    const results = readRelevantFiles(wt, ['.env']);

    expect(results).toHaveLength(1);
    expect(results[0]?.content).toBe('[EXCLUDED: sensitive file]');
  });

  it('refuses .pem files', () => {
    const wt = createTestWorktree();
    const results = readRelevantFiles(wt, ['server.pem']);

    expect(results).toHaveLength(1);
    expect(results[0]?.content).toBe('[EXCLUDED: sensitive file]');
  });

  it('refuses path traversal', () => {
    const wt = createTestWorktree();
    const results = readRelevantFiles(wt, ['../../etc/passwd']);

    expect(results).toHaveLength(1);
    expect(results[0]?.content).toBe('[EXCLUDED: invalid path]');
  });

  it('refuses absolute paths', () => {
    const wt = createTestWorktree();
    const results = readRelevantFiles(wt, ['/etc/passwd']);

    expect(results).toHaveLength(1);
    expect(results[0]?.content).toBe('[EXCLUDED: invalid path]');
  });
});

// =============================================================================
// assembleContext
// =============================================================================

describe('assembleContext', () => {
  it('assembles context with issue, repo, run info', () => {
    const { runId } = seedTestData(db);
    const ctx = assembleContext(db, { runId });

    expect(ctx.issue.number).toBe(42);
    expect(ctx.issue.title).toBe('Fix the login bug');
    expect(ctx.issue.body).toContain('special characters');
    expect(ctx.issue.type).toBe('issue');
    expect(ctx.issue.state).toBe('open');
    expect(ctx.issue.labels).toEqual(['bug', 'priority:high']);

    expect(ctx.repository.fullName).toBe('testowner/testrepo');
    expect(ctx.repository.defaultBranch).toBe('main');

    expect(ctx.run.runId).toBe(runId);
    expect(ctx.run.baseBranch).toBe('main');
  });

  it('includes latest plan artifact when available', () => {
    const { runId } = seedTestData(db);
    createArtifact(db, { runId, type: 'plan', contentMarkdown: 'My plan v1', createdBy: 'planner' });
    createArtifact(db, { runId, type: 'plan', contentMarkdown: 'My plan v2', createdBy: 'planner' });

    const ctx = assembleContext(db, { runId });
    expect(ctx.plan).toBe('My plan v2');
  });

  it('includes latest review artifact when available', () => {
    const { runId } = seedTestData(db);
    createArtifact(db, { runId, type: 'review', contentMarkdown: 'CHANGES_REQUESTED\nFix X', createdBy: 'reviewer' });

    const ctx = assembleContext(db, { runId });
    expect(ctx.review).toContain('CHANGES_REQUESTED');
  });

  it('handles missing optional fields gracefully', () => {
    const { runId } = seedTestData(db);
    const ctx = assembleContext(db, { runId });

    expect(ctx.plan).toBeUndefined();
    expect(ctx.review).toBeUndefined();
    expect(ctx.fileTree).toBeUndefined();
    expect(ctx.relevantFiles).toBeUndefined();
  });
});

// =============================================================================
// formatContextForPrompt
// =============================================================================

describe('formatContextForPrompt', () => {
  it('produces readable markdown', () => {
    const { runId } = seedTestData(db);
    const ctx = assembleContext(db, { runId });
    const formatted = formatContextForPrompt(ctx);

    expect(formatted).toContain('## Issue #42: Fix the login bug');
    expect(formatted).toContain('## Repository: testowner/testrepo');
    expect(formatted).toContain('## Run:');
    expect(formatted).toContain('special characters');
  });

  it('includes plan section when present', () => {
    const { runId } = seedTestData(db);
    createArtifact(db, { runId, type: 'plan', contentMarkdown: 'The plan', createdBy: 'planner' });

    const ctx = assembleContext(db, { runId });
    const formatted = formatContextForPrompt(ctx);

    expect(formatted).toContain('## Current Plan');
    expect(formatted).toContain('The plan');
  });

  it('includes review section when present', () => {
    const { runId } = seedTestData(db);
    createArtifact(db, { runId, type: 'review', contentMarkdown: 'Fix the thing', createdBy: 'reviewer' });

    const ctx = assembleContext(db, { runId });
    const formatted = formatContextForPrompt(ctx);

    expect(formatted).toContain('## Latest Review Feedback');
    expect(formatted).toContain('Fix the thing');
  });
});
