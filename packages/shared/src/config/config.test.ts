import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  getEnv,
  validateRedisUrl,
  validateNumber,
  validateBoolean,
  validatePath,
  parseBoolean,
} from './index.ts';

describe('validateRedisUrl', () => {
  it('should accept valid redis:// URLs', () => {
    const result = validateRedisUrl('redis://localhost:6379');
    expect(result.valid).toBe(true);
  });

  it('should accept valid rediss:// URLs', () => {
    const result = validateRedisUrl('rediss://localhost:6379');
    expect(result.valid).toBe(true);
  });

  it('should reject non-redis URLs', () => {
    const result = validateRedisUrl('http://localhost:6379');
    expect(result.valid).toBe(false);
    expect(result.error).toContain('redis://');
  });

  it('should reject invalid URLs', () => {
    const result = validateRedisUrl('not-a-url');
    expect(result.valid).toBe(false);
  });
});

describe('validateNumber', () => {
  it('should accept valid integers', () => {
    const result = validateNumber('42');
    expect(result.valid).toBe(true);
  });

  it('should reject non-numeric strings', () => {
    const result = validateNumber('abc');
    expect(result.valid).toBe(false);
  });

  it('should enforce minimum value', () => {
    const result = validateNumber('5', { min: 10 });
    expect(result.valid).toBe(false);
    expect(result.error).toContain('minimum');
  });

  it('should enforce maximum value', () => {
    const result = validateNumber('100', { max: 50 });
    expect(result.valid).toBe(false);
    expect(result.error).toContain('maximum');
  });

  it('should accept values within range', () => {
    const result = validateNumber('25', { min: 10, max: 50 });
    expect(result.valid).toBe(true);
  });
});

describe('validateBoolean', () => {
  it('should accept "true"', () => {
    expect(validateBoolean('true').valid).toBe(true);
  });

  it('should accept "false"', () => {
    expect(validateBoolean('false').valid).toBe(true);
  });

  it('should accept "1" and "0"', () => {
    expect(validateBoolean('1').valid).toBe(true);
    expect(validateBoolean('0').valid).toBe(true);
  });

  it('should accept "yes" and "no"', () => {
    expect(validateBoolean('yes').valid).toBe(true);
    expect(validateBoolean('no').valid).toBe(true);
  });

  it('should reject invalid values', () => {
    expect(validateBoolean('maybe').valid).toBe(false);
  });
});

describe('validatePath', () => {
  it('should accept valid paths', () => {
    expect(validatePath('./data/db.sqlite').valid).toBe(true);
    expect(validatePath('/absolute/path').valid).toBe(true);
  });

  it('should reject empty paths', () => {
    expect(validatePath('').valid).toBe(false);
  });

  it('should reject paths with null bytes', () => {
    expect(validatePath('/path/with\0null').valid).toBe(false);
  });
});

describe('parseBoolean', () => {
  it('should parse truthy values', () => {
    expect(parseBoolean('true')).toBe(true);
    expect(parseBoolean('TRUE')).toBe(true);
    expect(parseBoolean('1')).toBe(true);
    expect(parseBoolean('yes')).toBe(true);
  });

  it('should parse falsy values', () => {
    expect(parseBoolean('false')).toBe(false);
    expect(parseBoolean('FALSE')).toBe(false);
    expect(parseBoolean('0')).toBe(false);
    expect(parseBoolean('no')).toBe(false);
  });
});

describe('getEnv', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('should return environment variable value', () => {
    process.env['TEST_VAR'] = 'test_value';
    const result = getEnv({
      name: 'TEST_VAR',
      type: 'string',
      required: true,
    });
    expect(result).toBe('test_value');
  });

  it('should return default value when env var is missing', () => {
    delete process.env['MISSING_VAR'];
    const result = getEnv({
      name: 'MISSING_VAR',
      type: 'string',
      required: false,
      default: 'default_value',
    });
    expect(result).toBe('default_value');
  });

  it('should throw for missing required variable', () => {
    delete process.env['REQUIRED_VAR'];
    expect(() =>
      getEnv({
        name: 'REQUIRED_VAR',
        type: 'string',
        required: true,
      })
    ).toThrow('Missing required environment variable');
  });

  it('should validate URL type', () => {
    process.env['URL_VAR'] = 'not-a-url';
    expect(() =>
      getEnv({
        name: 'URL_VAR',
        type: 'url',
        required: true,
      })
    ).toThrow('Invalid');
  });

  it('should validate number type', () => {
    process.env['NUM_VAR'] = 'not-a-number';
    expect(() =>
      getEnv({
        name: 'NUM_VAR',
        type: 'number',
        required: true,
      })
    ).toThrow('Invalid');
  });

  it('should apply custom validation', () => {
    process.env['CUSTOM_VAR'] = 'invalid';
    expect(() =>
      getEnv({
        name: 'CUSTOM_VAR',
        type: 'string',
        required: true,
        validate: () => ({ valid: false, error: 'Custom error' }),
      })
    ).toThrow('Custom error');
  });
});
