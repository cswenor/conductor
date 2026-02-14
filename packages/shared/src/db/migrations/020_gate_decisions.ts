/**
 * Migration 020: Gate Decisions table + approval_cycle column
 *
 * Explicit gate decision state (control), separate from operator_actions (audit).
 * One decision per (run, gate, cycle) — first decision wins.
 */

import type { Database } from 'better-sqlite3';
import type { Migration } from './index.ts';

export const migration020: Migration = {
  version: 20,
  name: 'gate_decisions',
  up(db: Database) {
    db.exec(`
      CREATE TABLE gate_decisions (
        gate_decision_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(run_id),
        gate_id TEXT NOT NULL REFERENCES gate_definitions(gate_id),
        cycle INTEGER NOT NULL,
        decision TEXT NOT NULL CHECK (decision IN ('approved', 'rejected')),
        actor_id TEXT NOT NULL,
        comment TEXT,
        created_at TEXT NOT NULL
      );

      -- One decision per gate per cycle (first-decision-wins)
      CREATE UNIQUE INDEX idx_gate_decisions_cycle
        ON gate_decisions(run_id, gate_id, cycle);

      -- Cycle counter on runs: incremented each time run enters awaiting_plan_approval
      ALTER TABLE runs ADD COLUMN approval_cycle INTEGER NOT NULL DEFAULT 0;
    `);
  },
};
