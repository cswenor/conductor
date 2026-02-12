/**
 * SSE endpoint for real-time event streaming.
 *
 * V2: Per-process shared Redis subscriber with fan-out dispatch map.
 * Supports Last-Event-ID replay from stream_events table.
 * Emits StreamEventV2 events.
 */

import { type NextRequest } from 'next/server';
import {
  validateSession,
  listProjects,
  createSubscriber,
  createLogger,
  queryStreamEventsForReplay,
  rowToStreamEventV2,
  type Subscriber,
  type StreamEventV2,
} from '@conductor/shared';
import { ensureBootstrap, getDb } from '@/lib/bootstrap';
import { getConfig } from '@/lib/config';
import { SESSION_COOKIE_NAME, userToAuthUser } from '@/lib/auth/middleware';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const log = createLogger({ name: 'conductor:api:events-stream' });

// =============================================================================
// Per-process shared subscriber + fan-out dispatch
// =============================================================================

interface Connection {
  writer: (data: string) => void;
  projectIds: Set<string>;
}

let sharedSubscriber: Subscriber | undefined;
const connections = new Map<string, Connection>();
const subscribedChannels = new Set<string>();

let connectionCounter = 0;

function generateConnectionId(): string {
  return `conn_${++connectionCounter}_${Date.now()}`;
}

function ensureSharedSubscriber(redisUrl: string): void {
  if (sharedSubscriber !== undefined) return;

  sharedSubscriber = createSubscriber(redisUrl);
}

async function subscribeToChannels(
  projectIds: string[],
): Promise<void> {
  if (sharedSubscriber === undefined) return;

  const newChannels = projectIds.filter((pid) => !subscribedChannels.has(pid));
  if (newChannels.length === 0) return;

  for (const pid of newChannels) {
    subscribedChannels.add(pid);
  }

  // Subscribe and set up message handler
  await sharedSubscriber.subscribe(newChannels, (event) => {
    // Fan out to all connections that care about this event's project
    const eventAny = event as unknown as Record<string, unknown>;
    const projectId = (eventAny['projectId'] as string) ?? '';

    for (const conn of connections.values()) {
      if (conn.projectIds.has(projectId)) {
        try {
          // Build SSE frame with id: field if present
          const id = eventAny['id'] as number | undefined;
          let frame = '';
          if (typeof id === 'number') {
            frame += `id: ${id}\n`;
          }
          frame += `data: ${JSON.stringify(event)}\n\n`;
          conn.writer(frame);
        } catch {
          // Connection may be closed
        }
      }
    }
  });
}

function removeConnection(connId: string): void {
  connections.delete(connId);

  // Check if any remaining connections still need each channel
  // For simplicity we don't unsubscribe channels — shared subscriber stays connected
  // to all ever-subscribed channels. This is fine for a long-lived process.
}

// =============================================================================
// Replay from stream_events
// =============================================================================

function buildReplayFrames(
  db: Awaited<ReturnType<typeof getDb>>,
  lastEventId: number,
  projectIds: string[],
): string | null {
  const rows = queryStreamEventsForReplay(db, lastEventId, projectIds, 101);

  if (rows.length === 0) return null;

  // Check if gap is too large
  if (rows.length > 100) {
    return 'refresh_required';
  }

  // Check if oldest event is too old (>5 min)
  const oldestCreatedAt = rows[0]?.created_at ?? '';
  if (oldestCreatedAt !== '') {
    const ageMs = Date.now() - new Date(oldestCreatedAt).getTime();
    if (ageMs > 5 * 60 * 1000) {
      return 'refresh_required';
    }
  }

  // Build replay frames
  let frames = '';
  for (const row of rows) {
    const event = rowToStreamEventV2(row);
    frames += `id: ${row.id}\ndata: ${JSON.stringify(event)}\n\n`;
  }
  return frames;
}

// =============================================================================
// Route handler
// =============================================================================

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

  // 3. Initialize shared subscriber if needed
  const config = getConfig();
  ensureSharedSubscriber(config.redisUrl);

  // 4. Parse Last-Event-ID for replay
  const lastEventIdHeader = request.headers.get('Last-Event-ID');
  const lastEventId = lastEventIdHeader !== null ? parseInt(lastEventIdHeader, 10) : NaN;

  // 5. Build ReadableStream with fan-out + replay
  const encoder = new TextEncoder();
  const connId = generateConnectionId();
  let cleaned = false;
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;

  function cleanup() {
    if (cleaned) return;
    cleaned = true;
    if (heartbeatTimer !== undefined) {
      clearInterval(heartbeatTimer);
    }
    removeConnection(connId);
  }

  const stream = new ReadableStream({
    async start(controller) {
      const writer = (data: string) => {
        controller.enqueue(encoder.encode(data));
      };

      // Register connection in dispatch map
      connections.set(connId, {
        writer,
        projectIds: new Set(projectIds),
      });

      // Subscribe to project channels
      try {
        await subscribeToChannels(projectIds);
      } catch (err: unknown) {
        log.warn(
          { error: err instanceof Error ? err.message : 'Unknown', userId: user.userId },
          'Failed to subscribe to project channels',
        );
      }

      // Replay missed events if Last-Event-ID was provided
      if (!isNaN(lastEventId) && lastEventId > 0) {
        try {
          const replay = buildReplayFrames(db, lastEventId, projectIds);
          if (replay === 'refresh_required') {
            const refreshEvent: StreamEventV2 = {
              kind: 'refresh_required',
              projectId: '',
              reason: 'Reconnect gap too large',
              timestamp: new Date().toISOString(),
            };
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(refreshEvent)}\n\n`));
          } else if (replay !== null) {
            controller.enqueue(encoder.encode(replay));
          }
        } catch (err: unknown) {
          log.warn(
            { error: err instanceof Error ? err.message : 'Unknown', lastEventId },
            'Failed to replay stream events',
          );
        }
      }

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

  // 6. Return SSE response
  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no',
    },
  });
}
