import { getConfig } from '@/lib/config';
import { success } from '@/lib/api-utils';

/**
 * Force dynamic rendering (not static)
 */
export const dynamic = 'force-dynamic';

/**
 * Health check endpoint
 *
 * Returns basic health status and version information.
 * Used by load balancers and monitoring systems.
 */
export function GET() {
  const config = getConfig();

  return success({
    status: 'ok',
    timestamp: new Date().toISOString(),
    version: config.version,
    environment: config.nodeEnv,
  });
}
