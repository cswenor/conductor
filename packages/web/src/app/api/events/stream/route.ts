/**
 * SSE endpoint for real-time event streaming.
 *
 * Authenticated clients receive phase transition events for all projects
 * they have access to. Uses Redis pub/sub under the hood.
 */

import { type NextRequest } from 'next/server';
import {
  validateSession,
  listProjects,
  createSubscriber,
  createLogger,
} from '@conductor/shared';
import { ensureBootstrap, getDb } from '@/lib/bootstrap';
import { getConfig } from '@/lib/config';
import { SESSION_COOKIE_NAME, userToAuthUser } from '@/lib/auth/middleware';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const log = createLogger({ name: 'conductor:api:events-stream' });

export async function GET(request: NextRequest): Promise<Response> {
  // 1. Auth — inline cookie-based auth (withAuth returns NextResponse, SSE needs raw Response)
  await ensureBootstrap();
  const db = await getDb();

  const token = request.cookies.get(SESSION_COOKIE_NAME)?.value;
  if (token === undefined || token === '') {
    return new Response('Unauthorized', { status: 401 });
  }

  const rawUser = validateSession(db, token);
  if (rawUser === null) {
    return new Response('Unauthorized', { status: 401 });
  }

  const user = userToAuthUser(rawUser);

  // 2. Get user's project IDs
  const projects = listProjects(db, { userId: user.userId });
  const projectIds = projects.map((p) => p.projectId);

  // 3. Create Redis subscriber
  const config = getConfig();
  const subscriber = createSubscriber(config.redisUrl);

  // 4. Build ReadableStream with unified cleanup
  const encoder = new TextEncoder();
  let cleaned = false;
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;

  function cleanup() {
    if (cleaned) return;
    cleaned = true;
    if (heartbeatTimer !== undefined) {
      clearInterval(heartbeatTimer);
    }
    subscriber.unsubscribe().catch(() => { /* ignore */ });
    subscriber.close().catch(() => { /* ignore */ });
  }

  const stream = new ReadableStream({
    start(controller) {
      // Subscribe to all project channels
      subscriber.subscribe(projectIds, (event) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        } catch {
          // Stream may be closed
          cleanup();
        }
      }).catch((err: unknown) => {
        log.warn(
          { error: err instanceof Error ? err.message : 'Unknown', userId: user.userId },
          'Failed to subscribe to project channels',
        );
      });

      // Heartbeat every 30s to keep connection alive
      heartbeatTimer = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(': heartbeat\n\n'));
        } catch {
          cleanup();
        }
      }, 30_000);

      // Handle abrupt disconnects
      request.signal.addEventListener('abort', cleanup);
    },
    cancel() {
      cleanup();
    },
  });

  // 5. Return SSE response
  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no',
    },
  });
}
