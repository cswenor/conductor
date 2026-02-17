/**
 * Step Registry Tests
 *
 * Tests the pure step-registry module: registry parity, collision detection,
 * reverse lookup, and dispatch resolution.
 */

import { describe, it, expect } from 'vitest';
import type { RunStep } from '@conductor/shared';
import {
  STEP_REGISTRY,
  ROUTE_KEY_TO_STEP,
  getRouteForStep,
  getStepForRoute,
  resolveDispatch,
} from './step-registry.ts';

describe('STEP_REGISTRY', () => {
  it('has entries for all 4 agent dispatch steps', () => {
    expect(STEP_REGISTRY).toHaveProperty('planner_create_plan');
    expect(STEP_REGISTRY).toHaveProperty('reviewer_review_plan');
    expect(STEP_REGISTRY).toHaveProperty('implementer_apply_changes');
    expect(STEP_REGISTRY).toHaveProperty('reviewer_review_code');
  });

  it('ROUTE_KEY_TO_STEP is inverse of STEP_REGISTRY', () => {
    for (const [step, route] of Object.entries(STEP_REGISTRY)) {
      const key = `${route.agent}:${route.action}`;
      expect(ROUTE_KEY_TO_STEP[key]).toBe(step);
    }
  });

  it('no duplicate route keys (collision detection)', () => {
    const routeKeys = Object.values(STEP_REGISTRY).map(
      (r) => `${r.agent}:${r.action}`,
    );
    expect(new Set(routeKeys).size).toBe(routeKeys.length);
  });
});

describe('getRouteForStep', () => {
  it('returns correct agent:action for planner step', () => {
    const route = getRouteForStep('planner_create_plan');
    expect(route).toEqual({ agent: 'planner', action: 'create_plan' });
  });

  it('returns correct agent:action for reviewer_review_plan', () => {
    const route = getRouteForStep('reviewer_review_plan');
    expect(route).toEqual({ agent: 'reviewer', action: 'review_plan' });
  });

  it('returns correct agent:action for implementer step', () => {
    const route = getRouteForStep('implementer_apply_changes');
    expect(route).toEqual({ agent: 'implementer', action: 'apply_changes' });
  });

  it('returns correct agent:action for reviewer_review_code', () => {
    const route = getRouteForStep('reviewer_review_code');
    expect(route).toEqual({ agent: 'reviewer', action: 'review_code' });
  });

  it('returns undefined for non-agent steps', () => {
    expect(getRouteForStep('setup_worktree')).toBeUndefined();
    expect(getRouteForStep('cleanup')).toBeUndefined();
    expect(getRouteForStep('wait_plan_approval')).toBeUndefined();
    expect(getRouteForStep('create_pr')).toBeUndefined();
    expect(getRouteForStep('wait_pr_merge')).toBeUndefined();
  });
});

describe('getStepForRoute', () => {
  it('returns correct step for known agent:action', () => {
    expect(getStepForRoute('planner', 'create_plan')).toBe('planner_create_plan');
    expect(getStepForRoute('reviewer', 'review_plan')).toBe('reviewer_review_plan');
    expect(getStepForRoute('implementer', 'apply_changes')).toBe('implementer_apply_changes');
    expect(getStepForRoute('reviewer', 'review_code')).toBe('reviewer_review_code');
  });

  it('returns undefined for unknown combinations', () => {
    expect(getStepForRoute('unknown', 'route')).toBeUndefined();
    expect(getStepForRoute('planner', 'unknown_action')).toBeUndefined();
    expect(getStepForRoute('', '')).toBeUndefined();
  });
});

describe('resolveDispatch', () => {
  it('dispatches when agent:action matches run.step', () => {
    const result = resolveDispatch('planner', 'create_plan', 'planner_create_plan');
    expect(result).toEqual({ action: 'dispatch', step: 'planner_create_plan' });
  });

  it('dispatches for each registered step when run.step matches', () => {
    for (const [step, route] of Object.entries(STEP_REGISTRY)) {
      const result = resolveDispatch(route.agent, route.action, step as RunStep);
      expect(result).toEqual({ action: 'dispatch', step });
    }
  });

  it('skips stale job: implementer job while run at reviewer step', () => {
    const result = resolveDispatch('implementer', 'apply_changes', 'reviewer_review_code');
    expect(result).toEqual({
      action: 'skip_stale',
      expectedStep: 'implementer_apply_changes',
      actualStep: 'reviewer_review_code',
    });
  });

  it('skips stale job: planner job while run at implementer step', () => {
    const result = resolveDispatch('planner', 'create_plan', 'implementer_apply_changes');
    expect(result).toEqual({
      action: 'skip_stale',
      expectedStep: 'planner_create_plan',
      actualStep: 'implementer_apply_changes',
    });
  });

  it('skips stale job: reviewer_review_plan while run at planner_create_plan', () => {
    const result = resolveDispatch('reviewer', 'review_plan', 'planner_create_plan');
    expect(result).toEqual({
      action: 'skip_stale',
      expectedStep: 'reviewer_review_plan',
      actualStep: 'planner_create_plan',
    });
  });

  it('fails unknown agent:action combination', () => {
    const result = resolveDispatch('unknown', 'action', 'planner_create_plan');
    expect(result).toEqual({
      action: 'fail_unknown',
      agent: 'unknown',
      routeAction: 'action',
    });
  });

  it('fails for known agent with wrong action', () => {
    const result = resolveDispatch('planner', 'wrong_action', 'planner_create_plan');
    expect(result).toEqual({
      action: 'fail_unknown',
      agent: 'planner',
      routeAction: 'wrong_action',
    });
  });
});
