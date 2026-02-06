/**
 * Overrides Service
 *
 * CRUD operations for the overrides table.
 * Overrides are scope-aware exceptions (policy_exception, skip_tests,
 * accept_with_issues) granted by operators with justification.
 *
 * Per DATA_MODEL.md Section 6.7: "Overrides are not blanket exceptions —
 * they include constraints that limit what they permit."
 *
 * GitHub mirroring: The github_write_id FK is nullable and will be
 * populated by WP9 (GitHub Mirroring).
 */

import type { Database } from 'better-sqlite3';

// =============================================================================
// Types
// =============================================================================

export type OverrideKind = 'policy_exception' | 'skip_tests' | 'accept_with_issues';

export type OverrideScope = 'this_run' | 'this_task' | 'this_repo' | 'project_wide';

export interface Override {
  overrideId: string;
  runId: string;
  kind: OverrideKind;
  targetId?: string;
  scope: OverrideScope;
  constraintKind?: string;
  constraintValue?: string;
  constraintHash?: string;
  policySetId?: string;
  operator: string;
  justification: string;
  expiresAt?: string;
  githubWriteId?: string;
  createdAt: string;
}

interface OverrideRow {
  override_id: string;
  run_id: string;
  kind: string;
  target_id: string | null;
  scope: string;
  constraint_kind: string | null;
  constraint_value: string | null;
  constraint_hash: string | null;
  policy_set_id: string | null;
  operator: string;
  justification: string;
  expires_at: string | null;
  github_write_id: string | null;
  created_at: string;
}

export interface CreateOverrideInput {
  runId: string;
  kind: OverrideKind;
  targetId?: string;
  scope: OverrideScope;
  constraintKind?: string;
  constraintValue?: string;
  constraintHash?: string;
  policySetId?: string;
  operator: string;
  justification: string;
  expiresAt?: string;
}

// =============================================================================
// Helpers
// =============================================================================

export function generateOverrideId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 8);
  return `ov_${timestamp}${random}`;
}

function mapRow(row: OverrideRow): Override {
  return {
    overrideId: row.override_id,
    runId: row.run_id,
    kind: row.kind as OverrideKind,
    targetId: row.target_id ?? undefined,
    scope: row.scope as OverrideScope,
    constraintKind: row.constraint_kind ?? undefined,
    constraintValue: row.constraint_value ?? undefined,
    constraintHash: row.constraint_hash ?? undefined,
    policySetId: row.policy_set_id ?? undefined,
    operator: row.operator,
    justification: row.justification,
    expiresAt: row.expires_at ?? undefined,
    githubWriteId: row.github_write_id ?? undefined,
    createdAt: row.created_at,
  };
}

// =============================================================================
// CRUD
// =============================================================================

/**
 * Create a new override record.
 */
export function createOverride(
  db: Database,
  input: CreateOverrideInput,
): Override {
  const id = generateOverrideId();
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO overrides (
      override_id, run_id, kind, target_id, scope,
      constraint_kind, constraint_value, constraint_hash,
      policy_set_id, operator, justification,
      expires_at, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    input.runId,
    input.kind,
    input.targetId ?? null,
    input.scope,
    input.constraintKind ?? null,
    input.constraintValue ?? null,
    input.constraintHash ?? null,
    input.policySetId ?? null,
    input.operator,
    input.justification,
    input.expiresAt ?? null,
    now,
  );

  return {
    overrideId: id,
    runId: input.runId,
    kind: input.kind,
    targetId: input.targetId,
    scope: input.scope,
    constraintKind: input.constraintKind,
    constraintValue: input.constraintValue,
    constraintHash: input.constraintHash,
    policySetId: input.policySetId,
    operator: input.operator,
    justification: input.justification,
    expiresAt: input.expiresAt,
    createdAt: now,
  };
}

/**
 * Get a single override by ID.
 */
export function getOverride(
  db: Database,
  overrideId: string,
): Override | null {
  const row = db.prepare(
    'SELECT * FROM overrides WHERE override_id = ?'
  ).get(overrideId) as OverrideRow | undefined;

  if (row === undefined) return null;
  return mapRow(row);
}

/**
 * List all overrides for a run.
 */
export function listOverrides(
  db: Database,
  runId: string,
): Override[] {
  const rows = db.prepare(
    'SELECT * FROM overrides WHERE run_id = ? ORDER BY created_at ASC'
  ).all(runId) as OverrideRow[];

  return rows.map(mapRow);
}

/**
 * Find an active (non-expired) override matching kind + target + scope.
 * Scope hierarchy: project_wide > this_repo > this_task > this_run.
 *
 * For broader scopes (this_task, this_repo, project_wide), the lookup
 * joins through the runs table to find overrides created on other runs
 * that share the same task, repo, or project. This ensures an override
 * granted at project_wide scope on one run applies to all runs in that project.
 */
export function findMatchingOverride(
  db: Database,
  params: {
    runId: string;
    kind: OverrideKind;
    targetId?: string;
  },
): Override | null {
  const now = new Date().toISOString();

  // Join overrides with runs to match broader scopes.
  // For 'this_run': override.run_id must match the target run.
  // For 'this_task': override's run must share the same task_id.
  // For 'this_repo': override's run must share the same repo_id.
  // For 'project_wide': override's run must share the same project_id.
  const row = db.prepare(`
    SELECT o.* FROM overrides o
    JOIN runs override_run ON o.run_id = override_run.run_id
    JOIN runs target_run ON target_run.run_id = ?
    WHERE o.kind = ?
      AND (o.target_id IS NULL OR o.target_id = ?)
      AND (o.expires_at IS NULL OR o.expires_at > ?)
      AND (
        (o.scope = 'this_run' AND o.run_id = ?)
        OR (o.scope = 'this_task' AND override_run.task_id = target_run.task_id)
        OR (o.scope = 'this_repo' AND override_run.repo_id = target_run.repo_id)
        OR (o.scope = 'project_wide' AND override_run.project_id = target_run.project_id)
      )
    ORDER BY
      CASE o.scope
        WHEN 'project_wide' THEN 1
        WHEN 'this_repo' THEN 2
        WHEN 'this_task' THEN 3
        WHEN 'this_run' THEN 4
        ELSE 5
      END ASC
    LIMIT 1
  `).get(
    params.runId,
    params.kind,
    params.targetId ?? '',
    now,
    params.runId,
  ) as OverrideRow | undefined;

  if (row === undefined) return null;
  return mapRow(row);
}
