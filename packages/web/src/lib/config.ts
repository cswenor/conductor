/**
 * Environment configuration for Conductor web application
 *
 * All environment variables should be accessed through this module.
 * This provides type safety and validation at startup.
 */

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
 * Get a required environment variable
 * @throws Error if the variable is not set
 */
function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

/**
 * Get an optional environment variable with a default value
 */
function optionalEnv(name: string, defaultValue: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    return defaultValue;
  }
  return value;
}

/**
 * Validate and load application configuration
 *
 * In development mode, missing GitHub credentials are allowed.
 * In production mode, all credentials are required.
 */
export function loadConfig(): AppConfig {
  const nodeEnv = optionalEnv('NODE_ENV', 'development') as AppConfig['nodeEnv'];
  // Allow missing credentials in development or during Next.js build
  const isDev = nodeEnv !== 'production';

  return {
    nodeEnv,
    version: optionalEnv('npm_package_version', '0.1.0'),
    databasePath: optionalEnv('DATABASE_PATH', './conductor.db'),
    redisUrl: optionalEnv('REDIS_URL', 'redis://localhost:6379'),
    // GitHub credentials are required in production only
    githubAppId: isDev ? optionalEnv('GITHUB_APP_ID', '') : requireEnv('GITHUB_APP_ID'),
    githubPrivateKey: isDev
      ? optionalEnv('GITHUB_PRIVATE_KEY', '')
      : requireEnv('GITHUB_PRIVATE_KEY'),
    githubWebhookSecret: isDev
      ? optionalEnv('GITHUB_WEBHOOK_SECRET', '')
      : requireEnv('GITHUB_WEBHOOK_SECRET'),
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
