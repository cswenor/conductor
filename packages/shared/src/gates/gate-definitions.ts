/**
 * Gate Definitions Seeder
 *
 * Seeds the built-in gate definitions into the gate_definitions table.
 * Follows the same idempotent pattern as ensureBuiltInPolicyDefinitions.
 *
 * Gate IDs match docs/ROUTING_AND_GATES.md configuration reference:
 * plan_approval, tests_pass, code_review, merge_wait
 */

import type { Database } from 'better-sqlite3';
import type { GateKind } from '../types/index.ts';

// =============================================================================
// Types
// =============================================================================

export interface BuiltInGate {
  gateId: string;
  kind: GateKind;
  description: string;
  defaultConfig: Record<string, unknown>;
}

export interface GateDefinition {
  gateId: string;
  kind: GateKind;
  description: string;
  defaultConfigJson: string;
}

interface GateDefinitionRow {
  gate_id: string;
  kind: string;
  description: string;
  default_config_json: string;
}

// =============================================================================
// Built-in Gate Definitions
// =============================================================================

export const BUILT_IN_GATES: BuiltInGate[] = [
  {
    gateId: 'plan_approval',
    kind: 'human',
    description: 'Requires operator approval of the generated plan before execution proceeds',
    defaultConfig: {
      required: true,
      timeout_hours: 72,
      reminder_hours: 24,
    },
  },
  {
    gateId: 'tests_pass',
    kind: 'automatic',
    description: 'Verifies that all tests pass after implementation changes are applied',
    defaultConfig: {
      required: true,
      max_retries: 3,
      timeout_minutes: 15,
      allow_skip: false,
    },
  },
  {
    gateId: 'code_review',
    kind: 'automatic',
    description: 'Automated code review evaluates implementation quality and correctness',
    defaultConfig: {
      required: true,
      max_rounds: 3,
      allow_accept_with_issues: true,
    },
  },
  {
    gateId: 'merge_wait',
    kind: 'human',
    description: 'Waits for the pull request to be reviewed and merged before completing',
    defaultConfig: {
      required: true,
    },
  },
];

// =============================================================================
// Helpers
// =============================================================================

function mapRow(row: GateDefinitionRow): GateDefinition {
  return {
    gateId: row.gate_id,
    kind: row.kind as GateKind,
    description: row.description,
    defaultConfigJson: row.default_config_json,
  };
}

// =============================================================================
// Seeder
// =============================================================================

/**
 * Ensures all built-in gate definitions exist in the database.
 * Idempotent — safe to call multiple times.
 */
export function ensureBuiltInGateDefinitions(db: Database): void {
  const insert = db.prepare(`
    INSERT OR IGNORE INTO gate_definitions (
      gate_id, kind, description, default_config_json
    ) VALUES (?, ?, ?, ?)
  `);

  const tx = db.transaction(() => {
    for (const gate of BUILT_IN_GATES) {
      insert.run(
        gate.gateId,
        gate.kind,
        gate.description,
        JSON.stringify(gate.defaultConfig),
      );
    }
  });

  tx();
}

// =============================================================================
// Queries
// =============================================================================

/**
 * Retrieve a single gate definition by ID.
 */
export function getGateDefinition(
  db: Database,
  gateId: string,
): GateDefinition | null {
  const row = db.prepare(
    'SELECT * FROM gate_definitions WHERE gate_id = ?'
  ).get(gateId) as GateDefinitionRow | undefined;

  if (row === undefined) return null;
  return mapRow(row);
}

/**
 * List all gate definitions.
 */
export function listGateDefinitions(db: Database): GateDefinition[] {
  const rows = db.prepare(
    'SELECT * FROM gate_definitions ORDER BY gate_id ASC'
  ).all() as GateDefinitionRow[];

  return rows.map(mapRow);
}
