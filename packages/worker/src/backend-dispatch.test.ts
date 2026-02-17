/**
 * Backend Dispatch Tests
 *
 * Pure function tests — no worker bootstrap, no Redis, no DB.
 */

import { describe, it, expect } from 'vitest';
import { resolveBackendDispatch, validateSdkProvider, getStepConfigForHandler } from './backend-dispatch.ts';
import type { ResolvedWorkflowConfig, ResolvedStepConfig } from '@conductor/shared';

// =============================================================================
// resolveBackendDispatch
// =============================================================================

describe('resolveBackendDispatch', () => {
  it('returns { backend: "raw" } for raw config', () => {
    const config: ResolvedStepConfig = {
      model: 'claude-sonnet-4-20250514',
      maxTokens: 8192,
      temperature: 0.3,
      backend: 'raw',
      budgets: {},
    };
    expect(resolveBackendDispatch(config)).toEqual({ backend: 'raw' });
  });

  it('returns { backend: "agent_sdk", providerCheck: true } for agent_sdk config', () => {
    const config: ResolvedStepConfig = {
      model: 'claude-sonnet-4-20250514',
      maxTokens: 8192,
      temperature: 0.3,
      backend: 'agent_sdk',
      budgets: {},
    };
    expect(resolveBackendDispatch(config)).toEqual({ backend: 'agent_sdk', providerCheck: true });
  });
});

// =============================================================================
// validateSdkProvider
// =============================================================================

describe('validateSdkProvider', () => {
  it('returns null for anthropic', () => {
    expect(validateSdkProvider('anthropic')).toBeNull();
  });

  it('returns error message for openai', () => {
    const result = validateSdkProvider('openai');
    expect(result).not.toBeNull();
    expect(result).toContain('openai');
  });

  it('returns error message for azure', () => {
    const result = validateSdkProvider('azure');
    expect(result).not.toBeNull();
    expect(result).toContain('azure');
  });

  it('returns error message for google', () => {
    const result = validateSdkProvider('google');
    expect(result).not.toBeNull();
  });
});

// =============================================================================
// getStepConfigForHandler
// =============================================================================

describe('getStepConfigForHandler', () => {
  const plannerConfig: ResolvedStepConfig = {
    model: 'model-p', maxTokens: 1000, temperature: 0.3, backend: 'raw', budgets: {},
  };
  const reviewerPlanConfig: ResolvedStepConfig = {
    model: 'model-rp', maxTokens: 2000, temperature: 0.2, backend: 'raw', budgets: {},
  };
  const implementerConfig: ResolvedStepConfig = {
    model: 'model-i', maxTokens: 3000, temperature: 0.2, backend: 'agent_sdk', budgets: {},
  };
  const reviewerCodeConfig: ResolvedStepConfig = {
    model: 'model-rc', maxTokens: 4000, temperature: 0.2, backend: 'raw', budgets: {},
  };

  const config: ResolvedWorkflowConfig = {
    planner: plannerConfig,
    reviewerPlan: reviewerPlanConfig,
    implementer: implementerConfig,
    reviewerCode: reviewerCodeConfig,
  };

  it('planner returns config.planner', () => {
    expect(getStepConfigForHandler(config, 'planner')).toBe(plannerConfig);
  });

  it('planReviewer returns config.reviewerPlan', () => {
    expect(getStepConfigForHandler(config, 'planReviewer')).toBe(reviewerPlanConfig);
  });

  it('implementer returns config.implementer', () => {
    expect(getStepConfigForHandler(config, 'implementer')).toBe(implementerConfig);
  });

  it('codeReviewer returns config.reviewerCode', () => {
    expect(getStepConfigForHandler(config, 'codeReviewer')).toBe(reviewerCodeConfig);
  });
});

// =============================================================================
// Integration: dispatch flow composition
// =============================================================================

describe('dispatch flow composition', () => {
  const rawConfig: ResolvedStepConfig = {
    model: 'model', maxTokens: 1000, temperature: 0.3, backend: 'raw', budgets: {},
  };
  const sdkConfig: ResolvedStepConfig = {
    model: 'model', maxTokens: 1000, temperature: 0.3, backend: 'agent_sdk', budgets: {},
  };

  it('raw backend needs no provider check', () => {
    const dispatch = resolveBackendDispatch(rawConfig);
    expect(dispatch.backend).toBe('raw');
    // No providerCheck field on raw dispatch
    expect('providerCheck' in dispatch).toBe(false);
  });

  it('agent_sdk + anthropic provider is valid', () => {
    const dispatch = resolveBackendDispatch(sdkConfig);
    expect(dispatch.backend).toBe('agent_sdk');
    if (dispatch.backend === 'agent_sdk') {
      expect(dispatch.providerCheck).toBe(true);
      expect(validateSdkProvider('anthropic')).toBeNull();
    }
  });

  it('agent_sdk + openai provider is invalid', () => {
    const dispatch = resolveBackendDispatch(sdkConfig);
    if (dispatch.backend === 'agent_sdk') {
      const error = validateSdkProvider('openai');
      expect(error).not.toBeNull();
    }
  });
});
