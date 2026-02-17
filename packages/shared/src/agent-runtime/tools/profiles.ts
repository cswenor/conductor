/**
 * Tool Profiles
 *
 * Defines the mapping from toolProfile string to tool registration sets.
 * Single source of truth for profile constants — both config validation
 * (workflow-config/index.ts) and runtime registration import from here.
 */

import type { ToolRegistry } from './registry.ts';
import { registerFilesystemTools, registerReadOnlyFilesystemTools } from './filesystem.ts';
import { registerTestRunnerTool } from './test-runner.ts';

// =============================================================================
// Profile Types & Constants
// =============================================================================

/**
 * Known tool profiles.
 * 'readonly'  — read_file, read_file_range, search_in_file, list_files
 * 'inspect'   — readonly + run_tests
 * 'full'      — all filesystem tools + run_tests
 */
export type ToolProfile = 'readonly' | 'inspect' | 'full';

/** All valid profile names — used by both config validation and runtime. */
export const VALID_TOOL_PROFILES = new Set<ToolProfile>(['readonly', 'inspect', 'full']);

export function isValidToolProfile(profile: string): profile is ToolProfile {
  return VALID_TOOL_PROFILES.has(profile as ToolProfile);
}

/** Profiles that include write_file/delete_file. */
export const WRITE_CAPABLE_PROFILES = new Set<ToolProfile>(['full']);

/** Profiles allowed for non-mutating steps (planner, reviewerPlan, reviewerCode). */
export const NON_WRITE_PROFILES = new Set<ToolProfile>(['readonly', 'inspect']);

// =============================================================================
// Step-Specific Profile Constraints
// =============================================================================

/**
 * Step-specific profile constraint definitions.
 * Consumed by both workflow config validation and SDK runtime guards.
 */
export const STEP_PROFILE_CONSTRAINTS: Record<string, { allowed: Set<ToolProfile>; reason: string }> = {
  planner:      { allowed: NON_WRITE_PROFILES, reason: 'planner is non-mutating' },
  reviewerPlan: { allowed: NON_WRITE_PROFILES, reason: 'plan reviewer is non-mutating' },
  reviewerCode: { allowed: NON_WRITE_PROFILES, reason: 'code reviewer is non-mutating' },
  implementer:  { allowed: WRITE_CAPABLE_PROFILES, reason: 'implementer requires write capability' },
};

/**
 * Check if a profile is allowed for a given step. Returns error message or null.
 * Used by both config validation and runtime guards — single policy source.
 */
export function validateProfileForStep(profile: ToolProfile, stepName: string): string | null {
  const constraint = STEP_PROFILE_CONSTRAINTS[stepName];
  if (constraint === undefined) return null; // Unknown step — no constraint
  if (!constraint.allowed.has(profile)) {
    return `'${profile}' is not allowed for ${stepName} (${constraint.reason}). Allowed: ${[...constraint.allowed].join(', ')}`;
  }
  return null;
}

// =============================================================================
// Tool Registration
// =============================================================================

/**
 * Register tools for the given profile.
 * Phase B adds 'inspect_full' (inspect + run_command + web_fetch).
 */
export function registerToolsForProfile(registry: ToolRegistry, profile: ToolProfile): void {
  switch (profile) {
    case 'readonly':
      registerReadOnlyFilesystemTools(registry);
      break;
    case 'inspect':
      registerReadOnlyFilesystemTools(registry);
      registerTestRunnerTool(registry);
      break;
    case 'full':
      registerFilesystemTools(registry);
      registerTestRunnerTool(registry);
      break;
  }
}
