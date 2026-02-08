/**
 * Reviewer Agent Tests
 *
 * Tests verdict parsing. Agent invocation tested via integration (requires mocks).
 */

import { describe, it, expect } from 'vitest';
import { parseVerdict } from './reviewer.ts';

describe('parseVerdict', () => {
  it('parses APPROVED on first line', () => {
    expect(parseVerdict('APPROVED\n\nThe plan looks great.')).toBe(true);
  });

  it('parses APPROVED with extra text on first line', () => {
    expect(parseVerdict('APPROVED — The plan is ready for implementation.\n\nDetails...')).toBe(true);
  });

  it('parses CHANGES_REQUESTED on first line', () => {
    expect(parseVerdict('CHANGES_REQUESTED\n\n### Issues\n- Missing error handling')).toBe(false);
  });

  it('parses CHANGES_REQUESTED with extra text', () => {
    expect(parseVerdict('CHANGES_REQUESTED — The plan needs revisions.\n\nFeedback...')).toBe(false);
  });

  it('finds APPROVED in first 200 chars when not on first line', () => {
    expect(parseVerdict('After reviewing...\n\nAPPROVED\n\nGood plan.')).toBe(true);
  });

  it('defaults to CHANGES_REQUESTED on ambiguous response', () => {
    expect(parseVerdict('The plan looks reasonable but has some issues.\n\n- Missing tests')).toBe(false);
  });

  it('defaults to CHANGES_REQUESTED when both keywords present', () => {
    expect(parseVerdict('CHANGES_REQUESTED\n\nThis is not APPROVED yet.')).toBe(false);
  });

  it('is case-insensitive for first line detection', () => {
    expect(parseVerdict('approved\nLooks good.')).toBe(true);
    expect(parseVerdict('changes_requested\nNeeds work.')).toBe(false);
  });

  it('handles empty string', () => {
    expect(parseVerdict('')).toBe(false);
  });
});
