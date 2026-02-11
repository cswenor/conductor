/**
 * Bootstrap utilities for Conductor web application
 *
 * Provides lazy initialization of database and queue manager
 * for use in Next.js API routes.
 */

import { resolve, isAbsolute } from 'node:path';
import {
  bootstrap,
  isBootstrapped,
  getDatabase,
  getQueueManager,
  healthCheck,
  type BootstrapResult,
  type HealthCheckResult,
  type Database,
  type QueueManager,
  createLogger,
} from '@conductor/shared';
import { getConfig } from './config';

// Resolve relative paths from the monorepo root so web and worker share the
// same database file. Assumes cwd is packages/web (pnpm --filter @conductor/web ...).
const monorepoRoot = resolve(process.cwd(), '../..');

const log = createLogger({ name: 'conductor:web:bootstrap' });

/** Promise to track in-flight bootstrap */
let bootstrapPromise: Promise<BootstrapResult> | null = null;

/**
 * Ensure Conductor services are initialized
 *
 * This function is idempotent and safe to call from multiple requests.
 * It will only bootstrap once and subsequent calls will wait for or
 * return the existing bootstrap.
 */
export async function ensureBootstrap(): Promise<void> {
  if (isBootstrapped()) {
    return;
  }

  // If bootstrap is in progress, wait for it
  if (bootstrapPromise !== null) {
    await bootstrapPromise;
    return;
  }

  // Start bootstrap
  const config = getConfig();
  log.info('Starting lazy bootstrap');

  const rawPath = config.databasePath === '' ? './conductor.db' : config.databasePath;
  if (config.databasePath === '') {
    log.warn('DATABASE_PATH is empty. Falling back to ./conductor.db');
  }
  const databasePath = isAbsolute(rawPath) ? rawPath : resolve(monorepoRoot, rawPath);

  bootstrapPromise = bootstrap({
    databasePath,
    redisUrl: config.redisUrl,
  });

  try {
    await bootstrapPromise;
    log.info('Lazy bootstrap complete');
  } catch (err) {
    // Clear promise so we can retry
    bootstrapPromise = null;
    console.error('Bootstrap error full stack:', err);
    throw err;
  }
}

/**
 * Get database instance, bootstrapping if needed
 */
export async function getDb(): Promise<Database> {
  await ensureBootstrap();
  return getDatabase();
}

/**
 * Get queue manager instance, bootstrapping if needed
 */
export async function getQueues(): Promise<QueueManager> {
  await ensureBootstrap();
  return getQueueManager();
}

/**
 * Perform health check, bootstrapping if needed
 */
export async function checkHealth(): Promise<HealthCheckResult> {
  try {
    await ensureBootstrap();
  } catch {
    // Return unhealthy status if bootstrap fails
    return {
      database: { healthy: false, schemaVersion: 0, error: 'Bootstrap failed' },
      redis: { healthy: false, latencyMs: -1, error: 'Bootstrap failed' },
    };
  }
  return healthCheck();
}
