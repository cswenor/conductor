/**
 * Structured logging module using pino
 *
 * Provides consistent, structured logging across all Conductor services.
 * In development, logs are pretty-printed; in production, they're JSON.
 */

import pino from 'pino';

/** Log levels supported by the logger */
export type LogLevel = 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace';

/** Context that can be attached to log messages */
export interface LogContext {
  [key: string]: unknown;
}

/** Configuration options for creating a logger */
export interface LoggerOptions {
  /** Name of the service/component */
  name: string;
  /** Minimum log level to output */
  level?: LogLevel;
  /** Additional base context to include in all logs */
  base?: LogContext;
}

/** Determine if we're in development mode */
function isDevelopment(): boolean {
  return process.env['NODE_ENV'] !== 'production';
}

/** Check if we're in a Next.js environment where worker threads don't work */
function isNextJs(): boolean {
  return typeof process.env['NEXT_RUNTIME'] !== 'undefined' ||
    typeof (globalThis as Record<string, unknown>)['__NEXT_DATA__'] !== 'undefined';
}

/** Get the log level from environment or default */
function getLogLevel(): LogLevel {
  const envLevel = process.env['LOG_LEVEL'];
  if (
    envLevel === 'fatal' ||
    envLevel === 'error' ||
    envLevel === 'warn' ||
    envLevel === 'info' ||
    envLevel === 'debug' ||
    envLevel === 'trace'
  ) {
    return envLevel;
  }
  return isDevelopment() ? 'debug' : 'info';
}

/**
 * Create a configured pino logger instance
 */
export function createLogger(options: LoggerOptions): pino.Logger {
  const level = options.level ?? getLogLevel();

  // pino-pretty uses worker threads which don't work in Next.js
  // Only use pino-pretty in non-Next.js development environments
  const transport = isDevelopment() && !isNextJs()
    ? {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'HH:MM:ss',
          ignore: 'pid,hostname',
        },
      }
    : undefined;

  return pino({
    name: options.name,
    level,
    base: {
      ...options.base,
      env: process.env['NODE_ENV'] ?? 'development',
    },
    transport,
  });
}

/**
 * Create a child logger with additional context
 */
export function childLogger(
  parent: pino.Logger,
  context: LogContext
): pino.Logger {
  return parent.child(context);
}

/** Default logger for the shared package */
let defaultLogger: pino.Logger | null = null;

/**
 * Get or create the default shared logger
 */
export function getLogger(): pino.Logger {
  if (defaultLogger === null) {
    defaultLogger = createLogger({ name: 'conductor' });
  }
  return defaultLogger;
}

/**
 * Set the default logger (useful for testing)
 */
export function setLogger(logger: pino.Logger): void {
  defaultLogger = logger;
}

// Re-export pino types that consumers might need
export type { Logger } from 'pino';
