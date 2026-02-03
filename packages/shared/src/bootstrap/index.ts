/**
 * Bootstrap module for Conductor
 *
 * Provides unified initialization for database and queue manager,
 * used by both web and worker processes.
 */

import type { Database as DatabaseType } from 'better-sqlite3';
import { initDatabase, closeDatabase, getSchemaVersion } from '../db/index';
import { initQueueManager, closeQueueManager, type QueueManager } from '../queue/index';
import { createLogger } from '../logger/index';
import { initEncryption } from '../crypto/index';

const log = createLogger({ name: 'conductor:bootstrap' });

/**
 * Bootstrap configuration
 */
export interface BootstrapConfig {
  /** Path to SQLite database file */
  databasePath: string;
  /** Redis connection URL */
  redisUrl: string;
  /** Enable verbose SQL logging */
  verboseDb?: boolean;
  /** Queue prefix (default: 'conductor') */
  queuePrefix?: string;
}

/**
 * Bootstrap result containing initialized services
 */
export interface BootstrapResult {
  db: DatabaseType;
  queueManager: QueueManager;
}

/**
 * Health check result
 */
export interface HealthCheckResult {
  database: {
    healthy: boolean;
    schemaVersion: number;
    error?: string;
  };
  redis: {
    healthy: boolean;
    latencyMs: number;
    error?: string;
  };
}

/**
 * Singleton state for bootstrap
 */
let bootstrapState: BootstrapResult | null = null;

/**
 * Initialize all Conductor services
 *
 * This function initializes the database (running any pending migrations)
 * and the queue manager. It should be called once at startup.
 *
 * @throws Error if already bootstrapped or if initialization fails
 */
export async function bootstrap(config: BootstrapConfig): Promise<BootstrapResult> {
  if (bootstrapState !== null) {
    throw new Error('Conductor already bootstrapped. Call shutdown() first to reinitialize.');
  }

  log.info({ databasePath: config.databasePath }, 'Starting bootstrap');

  // Initialize encryption if DATABASE_ENCRYPTION_KEY is set
  const encryptionKey = process.env['DATABASE_ENCRYPTION_KEY'];
  if (encryptionKey !== undefined && encryptionKey !== '') {
    try {
      initEncryption(encryptionKey);
      log.info('Database encryption enabled');
    } catch (err) {
      log.error(
        { error: err instanceof Error ? err.message : 'Unknown error' },
        'Failed to initialize encryption'
      );
      throw err;
    }
  } else if (process.env['NODE_ENV'] === 'production') {
    log.warn(
      'DATABASE_ENCRYPTION_KEY not set. OAuth tokens will be stored in plaintext. ' +
      'Set DATABASE_ENCRYPTION_KEY for production deployments.'
    );
  } else {
    log.debug('Database encryption not configured (development mode)');
  }

  // Initialize database with migrations
  log.info('Initializing database');
  const db = initDatabase({
    path: config.databasePath,
    verbose: config.verboseDb,
  });

  const schemaVersion = getSchemaVersion(db);
  log.info({ schemaVersion }, 'Database initialized');

  // Initialize queue manager
  log.info('Initializing queue manager');
  const queueManager = initQueueManager({
    redisUrl: config.redisUrl,
    prefix: config.queuePrefix,
  });

  // Verify Redis connection
  const redisHealth = await queueManager.healthCheck();
  if (!redisHealth.healthy) {
    // Clean up on failure
    closeDatabase(db);
    throw new Error('Failed to connect to Redis during bootstrap');
  }
  log.info({ latencyMs: redisHealth.latencyMs }, 'Redis connected');

  bootstrapState = { db, queueManager };

  log.info('Bootstrap complete');
  return bootstrapState;
}

/**
 * Get the bootstrapped services
 *
 * @throws Error if not bootstrapped
 */
export function getBootstrap(): BootstrapResult {
  if (bootstrapState === null) {
    throw new Error('Conductor not bootstrapped. Call bootstrap() first.');
  }
  return bootstrapState;
}

/**
 * Check if Conductor has been bootstrapped
 */
export function isBootstrapped(): boolean {
  return bootstrapState !== null;
}

/**
 * Get the database instance (convenience function)
 *
 * @throws Error if not bootstrapped
 */
export function getDatabase(): DatabaseType {
  return getBootstrap().db;
}

/**
 * Perform health check on all services
 */
export async function healthCheck(): Promise<HealthCheckResult> {
  const result: HealthCheckResult = {
    database: { healthy: false, schemaVersion: 0 },
    redis: { healthy: false, latencyMs: -1 },
  };

  // Check database health
  if (bootstrapState !== null) {
    try {
      // Simple query to verify database is responsive
      const schemaVersion = getSchemaVersion(bootstrapState.db);
      result.database = { healthy: true, schemaVersion };
    } catch (err) {
      result.database = {
        healthy: false,
        schemaVersion: 0,
        error: err instanceof Error ? err.message : 'Unknown error',
      };
    }

    // Check Redis health
    try {
      const redisHealth = await bootstrapState.queueManager.healthCheck();
      result.redis = {
        healthy: redisHealth.healthy,
        latencyMs: redisHealth.latencyMs,
      };
    } catch (err) {
      result.redis = {
        healthy: false,
        latencyMs: -1,
        error: err instanceof Error ? err.message : 'Unknown error',
      };
    }
  } else {
    result.database.error = 'Not bootstrapped';
    result.redis.error = 'Not bootstrapped';
  }

  return result;
}

/**
 * Gracefully shutdown all services
 */
export async function shutdown(): Promise<void> {
  if (bootstrapState === null) {
    log.warn('Shutdown called but not bootstrapped');
    return;
  }

  log.info('Starting shutdown');

  // Close queue manager first (may have active connections)
  log.info('Closing queue manager');
  await closeQueueManager();

  // Close database
  log.info('Closing database');
  closeDatabase(bootstrapState.db);

  bootstrapState = null;
  log.info('Shutdown complete');
}
