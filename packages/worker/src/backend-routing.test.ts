/**
 * Backend routing tests — pure helpers for worker handler decisions.
 */

import { describe, it, expect } from 'vitest';
import { getStepConfig, validateProviderForBackend, requiresSdkCredentials } from './backend-routing.ts';
import type { ResolvedWorkflowConfig } from '@conductor/shared';

// ---- Helpers ----

function makeConfig(overrides?: Partial<Record<keyof ResolvedWorkflowConfig, { backend: 'raw' | 'agent_sdk' }>>): ResolvedWorkflowConfig {
  const base = {
    model: 'claude-sonnet-4-20250514',
    maxTokens: 8192,
    temperature: 0.2,
    backend: 'raw' as const,
    toolProfile: 'inspect',
    budgets: {},
  };
  return {
    planner: { ...base, toolProfile: 'inspect', ...overrides?.planner },
    reviewerPlan: { ...base, maxTokens: 4096, toolProfile: 'inspect', ...overrides?.reviewerPlan },
    implementer: { ...base, toolProfile: 'full', ...overrides?.implementer },
    reviewerCode: { ...base, maxTokens: 4096, toolProfile: 'inspect', ...overrides?.reviewerCode },
  };
}

// ---- Tests ----

describe('getStepConfig', () => {
  it('returns planner config for planner handler', () => {
    const config = makeConfig({ planner: { backend: 'agent_sdk' } });
    expect(getStepConfig(config, 'planner').backend).toBe('agent_sdk');
  });

  it('returns reviewerPlan config for planReviewer handler', () => {
    const config = makeConfig({ reviewerPlan: { backend: 'agent_sdk' } });
    expect(getStepConfig(config, 'planReviewer').backend).toBe('agent_sdk');
  });

  it('returns implementer config for implementer handler', () => {
    const config = makeConfig({ implementer: { backend: 'agent_sdk' } });
    expect(getStepConfig(config, 'implementer').backend).toBe('agent_sdk');
  });

  it('returns reviewerCode config for codeReviewer handler', () => {
    const config = makeConfig({ reviewerCode: { backend: 'agent_sdk' } });
    expect(getStepConfig(config, 'codeReviewer').backend).toBe('agent_sdk');
  });

  it('returns raw when no override', () => {
    const config = makeConfig();
    expect(getStepConfig(config, 'planner').backend).toBe('raw');
  });
});

describe('validateProviderForBackend', () => {
  it('returns null for anthropic with agent_sdk', () => {
    expect(validateProviderForBackend('agent_sdk', 'anthropic', 'Planner')).toBeNull();
  });

  it('returns error for openai with agent_sdk', () => {
    const err = validateProviderForBackend('agent_sdk', 'openai', 'Planner');
    expect(err).not.toBeNull();
    expect(err).toContain('Anthropic');
    expect(err).toContain('openai');
    expect(err).toContain('Planner');
  });

  it('returns error for azure with agent_sdk', () => {
    const err = validateProviderForBackend('agent_sdk', 'azure', 'Code reviewer');
    expect(err).not.toBeNull();
    expect(err).toContain('azure');
  });

  it('returns null for any provider with raw backend', () => {
    expect(validateProviderForBackend('raw', 'openai', 'Planner')).toBeNull();
    expect(validateProviderForBackend('raw', 'azure', 'Implementer')).toBeNull();
    expect(validateProviderForBackend('raw', 'anthropic', 'Reviewer')).toBeNull();
  });
});

describe('requiresSdkCredentials', () => {
  it('returns true for agent_sdk', () => {
    expect(requiresSdkCredentials('agent_sdk')).toBe(true);
  });

  it('returns false for raw', () => {
    expect(requiresSdkCredentials('raw')).toBe(false);
  });
});

describe('end-to-end routing scenarios', () => {
  it('planner SDK + anthropic = valid', () => {
    const config = makeConfig({ planner: { backend: 'agent_sdk' } });
    const step = getStepConfig(config, 'planner');
    expect(requiresSdkCredentials(step.backend)).toBe(true);
    expect(validateProviderForBackend(step.backend, 'anthropic', 'Planner')).toBeNull();
  });

  it('planner SDK + openai = rejected', () => {
    const config = makeConfig({ planner: { backend: 'agent_sdk' } });
    const step = getStepConfig(config, 'planner');
    expect(requiresSdkCredentials(step.backend)).toBe(true);
    expect(validateProviderForBackend(step.backend, 'openai', 'Planner')).not.toBeNull();
  });

  it('planner raw = no provider check needed', () => {
    const config = makeConfig();
    const step = getStepConfig(config, 'planner');
    expect(requiresSdkCredentials(step.backend)).toBe(false);
    // Even with a non-anthropic provider, raw doesn't care
    expect(validateProviderForBackend(step.backend, 'openai', 'Planner')).toBeNull();
  });

  it('implementer SDK + anthropic = valid', () => {
    const config = makeConfig({ implementer: { backend: 'agent_sdk' } });
    const step = getStepConfig(config, 'implementer');
    expect(requiresSdkCredentials(step.backend)).toBe(true);
    expect(validateProviderForBackend(step.backend, 'anthropic', 'Implementer')).toBeNull();
  });

  it('code reviewer SDK + non-anthropic = rejected', () => {
    const config = makeConfig({ reviewerCode: { backend: 'agent_sdk' } });
    const step = getStepConfig(config, 'codeReviewer');
    expect(validateProviderForBackend(step.backend, 'openai', 'Code reviewer')).not.toBeNull();
  });
});
