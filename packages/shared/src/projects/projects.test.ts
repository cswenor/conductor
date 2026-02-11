/**
 * syncUserInstallations unit tests
 *
 * Uses in-memory SQLite (same pattern as db.test.ts / runs.test.ts).
 */

import { describe, it, expect, afterEach } from 'vitest';
import { initDatabase, closeDatabase } from '../db/index.ts';
import {
  syncUserInstallations,
  listPendingInstallations,
  type DiscoveredInstallation,
} from './index.ts';
import type { Database } from 'better-sqlite3';

let db: Database;

function setup(): Database {
  db = initDatabase({ path: ':memory:' });
  // Seed a user so FK constraints (if any future migration adds them) are satisfied
  db.prepare(
    `INSERT INTO users (user_id, github_id, github_node_id, github_login, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run('user_a', 1, 'node_1', 'user-a', 'active', new Date().toISOString(), new Date().toISOString());
  db.prepare(
    `INSERT INTO users (user_id, github_id, github_node_id, github_login, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run('user_b', 2, 'node_2', 'user-b', 'active', new Date().toISOString(), new Date().toISOString());
  return db;
}

afterEach(() => {
  if (db) {
    closeDatabase(db);
  }
});

function makeDiscovered(installationId: number): DiscoveredInstallation {
  return {
    installationId,
    accountLogin: `org-${installationId}`,
    accountId: installationId * 10,
    accountNodeId: `MDQ_${installationId}`,
    accountType: 'Organization',
  };
}

describe('syncUserInstallations', () => {
  it('inserts pending for new discovered installation', () => {
    setup();

    const result = syncUserInstallations(db, 'user_a', [makeDiscovered(100)]);

    expect(result).toHaveLength(1);
    expect(result[0]?.installationId).toBe(100);
    expect(result[0]?.setupAction).toBe('discovered');
    expect(result[0]?.userId).toBe('user_a');
  });

  it('skips installation already linked to a project', () => {
    setup();

    // Seed a project with github_installation_id = 200
    db.prepare(
      `INSERT INTO projects (project_id, name, user_id, github_org_id, github_org_node_id, github_org_name,
        github_installation_id, default_profile_id, default_base_branch, enforce_projects,
        port_range_start, port_range_end, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'proj_1', 'My Project', 'user_a', 200, 'MDQ_200', 'org-200',
      200, 'default', 'main', 0, 3000, 4000,
      new Date().toISOString(), new Date().toISOString()
    );

    const result = syncUserInstallations(db, 'user_a', [makeDiscovered(200)]);

    // Should not create a pending record for the already-linked installation
    expect(result).toHaveLength(0);
  });

  it('skips installation already pending for this user', () => {
    setup();

    // Seed an existing pending record
    db.prepare(
      `INSERT INTO pending_github_installations (installation_id, setup_action, state, user_id, created_at)
       VALUES (?, ?, ?, ?, ?)`
    ).run(300, 'install', null, 'user_a', new Date().toISOString());

    const result = syncUserInstallations(db, 'user_a', [makeDiscovered(300)]);

    // Should return the existing pending record but not duplicate it
    expect(result).toHaveLength(1);
    expect(result[0]?.installationId).toBe(300);
    expect(result[0]?.setupAction).toBe('install'); // original, not 'discovered'

    // Verify only one record exists
    const all = db
      .prepare('SELECT COUNT(*) as cnt FROM pending_github_installations WHERE installation_id = ? AND user_id = ?')
      .get(300, 'user_a') as { cnt: number };
    expect(all.cnt).toBe(1);
  });

  it('no cross-user leakage', () => {
    setup();

    // User A has a pending installation for ID 400
    db.prepare(
      `INSERT INTO pending_github_installations (installation_id, setup_action, state, user_id, created_at)
       VALUES (?, ?, ?, ?, ?)`
    ).run(400, 'install', null, 'user_a', new Date().toISOString());

    // User B discovers the same installation
    const resultB = syncUserInstallations(db, 'user_b', [makeDiscovered(400)]);

    // User B should get their own pending record
    expect(resultB).toHaveLength(1);
    expect(resultB[0]?.userId).toBe('user_b');
    expect(resultB[0]?.setupAction).toBe('discovered');

    // User A's record should be unchanged
    const resultA = listPendingInstallations(db, { userId: 'user_a' });
    expect(resultA).toHaveLength(1);
    expect(resultA[0]?.userId).toBe('user_a');
    expect(resultA[0]?.setupAction).toBe('install');
  });

  it('returns merged list of existing pending and newly discovered', () => {
    setup();

    // Seed one existing pending
    db.prepare(
      `INSERT INTO pending_github_installations (installation_id, setup_action, state, user_id, created_at)
       VALUES (?, ?, ?, ?, ?)`
    ).run(500, 'install', null, 'user_a', new Date().toISOString());

    // Discover a new one
    const result = syncUserInstallations(db, 'user_a', [makeDiscovered(600)]);

    expect(result).toHaveLength(2);
    const ids = result.map((r) => r.installationId).sort((a, b) => a - b);
    expect(ids).toEqual([500, 600]);
  });
});
