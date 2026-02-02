/**
 * Environment configuration for Conductor web application
 *
 * All environment variables should be accessed through this module.
 * This provides type safety and validation at startup.
 */

import {
  getEnv,
  validateRedisUrl,
  type ConfigField,
  createLogger,
} from '@conductor/shared';

const log = createLogger({ name: 'conductor:web:config' });

/**
 * Application configuration derived from environment variables
 */
export interface AppConfig {
  /** Node environment */
  nodeEnv: 'development' | 'production' | 'test';
  /** Application version */
  version: string;
  /** Database file path */
  databasePath: string;
  /** Redis URL for BullMQ */
  redisUrl: string;
  /** GitHub App ID */
  githubAppId: string;
  /** GitHub App private key */
  githubPrivateKey: string;
  /** GitHub webhook secret */
  githubWebhookSecret: string;
}

/**
 * Validate and load application configuration
 *
 * In development mode, missing GitHub credentials are allowed.
 * In production mode, all credentials are required.
 */
export function loadConfig(): AppConfig {
  const envValue = process.env['NODE_ENV'] ?? 'development';
  const nodeEnv: AppConfig['nodeEnv'] =
    envValue === 'production' ? 'production' : envValue === 'test' ? 'test' : 'development';
  const isDev = nodeEnv !== 'production';

  // Define configuration fields with validation
  const fields: ConfigField[] = [
    {
      name: 'DATABASE_PATH',
      type: 'path',
      required: false,
      default: './conductor.db',
      description: 'SQLite database file path',
    },
    {
      name: 'REDIS_URL',
      type: 'url',
      required: false,
      default: 'redis://localhost:6379',
      validate: validateRedisUrl,
      description: 'Redis connection URL',
    },
    {
      name: 'GITHUB_APP_ID',
      type: 'string',
      required: !isDev,
      default: isDev ? '' : undefined,
      description: 'GitHub App ID',
    },
    {
      name: 'GITHUB_PRIVATE_KEY',
      type: 'string',
      required: !isDev,
      default: isDev ? '' : undefined,
      description: 'GitHub App private key',
    },
    {
      name: 'GITHUB_WEBHOOK_SECRET',
      type: 'string',
      required: !isDev,
      default: isDev ? '' : undefined,
      description: 'GitHub webhook secret',
    },
  ];

  // Validate each field
  const config: Record<string, string> = {};
  for (const field of fields) {
    config[field.name] = getEnv(field);
  }

  // Log warning in dev mode if GitHub credentials are missing
  if (isDev) {
    const missingGitHub = ['GITHUB_APP_ID', 'GITHUB_PRIVATE_KEY', 'GITHUB_WEBHOOK_SECRET'].filter(
      (key) => config[key] === ''
    );
    if (missingGitHub.length > 0) {
      log.warn(
        { missing: missingGitHub },
        'GitHub credentials not configured - GitHub features will be disabled'
      );
    }
  }

  return {
    nodeEnv,
    version: process.env['npm_package_version'] ?? '0.1.0',
    databasePath: config['DATABASE_PATH'] ?? './conductor.db',
    redisUrl: config['REDIS_URL'] ?? 'redis://localhost:6379',
    githubAppId: config['GITHUB_APP_ID'] ?? '',
    githubPrivateKey: config['GITHUB_PRIVATE_KEY'] ?? '',
    githubWebhookSecret: config['GITHUB_WEBHOOK_SECRET'] ?? '',
  };
}

/**
 * Cached configuration instance
 */
let cachedConfig: AppConfig | null = null;

/**
 * Get the application configuration (cached)
 */
export function getConfig(): AppConfig {
  if (cachedConfig === null) {
    cachedConfig = loadConfig();
  }
  return cachedConfig;
}

/**
 * Reset configuration cache (for testing)
 */
export function resetConfig(): void {
  cachedConfig = null;
}
