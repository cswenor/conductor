import { describe, it, expect } from 'vitest';
import { redact, containsSecrets, detectSecrets } from './index';

describe('redact', () => {
  describe('field name redaction', () => {
    it('should redact password fields', () => {
      const result = redact({ password: 'secret123' });
      const parsed = JSON.parse(result.json) as Record<string, unknown>;
      expect(parsed['password']).toBe('[REDACTED]');
      expect(result.fieldsRemoved).toContain('password');
    });

    it('should redact various sensitive field names', () => {
      const input = {
        api_key: 'key123',
        apiKey: 'key456',
        'api-key': 'key789',
        token: 'tok123',
        secret: 'sec123',
        authorization: 'auth123',
      };
      const result = redact(input);
      const parsed = JSON.parse(result.json) as Record<string, unknown>;

      expect(parsed['api_key']).toBe('[REDACTED]');
      expect(parsed['apiKey']).toBe('[REDACTED]');
      expect(parsed['api-key']).toBe('[REDACTED]');
      expect(parsed['token']).toBe('[REDACTED]');
      expect(parsed['secret']).toBe('[REDACTED]');
      expect(parsed['authorization']).toBe('[REDACTED]');
    });

    it('should preserve non-sensitive fields', () => {
      const input = {
        username: 'john',
        email: 'john@example.com',
        id: 123,
      };
      const result = redact(input);
      const parsed = JSON.parse(result.json) as Record<string, unknown>;

      expect(parsed['username']).toBe('john');
      expect(parsed['email']).toBe('john@example.com');
      expect(parsed['id']).toBe(123);
      expect(result.fieldsRemoved).toHaveLength(0);
    });

    it('should handle nested objects', () => {
      const input = {
        user: {
          name: 'john',
          config: {
            password: 'secret',
          },
        },
      };
      const result = redact(input);
      const parsed = JSON.parse(result.json) as Record<string, Record<string, Record<string, unknown>>>;

      expect(parsed['user']['name']).toBe('john');
      expect(parsed['user']['config']['password']).toBe('[REDACTED]');
    });

    it('should handle arrays', () => {
      const input = {
        users: [
          { name: 'john', password: 'pass1' },
          { name: 'jane', password: 'pass2' },
        ],
      };
      const result = redact(input);
      const parsed = JSON.parse(result.json) as Record<string, Array<Record<string, unknown>>>;

      expect(parsed['users'][0]['name']).toBe('john');
      expect(parsed['users'][0]['password']).toBe('[REDACTED]');
      expect(parsed['users'][1]['password']).toBe('[REDACTED]');
    });
  });

  describe('secret pattern detection', () => {
    it('should detect GitHub PAT tokens', () => {
      const result = redact({ message: 'Use token ghp_abcdefghijklmnopqrstuvwxyz0123456789' });
      expect(result.secretsDetected).toBe(true);
      const parsed = JSON.parse(result.json) as Record<string, unknown>;
      expect(parsed['message']).toBe('[REDACTED]');
    });

    it('should detect AWS access keys', () => {
      const result = redact({ key: 'AKIAIOSFODNN7EXAMPLE' });
      expect(result.secretsDetected).toBe(true);
    });

    it('should detect JWT tokens', () => {
      // This is a real JWT format with sufficient length in each part
      const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
      const result = redact({ data: jwt });
      expect(result.secretsDetected).toBe(true);
    });

    it('should detect private key markers', () => {
      const result = redact({
        key: '-----BEGIN RSA PRIVATE KEY-----\nMIIE...\n-----END RSA PRIVATE KEY-----',
      });
      expect(result.secretsDetected).toBe(true);
    });

    it('should detect database URLs with credentials', () => {
      const result = redact({
        url: 'postgres://user:password123@localhost:5432/db',
      });
      expect(result.secretsDetected).toBe(true);
    });

    it('should detect OpenAI keys', () => {
      const result = redact({
        key: 'sk-abcdefghijklmnopqrstuvwxyz',
      });
      expect(result.secretsDetected).toBe(true);
    });

    it('should detect Anthropic keys', () => {
      const result = redact({
        key: 'sk-ant-abcdefghijklmnopqrstuvwxyz01234567890123',
      });
      expect(result.secretsDetected).toBe(true);
    });

    it('should not flag regular strings', () => {
      const result = redact({
        message: 'Hello, this is a normal message',
        code: 'function foo() { return bar; }',
      });
      expect(result.secretsDetected).toBe(false);
    });
  });

  describe('allowlist', () => {
    it('should not redact allowlisted fields', () => {
      const input = { password: 'secret', api_key: 'key123' };
      const result = redact(input, { allowlist: ['password'] });
      const parsed = JSON.parse(result.json) as Record<string, unknown>;

      expect(parsed['password']).toBe('secret');
      expect(parsed['api_key']).toBe('[REDACTED]');
    });
  });

  describe('additional sensitive fields', () => {
    it('should redact custom sensitive fields', () => {
      const input = { custom_secret: 'value', normal: 'data' };
      const result = redact(input, { additionalSensitiveFields: ['custom_secret'] });
      const parsed = JSON.parse(result.json) as Record<string, unknown>;

      expect(parsed['custom_secret']).toBe('[REDACTED]');
      expect(parsed['normal']).toBe('data');
    });
  });

  describe('max depth', () => {
    it('should respect max depth limit', () => {
      const deepObject = {
        level1: {
          level2: {
            level3: {
              level4: {
                level5: 'deep',
              },
            },
          },
        },
      };
      // With maxDepth=3: depth 0 (root), 1 (level1), 2 (level2), 3 (level3)
      // At depth 4 (level4), it exceeds maxDepth and gets redacted
      const result = redact(deepObject, { maxDepth: 3 });
      const parsed = JSON.parse(result.json) as Record<
        string,
        Record<string, Record<string, Record<string, unknown>>>
      >;

      expect(parsed['level1']['level2']['level3']['level4']).toBe('[REDACTED]');
    });
  });

  describe('hash computation', () => {
    it('should produce consistent hashes', () => {
      const input = { foo: 'bar', baz: 123 };
      const result1 = redact(input);
      const result2 = redact(input);

      expect(result1.payloadHash).toBe(result2.payloadHash);
    });

    it('should produce different hashes for different inputs', () => {
      const result1 = redact({ foo: 'bar' });
      const result2 = redact({ foo: 'baz' });

      expect(result1.payloadHash).not.toBe(result2.payloadHash);
    });

    it('should use correct hash scheme', () => {
      const result = redact({ test: true });
      expect(result.payloadHashScheme).toBe('sha256:cjson:v1');
    });
  });
});

describe('containsSecrets', () => {
  it('should return true for strings with secrets', () => {
    expect(containsSecrets('ghp_abcdefghijklmnopqrstuvwxyz0123456789')).toBe(true);
  });

  it('should return false for normal strings', () => {
    expect(containsSecrets('hello world')).toBe(false);
  });
});

describe('detectSecrets', () => {
  it('should return pattern names for detected secrets', () => {
    const patterns = detectSecrets('ghp_abcdefghijklmnopqrstuvwxyz0123456789');
    expect(patterns).toContain('github_pat');
  });

  it('should return empty array for no secrets', () => {
    const patterns = detectSecrets('normal string');
    expect(patterns).toHaveLength(0);
  });
});
