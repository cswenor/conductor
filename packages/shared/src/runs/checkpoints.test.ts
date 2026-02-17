/**
 * Checkpoint Registry Tests
 */

import { describe, it, expect } from 'vitest';
import { resolveCheckpoint, CHECKPOINT_REGISTRY } from './checkpoints.ts';
import { isValidContextMode } from '../types/index.ts';

describe('resolveCheckpoint', () => {
  it('resolves planning:start to planner_create_plan / planning', () => {
    const target = resolveCheckpoint('planning:start');
    expect(target).not.toBeNull();
    expect(target?.step).toBe('planner_create_plan');
    expect(target?.phase).toBe('planning');
    expect(target?.rewindable).toBe(true);
  });

  it('resolves awaiting_plan_approval to wait_plan_approval / awaiting_plan_approval', () => {
    const target = resolveCheckpoint('awaiting_plan_approval');
    expect(target).not.toBeNull();
    expect(target?.step).toBe('wait_plan_approval');
    expect(target?.phase).toBe('awaiting_plan_approval');
    expect(target?.rewindable).toBe(true);
  });

  it('resolves executing:start to implementer_apply_changes / executing', () => {
    const target = resolveCheckpoint('executing:start');
    expect(target).not.toBeNull();
    expect(target?.step).toBe('implementer_apply_changes');
    expect(target?.phase).toBe('executing');
    expect(target?.rewindable).toBe(true);
  });

  it('resolves awaiting_review to reviewer_review_code / awaiting_review', () => {
    const target = resolveCheckpoint('awaiting_review');
    expect(target).not.toBeNull();
    expect(target?.step).toBe('reviewer_review_code');
    expect(target?.phase).toBe('awaiting_review');
    expect(target?.rewindable).toBe(true);
  });

  it('returns null for completed (non-rewindable)', () => {
    const target = resolveCheckpoint('completed');
    expect(target).toBeNull();
  });

  it('returns null for unknown checkpoint strings', () => {
    expect(resolveCheckpoint('garbage')).toBeNull();
    expect(resolveCheckpoint('')).toBeNull();
    expect(resolveCheckpoint('planning:end')).toBeNull();
  });

  it('registry has completed entry with rewindable: false', () => {
    const entry = CHECKPOINT_REGISTRY['completed'];
    expect(entry).toBeDefined();
    expect(entry.rewindable).toBe(false);
    expect(entry.step).toBe('cleanup');
  });
});

describe('isValidContextMode', () => {
  it('accepts preserve', () => {
    expect(isValidContextMode('preserve')).toBe(true);
  });

  it('accepts truncate', () => {
    expect(isValidContextMode('truncate')).toBe(true);
  });

  it('rejects invalid strings', () => {
    expect(isValidContextMode('invalid')).toBe(false);
    expect(isValidContextMode('')).toBe(false);
    expect(isValidContextMode('PRESERVE')).toBe(false);
  });
});
