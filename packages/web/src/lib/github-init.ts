import { isGitHubAppInitialized, initGitHubApp } from '@conductor/shared';
import { getConfig } from '@/lib/config';

export function ensureGitHubApp(): boolean {
  if (isGitHubAppInitialized()) {
    return true;
  }

  const config = getConfig();

  if (
    config.githubAppId === '' ||
    config.githubPrivateKey === '' ||
    config.githubWebhookSecret === ''
  ) {
    return false;
  }

  try {
    initGitHubApp({
      appId: config.githubAppId,
      privateKey: config.githubPrivateKey,
      webhookSecret: config.githubWebhookSecret,
    });
    return true;
  } catch {
    return false;
  }
}
