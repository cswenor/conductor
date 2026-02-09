import { describe, it, expect } from 'vitest';
import { redactContent } from './redact-content.ts';

describe('redactContent', () => {
  it('preserves non-secret content', () => {
    const input = 'Hello world\nThis is a normal plan\nNo secrets here';
    expect(redactContent(input)).toBe(input);
  });

  it('redacts PEM private key blocks (pass 1)', () => {
    const input = [
      'Some text before',
      '-----BEGIN RSA PRIVATE KEY-----',
      'MIIEpAIBAAKCAQEA0Z3VS5JJcds3xfn/ygWyF8PbnGPo',
      'SomeMoreBase64Data==',
      '-----END RSA PRIVATE KEY-----',
      'Some text after',
    ].join('\n');

    const result = redactContent(input);
    expect(result).toContain('Some text before');
    expect(result).toContain('[REDACTED]');
    expect(result).toContain('Some text after');
    expect(result).not.toContain('MIIEpAIBAAKCAQEA0Z3VS5JJcds3xfn');
    expect(result).not.toContain('BEGIN RSA PRIVATE KEY');
  });

  it('redacts generic private key blocks', () => {
    const input = [
      '-----BEGIN PRIVATE KEY-----',
      'MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEA',
      '-----END PRIVATE KEY-----',
    ].join('\n');

    const result = redactContent(input);
    expect(result).toBe('[REDACTED]');
  });

  it('redacts EC private key blocks', () => {
    const input = [
      '-----BEGIN EC PRIVATE KEY-----',
      'MHQCAQEEIIosLE+VGCRbB11xFIkInWM=',
      '-----END EC PRIVATE KEY-----',
    ].join('\n');

    const result = redactContent(input);
    expect(result).toBe('[REDACTED]');
  });

  it('redacts GitHub tokens (pass 2)', () => {
    const input = 'Token: ghp_1234567890abcdefghijklmnopqrstuvwxyz12';
    const result = redactContent(input);
    expect(result).toBe('[REDACTED]');
  });

  it('redacts JWTs (pass 2)', () => {
    const input = 'Authorization: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
    const result = redactContent(input);
    expect(result).toBe('[REDACTED]');
  });

  it('redacts database connection strings (pass 2)', () => {
    const input = 'DB_URL=postgres://admin:secretpass@db.example.com:5432/mydb';
    const result = redactContent(input);
    expect(result).toBe('[REDACTED]');
  });

  it('handles mixed content with secrets and non-secrets', () => {
    const input = [
      '## Plan',
      '',
      '1. Fetch data from API',
      '2. Use token ghp_1234567890abcdefghijklmnopqrstuvwxyz12',
      '3. Store in database',
      '',
      'End of plan',
    ].join('\n');

    const result = redactContent(input);
    expect(result).toContain('## Plan');
    expect(result).toContain('1. Fetch data from API');
    expect(result).not.toContain('ghp_1234567890');
    expect(result).toContain('3. Store in database');
    expect(result).toContain('End of plan');
  });

  it('handles multiple PEM blocks in same content', () => {
    const input = [
      '-----BEGIN RSA PRIVATE KEY-----',
      'key1data',
      '-----END RSA PRIVATE KEY-----',
      'middle text',
      '-----BEGIN EC PRIVATE KEY-----',
      'key2data',
      '-----END EC PRIVATE KEY-----',
    ].join('\n');

    const result = redactContent(input);
    expect(result).toBe('[REDACTED]\nmiddle text\n[REDACTED]');
  });

  it('preserves empty lines', () => {
    const input = 'line 1\n\nline 3\n\nline 5';
    expect(redactContent(input)).toBe(input);
  });

  it('handles empty string', () => {
    expect(redactContent('')).toBe('');
  });

  it('redacts AWS access keys (pass 2)', () => {
    const input = 'AWS key: AKIAIOSFODNN7EXAMPLE';
    const result = redactContent(input);
    expect(result).toBe('[REDACTED]');
  });

  it('redacts generic secret assignments (pass 2)', () => {
    const input = 'password="my_super_secret_value_here"';
    const result = redactContent(input);
    expect(result).toBe('[REDACTED]');
  });
});
