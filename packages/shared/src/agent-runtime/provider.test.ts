/**
 * Agent Invocation Framework Tests
 *
 * Tests provider factory, error classes, and executeAgent flow.
 * API calls are NOT tested here (mocked via vitest).
 */

import { describe, it, expect } from 'vitest';
import {
  createProvider,
  AgentError,
  AgentAuthError,
  AgentRateLimitError,
  AgentContextLengthError,
  AgentUnsupportedProviderError,
  AgentTimeoutError,
  AnthropicProvider,
  getDefaultTimeout,
} from './provider.js';

describe('createProvider', () => {
  it('creates AnthropicProvider for anthropic', () => {
    const provider = createProvider('anthropic', 'sk-ant-test123');
    expect(provider).toBeInstanceOf(AnthropicProvider);
  });

  it('throws AgentUnsupportedProviderError for openai', () => {
    expect(() => createProvider('openai', 'sk-test')).toThrow(AgentUnsupportedProviderError);
    expect(() => createProvider('openai', 'sk-test')).toThrow("Provider 'openai' is not yet supported");
  });

  it('throws AgentUnsupportedProviderError for google', () => {
    expect(() => createProvider('google', 'AIza-test')).toThrow(AgentUnsupportedProviderError);
  });

  it('throws AgentUnsupportedProviderError for mistral', () => {
    expect(() => createProvider('mistral', 'test-key')).toThrow(AgentUnsupportedProviderError);
  });
});

describe('error classes', () => {
  it('AgentError has correct code', () => {
    const err = new AgentError('test');
    expect(err.code).toBe('agent_error');
    expect(err.name).toBe('AgentError');
    expect(err).toBeInstanceOf(Error);
  });

  it('AgentAuthError has auth_error code', () => {
    const err = new AgentAuthError('bad key');
    expect(err.code).toBe('auth_error');
    expect(err.name).toBe('AgentAuthError');
    expect(err).toBeInstanceOf(AgentError);
  });

  it('AgentRateLimitError includes retryAfterMs', () => {
    const err = new AgentRateLimitError('rate limited', 5000);
    expect(err.code).toBe('rate_limit');
    expect(err.retryAfterMs).toBe(5000);
    expect(err).toBeInstanceOf(AgentError);
  });

  it('AgentContextLengthError has context_length code', () => {
    const err = new AgentContextLengthError('too long');
    expect(err.code).toBe('context_length');
    expect(err).toBeInstanceOf(AgentError);
  });

  it('AgentUnsupportedProviderError has unsupported_provider code', () => {
    const err = new AgentUnsupportedProviderError('cohere');
    expect(err.code).toBe('unsupported_provider');
    expect(err.message).toContain('cohere');
    expect(err.message).toContain('not yet supported');
  });

  it('AgentTimeoutError includes timeout details', () => {
    const err = new AgentTimeoutError(300000, 'planner', 'create_plan');
    expect(err.code).toBe('timeout');
    expect(err.timeoutMs).toBe(300000);
    expect(err.agent).toBe('planner');
    expect(err.action).toBe('create_plan');
    expect(err.message).toContain('300s');
    expect(err).toBeInstanceOf(AgentError);
  });
});

describe('getDefaultTimeout', () => {
  it('returns 300s for planner', () => {
    expect(getDefaultTimeout('planner')).toBe(300_000);
  });

  it('returns 180s for reviewer', () => {
    expect(getDefaultTimeout('reviewer')).toBe(180_000);
  });

  it('returns 600s for implementer', () => {
    expect(getDefaultTimeout('implementer')).toBe(600_000);
  });

  it('returns default for unknown agent', () => {
    expect(getDefaultTimeout('custom_agent')).toBe(300_000);
  });
});
