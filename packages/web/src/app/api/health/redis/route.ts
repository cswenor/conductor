import { success, errors } from '@/lib/api-utils';
import { checkHealth } from '@/lib/bootstrap';

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
  try {
    const health = await checkHealth();

    if (!health.redis.healthy) {
      return errors.serviceUnavailable(health.redis.error ?? 'Redis connection failed');
    }

    return success({
      status: 'ok',
      latencyMs: health.redis.latencyMs,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return errors.serviceUnavailable(`Redis health check failed: ${message}`);
  }
}
