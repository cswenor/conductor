/**
 * Tool Profile Tests
 */

import { describe, it, expect } from 'vitest';
import {
  isValidToolProfile,
  VALID_TOOL_PROFILES,
  WRITE_CAPABLE_PROFILES,
  NON_WRITE_PROFILES,
  STEP_PROFILE_CONSTRAINTS,
  validateProfileForStep,
  registerToolsForProfile,
} from './profiles.ts';
import { createToolRegistry } from './registry.ts';

// =============================================================================
// isValidToolProfile
// =============================================================================

describe('isValidToolProfile', () => {
  it('returns true for readonly', () => {
    expect(isValidToolProfile('readonly')).toBe(true);
  });

  it('returns true for inspect', () => {
    expect(isValidToolProfile('inspect')).toBe(true);
  });

  it('returns true for full', () => {
    expect(isValidToolProfile('full')).toBe(true);
  });

  it('returns false for unknown profile', () => {
    expect(isValidToolProfile('unknown')).toBe(false);
  });

  it('returns false for empty string', () => {
    expect(isValidToolProfile('')).toBe(false);
  });

  it('returns false for inspect_full (Phase B)', () => {
    expect(isValidToolProfile('inspect_full')).toBe(false);
  });
});

// =============================================================================
// VALID_TOOL_PROFILES
// =============================================================================

describe('VALID_TOOL_PROFILES', () => {
  it('contains exactly readonly, inspect, full', () => {
    expect([...VALID_TOOL_PROFILES].sort()).toEqual(['full', 'inspect', 'readonly']);
  });
});

// =============================================================================
// registerToolsForProfile — tool registration
// =============================================================================

describe('registerToolsForProfile', () => {
  it('readonly registers exactly 4 tools (read-only filesystem)', () => {
    const registry = createToolRegistry();
    registerToolsForProfile(registry, 'readonly');
    const names = registry.names().sort();
    expect(names).toEqual(['list_files', 'read_file', 'read_file_range', 'search_in_file']);
  });

  it('readonly does NOT include write_file or delete_file', () => {
    const registry = createToolRegistry();
    registerToolsForProfile(registry, 'readonly');
    expect(registry.has('write_file')).toBe(false);
    expect(registry.has('delete_file')).toBe(false);
  });

  it('inspect registers 5 tools (readonly + run_tests)', () => {
    const registry = createToolRegistry();
    registerToolsForProfile(registry, 'inspect');
    const names = registry.names().sort();
    expect(names).toEqual(['list_files', 'read_file', 'read_file_range', 'run_tests', 'search_in_file']);
  });

  it('inspect does NOT include write_file or delete_file', () => {
    const registry = createToolRegistry();
    registerToolsForProfile(registry, 'inspect');
    expect(registry.has('write_file')).toBe(false);
    expect(registry.has('delete_file')).toBe(false);
  });

  it('full registers 7 tools (all filesystem + run_tests)', () => {
    const registry = createToolRegistry();
    registerToolsForProfile(registry, 'full');
    const names = registry.names().sort();
    expect(names).toEqual([
      'delete_file', 'list_files', 'read_file', 'read_file_range',
      'run_tests', 'search_in_file', 'write_file',
    ]);
  });

  it('full includes write_file and delete_file', () => {
    const registry = createToolRegistry();
    registerToolsForProfile(registry, 'full');
    expect(registry.has('write_file')).toBe(true);
    expect(registry.has('delete_file')).toBe(true);
  });
});

// =============================================================================
// validateProfileForStep — step-specific constraints
// =============================================================================

describe('validateProfileForStep', () => {
  it('full is not allowed for planner', () => {
    const result = validateProfileForStep('full', 'planner');
    expect(result).not.toBeNull();
    expect(result).toContain('planner');
    expect(result).toContain('non-mutating');
  });

  it('full is not allowed for reviewerPlan', () => {
    const result = validateProfileForStep('full', 'reviewerPlan');
    expect(result).not.toBeNull();
  });

  it('full is not allowed for reviewerCode', () => {
    const result = validateProfileForStep('full', 'reviewerCode');
    expect(result).not.toBeNull();
  });

  it('inspect is allowed for planner', () => {
    expect(validateProfileForStep('inspect', 'planner')).toBeNull();
  });

  it('readonly is allowed for planner', () => {
    expect(validateProfileForStep('readonly', 'planner')).toBeNull();
  });

  it('inspect is allowed for reviewerPlan', () => {
    expect(validateProfileForStep('inspect', 'reviewerPlan')).toBeNull();
  });

  it('readonly is not allowed for implementer', () => {
    const result = validateProfileForStep('readonly', 'implementer');
    expect(result).not.toBeNull();
    expect(result).toContain('implementer');
  });

  it('inspect is not allowed for implementer', () => {
    const result = validateProfileForStep('inspect', 'implementer');
    expect(result).not.toBeNull();
  });

  it('full is allowed for implementer', () => {
    expect(validateProfileForStep('full', 'implementer')).toBeNull();
  });

  it('unknown step has no constraints', () => {
    expect(validateProfileForStep('full', 'unknownStep')).toBeNull();
  });
});

// =============================================================================
// Profile constant consistency
// =============================================================================

describe('profile constants', () => {
  it('WRITE_CAPABLE_PROFILES contains only full', () => {
    expect([...WRITE_CAPABLE_PROFILES]).toEqual(['full']);
  });

  it('NON_WRITE_PROFILES contains readonly and inspect', () => {
    expect([...NON_WRITE_PROFILES].sort()).toEqual(['inspect', 'readonly']);
  });

  it('STEP_PROFILE_CONSTRAINTS covers all 4 steps', () => {
    expect(Object.keys(STEP_PROFILE_CONSTRAINTS).sort()).toEqual([
      'implementer', 'planner', 'reviewerCode', 'reviewerPlan',
    ]);
  });
});
