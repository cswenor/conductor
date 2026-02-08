/**
 * Policy Sets Module
 *
 * Manages policy set records. Runs require a FK to policy_sets,
 * so a default policy set must exist per project before creating runs.
 */

import type { Database } from 'better-sqlite3';
import { createLogger } from '../logger/index.ts';

const log = createLogger({ name: 'conductor:policy-sets' });

// =============================================================================
// Types
// =============================================================================

export interface PolicySet {
  policySetId: string;
  projectId: string;
  configHash: string;
  replacesPolicySetId?: string;
  createdBy: string;
  createdAt: string;
}

// =============================================================================
// ID Generation
// =============================================================================

export function generatePolicySetId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 8);
  return `ps_${timestamp}${random}`;
}

// =============================================================================
// Operations
// =============================================================================

/**
 * Get the default policy set for a project.
 * Returns null if none exists.
 */
export function getDefaultPolicySet(db: Database, projectId: string): PolicySet | null {
  const stmt = db.prepare(
    'SELECT * FROM policy_sets WHERE project_id = ? AND config_hash = ? ORDER BY created_at ASC LIMIT 1'
  );
  const row = stmt.get(projectId, 'default:v1') as Record<string, unknown> | undefined;

  if (row === undefined) return null;

  return rowToPolicySet(row);
}

/**
 * Ensure a default policy set exists for a project.
 * Creates one if none exists, returns existing otherwise.
 */
export function ensureDefaultPolicySet(db: Database, projectId: string): PolicySet {
  const existing = getDefaultPolicySet(db, projectId);
  if (existing !== null) return existing;

  const policySetId = generatePolicySetId();
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO policy_sets (policy_set_id, project_id, config_hash, created_by, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(policySetId, projectId, 'default:v1', 'system', now);

  log.info({ policySetId, projectId }, 'Default policy set created');

  return {
    policySetId,
    projectId,
    configHash: 'default:v1',
    createdBy: 'system',
    createdAt: now,
  };
}

// =============================================================================
// Helpers
// =============================================================================

function rowToPolicySet(row: Record<string, unknown>): PolicySet {
  return {
    policySetId: row['policy_set_id'] as string,
    projectId: row['project_id'] as string,
    configHash: row['config_hash'] as string,
    replacesPolicySetId: row['replaces_policy_set_id'] as string | undefined,
    createdBy: row['created_by'] as string,
    createdAt: row['created_at'] as string,
  };
}
