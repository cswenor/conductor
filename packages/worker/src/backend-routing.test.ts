/**
 * Backend routing tests — provider validation used by worker handlers.
 */

import { describe, it, expect } from 'vitest';
import { validateProviderForBackend } from './backend-routing.ts';

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

  it('includes step label in error message', () => {
    const err = validateProviderForBackend('agent_sdk', 'openai', 'Code reviewer');
    expect(err).toContain('Code reviewer');
  });
});
