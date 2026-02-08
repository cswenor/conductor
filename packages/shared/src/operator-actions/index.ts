/**
 * Operator Actions Service
 *
 * CRUD operations for recording operator actions with full attribution.
 * Operator actions are the mechanism by which humans interact with gates
 * and control runs (approve, reject, revise, pause, resume, cancel, retry).
 *
 * Actor attribution: per DATA_MODEL.md Section 6.6, the service API accepts
 * actorId, actorType, actorDisplayName. The current schema has a single
 * `operator` column — actorId is stored there.
 *
 * TODO: Future migration should add actor_type and actor_display_name columns
 * to operator_actions table to match DATA_MODEL.md Section 6.6.
 *
 * GitHub mirroring: The github_write_id FK is nullable and will be populated
 * by WP9 (GitHub Mirroring). WP8 records the action; WP9 mirrors it.
 */

import type { Database } from 'better-sqlite3';
import type { OperatorActionType, ActorType, RunPhase } from '../types/index.ts';

// =============================================================================
// Types
// =============================================================================

export interface OperatorAction {
  operatorActionId: string;
  runId: string;
  action: OperatorActionType;
  operator: string;
  comment?: string;
  fromPhase?: string;
  toPhase?: string;
  githubWriteId?: string;
  createdAt: string;
}

interface OperatorActionRow {
  operator_action_id: string;
  run_id: string;
  action: string;
  operator: string;
  comment: string | null;
  from_phase: string | null;
  to_phase: string | null;
  github_write_id: string | null;
  created_at: string;
}

export interface RecordActionParams {
  runId: string;
  action: OperatorActionType;
  actorId: string;
  actorType: ActorType;
  actorDisplayName?: string;
  comment?: string;
  fromPhase?: RunPhase;
  toPhase?: RunPhase;
}

// =============================================================================
// Constants
// =============================================================================

const VALID_ACTION_TYPES: ReadonlySet<string> = new Set<OperatorActionType>([
  'start_run',
  'approve_plan',
  'revise_plan',
  'reject_run',
  'retry',
  'pause',
  'resume',
  'cancel',
  'grant_policy_exception',
  'deny_policy_exception',
]);

/**
 * Phase-action compatibility rules.
 * Maps each action to the phases in which it is valid.
 * `null` means special logic is needed (checked separately).
 */
const ACTION_PHASE_RULES: Record<OperatorActionType, ReadonlySet<RunPhase> | null> = {
  start_run: new Set(['pending']),
  approve_plan: new Set(['awaiting_plan_approval']),
  revise_plan: new Set(['awaiting_plan_approval']),
  reject_run: new Set(['awaiting_plan_approval']),
  retry: new Set(['blocked']),
  pause: null, // valid in any non-terminal, non-blocked phase
  resume: null, // valid only when paused_at IS NOT NULL
  cancel: null, // valid in any non-terminal phase
  grant_policy_exception: new Set(['blocked']),
  deny_policy_exception: new Set(['blocked']),
};

const TERMINAL_PHASES: ReadonlySet<RunPhase> = new Set(['completed', 'cancelled']);

const ACTIVE_NON_BLOCKED_PHASES: ReadonlySet<RunPhase> = new Set([
  'pending', 'planning', 'awaiting_plan_approval', 'executing', 'awaiting_review',
]);

// =============================================================================
// Helpers
// =============================================================================

export function generateOperatorActionId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 8);
  return `oa_${timestamp}${random}`;
}

function mapRow(row: OperatorActionRow): OperatorAction {
  return {
    operatorActionId: row.operator_action_id,
    runId: row.run_id,
    action: row.action as OperatorActionType,
    operator: row.operator,
    comment: row.comment ?? undefined,
    fromPhase: row.from_phase ?? undefined,
    toPhase: row.to_phase ?? undefined,
    githubWriteId: row.github_write_id ?? undefined,
    createdAt: row.created_at,
  };
}

// =============================================================================
// Validation
// =============================================================================

/**
 * Validate that an action type string is a valid OperatorActionType.
 */
export function isValidActionType(action: string): action is OperatorActionType {
  return VALID_ACTION_TYPES.has(action);
}

/**
 * Check if an action is compatible with the current run phase.
 * Returns an error message if incompatible, or null if valid.
 */
export function validateActionPhase(
  action: OperatorActionType,
  phase: RunPhase,
  pausedAt?: string,
): string | null {
  const allowedPhases = ACTION_PHASE_RULES[action];

  if (allowedPhases !== null) {
    if (!allowedPhases.has(phase)) {
      return `Action '${action}' is not valid in phase '${phase}'`;
    }
    return null;
  }

  // Special cases
  switch (action) {
    case 'pause':
      if (!ACTIVE_NON_BLOCKED_PHASES.has(phase)) {
        return `Action 'pause' is not valid in phase '${phase}'`;
      }
      if (pausedAt !== undefined) {
        return 'Run is already paused';
      }
      return null;

    case 'resume':
      if (pausedAt === undefined) {
        return 'Run is not currently paused';
      }
      return null;

    case 'cancel':
      if (TERMINAL_PHASES.has(phase)) {
        return `Action 'cancel' is not valid in terminal phase '${phase}'`;
      }
      return null;

    default:
      return null;
  }
}

// =============================================================================
// CRUD
// =============================================================================

/**
 * Record an operator action with full attribution.
 * Validates action type and phase compatibility before inserting.
 *
 * @throws Error if action type is invalid or incompatible with current phase.
 */
export function recordOperatorAction(
  db: Database,
  params: RecordActionParams,
): OperatorAction {
  // Validate action type (runtime guard for external callers)
  if (!isValidActionType(params.action as string)) {
    throw new Error(`Invalid action type: ${params.action as string}`);
  }

  // Look up the run to validate phase compatibility
  const run = db.prepare(
    'SELECT phase, paused_at FROM runs WHERE run_id = ?'
  ).get(params.runId) as { phase: string; paused_at: string | null } | undefined;

  if (run === undefined) {
    throw new Error(`Run not found: ${params.runId}`);
  }

  const phaseError = validateActionPhase(
    params.action,
    run.phase as RunPhase,
    run.paused_at ?? undefined,
  );
  if (phaseError !== null) {
    throw new Error(phaseError);
  }

  const id = generateOperatorActionId();
  const now = new Date().toISOString();

  // Store actorId in the operator column (see TODO at top for schema gap)
  db.prepare(`
    INSERT INTO operator_actions (
      operator_action_id, run_id, action, operator,
      comment, from_phase, to_phase, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    params.runId,
    params.action,
    params.actorId,
    params.comment ?? null,
    params.fromPhase ?? null,
    params.toPhase ?? null,
    now,
  );

  return {
    operatorActionId: id,
    runId: params.runId,
    action: params.action,
    operator: params.actorId,
    comment: params.comment,
    fromPhase: params.fromPhase,
    toPhase: params.toPhase,
    createdAt: now,
  };
}

/**
 * Get the latest operator action of a given type for a run.
 */
export function getOperatorAction(
  db: Database,
  runId: string,
  actionType: OperatorActionType,
): OperatorAction | null {
  const row = db.prepare(`
    SELECT * FROM operator_actions
    WHERE run_id = ? AND action = ?
    ORDER BY created_at DESC, rowid DESC
    LIMIT 1
  `).get(runId, actionType) as OperatorActionRow | undefined;

  if (row === undefined) return null;
  return mapRow(row);
}

/**
 * List all operator actions for a run, ordered by created_at ASC.
 */
export function listOperatorActions(
  db: Database,
  runId: string,
): OperatorAction[] {
  const rows = db.prepare(`
    SELECT * FROM operator_actions
    WHERE run_id = ?
    ORDER BY created_at ASC
  `).all(runId) as OperatorActionRow[];

  return rows.map(mapRow);
}
