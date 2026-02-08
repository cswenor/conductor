/**
 * Policy Sets Module Tests
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Database as DatabaseType } from 'better-sqlite3';
import { initDatabase, closeDatabase } from '../db/index.ts';
import {
  generatePolicySetId,
  getDefaultPolicySet,
  ensureDefaultPolicySet,
} from './index.ts';

let db: DatabaseType;

function seedProject(db: DatabaseType, projectId = 'proj_test'): void {
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO users (user_id, github_id, github_node_id, github_login, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'active', ?, ?)
  `).run('user_test', 100, 'U_test', 'testuser', now, now);

  db.prepare(`
    INSERT INTO projects (
      project_id, user_id, name, github_org_id, github_org_node_id, github_org_name,
      github_installation_id, default_profile_id, default_base_branch,
      port_range_start, port_range_end, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(projectId, 'user_test', 'Test Project', 1, 'O_test', 'testorg',
    12345, 'default', 'main', 3100, 3199, now, now);
}

beforeEach(() => {
  db = initDatabase({ path: ':memory:' });
});

afterEach(() => {
  closeDatabase(db);
});

describe('generatePolicySetId', () => {
  it('produces ids with ps_ prefix', () => {
    const id = generatePolicySetId();
    expect(id).toMatch(/^ps_/);
  });

  it('produces unique ids', () => {
    const ids = new Set(Array.from({ length: 100 }, () => generatePolicySetId()));
    expect(ids.size).toBe(100);
  });
});

describe('getDefaultPolicySet', () => {
  it('returns null when no policy set exists', () => {
    seedProject(db);
    const result = getDefaultPolicySet(db, 'proj_test');
    expect(result).toBeNull();
  });

  it('returns existing default policy set', () => {
    seedProject(db);
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO policy_sets (policy_set_id, project_id, config_hash, created_by, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run('ps_existing', 'proj_test', 'default:v1', 'system', now);

    const result = getDefaultPolicySet(db, 'proj_test');
    expect(result).not.toBeNull();
    expect(result!.policySetId).toBe('ps_existing');
    expect(result!.configHash).toBe('default:v1');
  });
});

describe('ensureDefaultPolicySet', () => {
  it('creates a new policy set when none exists', () => {
    seedProject(db);
    const result = ensureDefaultPolicySet(db, 'proj_test');
    expect(result.projectId).toBe('proj_test');
    expect(result.configHash).toBe('default:v1');
    expect(result.createdBy).toBe('system');
    expect(result.policySetId).toMatch(/^ps_/);
  });

  it('returns existing policy set without creating duplicate', () => {
    seedProject(db);
    const first = ensureDefaultPolicySet(db, 'proj_test');
    const second = ensureDefaultPolicySet(db, 'proj_test');
    expect(first.policySetId).toBe(second.policySetId);
  });

  it('creates separate policy sets for different projects', () => {
    seedProject(db, 'proj_a');
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO projects (
        project_id, user_id, name, github_org_id, github_org_node_id, github_org_name,
        github_installation_id, default_profile_id, default_base_branch,
        port_range_start, port_range_end, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run('proj_b', 'user_test', 'Project B', 2, 'O_b', 'orgb',
      12346, 'default', 'main', 3200, 3299, now, now);

    const psA = ensureDefaultPolicySet(db, 'proj_a');
    const psB = ensureDefaultPolicySet(db, 'proj_b');
    expect(psA.policySetId).not.toBe(psB.policySetId);
  });
});
