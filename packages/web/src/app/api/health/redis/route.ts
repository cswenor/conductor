import { getConfig } from '@/lib/config';
import { success, errors } from '@/lib/api-utils';
import { initQueueManager, getQueueManager } from '@conductor/shared';

/**
 * Force dynamic rendering
 */
export const dynamic = 'force-dynamic';

/**
 * Redis health check endpoint
 *
 * Returns Redis connection status and latency.
 */
export async function GET() {
  const config = getConfig();

  try {
    // Initialize queue manager if not already done
    try {
      getQueueManager();
    } catch {
      initQueueManager({ redisUrl: config.redisUrl });
    }

    const queueManager = getQueueManager();
    const health = await queueManager.healthCheck();

    if (!health.healthy) {
      return errors.serviceUnavailable('Redis connection failed');
    }

    return success({
      status: 'ok',
      redis: {
        connected: true,
        latencyMs: health.latencyMs,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return errors.serviceUnavailable(`Redis health check failed: ${message}`);
  }
}
