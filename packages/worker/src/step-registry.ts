/**
 * Step Registry — Step→Agent Routing Table
 *
 * Pure module with no side effects (no Redis, no main(), no worker boot).
 * Single source of truth for step-centric dispatch.
 */

import type { RunStep } from '@conductor/shared';

export interface StepRoute {
  agent: string;
  action: string;
}

/**
 * Canonical step→agent routing table. Single source of truth for:
 * - processAgent dispatch (step-based routing)
 * - handleRunResume dispatch (resume routing)
 *
 * Handler functions are NOT stored here — they live in index.ts and are
 * looked up by step after registry validation.
 */
export const STEP_REGISTRY: Partial<Record<RunStep, StepRoute>> = {
  planner_create_plan:       { agent: 'planner',     action: 'create_plan' },
  reviewer_review_plan:      { agent: 'reviewer',    action: 'review_plan' },
  implementer_apply_changes: { agent: 'implementer', action: 'apply_changes' },
  reviewer_review_code:      { agent: 'reviewer',    action: 'review_code' },
};

/**
 * Reverse lookup: agent:action → RunStep.
 * Built with collision detection — throws at module init if two steps
 * share the same agent:action (catches bugs at startup, not at runtime).
 */
export const ROUTE_KEY_TO_STEP: Record<string, RunStep> = {};
for (const [step, route] of Object.entries(STEP_REGISTRY)) {
  const key = `${route.agent}:${route.action}`;
  if (key in ROUTE_KEY_TO_STEP) {
    throw new Error(
      `STEP_REGISTRY collision: '${key}' maps to both '${ROUTE_KEY_TO_STEP[key]}' and '${step}'`,
    );
  }
  ROUTE_KEY_TO_STEP[key] = step as RunStep;
}

/**
 * Get the expected agent:action for a given RunStep.
 * Used by resume dispatch and stale job detection.
 */
export function getRouteForStep(step: RunStep): StepRoute | undefined {
  return STEP_REGISTRY[step];
}

/**
 * Get the expected RunStep for an agent:action pair.
 * Returns undefined for unknown combinations.
 */
export function getStepForRoute(agent: string, action: string): RunStep | undefined {
  return ROUTE_KEY_TO_STEP[`${agent}:${action}`];
}

/**
 * Dispatch decision result — pure function for testability.
 */
export type DispatchDecision =
  | { action: 'dispatch'; step: RunStep }
  | { action: 'skip_stale'; expectedStep: RunStep; actualStep: RunStep }
  | { action: 'fail_unknown'; agent: string; routeAction: string };

/**
 * Determine the dispatch action for an agent job given the run's current step.
 * Pure function — no DB or side effects.
 */
export function resolveDispatch(agent: string, routeAction: string, runStep: RunStep): DispatchDecision {
  const expectedStep = getStepForRoute(agent, routeAction);
  if (expectedStep === undefined) {
    return { action: 'fail_unknown', agent, routeAction };
  }
  if (runStep !== expectedStep) {
    return { action: 'skip_stale', expectedStep, actualStep: runStep };
  }
  return { action: 'dispatch', step: expectedStep };
}
