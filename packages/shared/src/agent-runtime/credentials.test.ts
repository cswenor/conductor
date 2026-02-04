import { describe, it, expect } from 'vitest';
import { getStepCredentialRequirement } from './credentials.js';
import type { RunStep } from '../types/index.js';

describe('getStepCredentialRequirement', () => {
  it('returns ai_provider mode with anthropic for planner step', () => {
    const req = getStepCredentialRequirement('planner_create_plan');
    expect(req.mode).toBe('ai_provider');
    expect(req.provider).toBe('anthropic');
  });

  it('returns ai_provider mode for reviewer_review_plan step', () => {
    const req = getStepCredentialRequirement('reviewer_review_plan');
    expect(req.mode).toBe('ai_provider');
    expect(req.provider).toBe('anthropic');
  });

  it('returns ai_provider mode for implementer step', () => {
    const req = getStepCredentialRequirement('implementer_apply_changes');
    expect(req.mode).toBe('ai_provider');
    expect(req.provider).toBe('anthropic');
  });

  it('returns ai_provider mode for reviewer_review_code step', () => {
    const req = getStepCredentialRequirement('reviewer_review_code');
    expect(req.mode).toBe('ai_provider');
    expect(req.provider).toBe('anthropic');
  });

  it('returns github_installation mode for setup_worktree step', () => {
    const req = getStepCredentialRequirement('setup_worktree');
    expect(req.mode).toBe('github_installation');
    expect(req.provider).toBeUndefined();
  });

  it('returns github_installation mode for create_pr step', () => {
    const req = getStepCredentialRequirement('create_pr');
    expect(req.mode).toBe('github_installation');
    expect(req.provider).toBeUndefined();
  });

  it('returns none mode for route step', () => {
    const req = getStepCredentialRequirement('route');
    expect(req.mode).toBe('none');
    expect(req.provider).toBeUndefined();
  });

  it('returns none mode for wait_plan_approval step', () => {
    const req = getStepCredentialRequirement('wait_plan_approval');
    expect(req.mode).toBe('none');
  });

  it('returns none mode for tester_run_tests step', () => {
    const req = getStepCredentialRequirement('tester_run_tests');
    expect(req.mode).toBe('none');
  });

  it('returns none mode for wait_pr_merge step', () => {
    const req = getStepCredentialRequirement('wait_pr_merge');
    expect(req.mode).toBe('none');
  });

  it('returns none mode for cleanup step', () => {
    const req = getStepCredentialRequirement('cleanup');
    expect(req.mode).toBe('none');
  });

  it('covers all RunStep values', () => {
    const allSteps: RunStep[] = [
      'setup_worktree',
      'route',
      'planner_create_plan',
      'reviewer_review_plan',
      'wait_plan_approval',
      'implementer_apply_changes',
      'tester_run_tests',
      'reviewer_review_code',
      'create_pr',
      'wait_pr_merge',
      'cleanup',
    ];

    for (const step of allSteps) {
      const req = getStepCredentialRequirement(step);
      expect(req).toBeDefined();
      expect(req.step).toBe(step);
      expect(['none', 'ai_provider', 'github_installation']).toContain(req.mode);
    }
  });
});
