/**
 * Artifact Storage Service Tests
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Database as DatabaseType } from 'better-sqlite3';
import { initDatabase, closeDatabase } from '../db/index.js';
import { createRun } from '../runs/index.js';
import {
  generateArtifactId,
  createArtifact,
  getArtifact,
  getLatestArtifact,
  listArtifacts,
  updateValidationStatus,
} from './artifacts.js';

let db: DatabaseType;

function seedTestData(db: DatabaseType): { runId: string } {
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
  return { runId: run.runId };
}

beforeEach(() => {
  db = initDatabase({ path: ':memory:' });
});

afterEach(() => {
  closeDatabase(db);
});

describe('generateArtifactId', () => {
  it('produces ids with art_ prefix', () => {
    const id = generateArtifactId();
    expect(id).toMatch(/^art_/);
  });

  it('produces unique ids', () => {
    const ids = new Set(Array.from({ length: 100 }, () => generateArtifactId()));
    expect(ids.size).toBe(100);
  });
});

describe('createArtifact', () => {
  it('creates artifact with version 1', () => {
    const { runId } = seedTestData(db);
    const art = createArtifact(db, {
      runId,
      type: 'plan',
      contentMarkdown: '# Plan\nStep 1: Do the thing',
      createdBy: 'planner',
    });

    expect(art.artifactId).toMatch(/^art_/);
    expect(art.runId).toBe(runId);
    expect(art.type).toBe('plan');
    expect(art.version).toBe(1);
    expect(art.contentMarkdown).toBe('# Plan\nStep 1: Do the thing');
    expect(art.sizeBytes).toBeGreaterThan(0);
    expect(art.checksumSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(art.validationStatus).toBe('pending');
  });

  it('auto-increments version for same runId and type', () => {
    const { runId } = seedTestData(db);

    const v1 = createArtifact(db, { runId, type: 'plan', contentMarkdown: 'v1', createdBy: 'planner' });
    const v2 = createArtifact(db, { runId, type: 'plan', contentMarkdown: 'v2', createdBy: 'planner' });
    const v3 = createArtifact(db, { runId, type: 'plan', contentMarkdown: 'v3', createdBy: 'planner' });

    expect(v1.version).toBe(1);
    expect(v2.version).toBe(2);
    expect(v3.version).toBe(3);
  });

  it('maintains independent version sequences for different types', () => {
    const { runId } = seedTestData(db);

    const plan1 = createArtifact(db, { runId, type: 'plan', contentMarkdown: 'plan', createdBy: 'planner' });
    const review1 = createArtifact(db, { runId, type: 'review', contentMarkdown: 'review', createdBy: 'reviewer' });
    const plan2 = createArtifact(db, { runId, type: 'plan', contentMarkdown: 'plan v2', createdBy: 'planner' });

    expect(plan1.version).toBe(1);
    expect(review1.version).toBe(1);
    expect(plan2.version).toBe(2);
  });

  it('computes deterministic checksum for same content', () => {
    const { runId } = seedTestData(db);
    const content = 'identical content';

    const a1 = createArtifact(db, { runId, type: 'plan', contentMarkdown: content, createdBy: 'planner' });
    const a2 = createArtifact(db, { runId, type: 'review', contentMarkdown: content, createdBy: 'reviewer' });

    expect(a1.checksumSha256).toBe(a2.checksumSha256);
  });

  it('computes correct size from content', () => {
    const { runId } = seedTestData(db);
    const content = 'hello world';
    const art = createArtifact(db, { runId, type: 'plan', contentMarkdown: content, createdBy: 'planner' });

    expect(art.sizeBytes).toBe(Buffer.byteLength(content, 'utf8'));
  });
});

describe('getArtifact', () => {
  it('retrieves created artifact', () => {
    const { runId } = seedTestData(db);
    const created = createArtifact(db, { runId, type: 'plan', contentMarkdown: 'test', createdBy: 'planner' });

    const fetched = getArtifact(db, created.artifactId);
    expect(fetched).not.toBeNull();
    expect(fetched?.artifactId).toBe(created.artifactId);
    expect(fetched?.contentMarkdown).toBe('test');
  });

  it('returns null for non-existent id', () => {
    expect(getArtifact(db, 'art_nonexistent')).toBeNull();
  });
});

describe('getLatestArtifact', () => {
  it('returns highest version for run and type', () => {
    const { runId } = seedTestData(db);

    createArtifact(db, { runId, type: 'plan', contentMarkdown: 'v1', createdBy: 'planner' });
    createArtifact(db, { runId, type: 'plan', contentMarkdown: 'v2', createdBy: 'planner' });
    createArtifact(db, { runId, type: 'plan', contentMarkdown: 'v3', createdBy: 'planner' });

    const latest = getLatestArtifact(db, runId, 'plan');
    expect(latest).not.toBeNull();
    expect(latest?.version).toBe(3);
    expect(latest?.contentMarkdown).toBe('v3');
  });

  it('returns null when no artifacts exist', () => {
    const { runId } = seedTestData(db);
    expect(getLatestArtifact(db, runId, 'plan')).toBeNull();
  });
});

describe('listArtifacts', () => {
  it('lists all versions ordered by version desc', () => {
    const { runId } = seedTestData(db);

    createArtifact(db, { runId, type: 'plan', contentMarkdown: 'v1', createdBy: 'planner' });
    createArtifact(db, { runId, type: 'plan', contentMarkdown: 'v2', createdBy: 'planner' });

    const artifacts = listArtifacts(db, runId, 'plan');
    expect(artifacts).toHaveLength(2);
    expect(artifacts[0]?.version).toBe(2);
    expect(artifacts[1]?.version).toBe(1);
  });

  it('lists all types when no filter', () => {
    const { runId } = seedTestData(db);

    createArtifact(db, { runId, type: 'plan', contentMarkdown: 'p', createdBy: 'planner' });
    createArtifact(db, { runId, type: 'review', contentMarkdown: 'r', createdBy: 'reviewer' });

    const all = listArtifacts(db, runId);
    expect(all).toHaveLength(2);
  });
});

describe('updateValidationStatus', () => {
  it('updates status to valid', () => {
    const { runId } = seedTestData(db);
    const art = createArtifact(db, { runId, type: 'plan', contentMarkdown: 'test', createdBy: 'planner' });

    updateValidationStatus(db, art.artifactId, 'valid');

    const fetched = getArtifact(db, art.artifactId);
    expect(fetched?.validationStatus).toBe('valid');
    expect(fetched?.validatedAt).toBeDefined();
  });

  it('updates status to invalid with errors', () => {
    const { runId } = seedTestData(db);
    const art = createArtifact(db, { runId, type: 'plan', contentMarkdown: 'test', createdBy: 'planner' });

    updateValidationStatus(db, art.artifactId, 'invalid', '["missing steps section"]');

    const fetched = getArtifact(db, art.artifactId);
    expect(fetched?.validationStatus).toBe('invalid');
    expect(fetched?.validationErrorsJson).toBe('["missing steps section"]');
  });
});
