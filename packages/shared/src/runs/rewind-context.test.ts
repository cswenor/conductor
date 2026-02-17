/**
 * Rewind Context Summary Builder Tests
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Database as DatabaseType } from 'better-sqlite3';
import { initDatabase, closeDatabase } from '../db/index.ts';
import { createRun } from './index.ts';
import { buildRewindContextSummary } from './rewind-context.ts';

// Mock pubsub
vi.mock('../pubsub/index.ts', () => ({
  publishOperatorActionEvent: vi.fn(),
  publishRunUpdatedEvent: vi.fn(),
  publishTransitionEvent: vi.fn(),
  initPublisher: vi.fn(),
  publishGateEvaluatedEvent: vi.fn(),
  publishAgentInvocationEvent: vi.fn(),
  publishProjectUpdatedEvent: vi.fn(),
}));

let db: DatabaseType;

function seedTestData(database: DatabaseType): {
  runId: string;
  projectId: string;
  repoId: string;
  taskId: string;
} {
  const now = new Date().toISOString();
  const userId = 'user_1';
  const projectId = 'proj_1';
  const repoId = 'repo_1';
  const taskId = 'task_1';

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

  return { runId: run.runId, projectId, repoId, taskId };
}

function addInvocation(
  database: DatabaseType,
  runId: string,
  id: string,
  agent: string,
  action: string,
  status: string,
  durationMs?: number,
): void {
  const now = new Date().toISOString();
  database.prepare(`
    INSERT INTO agent_invocations (agent_invocation_id, run_id, agent, action, status, duration_ms, started_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, runId, agent, action, status, durationMs ?? null, now);
}

function addArtifact(
  database: DatabaseType,
  runId: string,
  id: string,
  type: string,
  version: number,
  content: string,
): void {
  const now = new Date().toISOString();
  database.prepare(`
    INSERT INTO artifacts (artifact_id, run_id, type, version, content_markdown, size_bytes,
      checksum_sha256, validation_status, created_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'valid', 'system', ?)
  `).run(id, runId, type, version, content, content.length, 'abc123', now);
}

beforeEach(() => {
  db = initDatabase({ path: ':memory:' });
});

afterEach(() => {
  closeDatabase(db);
});

describe('buildRewindContextSummary', () => {
  it('returns minimal summary for empty run', () => {
    const { runId } = seedTestData(db);
    const summary = buildRewindContextSummary(db, runId);

    expect(summary).toContain('Agent Invocation History');
    expect(summary).toContain('No prior agent invocations');
    expect(summary).toContain('Artifacts');
    expect(summary).toContain('No artifacts produced');
  });

  it('includes invocation agent/action/status', () => {
    const { runId } = seedTestData(db);
    addInvocation(db, runId, 'ai_1', 'planner', 'create_plan', 'completed', 1200);
    addInvocation(db, runId, 'ai_2', 'reviewer', 'review_plan', 'completed', 800);

    const summary = buildRewindContextSummary(db, runId);

    expect(summary).toContain('planner:create_plan');
    expect(summary).toContain('completed');
    expect(summary).toContain('1200ms');
    expect(summary).toContain('reviewer:review_plan');
  });

  it('includes artifact type/version/content preview', () => {
    const { runId } = seedTestData(db);
    addArtifact(db, runId, 'art_1', 'plan', 1, 'This is the plan content');
    addArtifact(db, runId, 'art_2', 'review', 1, 'Review feedback here');

    const summary = buildRewindContextSummary(db, runId);

    expect(summary).toContain('**plan**');
    expect(summary).toContain('v1');
    expect(summary).toContain('This is the plan content');
    expect(summary).toContain('**review**');
    expect(summary).toContain('Review feedback here');
  });

  it('only includes last 20 invocations when more exist', () => {
    const { runId } = seedTestData(db);

    // Add 25 invocations
    for (let i = 0; i < 25; i++) {
      addInvocation(db, runId, `ai_${i}`, 'planner', 'create_plan', 'completed', 100);
    }

    const summary = buildRewindContextSummary(db, runId);

    expect(summary).toContain('showing last 20 of 25 invocations');
    // Count lines with "planner:create_plan"
    const lines = summary.split('\n').filter(l => l.includes('planner:create_plan'));
    expect(lines.length).toBe(20);
  });

  it('takes latest artifact per type', () => {
    const { runId } = seedTestData(db);
    addArtifact(db, runId, 'art_1', 'plan', 1, 'Plan v1');
    addArtifact(db, runId, 'art_2', 'plan', 2, 'Plan v2');

    const summary = buildRewindContextSummary(db, runId);

    // Should only show v2 (latest), not both
    expect(summary).toContain('v2');
    // Only one plan entry
    const planLines = summary.split('\n').filter(l => l.includes('**plan**'));
    expect(planLines.length).toBe(1);
  });

  it('respects 8000 char cap', () => {
    const { runId } = seedTestData(db);

    // Add many invocations and artifacts with long content to exceed 8000 chars
    for (let i = 0; i < 20; i++) {
      addInvocation(db, runId, `ai_${i}`, 'planner', 'create_plan', 'completed', 100);
    }
    // Add artifacts with 500-char content previews (the cap per artifact)
    // Each type is unique so each gets included. Use 'other' type with different versions
    // to get multiple entries. But listArtifacts groups by type, so we need
    // different types. ArtifactType only has plan/review/test_report/other —
    // so we add many invocations and long artifact content to fill the space.
    const longContent = 'A'.repeat(500);
    addArtifact(db, runId, 'art_1', 'plan', 1, longContent.repeat(20));
    addArtifact(db, runId, 'art_2', 'review', 1, longContent.repeat(20));
    addArtifact(db, runId, 'art_3', 'test_report', 1, longContent.repeat(20));
    addArtifact(db, runId, 'art_4', 'other', 1, longContent.repeat(20));

    const summary = buildRewindContextSummary(db, runId);

    expect(summary.length).toBeLessThanOrEqual(8000);
  });

  it('redacts sensitive patterns in artifact content', () => {
    const { runId } = seedTestData(db);
    addArtifact(db, runId, 'art_1', 'plan', 1, 'Use key sk-ant-abcdefghijklmnopqrstuvwxyz123456 for access');

    const summary = buildRewindContextSummary(db, runId);

    expect(summary).not.toContain('sk-ant-');
    expect(summary).toContain('[REDACTED:anthropic_key]');
  });
});
