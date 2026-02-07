import { describe, it, expect } from 'vitest';
import {
  phaseConfig,
  getPhaseLabel,
  getPhaseVariant,
  getWorkTab,
  workTabPhases,
  formatDuration,
} from './phase-config';

describe('phaseConfig', () => {
  it('has entries for all 8 RunPhase values', () => {
    const phases = [
      'pending', 'planning', 'awaiting_plan_approval', 'executing',
      'awaiting_review', 'blocked', 'completed', 'cancelled',
    ];
    for (const phase of phases) {
      expect(phaseConfig[phase as keyof typeof phaseConfig]).toBeDefined();
    }
    expect(Object.keys(phaseConfig)).toHaveLength(8);
  });

  it('uses correct variants for terminal and blocked phases', () => {
    expect(phaseConfig.completed.variant).toBe('success');
    expect(phaseConfig.blocked.variant).toBe('destructive');
    expect(phaseConfig.cancelled.variant).toBe('secondary');
  });
});

describe('getPhaseLabel', () => {
  it('returns mapped labels for known phases', () => {
    expect(getPhaseLabel('pending')).toBe('Pending');
    expect(getPhaseLabel('awaiting_plan_approval')).toBe('Awaiting Approval');
    expect(getPhaseLabel('awaiting_review')).toBe('Awaiting Review');
    expect(getPhaseLabel('executing')).toBe('Executing');
    expect(getPhaseLabel('completed')).toBe('Completed');
  });

  it('returns raw string for unknown phases', () => {
    expect(getPhaseLabel('unknown_phase')).toBe('unknown_phase');
  });
});

describe('getPhaseVariant', () => {
  it('returns correct variants', () => {
    expect(getPhaseVariant('blocked')).toBe('destructive');
    expect(getPhaseVariant('completed')).toBe('success');
    expect(getPhaseVariant('pending')).toBe('secondary');
  });

  it('falls back to secondary for unknown phases', () => {
    expect(getPhaseVariant('something_new')).toBe('secondary');
  });
});

describe('getWorkTab', () => {
  it('maps queued phases', () => {
    expect(getWorkTab('pending')).toBe('queued');
  });

  it('maps active phases', () => {
    expect(getWorkTab('planning')).toBe('active');
    expect(getWorkTab('executing')).toBe('active');
    expect(getWorkTab('awaiting_review')).toBe('active');
  });

  it('maps blocked phases', () => {
    expect(getWorkTab('awaiting_plan_approval')).toBe('blocked');
    expect(getWorkTab('blocked')).toBe('blocked');
  });

  it('maps completed phases', () => {
    expect(getWorkTab('completed')).toBe('completed');
    expect(getWorkTab('cancelled')).toBe('completed');
  });

  it('treats paused runs as blocked regardless of phase', () => {
    expect(getWorkTab('executing', 'paused')).toBe('blocked');
    expect(getWorkTab('planning', 'paused')).toBe('blocked');
    expect(getWorkTab('pending', 'paused')).toBe('blocked');
  });

  it('does not treat non-paused status as blocked override', () => {
    expect(getWorkTab('executing', 'active')).toBe('active');
    expect(getWorkTab('pending', 'active')).toBe('queued');
  });

  it('defaults unknown phases to active', () => {
    expect(getWorkTab('something_new')).toBe('active');
  });
});

describe('workTabPhases', () => {
  it('covers all non-paused phases across tabs', () => {
    const allPhases = Object.values(workTabPhases).flat();
    const expected = [
      'pending', 'planning', 'awaiting_plan_approval', 'executing',
      'awaiting_review', 'blocked', 'completed', 'cancelled',
    ];
    for (const phase of expected) {
      expect(allPhases).toContain(phase);
    }
  });

  it('has no duplicate phases across tabs', () => {
    const allPhases = Object.values(workTabPhases).flat();
    expect(new Set(allPhases).size).toBe(allPhases.length);
  });
});

describe('formatDuration', () => {
  it('formats seconds', () => {
    expect(formatDuration(0)).toBe('0s');
    expect(formatDuration(5_000)).toBe('5s');
    expect(formatDuration(30_000)).toBe('30s');
    expect(formatDuration(59_000)).toBe('59s');
  });

  it('formats minutes', () => {
    expect(formatDuration(60_000)).toBe('1m');
    expect(formatDuration(720_000)).toBe('12m');
    expect(formatDuration(3_540_000)).toBe('59m');
  });

  it('formats hours with remaining minutes', () => {
    expect(formatDuration(3_600_000)).toBe('1h');
    expect(formatDuration(5_400_000)).toBe('1h 30m');
    expect(formatDuration(7_200_000)).toBe('2h');
  });

  it('formats days with remaining hours', () => {
    expect(formatDuration(86_400_000)).toBe('1d');
    expect(formatDuration(172_800_000)).toBe('2d');
    expect(formatDuration(90_000_000)).toBe('1d 1h');
  });

  it('handles negative values', () => {
    expect(formatDuration(-1000)).toBe('0s');
  });
});
