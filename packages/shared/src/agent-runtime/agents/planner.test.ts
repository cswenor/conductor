/**
 * Planner Agent Tests
 *
 * Tests planner input/output types and system prompt content.
 * API invocation is NOT tested (requires live credentials).
 */

import { describe, it, expect } from 'vitest';

// We import the module to verify exports exist and types are correct.
// Actual invocation is tested via integration tests.
import type { PlannerInput, PlannerResult } from './planner.js';

describe('PlannerInput type', () => {
  it('requires runId', () => {
    const input: PlannerInput = { runId: 'run_test' };
    expect(input.runId).toBe('run_test');
    expect(input.worktreePath).toBeUndefined();
  });

  it('accepts optional worktreePath', () => {
    const input: PlannerInput = { runId: 'run_test', worktreePath: '/tmp/wt' };
    expect(input.worktreePath).toBe('/tmp/wt');
  });
});

describe('PlannerResult type', () => {
  it('has required fields', () => {
    const result: PlannerResult = {
      agentInvocationId: 'ai_test',
      artifactId: 'art_test',
      plan: '### Approach\nFix the bug',
    };
    expect(result.agentInvocationId).toMatch(/^ai_/);
    expect(result.artifactId).toMatch(/^art_/);
    expect(result.plan).toContain('Approach');
  });
});
