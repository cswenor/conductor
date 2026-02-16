/**
 * Tests for extractRetryAfterMs.
 *
 * Covers Headers-like API, plain Record, case-insensitive lookup,
 * edge cases (zero, negative, out-of-range, fractional, non-string).
 */

import { describe, it, expect } from 'vitest';
import { extractRetryAfterMs } from './retry-after.ts';

describe('extractRetryAfterMs', () => {
  it('returns undefined for non-object', () => {
    expect(extractRetryAfterMs(null)).toBeUndefined();
    expect(extractRetryAfterMs('string')).toBeUndefined();
    expect(extractRetryAfterMs(42)).toBeUndefined();
  });

  it('returns undefined for object without headers', () => {
    expect(extractRetryAfterMs({ status: 429 })).toBeUndefined();
  });

  it('extracts from Headers-like API', () => {
    const err = {
      status: 429,
      headers: {
        get(key: string): string | null {
          if (key === 'retry-after') return '30';
          return null;
        },
      },
    };
    expect(extractRetryAfterMs(err)).toBe(30000);
  });

  it('extracts from plain Record', () => {
    const err = {
      status: 429,
      headers: { 'retry-after': '5' },
    };
    expect(extractRetryAfterMs(err)).toBe(5000);
  });

  it('returns undefined for missing header', () => {
    const err = {
      status: 429,
      headers: { 'x-other': 'value' },
    };
    expect(extractRetryAfterMs(err)).toBeUndefined();
  });

  it('returns undefined for non-numeric values', () => {
    const err = {
      status: 429,
      headers: { 'retry-after': 'not-a-number' },
    };
    expect(extractRetryAfterMs(err)).toBeUndefined();
  });

  it('returns undefined for out-of-range values', () => {
    const err = {
      status: 429,
      headers: { 'retry-after': '5000' }, // > 3600
    };
    expect(extractRetryAfterMs(err)).toBeUndefined();
  });

  it('returns undefined for zero', () => {
    const err = {
      status: 429,
      headers: { 'retry-after': '0' },
    };
    expect(extractRetryAfterMs(err)).toBeUndefined();
  });

  it('returns undefined for negative values', () => {
    const err = {
      status: 429,
      headers: { 'retry-after': '-10' },
    };
    expect(extractRetryAfterMs(err)).toBeUndefined();
  });

  it('ceils fractional seconds', () => {
    const err = {
      status: 429,
      headers: { 'retry-after': '1.5' },
    };
    expect(extractRetryAfterMs(err)).toBe(1500);
  });

  it('extracts from capitalized Retry-After header', () => {
    const err = {
      status: 429,
      headers: { 'Retry-After': '10' },
    };
    expect(extractRetryAfterMs(err)).toBe(10000);
  });

  it('extracts from mixed-case ReTrY-AfTeR header', () => {
    const err = {
      status: 429,
      headers: { 'ReTrY-AfTeR': '5' },
    };
    expect(extractRetryAfterMs(err)).toBe(5000);
  });

  it('returns undefined for non-string value (number)', () => {
    const err = {
      status: 429,
      headers: { 'retry-after': 42 },
    };
    expect(extractRetryAfterMs(err)).toBeUndefined();
  });

  it('returns undefined for non-string value (boolean)', () => {
    const err = {
      status: 429,
      headers: { 'retry-after': true },
    };
    expect(extractRetryAfterMs(err)).toBeUndefined();
  });
});
