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
  resolveImplementerBudgets,
  TRUNCATION_HINT,
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

// =============================================================================
// Section Budgets
// =============================================================================

function makeMinimalContext(overrides: Partial<import('./context.ts').AgentContext> = {}): import('./context.ts').AgentContext {
  return {
    issue: { number: 1, title: 'Test', body: overrides.issue?.body ?? 'body', type: 'issue', state: 'open', labels: [] },
    repository: { fullName: 'o/r', defaultBranch: 'main' },
    run: { runId: 'r_1', baseBranch: 'main', branch: '', planRevisions: 0, testFixAttempts: 0, reviewRounds: 0 },
    ...overrides,
  };
}

/**
 * Extract the plan payload from formatted output.
 * Plan payload is everything between "## Current Plan\n" and the next "\n\n##" or end of string.
 */
function extractPlanPayload(formatted: string): string | null {
  const marker = '## Current Plan\n';
  const start = formatted.indexOf(marker);
  if (start === -1) return null;
  const payloadStart = start + marker.length;
  const nextSection = formatted.indexOf('\n\n##', payloadStart);
  if (nextSection === -1) return formatted.substring(payloadStart);
  return formatted.substring(payloadStart, nextSection);
}

function extractReviewPayload(formatted: string): string | null {
  const marker = '## Latest Review Feedback\n';
  const start = formatted.indexOf(marker);
  if (start === -1) return null;
  const payloadStart = start + marker.length;
  const nextSection = formatted.indexOf('\n\n##', payloadStart);
  if (nextSection === -1) return formatted.substring(payloadStart);
  return formatted.substring(payloadStart, nextSection);
}

describe('section budgets', () => {
  it('returns full content when no budgets specified', () => {
    const bigPlan = 'X'.repeat(20_000);
    const ctx = makeMinimalContext({ plan: bigPlan });
    const formatted = formatContextForPrompt(ctx);
    expect(formatted).toContain(bigPlan);
  });

  it('truncates plan when budget exceeded', () => {
    const bigPlan = 'X'.repeat(20_000);
    const ctx = makeMinimalContext({ plan: bigPlan });
    const formatted = formatContextForPrompt(ctx, { plan: 5000 });
    expect(formatted).toContain(TRUNCATION_HINT);
    expect(formatted).not.toContain(bigPlan);
  });

  it('truncates issue body when budget exceeded', () => {
    const bigBody = 'B'.repeat(10_000);
    const ctx = makeMinimalContext({ issue: { number: 1, title: 'T', body: bigBody, type: 'issue', state: 'open', labels: [] } });
    const formatted = formatContextForPrompt(ctx, { issueBody: 1000 });
    expect(formatted).toContain(TRUNCATION_HINT);
    expect(formatted).not.toContain(bigBody);
  });

  it('truncates review when budget exceeded', () => {
    const bigReview = 'R'.repeat(20_000);
    const ctx = makeMinimalContext({ review: bigReview });
    const formatted = formatContextForPrompt(ctx, { review: 5000 });
    const payload = extractReviewPayload(formatted);
    expect(payload).not.toBeNull();
    expect(payload).toContain(TRUNCATION_HINT);
    expect(payload!.length).toBeLessThanOrEqual(5000);
  });

  it('limits file tree entries when fileTreeEntries budget set', () => {
    const lines = Array.from({ length: 1000 }, (_, i) => `src/file${i}.ts`);
    const ctx = makeMinimalContext({ fileTree: lines.join('\n') });
    const formatted = formatContextForPrompt(ctx, { fileTreeEntries: 50 });
    expect(formatted).toContain('950 more files');
  });

  it('does not truncate sections within budget', () => {
    const shortPlan = 'Short plan';
    const ctx = makeMinimalContext({ plan: shortPlan });
    const formatted = formatContextForPrompt(ctx, { plan: 50000 });
    expect(formatted).toContain(shortPlan);
    expect(formatted).not.toContain(TRUNCATION_HINT);
  });

  it('truncation hint contains tool names', () => {
    expect(TRUNCATION_HINT).toContain('read_file');
    expect(TRUNCATION_HINT).toContain('search_in_file');
    expect(TRUNCATION_HINT).toContain('list_files');
  });

  it('strict cap: plan payload fits within budget', () => {
    const bigPlan = 'X'.repeat(20_000);
    const ctx = makeMinimalContext({ plan: bigPlan });
    const formatted = formatContextForPrompt(ctx, { plan: 500 });
    const payload = extractPlanPayload(formatted);
    expect(payload).not.toBeNull();
    expect(payload!.length).toBeLessThanOrEqual(500);
  });

  it('strict cap: budget=0 produces empty plan payload', () => {
    const ctx = makeMinimalContext({ plan: 'some plan' });
    const formatted = formatContextForPrompt(ctx, { plan: 0 });
    const payload = extractPlanPayload(formatted);
    expect(payload).not.toBeNull();
    expect(payload).toBe('');
  });

  it('strict cap: tiny budget produces visible hint fragment', () => {
    const ctx = makeMinimalContext({ plan: 'X'.repeat(1000) });
    const formatted = formatContextForPrompt(ctx, { plan: 10 });
    const payload = extractPlanPayload(formatted);
    expect(payload).not.toBeNull();
    expect(payload!.length).toBe(10);
    expect(payload!.startsWith('[')).toBe(true);
  });

  it('no budgets means no truncation (backward compat)', () => {
    const bigPlan = 'P'.repeat(20_000);
    const bigReview = 'R'.repeat(15_000);
    const ctx = makeMinimalContext({ plan: bigPlan, review: bigReview });
    const withoutBudgets = formatContextForPrompt(ctx);
    const withUndefined = formatContextForPrompt(ctx, undefined);
    expect(withoutBudgets).toContain(bigPlan);
    expect(withoutBudgets).toContain(bigReview);
    expect(withoutBudgets).toBe(withUndefined);
  });
});

// =============================================================================
// resolveImplementerBudgets
// =============================================================================

const CTX_ENV_KEYS = [
  'CONDUCTOR_CTX_BUDGET_ISSUE', 'CONDUCTOR_CTX_BUDGET_PLAN',
  'CONDUCTOR_CTX_BUDGET_REVIEW', 'CONDUCTOR_CTX_BUDGET_FILE_TREE',
  'CONDUCTOR_CTX_BUDGET_FILE_TREE_ENTRIES',
];
function cleanCtxEnv() {
  for (const key of CTX_ENV_KEYS) delete process.env[key];
}

describe('resolveImplementerBudgets', () => {
  beforeEach(() => cleanCtxEnv());
  afterEach(() => cleanCtxEnv());

  it('returns default budgets', () => {
    const budgets = resolveImplementerBudgets();
    expect(budgets).toEqual({
      issueBody: 5_000,
      plan: 10_000,
      review: 10_000,
      fileTree: 10_000,
      fileTreeEntries: 500,
    });
  });

  it('CONDUCTOR_CTX_BUDGET_PLAN overrides plan budget', () => {
    process.env['CONDUCTOR_CTX_BUDGET_PLAN'] = '20000';
    const budgets = resolveImplementerBudgets();
    expect(budgets.plan).toBe(20_000);
  });

  it('invalid env value falls back to default', () => {
    process.env['CONDUCTOR_CTX_BUDGET_PLAN'] = 'garbage';
    const budgets = resolveImplementerBudgets();
    expect(budgets.plan).toBe(10_000);
  });

  it('below-floor env value is clamped', () => {
    process.env['CONDUCTOR_CTX_BUDGET_PLAN'] = '100';
    const budgets = resolveImplementerBudgets();
    expect(budgets.plan).toBe(1_000);
  });
});
