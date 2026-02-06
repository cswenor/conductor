/**
 * Gate Evaluations Service
 *
 * CRUD operations for the gate_evaluations table.
 * Gate evaluations are ordered by causation event sequence (not timestamp).
 * Gate state is derived from the latest evaluation per gate_id — never stored on runs.
 */

import type { Database } from 'better-sqlite3';
import type { GateKind, GateStatus } from '../types/index.js';

// =============================================================================
// Types
// =============================================================================

export interface GateEvaluation {
  gateEvaluationId: string;
  runId: string;
  gateId: string;
  kind: GateKind;
  status: GateStatus;
  reason?: string;
  detailsJson?: string;
  causationEventId: string;
  evaluatedAt: string;
  durationMs?: number;
}

interface GateEvaluationRow {
  gate_evaluation_id: string;
  run_id: string;
  gate_id: string;
  kind: string;
  status: string;
  reason: string | null;
  details_json: string | null;
  causation_event_id: string;
  evaluated_at: string;
  duration_ms: number | null;
}

export interface CreateGateEvaluationInput {
  runId: string;
  gateId: string;
  kind: GateKind;
  status: GateStatus;
  reason?: string;
  details?: Record<string, unknown>;
  causationEventId: string;
  durationMs?: number;
}

// =============================================================================
// Helpers
// =============================================================================

export function generateGateEvaluationId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 8);
  return `ge_${timestamp}${random}`;
}

function mapRow(row: GateEvaluationRow): GateEvaluation {
  return {
    gateEvaluationId: row.gate_evaluation_id,
    runId: row.run_id,
    gateId: row.gate_id,
    kind: row.kind as GateKind,
    status: row.status as GateStatus,
    reason: row.reason ?? undefined,
    detailsJson: row.details_json ?? undefined,
    causationEventId: row.causation_event_id,
    evaluatedAt: row.evaluated_at,
    durationMs: row.duration_ms ?? undefined,
  };
}

// =============================================================================
// CRUD
// =============================================================================

/**
 * Create a new gate evaluation record.
 */
export function createGateEvaluation(
  db: Database,
  input: CreateGateEvaluationInput,
): GateEvaluation {
  const id = generateGateEvaluationId();
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO gate_evaluations (
      gate_evaluation_id, run_id, gate_id, kind, status,
      reason, details_json, causation_event_id,
      evaluated_at, duration_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    input.runId,
    input.gateId,
    input.kind,
    input.status,
    input.reason ?? null,
    input.details !== undefined ? JSON.stringify(input.details) : null,
    input.causationEventId,
    now,
    input.durationMs ?? null,
  );

  return {
    gateEvaluationId: id,
    runId: input.runId,
    gateId: input.gateId,
    kind: input.kind,
    status: input.status,
    reason: input.reason,
    detailsJson: input.details !== undefined ? JSON.stringify(input.details) : undefined,
    causationEventId: input.causationEventId,
    evaluatedAt: now,
    durationMs: input.durationMs,
  };
}

/**
 * Get the latest gate evaluation for a specific gate on a run.
 * Ordered by causation event sequence DESC, then gate_evaluation_id DESC.
 * Per PROTOCOL.md: ordering is by event sequence, not timestamp.
 */
export function getLatestGateEvaluation(
  db: Database,
  runId: string,
  gateId: string,
): GateEvaluation | null {
  const row = db.prepare(`
    SELECT ge.*
    FROM gate_evaluations ge
    JOIN events e ON ge.causation_event_id = e.event_id
    WHERE ge.run_id = ? AND ge.gate_id = ?
    ORDER BY e.sequence DESC, ge.gate_evaluation_id DESC
    LIMIT 1
  `).get(runId, gateId) as GateEvaluationRow | undefined;

  if (row === undefined) return null;
  return mapRow(row);
}

/**
 * List all gate evaluations for a run, ordered by causation event sequence.
 */
export function listGateEvaluations(
  db: Database,
  runId: string,
): GateEvaluation[] {
  const rows = db.prepare(`
    SELECT ge.*
    FROM gate_evaluations ge
    JOIN events e ON ge.causation_event_id = e.event_id
    WHERE ge.run_id = ?
    ORDER BY e.sequence ASC, ge.gate_evaluation_id ASC
  `).all(runId) as GateEvaluationRow[];

  return rows.map(mapRow);
}

/**
 * Derive the current gate state map for a run.
 * Returns the latest status for each gate that has been evaluated.
 * Per PROTOCOL.md: gate state is derived from GateEvaluation records, never stored on runs.
 */
export function deriveGateState(
  db: Database,
  runId: string,
): Record<string, GateStatus> {
  // Get the latest evaluation per gate_id, ordered by causation event sequence
  const rows = db.prepare(`
    SELECT ge.gate_id, ge.status
    FROM gate_evaluations ge
    JOIN events e ON ge.causation_event_id = e.event_id
    WHERE ge.run_id = ?
      AND ge.gate_evaluation_id = (
        SELECT ge2.gate_evaluation_id
        FROM gate_evaluations ge2
        JOIN events e2 ON ge2.causation_event_id = e2.event_id
        WHERE ge2.run_id = ge.run_id AND ge2.gate_id = ge.gate_id
        ORDER BY e2.sequence DESC, ge2.gate_evaluation_id DESC
        LIMIT 1
      )
  `).all(runId) as Array<{ gate_id: string; status: string }>;

  const state: Record<string, GateStatus> = {};
  for (const row of rows) {
    state[row.gate_id] = row.status as GateStatus;
  }
  return state;
}

/**
 * Get runs awaiting gate decisions for a project.
 * Returns runs in 'awaiting_plan_approval' or 'blocked' phase.
 * Used by the approvals inbox.
 */
export function getRunsAwaitingGates(
  db: Database,
  projectId: string,
): Array<{
  runId: string;
  phase: string;
  blockedReason?: string;
  taskId: string;
  repoId: string;
  updatedAt: string;
}> {
  const rows = db.prepare(`
    SELECT run_id, phase, blocked_reason, task_id, repo_id, updated_at
    FROM runs
    WHERE project_id = ?
      AND phase IN ('awaiting_plan_approval', 'blocked')
    ORDER BY updated_at ASC
  `).all(projectId) as Array<{
    run_id: string;
    phase: string;
    blocked_reason: string | null;
    task_id: string;
    repo_id: string;
    updated_at: string;
  }>;

  return rows.map((row) => ({
    runId: row.run_id,
    phase: row.phase,
    blockedReason: row.blocked_reason ?? undefined,
    taskId: row.task_id,
    repoId: row.repo_id,
    updatedAt: row.updated_at,
  }));
}
