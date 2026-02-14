import { describe, it, expect } from 'vitest';
import {
  getGateLabel,
  getGateStatusLabel,
  getInvocationStatusLabel,
  getOperatorActionLabel,
  getBlockedReasonLabel,
} from './labels';

describe('labels', () => {
  // -------------------------------------------------------------------------
  // getGateLabel
  // -------------------------------------------------------------------------

  describe('getGateLabel', () => {
    it.each([
      ['plan_approval', 'Plan Approval'],
      ['tests_pass', 'Tests'],
      ['code_review', 'Code Review'],
      ['merge_wait', 'Merge'],
    ])('%s → %s', (gateId, expected) => {
      expect(getGateLabel(gateId)).toBe(expected);
    });

    it('unknown gateId falls back to title-cased', () => {
      expect(getGateLabel('custom_gate')).toBe('Custom Gate');
    });

    it('single-word unknown gateId', () => {
      expect(getGateLabel('security')).toBe('Security');
    });
  });

  // -------------------------------------------------------------------------
  // getGateStatusLabel
  // -------------------------------------------------------------------------

  describe('getGateStatusLabel', () => {
    it.each([
      ['passed', 'Passed'],
      ['failed', 'Failed'],
      ['pending', 'Pending'],
    ])('%s → %s', (status, expected) => {
      expect(getGateStatusLabel(status)).toBe(expected);
    });

    it('unknown status falls back to title-cased', () => {
      expect(getGateStatusLabel('skipped')).toBe('Skipped');
    });
  });

  // -------------------------------------------------------------------------
  // getInvocationStatusLabel
  // -------------------------------------------------------------------------

  describe('getInvocationStatusLabel', () => {
    it.each([
      ['failed', 'Failed'],
      ['timed_out', 'Timed Out'],
      ['pending', 'Pending'],
      ['running', 'Running'],
      ['completed', 'Completed'],
    ])('%s → %s', (status, expected) => {
      expect(getInvocationStatusLabel(status)).toBe(expected);
    });

    it('unknown status falls back to title-cased', () => {
      expect(getInvocationStatusLabel('cancelled')).toBe('Cancelled');
    });
  });

  // -------------------------------------------------------------------------
  // getOperatorActionLabel
  // -------------------------------------------------------------------------

  describe('getOperatorActionLabel', () => {
    it.each([
      ['start_run', 'Started run'],
      ['approve_plan', 'Plan approved'],
      ['revise_plan', 'Revision requested'],
      ['reject_run', 'Run rejected'],
      ['retry', 'Run retried'],
      ['pause', 'Run paused'],
      ['resume', 'Run resumed'],
      ['cancel', 'Run cancelled'],
      ['grant_policy_exception', 'Policy exception granted'],
      ['deny_policy_exception', 'Policy exception denied'],
    ])('%s → %s', (action, expected) => {
      expect(getOperatorActionLabel(action)).toBe(expected);
    });

    it('unknown action falls back to title-cased', () => {
      expect(getOperatorActionLabel('custom_action')).toBe('Custom Action');
    });

    // Cross-domain: agent action strings should get a reasonable fallback
    it('agent action create_plan gets fallback, not a misleading hit', () => {
      expect(getOperatorActionLabel('create_plan')).toBe('Create Plan');
    });

    it('agent action apply_changes gets fallback', () => {
      expect(getOperatorActionLabel('apply_changes')).toBe('Apply Changes');
    });
  });

  // -------------------------------------------------------------------------
  // getBlockedReasonLabel
  // -------------------------------------------------------------------------

  describe('getBlockedReasonLabel', () => {
    it.each([
      ['gate_failed', 'A required gate failed'],
      ['policy_exception_required', 'A policy exception is required'],
      ['retry_limit_exceeded', 'Revision limit exceeded'],
      ['enqueue_failed', 'Failed to start run'],
    ])('%s → %s', (reason, expected) => {
      expect(getBlockedReasonLabel(reason)).toBe(expected);
    });

    it('unknown reason falls back to humanized', () => {
      expect(getBlockedReasonLabel('some_new_reason')).toBe('Some new reason');
    });

    it('single-word unknown reason', () => {
      expect(getBlockedReasonLabel('timeout')).toBe('Timeout');
    });
  });
});
