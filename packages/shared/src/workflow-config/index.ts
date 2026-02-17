/**
 * Workflow Config Module
 *
 * Layered workflow configuration: MVP defaults -> project config -> run snapshot -> overlay.
 * Enables per-project and per-run customization of agent step parameters.
 *
 * JSON keys use camelCase exclusively: planner, reviewerPlan, implementer, reviewerCode.
 */

import { createLogger } from '../logger/index.ts';

const log = createLogger({ name: 'conductor:workflow-config' });

// =============================================================================
// Types
// =============================================================================

export interface StepBudgets {
  maxInputTokens?: number;
  maxOutputTokens?: number;
  maxDurationMs?: number;
}

export interface StepConfig {
  model?: string;
  maxTokens?: number;
  temperature?: number;
  toolProfile?: string;
  sandboxProfile?: string;
  budgets?: StepBudgets;
  backend?: 'raw' | 'agent_sdk';
}

/** @deprecated Use StepConfig — backend is now on all steps */
export type ImplementerStepConfig = StepConfig;

/**
 * Partial workflow config — used for project-level and overlay storage.
 *
 * Valid top-level keys: planner, reviewerPlan, implementer, reviewerCode.
 * All keys are camelCase. No snake_case normalization.
 */
export interface WorkflowConfig {
  planner?: StepConfig;
  reviewerPlan?: StepConfig;
  implementer?: StepConfig;
  reviewerCode?: StepConfig;
}

export interface ResolvedStepConfig {
  model: string;
  maxTokens: number;
  temperature: number;
  toolProfile?: string;
  sandboxProfile?: string;
  budgets: StepBudgets;
  backend: 'raw' | 'agent_sdk';
}

/** @deprecated Use ResolvedStepConfig — backend is now on all steps */
export type ResolvedImplementerStepConfig = ResolvedStepConfig;

export interface ResolvedWorkflowConfig {
  planner: ResolvedStepConfig;
  reviewerPlan: ResolvedStepConfig;
  implementer: ResolvedStepConfig;
  reviewerCode: ResolvedStepConfig;
}

// =============================================================================
// MVP Defaults
// =============================================================================

// NOTE: implementer.maxTokens is 8192 for tool-use mode (primary path).
// Raw legacy path uses 16384 — runtime wiring PR must handle this divergence.
// See implementer.ts:250
export const MVP_DEFAULTS: ResolvedWorkflowConfig = {
  planner:      { model: 'claude-sonnet-4-20250514', maxTokens: 8192, temperature: 0.3, backend: 'raw', toolProfile: 'inspect', budgets: {} },
  reviewerPlan: { model: 'claude-sonnet-4-20250514', maxTokens: 4096, temperature: 0.2, backend: 'raw', toolProfile: 'inspect', budgets: {} },
  implementer:  { model: 'claude-sonnet-4-20250514', maxTokens: 8192, temperature: 0.2, backend: 'raw', toolProfile: 'full', budgets: {} },
  reviewerCode: { model: 'claude-sonnet-4-20250514', maxTokens: 4096, temperature: 0.2, backend: 'raw', toolProfile: 'inspect', budgets: {} },
};

// =============================================================================
// Error Class
// =============================================================================

export class WorkflowConfigError extends Error {
  readonly code = 'INVALID_WORKFLOW_CONFIG' as const;

  constructor(message: string) {
    super(message);
    this.name = 'WorkflowConfigError';
  }
}

// =============================================================================
// Valid Keys
// =============================================================================

const VALID_STEP_KEYS = new Set(['planner', 'reviewerPlan', 'implementer', 'reviewerCode']);

const KNOWN_STEP_FIELDS = new Set([
  'model', 'maxTokens', 'temperature', 'toolProfile', 'sandboxProfile', 'budgets', 'backend',
]);

const KNOWN_BUDGET_FIELDS = new Set(['maxInputTokens', 'maxOutputTokens', 'maxDurationMs']);

// =============================================================================
// Validation — Shared Core
// =============================================================================

/**
 * Validate known field types within a single step.
 * Does NOT report unknown nested keys — that is the sanitize stage's job.
 */
export function validateStepFields(step: unknown, stepName: string): string[] {
  const errors: string[] = [];
  if (typeof step !== 'object' || step === null || Array.isArray(step)) {
    errors.push(`${stepName}: must be an object`);
    return errors;
  }

  const s = step as Record<string, unknown>;

  if ('model' in s && typeof s['model'] !== 'string') {
    errors.push(`${stepName}.model: must be a string`);
  }
  if ('maxTokens' in s) {
    const v = s['maxTokens'];
    if (typeof v !== 'number' || !Number.isInteger(v) || v <= 0) {
      errors.push(`${stepName}.maxTokens: must be a positive integer`);
    }
  }
  if ('temperature' in s) {
    const v = s['temperature'];
    if (typeof v !== 'number' || v < 0 || v > 1) {
      errors.push(`${stepName}.temperature: must be a number in [0, 1]`);
    }
  }
  if ('toolProfile' in s) {
    const tp = s['toolProfile'];
    if (typeof tp !== 'string') {
      errors.push(`${stepName}.toolProfile: must be a string`);
    } else {
      // Tool profile validation — constants mirror profiles.ts (single source of truth).
      // Kept inline to avoid circular dependency:
      //   profiles.ts → filesystem.ts → implementer.ts → workflow-config → profiles.ts
      // profiles.test.ts validates these stay in sync.
      const validProfiles = new Set(['readonly', 'inspect', 'full']);
      const writeCapable = new Set(['full']);
      const nonWrite = new Set(['readonly', 'inspect']);

      if (!validProfiles.has(tp)) {
        errors.push(`${stepName}.toolProfile: must be one of: ${[...validProfiles].join(', ')}`);
      } else {
        // Step-specific constraints
        const nonMutatingSteps = new Set(['planner', 'reviewerPlan', 'reviewerCode']);
        if (nonMutatingSteps.has(stepName) && !nonWrite.has(tp)) {
          errors.push(`${stepName}.toolProfile: '${tp}' is not allowed for ${stepName} (${stepName} is non-mutating). Allowed: ${[...nonWrite].join(', ')}`);
        } else if (stepName === 'implementer' && !writeCapable.has(tp)) {
          errors.push(`${stepName}.toolProfile: '${tp}' is not allowed for ${stepName} (implementer requires write capability). Allowed: ${[...writeCapable].join(', ')}`);
        }
      }
    }
  }
  if ('sandboxProfile' in s && typeof s['sandboxProfile'] !== 'string') {
    errors.push(`${stepName}.sandboxProfile: must be a string`);
  }
  if ('backend' in s) {
    if (s['backend'] !== 'raw' && s['backend'] !== 'agent_sdk') {
      errors.push(`${stepName}.backend: must be 'raw' or 'agent_sdk'`);
    }
  }
  if ('budgets' in s) {
    if (typeof s['budgets'] !== 'object' || s['budgets'] === null || Array.isArray(s['budgets'])) {
      errors.push(`${stepName}.budgets: must be an object`);
    } else {
      const b = s['budgets'] as Record<string, unknown>;
      for (const field of ['maxInputTokens', 'maxOutputTokens', 'maxDurationMs']) {
        if (field in b) {
          const v = b[field];
          if (typeof v !== 'number' || !Number.isInteger(v) || v <= 0) {
            errors.push(`${stepName}.budgets.${field}: must be a positive integer`);
          }
        }
      }
    }
  }

  return errors;
}

// =============================================================================
// Validation — Write-time (Strict)
// =============================================================================

/**
 * Strict validation for write-time (updateProject).
 * Rejects unknown top-level step keys (typo protection).
 * Unknown nested fields within valid steps are accepted for forward-compat.
 */
export function validateWorkflowConfigStrict(input: unknown): string[] {
  const errors: string[] = [];

  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    errors.push('Workflow config must be an object');
    return errors;
  }

  const obj = input as Record<string, unknown>;

  // Reject unknown top-level keys
  for (const key of Object.keys(obj)) {
    if (!VALID_STEP_KEYS.has(key)) {
      errors.push(`Unknown step key: '${key}'. Valid keys: planner, reviewerPlan, implementer, reviewerCode`);
    }
  }

  // Validate known steps
  for (const key of VALID_STEP_KEYS) {
    if (key in obj) {
      errors.push(...validateStepFields(obj[key], key));
    }
  }

  return errors;
}

// =============================================================================
// Sanitize Stage — Unknown Field Handling
// =============================================================================

const warnedKeys = new Set<string>();

function warnOnce(dedupeKey: string, message: string): void {
  if (!warnedKeys.has(dedupeKey)) {
    warnedKeys.add(dedupeKey);
    log.warn({ dedupeKey }, message);
  }
}

/**
 * Strip unknown top-level keys, delegate known step values to sanitizeStepConfig.
 */
function sanitizeConfig(config: Record<string, unknown>, source: string): WorkflowConfig {
  const result: WorkflowConfig = {};

  for (const key of Object.keys(config)) {
    if (!VALID_STEP_KEYS.has(key)) {
      warnOnce(`${source}.__top__.${key}`, `Unknown workflow config step key '${key}' in ${source}, stripping`);
      continue;
    }

    const stepValue = config[key];
    if (typeof stepValue !== 'object' || stepValue === null || Array.isArray(stepValue)) {
      continue;
    }

    const isImplementer = key === 'implementer';
    const sanitized = sanitizeStepConfig(stepValue as Record<string, unknown>, key, source, isImplementer);
    if (Object.keys(sanitized).length > 0) {
      (result as Record<string, unknown>)[key] = sanitized;
    }
  }

  return result;
}

/**
 * Keep only known fields for a step. Unknown keys are logged and dropped.
 */
function sanitizeStepConfig(
  step: Record<string, unknown>,
  stepName: string,
  source: string,
  _isImplementer?: boolean,
): StepConfig {
  const knownFields = KNOWN_STEP_FIELDS;
  const result: Record<string, unknown> = {};

  for (const key of Object.keys(step)) {
    if (key === 'budgets') {
      // Sanitize budgets sub-object
      const budgetValue = step[key];
      if (typeof budgetValue === 'object' && budgetValue !== null && !Array.isArray(budgetValue)) {
        const sanitizedBudgets: Record<string, unknown> = {};
        for (const bKey of Object.keys(budgetValue as Record<string, unknown>)) {
          if (KNOWN_BUDGET_FIELDS.has(bKey)) {
            sanitizedBudgets[bKey] = (budgetValue as Record<string, unknown>)[bKey];
          } else {
            warnOnce(`${source}.${stepName}.budgets.${bKey}`, `Unknown budget field '${bKey}' in ${source}.${stepName}.budgets, stripping`);
          }
        }
        if (Object.keys(sanitizedBudgets).length > 0) {
          result['budgets'] = sanitizedBudgets;
        }
      }
    } else if (knownFields.has(key)) {
      result[key] = step[key];
    } else {
      warnOnce(`${source}.${stepName}.${key}`, `Unknown field '${key}' in ${source}.${stepName}, stripping`);
    }
  }

  return result as StepConfig;
}

// =============================================================================
// JSON Helpers
// =============================================================================

/**
 * Parse and salvage a workflow config JSON string.
 * - null/undefined/empty → undefined
 * - Malformed JSON → undefined (warning logged)
 * - Valid JSON: sanitize + per-field salvage (bad fields dropped, valid siblings preserved)
 */
export function parseWorkflowConfigJson(
  json: string | null | undefined,
  source = 'unknown',
): WorkflowConfig | undefined {
  if (json === null || json === undefined || json === '') return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    log.warn({ source }, `Malformed workflow config JSON from ${source}`);
    return undefined;
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    log.warn({ source }, `Workflow config from ${source} is not an object`);
    return undefined;
  }

  // Sanitize: strip unknown keys
  const sanitized = sanitizeConfig(parsed as Record<string, unknown>, source);

  // Per-field salvage: validate each field within each step, drop bad ones
  const salvaged: WorkflowConfig = {};

  for (const stepKey of Object.keys(sanitized) as Array<keyof WorkflowConfig>) {
    const stepConfig = sanitized[stepKey];
    if (stepConfig === undefined) continue;

    const salvagedStep: Record<string, unknown> = {};
    const stepObj = stepConfig as Record<string, unknown>;

    for (const field of Object.keys(stepObj)) {
      // Validate individual field by wrapping in a single-field object
      const singleFieldObj = { [field]: stepObj[field] };
      const fieldErrors = validateStepFields(singleFieldObj, stepKey);
      if (fieldErrors.length === 0) {
        salvagedStep[field] = stepObj[field];
      } else {
        log.warn(
          { source, step: stepKey, field },
          `Dropping invalid field ${source}.${stepKey}.${field}: ${fieldErrors.join('; ')}`,
        );
      }
    }

    if (Object.keys(salvagedStep).length > 0) {
      (salvaged as Record<string, unknown>)[stepKey] = salvagedStep;
    }
  }

  if (Object.keys(salvaged).length === 0) {
    if (Object.keys(sanitized).length > 0) {
      log.warn({ source }, `All config fields dropped after salvage, falling back to defaults`);
    }
    return undefined;
  }

  return salvaged;
}

export function serializeWorkflowConfig(config: ResolvedWorkflowConfig): string {
  return JSON.stringify(config);
}

// =============================================================================
// Resolution
// =============================================================================

/**
 * Filter out undefined values so they don't overwrite defined ones during spread.
 */
function definedOnly<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const result: Partial<T> = {};
  for (const key of Object.keys(obj) as Array<keyof T>) {
    if (obj[key] !== undefined) {
      result[key] = obj[key];
    }
  }
  return result;
}

type StepKey = keyof WorkflowConfig;

const STEP_KEYS: StepKey[] = ['planner', 'reviewerPlan', 'implementer', 'reviewerCode'];

/**
 * Resolve a full workflow config by layering: MVP_DEFAULTS <- projectConfig <- overlay.
 */
export function resolveWorkflowConfig(
  projectConfig?: WorkflowConfig,
  overlay?: WorkflowConfig,
): ResolvedWorkflowConfig {
  const result: Record<string, unknown> = {};

  for (const step of STEP_KEYS) {
    const defaults = MVP_DEFAULTS[step];
    const projStep = projectConfig?.[step];
    const overlayStep = overlay?.[step];

    // Merge budgets separately
    const mergedBudgets: StepBudgets = {
      ...defaults.budgets,
      ...(projStep?.budgets !== undefined ? definedOnly(projStep.budgets as unknown as Record<string, unknown>) : {}),
      ...(overlayStep?.budgets !== undefined ? definedOnly(overlayStep.budgets as unknown as Record<string, unknown>) : {}),
    };

    // Merge step (excluding budgets)
    const { budgets: _db, ...defaultsRest } = defaults;
    const projRest = projStep !== undefined ? (({ budgets: _pb, ...rest }) => rest)(projStep) : {};
    const overlayRest = overlayStep !== undefined ? (({ budgets: _ob, ...rest }) => rest)(overlayStep) : {};

    result[step] = {
      ...defaultsRest,
      ...definedOnly(projRest as Record<string, unknown>),
      ...definedOnly(overlayRest as Record<string, unknown>),
      budgets: mergedBudgets,
    };
  }

  return result as unknown as ResolvedWorkflowConfig;
}

// =============================================================================
// Snapshot Creation
// =============================================================================

/**
 * Create a fully-resolved workflow snapshot JSON string.
 * Used inside createRun to persist the config at run-creation time.
 */
export function createWorkflowSnapshot(
  projectConfigJson?: string | null,
  implementerBackendFallback?: 'raw' | 'agent_sdk',
): string {
  const projectConfig = parseWorkflowConfigJson(projectConfigJson, 'project');

  // Apply implementer backend fallback if not set in project config
  let effectiveProjectConfig = projectConfig;
  if (implementerBackendFallback !== undefined) {
    const currentBackend = projectConfig?.implementer?.backend;
    if (currentBackend === undefined) {
      effectiveProjectConfig = {
        ...projectConfig,
        implementer: {
          ...projectConfig?.implementer,
          backend: implementerBackendFallback,
        },
      };
    }
  }

  const resolved = resolveWorkflowConfig(effectiveProjectConfig);
  return serializeWorkflowConfig(resolved);
}

// =============================================================================
// Run-Level Resolution
// =============================================================================

/**
 * Structural type for run fields needed by getResolvedWorkflowConfig.
 * Uses structural typing to avoid importing Run (prevents module cycles).
 */
export interface WorkflowConfigRunFields {
  workflowSnapshotJson?: string;
  workflowOverlayJson?: string;
  implementerBackend: 'raw' | 'agent_sdk';
}

/**
 * Get the fully-resolved workflow config for a run.
 * - If snapshot exists: parse snapshot as base, apply overlay on top
 * - If no snapshot (legacy run): use MVP defaults, fall back to run.implementerBackend
 */
export function getResolvedWorkflowConfig(run: WorkflowConfigRunFields): ResolvedWorkflowConfig {
  const snapshot = parseWorkflowConfigJson(run.workflowSnapshotJson, 'snapshot');
  const overlay = parseWorkflowConfigJson(run.workflowOverlayJson, 'overlay');

  if (snapshot !== undefined) {
    // Snapshot is a fully-resolved config stored as JSON.
    // Parse it as a WorkflowConfig (partial) and re-resolve with overlay.
    return resolveWorkflowConfig(snapshot, overlay);
  }

  // Legacy run: no snapshot. Use MVP defaults + implementerBackend fallback.
  const legacyConfig: WorkflowConfig = {
    implementer: { backend: run.implementerBackend },
  };

  return resolveWorkflowConfig(legacyConfig, overlay);
}
