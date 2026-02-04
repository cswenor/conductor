/**
 * GitHub Integration Module
 *
 * Provides GitHub App authentication, API client creation,
 * and webhook verification utilities.
 */

import { App } from '@octokit/app';
import { Octokit as OctokitRest } from '@octokit/rest';
import { Webhooks, createNodeMiddleware } from '@octokit/webhooks';
import type { EmitterWebhookEvent } from '@octokit/webhooks';
import { createLogger } from '../logger/index';

/** Octokit instance type from App.getInstallationOctokit */
type InstallationOctokit = Awaited<ReturnType<App['getInstallationOctokit']>>;

const log = createLogger({ name: 'conductor:github' });

/**
 * GitHub App configuration
 */
export interface GitHubAppConfig {
  /** GitHub App ID */
  appId: string;
  /** GitHub App private key (PEM format) */
  privateKey: string;
  /** Webhook secret for signature verification */
  webhookSecret: string;
  /** Optional: Client ID for OAuth flows */
  clientId?: string;
  /** Optional: Client secret for OAuth flows */
  clientSecret?: string;
}

/**
 * Parsed private key (handles various formats)
 */
function parsePrivateKey(key: string): string {
  // Handle base64 encoded keys
  if (!key.includes('-----BEGIN')) {
    try {
      return Buffer.from(key, 'base64').toString('utf8');
    } catch {
      // Not base64, assume it's the raw key with escaped newlines
    }
  }

  // Handle escaped newlines
  return key.replace(/\\n/g, '\n');
}

/**
 * Singleton GitHub App instance
 */
let githubApp: App | null = null;
let webhooks: Webhooks | null = null;

/**
 * Initialize the GitHub App
 *
 * Must be called before using any GitHub functionality.
 */
export function initGitHubApp(config: GitHubAppConfig): App {
  if (githubApp !== null) {
    throw new Error('GitHub App already initialized');
  }

  const privateKey = parsePrivateKey(config.privateKey);

  log.info({ appId: config.appId }, 'Initializing GitHub App');

  const hasOAuth =
    config.clientId !== undefined &&
    config.clientId !== '' &&
    config.clientSecret !== undefined &&
    config.clientSecret !== '';

  githubApp = new App({
    appId: config.appId,
    privateKey,
    webhooks: {
      secret: config.webhookSecret,
    },
    oauth: hasOAuth
      ? {
          clientId: config.clientId as string,
          clientSecret: config.clientSecret as string,
        }
      : undefined,
    Octokit: OctokitRest.defaults({
      userAgent: 'conductor/0.1.0',
    }),
  });

  webhooks = new Webhooks({
    secret: config.webhookSecret,
  });

  log.info('GitHub App initialized');
  return githubApp;
}

/**
 * Get the GitHub App instance
 *
 * @throws Error if not initialized
 */
export function getGitHubApp(): App {
  if (githubApp === null) {
    throw new Error('GitHub App not initialized. Call initGitHubApp first.');
  }
  return githubApp;
}

/**
 * Check if GitHub App is initialized
 */
export function isGitHubAppInitialized(): boolean {
  return githubApp !== null;
}

/**
 * Get an authenticated Octokit instance for an installation
 *
 * @param installationId - The GitHub App installation ID
 */
export async function getInstallationOctokit(installationId: number): Promise<InstallationOctokit> {
  const app = getGitHubApp();
  return app.getInstallationOctokit(installationId);
}

/**
 * Get a raw installation access token string.
 *
 * Useful for git clone URLs: `https://x-access-token:{token}@github.com/...`
 */
export async function getInstallationToken(installationId: number): Promise<string> {
  const octokit = await getInstallationOctokit(installationId);
  const auth = (await octokit.auth({ type: 'installation' })) as { token: string };
  return auth.token;
}

/**
 * Get the Webhooks instance for verification and handling
 */
export function getWebhooks(): Webhooks {
  if (webhooks === null) {
    throw new Error('GitHub App not initialized. Call initGitHubApp first.');
  }
  return webhooks;
}

/**
 * Verify webhook signature
 *
 * @param payload - Raw webhook payload (string)
 * @param signature - X-Hub-Signature-256 header value
 * @returns true if signature is valid
 */
export async function verifyWebhookSignature(
  payload: string,
  signature: string
): Promise<boolean> {
  const wh = getWebhooks();
  try {
    return await wh.verify(payload, signature);
  } catch (err) {
    log.error({ error: err instanceof Error ? err.message : 'Unknown error' }, 'Webhook signature verification failed');
    return false;
  }
}

/**
 * Create Express/Connect middleware for webhook handling
 *
 * @param path - The path to mount the webhook handler (default: '/api/webhooks/github')
 */
export function createWebhookMiddleware(path = '/api/webhooks/github') {
  const wh = getWebhooks();
  return createNodeMiddleware(wh, { path });
}

/**
 * Register a webhook event handler
 */
export function onWebhookEvent<E extends EmitterWebhookEvent['name']>(
  event: E,
  handler: (event: EmitterWebhookEvent & { name: E }) => Promise<void>
): void {
  const wh = getWebhooks();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument
  wh.on(event as any, handler as any);
}

/**
 * Close the GitHub App (cleanup)
 */
export function closeGitHubApp(): void {
  githubApp = null;
  webhooks = null;
  log.info('GitHub App closed');
}

/**
 * Rate limit status for logging/monitoring
 */
export interface RateLimitStatus {
  limit: number;
  remaining: number;
  reset: Date;
  used: number;
}

/**
 * Get rate limit status for an installation
 */
export async function getRateLimitStatus(installationId: number): Promise<RateLimitStatus> {
  const octokit = await getInstallationOctokit(installationId);
  const { data } = await octokit.request('GET /rate_limit');

  return {
    limit: data.rate.limit,
    remaining: data.rate.remaining,
    reset: new Date(data.rate.reset * 1000),
    used: data.rate.used,
  };
}

// Re-export types for convenience
export type { InstallationOctokit as Octokit };
export type { EmitterWebhookEvent } from '@octokit/webhooks';
export type {
  IssuesEvent,
  IssueCommentEvent,
  PullRequestEvent,
  PullRequestReviewEvent,
  PushEvent,
  CheckSuiteEvent,
  CheckRunEvent,
} from '@octokit/webhooks-types';

// Re-export client
export * from './client';
