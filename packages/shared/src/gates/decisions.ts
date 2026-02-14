/**
 * Gate Decisions Module
 *
 * Explicit gate decision state (control), separate from operator_actions (audit).
 * One decision per (run, gate, cycle) — first decision wins.
 * Uses INSERT-first conflict detection (race-safe, no TOCTOU).
 */

import type { Database } from 'better-sqlite3';

// =============================================================================
// Types
// =============================================================================

export type GateDecisionType = 'approved' | 'rejected';

export interface GateDecision {
  gateDecisionId: string;
  runId: string;
  gateId: string;
  cycle: number;
  decision: GateDecisionType;
  actorId: string;
  comment?: string;
  createdAt: string;
}

export interface RecordGateDecisionInput {
  runId: string;
  gateId: string;
  cycle: number;
  decision: GateDecisionType;
  actorId: string;
  comment?: string;
}

export interface RecordGateDecisionResult {
  decision: GateDecision;
  /** True if the row was newly inserted. False if an existing decision was found (first-decision-wins). */
  inserted: boolean;
  /** True if existing decision has a different decision type (approve vs reject conflict). */
  conflict: boolean;
}

interface GateDecisionRow {
  gate_decision_id: string;
  run_id: string;
  gate_id: string;
  cycle: number;
  decision: string;
  actor_id: string;
  comment: string | null;
  created_at: string;
}

// =============================================================================
// Helpers
// =============================================================================

export function generateGateDecisionId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 8);
  return `gd_${timestamp}${random}`;
}

function mapRow(row: GateDecisionRow): GateDecision {
  return {
    gateDecisionId: row.gate_decision_id,
    runId: row.run_id,
    gateId: row.gate_id,
    cycle: row.cycle,
    decision: row.decision as GateDecisionType,
    actorId: row.actor_id,
    comment: row.comment ?? undefined,
    createdAt: row.created_at,
  };
}

// =============================================================================
// CRUD
// =============================================================================

/**
 * Record a gate decision using INSERT-first conflict detection.
 * Follows the existing worktree pattern: attempt INSERT, catch UNIQUE violation,
 * fetch existing row to determine idempotent vs conflict.
 */
export function recordGateDecision(
  db: Database,
  input: RecordGateDecisionInput,
): RecordGateDecisionResult {
  const id = generateGateDecisionId();
  const now = new Date().toISOString();

  try {
    db.prepare(`
      INSERT INTO gate_decisions (
        gate_decision_id, run_id, gate_id, cycle,
        decision, actor_id, comment, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, input.runId, input.gateId, input.cycle,
      input.decision, input.actorId, input.comment ?? null, now,
    );

    const decision: GateDecision = {
      gateDecisionId: id,
      runId: input.runId,
      gateId: input.gateId,
      cycle: input.cycle,
      decision: input.decision,
      actorId: input.actorId,
      comment: input.comment,
      createdAt: now,
    };

    return { decision, inserted: true, conflict: false };
  } catch (err: unknown) {
    // Check if this is a UNIQUE constraint violation
    const message = err instanceof Error ? err.message : '';
    if (!message.includes('UNIQUE constraint failed')) {
      throw err; // Re-throw non-constraint errors
    }

    // Race: another writer inserted first — fetch the existing row
    const existing = getGateDecision(db, input.runId, input.gateId, input.cycle);
    if (existing === null) {
      // Should not happen if UNIQUE constraint fired, but handle gracefully
      throw err;
    }

    return {
      decision: existing,
      inserted: false,
      conflict: existing.decision !== input.decision,
    };
  }
}

/**
 * Get the gate decision for a specific (run, gate, cycle).
 */
export function getGateDecision(
  db: Database,
  runId: string,
  gateId: string,
  cycle: number,
): GateDecision | null {
  const row = db.prepare(`
    SELECT * FROM gate_decisions
    WHERE run_id = ? AND gate_id = ? AND cycle = ?
  `).get(runId, gateId, cycle) as GateDecisionRow | undefined;

  if (row === undefined) return null;
  return mapRow(row);
}
