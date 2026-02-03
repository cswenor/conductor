/**
 * GitHub Status API
 *
 * Returns the configuration status of the GitHub App integration.
 */

import { NextResponse } from 'next/server';
import { getConfig } from '@/lib/config';

interface GitHubStatusResponse {
  configured: boolean;
  appId?: string;
  appSlug?: string;
}

/**
 * GET /api/github/status
 *
 * Returns the GitHub App configuration status.
 */
export function GET(): NextResponse<GitHubStatusResponse> {
  const config = getConfig();

  const configured =
    config.githubAppId !== '' &&
    config.githubPrivateKey !== '' &&
    config.githubWebhookSecret !== '';

  if (configured) {
    return NextResponse.json({
      configured: true,
      appId: config.githubAppId,
      appSlug: config.githubAppSlug || undefined,
    });
  }

  return NextResponse.json({
    configured: false,
  });
}
