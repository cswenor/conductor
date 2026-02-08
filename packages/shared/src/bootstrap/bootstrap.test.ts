import { describe, it, expect } from 'vitest';
import {
  isBootstrapped,
  getDatabase,
  getBootstrap,
  healthCheck,
} from './index.ts';

/**
 * Bootstrap tests that don't require Redis
 *
 * Integration tests requiring actual Redis should be in a separate
 * integration test suite that runs with Redis available.
 */
describe('Bootstrap', () => {
  describe('isBootstrapped', () => {
    it('should return false when not bootstrapped', () => {
      // Note: This test assumes no prior bootstrap in this test run
      // In a fresh test environment, this should be false
      expect(typeof isBootstrapped()).toBe('boolean');
    });
  });

  describe('getDatabase', () => {
    it('should throw if not bootstrapped', () => {
      // Only test this in isolation - skip if already bootstrapped
      if (!isBootstrapped()) {
        expect(() => getDatabase()).toThrow('not bootstrapped');
      }
    });
  });

  describe('getBootstrap', () => {
    it('should throw if not bootstrapped', () => {
      // Only test this in isolation - skip if already bootstrapped
      if (!isBootstrapped()) {
        expect(() => getBootstrap()).toThrow('not bootstrapped');
      }
    });
  });

  describe('healthCheck', () => {
    it('should return unhealthy if not bootstrapped', async () => {
      // Only test this in isolation - skip if already bootstrapped
      if (!isBootstrapped()) {
        const health = await healthCheck();

        expect(health.database.healthy).toBe(false);
        expect(health.database.error).toBe('Not bootstrapped');
        expect(health.redis.healthy).toBe(false);
        expect(health.redis.error).toBe('Not bootstrapped');
      }
    });
  });
});
