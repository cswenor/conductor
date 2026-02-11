import { describe, it, expect } from 'vitest';
import { getActionLabel, getEventSummary } from './run-detail-helpers';

describe('getActionLabel', () => {
  it('returns mapped labels for known actions', () => {
    expect(getActionLabel('create_plan')).toBe('Planning');
    expect(getActionLabel('review_plan')).toBe('Plan Review');
    expect(getActionLabel('apply_changes')).toBe('Implementation');
    expect(getActionLabel('run_tests')).toBe('Test Execution');
  });

  it('title-cases unknown actions', () => {
    expect(getActionLabel('deploy_staging')).toBe('Deploy Staging');
    expect(getActionLabel('custom_action')).toBe('Custom Action');
  });

  it('handles single-word action', () => {
    expect(getActionLabel('deploy')).toBe('Deploy');
  });
});

describe('getEventSummary', () => {
  it('formats phase.transitioned events', () => {
    const event = {
      type: 'phase.transitioned',
      payload: { from: 'pending', to: 'planning' },
    };
    expect(getEventSummary(event)).toBe('pending → planning');
  });

  it('uses ? for missing from/to in phase transitions', () => {
    expect(getEventSummary({ type: 'phase.transitioned', payload: {} })).toBe('? → ?');
    expect(getEventSummary({ type: 'phase.transitioned', payload: { from: 'a' } })).toBe('a → ?');
    expect(getEventSummary({ type: 'phase.transitioned', payload: { to: 'b' } })).toBe('? → b');
  });

  it('uses ? for non-string from/to values', () => {
    expect(getEventSummary({ type: 'phase.transitioned', payload: { from: 42, to: true } })).toBe('? → ?');
  });

  it('returns error message for agent.failed events', () => {
    const event = {
      type: 'agent.failed',
      payload: { errorMessage: 'API rate limit exceeded' },
    };
    expect(getEventSummary(event)).toBe('API rate limit exceeded');
  });

  it('falls back to error_message for agent.failed events', () => {
    const event = {
      type: 'agent.failed',
      payload: { error_message: 'Fallback message' },
    };
    expect(getEventSummary(event)).toBe('Fallback message');
  });

  it('returns — for agent.failed with no error fields', () => {
    expect(getEventSummary({ type: 'agent.failed', payload: {} })).toBe('—');
  });

  it('formats agent.started events with agent and action label', () => {
    const event = {
      type: 'agent.started',
      payload: { agent: 'planner', action: 'create_plan' },
    };
    expect(getEventSummary(event)).toBe('planner: Planning');
  });

  it('formats agent.completed events with agent and action label', () => {
    const event = {
      type: 'agent.completed',
      payload: { agent: 'implementer', action: 'apply_changes' },
    };
    expect(getEventSummary(event)).toBe('implementer: Implementation');
  });

  it('returns agent name only when action is missing', () => {
    const event = {
      type: 'agent.started',
      payload: { agent: 'planner' },
    };
    expect(getEventSummary(event)).toBe('planner');
  });

  it('returns — for unknown event types', () => {
    expect(getEventSummary({ type: 'run.created', payload: {} })).toBe('—');
    expect(getEventSummary({ type: 'webhook.received', payload: { data: 'test' } })).toBe('—');
  });

  it('returns — when payload throws during access', () => {
    const event = {
      type: 'phase.transitioned',
      payload: new Proxy({}, {
        get() { throw new Error('boom'); },
      }),
    };
    expect(getEventSummary(event)).toBe('—');
  });
});
