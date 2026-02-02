import { describe, it, expect } from 'vitest';
import { getConnectionOptions } from './index';

describe('Queue', () => {
  describe('getConnectionOptions', () => {
    it('should parse basic redis:// URL', () => {
      const options = getConnectionOptions('redis://localhost:6379');

      expect(options['host']).toBe('localhost');
      expect(options['port']).toBe(6379);
      expect(options['tls']).toBeUndefined();
    });

    it('should parse redis:// URL with auth', () => {
      const options = getConnectionOptions('redis://user:pass@localhost:6379');

      expect(options['host']).toBe('localhost');
      expect(options['port']).toBe(6379);
      expect(options['username']).toBe('user');
      expect(options['password']).toBe('pass');
      expect(options['tls']).toBeUndefined();
    });

    it('should enable TLS for rediss:// URLs', () => {
      const options = getConnectionOptions('rediss://localhost:6379');

      expect(options['host']).toBe('localhost');
      expect(options['port']).toBe(6379);
      expect(options['tls']).toEqual({});
    });

    it('should enable TLS for rediss:// with auth', () => {
      const options = getConnectionOptions('rediss://user:secret@redis.example.com:6380');

      expect(options['host']).toBe('redis.example.com');
      expect(options['port']).toBe(6380);
      expect(options['username']).toBe('user');
      expect(options['password']).toBe('secret');
      expect(options['tls']).toEqual({});
    });

    it('should use default port 6379 when not specified', () => {
      const options = getConnectionOptions('redis://localhost');

      expect(options['port']).toBe(6379);
    });

    it('should handle URL-encoded passwords', () => {
      const options = getConnectionOptions('redis://:p%40ssw0rd%21@localhost:6379');

      expect(options['password']).toBe('p@ssw0rd!');
    });
  });
});
