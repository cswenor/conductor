/**
 * Pub/Sub module for Conductor
 *
 * Provides Redis pub/sub for pushing real-time events to connected clients.
 * Uses ioredis directly (separate connections from BullMQ).
 */

import { Redis } from 'ioredis';
import type { RedisOptions } from 'ioredis';
import { createLogger } from '../logger/index.ts';

const log = createLogger({ name: 'conductor:pubsub' });

// =============================================================================
// Types
// =============================================================================

export interface StreamEvent {
  type: 'run.phase_changed';
  projectId: string;
  runId: string;
  fromPhase: string;
  toPhase: string;
  timestamp: string;
}

// =============================================================================
// Channel naming
// =============================================================================

export function projectChannel(projectId: string): string {
  return `conductor:events:${projectId}`;
}

// =============================================================================
// Redis connection helper (separate from BullMQ — no maxRetriesPerRequest: null)
// =============================================================================

function createPubsubRedis(redisUrl: string): Redis {
  const options: RedisOptions = {
    enableReadyCheck: false,
    lazyConnect: true,
  };

  if (redisUrl.startsWith('rediss://')) {
    options.tls = {};
  }

  return new Redis(redisUrl, options);
}

// =============================================================================
// Publisher
// =============================================================================

export interface Publisher {
  publish(projectId: string, event: StreamEvent): Promise<void>;
  close(): Promise<void>;
}

export function createPublisher(redisUrl: string): Publisher {
  const redis = createPubsubRedis(redisUrl);
  void redis.connect().catch((err: unknown) => {
    log.warn({ error: err instanceof Error ? err.message : 'Unknown' }, 'Publisher Redis connect failed');
  });

  return {
    async publish(projectId: string, event: StreamEvent): Promise<void> {
      const channel = projectChannel(projectId);
      await redis.publish(channel, JSON.stringify(event));
    },
    async close(): Promise<void> {
      await redis.quit();
    },
  };
}

// =============================================================================
// Subscriber
// =============================================================================

export interface Subscriber {
  subscribe(projectIds: string[], onMessage: (event: StreamEvent) => void): Promise<void>;
  unsubscribe(): Promise<void>;
  close(): Promise<void>;
}

export function createSubscriber(redisUrl: string): Subscriber {
  const redis = createPubsubRedis(redisUrl);
  void redis.connect().catch((err: unknown) => {
    log.warn({ error: err instanceof Error ? err.message : 'Unknown' }, 'Subscriber Redis connect failed');
  });

  let messageHandler: ((channel: string, message: string) => void) | undefined;

  return {
    async subscribe(projectIds: string[], onMessage: (event: StreamEvent) => void): Promise<void> {
      const channels = projectIds.map(projectChannel);
      if (channels.length === 0) return;

      messageHandler = (_channel: string, message: string) => {
        try {
          const event = JSON.parse(message) as StreamEvent;
          onMessage(event);
        } catch {
          log.warn({ message }, 'Failed to parse pub/sub message');
        }
      };

      redis.on('message', messageHandler);
      await redis.subscribe(...channels);
    },
    async unsubscribe(): Promise<void> {
      await redis.unsubscribe();
      if (messageHandler !== undefined) {
        redis.removeListener('message', messageHandler);
        messageHandler = undefined;
      }
    },
    async close(): Promise<void> {
      if (messageHandler !== undefined) {
        redis.removeListener('message', messageHandler);
        messageHandler = undefined;
      }
      await redis.quit();
    },
  };
}

// =============================================================================
// Singleton convenience (used by both worker + web)
// =============================================================================

let singletonPublisher: Publisher | undefined;

export function initPublisher(redisUrl: string): void {
  if (singletonPublisher !== undefined) return;
  singletonPublisher = createPublisher(redisUrl);
  log.info('Pub/sub publisher initialized');
}

export async function closePublisher(): Promise<void> {
  if (singletonPublisher !== undefined) {
    await singletonPublisher.close();
    singletonPublisher = undefined;
    log.info('Pub/sub publisher closed');
  }
}

/**
 * Fire-and-forget publish of a phase transition event.
 * No-op if publisher not initialized (e.g., tests without Redis).
 */
export function publishTransitionEvent(
  projectId: string,
  runId: string,
  fromPhase: string,
  toPhase: string,
): void {
  if (singletonPublisher === undefined) return;
  const event: StreamEvent = {
    type: 'run.phase_changed',
    projectId,
    runId,
    fromPhase,
    toPhase,
    timestamp: new Date().toISOString(),
  };
  singletonPublisher.publish(projectId, event).catch((err: unknown) => {
    log.warn(
      { projectId, runId, error: err instanceof Error ? err.message : 'Unknown' },
      'Failed to publish transition event (non-fatal)',
    );
  });
}

/** Reset singleton (for testing only) */
export function _resetPublisher(): void {
  singletonPublisher = undefined;
}
