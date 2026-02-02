import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createLogger, getLogger, setLogger, childLogger } from './index';

describe('createLogger', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
    process.env['NODE_ENV'] = 'test';
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('should create a logger with the given name', () => {
    const logger = createLogger({ name: 'test-logger' });
    expect(logger).toBeDefined();
    // Pino loggers have bindings that include the name
    const bindings = logger.bindings();
    expect(bindings['name']).toBe('test-logger');
  });

  it('should use specified log level', () => {
    const logger = createLogger({ name: 'test', level: 'error' });
    expect(logger.level).toBe('error');
  });

  it('should include base context', () => {
    const logger = createLogger({
      name: 'test',
      base: { service: 'api', version: '1.0.0' },
    });
    const bindings = logger.bindings();
    expect(bindings['service']).toBe('api');
    expect(bindings['version']).toBe('1.0.0');
  });

  it('should respect LOG_LEVEL environment variable', () => {
    process.env['LOG_LEVEL'] = 'warn';
    const logger = createLogger({ name: 'test' });
    expect(logger.level).toBe('warn');
  });
});

describe('getLogger', () => {
  it('should return a default logger', () => {
    const logger = getLogger();
    expect(logger).toBeDefined();
  });

  it('should return the same logger instance on multiple calls', () => {
    const logger1 = getLogger();
    const logger2 = getLogger();
    expect(logger1).toBe(logger2);
  });
});

describe('setLogger', () => {
  it('should allow setting a custom logger', () => {
    const customLogger = createLogger({ name: 'custom' });
    setLogger(customLogger);
    const logger = getLogger();
    expect(logger.bindings()['name']).toBe('custom');
  });
});

describe('childLogger', () => {
  it('should create a child logger with additional context', () => {
    const parent = createLogger({ name: 'parent' });
    const child = childLogger(parent, { requestId: '123' });

    const bindings = child.bindings();
    expect(bindings['requestId']).toBe('123');
    expect(bindings['name']).toBe('parent');
  });

  it('should inherit parent level', () => {
    const parent = createLogger({ name: 'parent', level: 'warn' });
    const child = childLogger(parent, { requestId: '123' });

    expect(child.level).toBe('warn');
  });
});

describe('logger methods', () => {
  it('should have standard logging methods', () => {
    const logger = createLogger({ name: 'test' });

    expect(typeof logger.info).toBe('function');
    expect(typeof logger.error).toBe('function');
    expect(typeof logger.warn).toBe('function');
    expect(typeof logger.debug).toBe('function');
    expect(typeof logger.trace).toBe('function');
    expect(typeof logger.fatal).toBe('function');
  });
});
