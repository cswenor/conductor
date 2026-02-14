/**
 * Pub/Sub module for Conductor
 *
 * Provides Redis pub/sub for pushing real-time events to connected clients.
 * Uses ioredis directly (separate connections from BullMQ).
 *
 * V1 StreamEvent: original phase-only type (deprecated, kept for compatibility).
 * V2 StreamEventV2: typed discriminated union with persistence + replay support.
 */

import { Redis } from 'ioredis';
import type { RedisOptions } from 'ioredis';
import type { Database } from 'better-sqlite3';
import { createLogger } from '../logger/index.ts';

const log = createLogger({ name: 'conductor:pubsub' });

// =============================================================================
// V1 Types (kept for backward compatibility during migration)
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
// V2 Types
// =============================================================================

interface StreamEventBase {
  /** Present when persisted to stream_events (strictly monotonic). Absent on live events where persistence failed. */
  id?: number;
  /** Discriminator */
  kind: string;
  projectId: string;
  runId?: string;
  timestamp: string;
}

export interface RunPhaseChangedEventV2 extends StreamEventBase {
  kind: 'run.phase_changed';
  runId: string;
  fromPhase: string;
  toPhase: string;
}

export interface GateEvaluatedEvent extends StreamEventBase {
  kind: 'gate.evaluated';
  runId: string;
  gateId: string;
  gateKind: string;
  status: string;
  reason?: string;
}

export interface OperatorActionEvent extends StreamEventBase {
  kind: 'operator.action';
  runId: string;
  action: string;
  operator: string;
}

export interface AgentInvocationEvent extends StreamEventBase {
  kind: 'agent.invocation';
  runId: string;
  agentInvocationId: string;
  agent: string;
  action: string;
  status: string;
  errorCode?: string;
}

export interface RunUpdatedEvent extends StreamEventBase {
  kind: 'run.updated';
  runId: string;
  fields: string[];
}

export interface ProjectUpdatedEvent extends StreamEventBase {
  kind: 'project.updated';
  reason: string;
}

export interface RefreshRequiredEvent extends StreamEventBase {
  kind: 'refresh_required';
  reason: string;
}

export type StreamEventV2 =
  | RunPhaseChangedEventV2
  | GateEvaluatedEvent
  | OperatorActionEvent
  | AgentInvocationEvent
  | RunUpdatedEvent
  | ProjectUpdatedEvent
  | RefreshRequiredEvent;

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
  publish(projectId: string, event: StreamEvent | StreamEventV2): Promise<void>;
  close(): Promise<void>;
}

export function createPublisher(redisUrl: string): Publisher {
  const redis = createPubsubRedis(redisUrl);
  void redis.connect().catch((err: unknown) => {
    log.warn({ error: err instanceof Error ? err.message : 'Unknown' }, 'Publisher Redis connect failed');
  });

  return {
    async publish(projectId: string, event: StreamEvent | StreamEventV2): Promise<void> {
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
  /** Register message handler exactly once. Must be called before addChannels. */
  setHandler(onMessage: (event: StreamEventV2) => void): void;
  /** Subscribe to additional project channels (idempotent, no handler re-registration). */
  addChannels(projectIds: string[]): Promise<void>;
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
    setHandler(onMessage: (event: StreamEventV2) => void): void {
      if (messageHandler !== undefined) {
        throw new Error('setHandler() called twice — handler is already registered');
      }

      messageHandler = (_channel: string, message: string) => {
        try {
          const event = JSON.parse(message) as StreamEventV2;
          onMessage(event);
        } catch {
          log.warn({ message }, 'Failed to parse pub/sub message');
        }
      };

      redis.on('message', messageHandler);
    },
    async addChannels(projectIds: string[]): Promise<void> {
      const channels = projectIds.map(projectChannel);
      if (channels.length === 0) return;
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
// stream_events persistence
// =============================================================================

interface StreamEventRow {
  id: number;
  kind: string;
  project_id: string;
  run_id: string | null;
  payload_json: string;
  created_at: string;
}

/**
 * Insert a V2 event into stream_events. Returns the auto-increment id.
 */
export function insertStreamEvent(
  db: Database,
  event: Omit<StreamEventV2, 'id'>,
): number {
  // Extract core fields; everything else goes into payload_json
  const { kind, projectId, runId, timestamp, ...rest } = event;
  const payloadJson = JSON.stringify(rest);

  const result = db.prepare(`
    INSERT INTO stream_events (kind, project_id, run_id, payload_json, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(kind, projectId, runId ?? null, payloadJson, timestamp);

  return Number(result.lastInsertRowid);
}

/**
 * Query stream_events for replay. Returns events with id > lastEventId
 * for the given project IDs, up to limit+1 rows (to detect overflow).
 */
export function queryStreamEventsForReplay(
  db: Database,
  lastEventId: number,
  projectIds: string[],
  limit: number = 101,
): StreamEventRow[] {
  if (projectIds.length === 0) return [];
  const placeholders = projectIds.map(() => '?').join(',');
  const sql = `
    SELECT id, kind, project_id, run_id, payload_json, created_at
    FROM stream_events
    WHERE id > ?
      AND project_id IN (${placeholders})
    ORDER BY id ASC
    LIMIT ?
  `;
  return db.prepare(sql).all(lastEventId, ...projectIds, limit) as StreamEventRow[];
}

/**
 * Reconstruct a StreamEventV2 from a stream_events row.
 */
export function rowToStreamEventV2(row: StreamEventRow): StreamEventV2 {
  const payload = JSON.parse(row.payload_json) as Record<string, unknown>;
  return {
    id: row.id,
    kind: row.kind,
    projectId: row.project_id,
    runId: row.run_id ?? undefined,
    timestamp: row.created_at,
    ...payload,
  } as StreamEventV2;
}

/**
 * Query recent stream_events for a set of projects.
 * Returns events in descending id order (newest first), up to `limit` rows.
 */
export function queryRecentStreamEvents(
  db: Database,
  projectIds: string[],
  limit: number = 20,
): StreamEventV2[] {
  if (projectIds.length === 0) return [];
  const placeholders = projectIds.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT id, kind, project_id, run_id, payload_json, created_at
    FROM stream_events
    WHERE project_id IN (${placeholders})
    ORDER BY id DESC
    LIMIT ?
  `).all(...projectIds, limit) as StreamEventRow[];
  return rows.map(rowToStreamEventV2);
}

// =============================================================================
// Enriched stream_events query (for inbox with project/task context)
// =============================================================================

export interface EnrichedStreamEventRow {
  event: StreamEventV2;
  projectName: string | null;
  taskTitle: string | null;
}

interface EnrichedRawRow extends StreamEventRow {
  project_name: string | null;
  task_title: string | null;
}

/**
 * Query recent stream_events with project name and task title context.
 * Used by the inbox API to provide enriched notifications.
 * Returns events in descending id order (newest first), up to `limit` rows.
 */
export function queryRecentStreamEventsEnriched(
  db: Database,
  projectIds: string[],
  limit: number = 20,
): EnrichedStreamEventRow[] {
  if (projectIds.length === 0) return [];
  const placeholders = projectIds.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT
      se.id, se.kind, se.project_id, se.run_id,
      se.payload_json, se.created_at,
      p.name AS project_name,
      t.github_title AS task_title
    FROM stream_events se
    LEFT JOIN projects p ON se.project_id = p.project_id
    LEFT JOIN runs r ON se.run_id = r.run_id
    LEFT JOIN tasks t ON r.task_id = t.task_id
    WHERE se.project_id IN (${placeholders})
    ORDER BY se.id DESC
    LIMIT ?
  `).all(...projectIds, limit) as EnrichedRawRow[];

  return rows.map((row) => ({
    event: rowToStreamEventV2(row),
    projectName: row.project_name,
    taskTitle: row.task_title,
  }));
}

/**
 * Prune old stream_events rows. Called by worker cleanup queue.
 */
export function pruneStreamEvents(db: Database, maxAgeDays: number = 14): number {
  const result = db.prepare(
    `DELETE FROM stream_events WHERE created_at < datetime('now', '-' || ? || ' days')`,
  ).run(maxAgeDays);
  return result.changes;
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

// =============================================================================
// persistAndPublish — V2 core helper
// =============================================================================

/**
 * Persist a V2 event to stream_events and publish via Redis.
 * Fully decoupled from domain mutations: never throws.
 * If persistence fails, still attempts Redis publish (without id).
 */
export function persistAndPublish(
  db: Database,
  projectId: string,
  event: Omit<StreamEventV2, 'id'>,
): void {
  if (projectId === '') {
    log.warn({ kind: event.kind }, 'Skipping stream emission: empty projectId');
    return;
  }

  let id: number | undefined;
  try {
    id = insertStreamEvent(db, event);
  } catch (err: unknown) {
    log.warn(
      { projectId, kind: event.kind, error: err instanceof Error ? err.message : 'Unknown' },
      'stream_events INSERT failed (non-fatal)',
    );
  }

  const payload = id !== undefined ? { ...event, id } : { ...event };
  if (singletonPublisher === undefined) return;
  singletonPublisher.publish(projectId, payload as StreamEventV2).catch((err: unknown) => {
    log.warn(
      { projectId, kind: event.kind, error: err instanceof Error ? err.message : 'Unknown' },
      'Redis publish failed (non-fatal)',
    );
  });
}

// =============================================================================
// V1 publishTransitionEvent — updated to also persist V2 event
// =============================================================================

/**
 * Fire-and-forget publish of a phase transition event.
 * Persists to stream_events when db is provided, publishes V2 event.
 * No-op if publisher not initialized (e.g., tests without Redis).
 */
export function publishTransitionEvent(
  projectId: string,
  runId: string,
  fromPhase: string,
  toPhase: string,
  db?: Database,
): void {
  const timestamp = new Date().toISOString();

  if (db !== undefined) {
    // Use V2 path with persistence
    const event: Omit<RunPhaseChangedEventV2, 'id'> = {
      kind: 'run.phase_changed',
      projectId,
      runId,
      fromPhase,
      toPhase,
      timestamp,
    };
    persistAndPublish(db, projectId, event);
    return;
  }

  // Legacy path: no db, publish V1 event directly
  if (singletonPublisher === undefined) return;
  const event: StreamEvent = {
    type: 'run.phase_changed',
    projectId,
    runId,
    fromPhase,
    toPhase,
    timestamp,
  };
  singletonPublisher.publish(projectId, event).catch((err: unknown) => {
    log.warn(
      { projectId, runId, error: err instanceof Error ? err.message : 'Unknown' },
      'Failed to publish transition event (non-fatal)',
    );
  });
}

// =============================================================================
// V2 fire-and-forget publish helpers
// =============================================================================

export function publishGateEvaluatedEvent(
  db: Database,
  projectId: string,
  runId: string,
  gateId: string,
  gateKind: string,
  status: string,
  reason?: string,
): void {
  const event: Omit<GateEvaluatedEvent, 'id'> = {
    kind: 'gate.evaluated',
    projectId,
    runId,
    gateId,
    gateKind,
    status,
    reason,
    timestamp: new Date().toISOString(),
  };
  persistAndPublish(db, projectId, event);
}

export function publishOperatorActionEvent(
  db: Database,
  projectId: string,
  runId: string,
  action: string,
  operator: string,
): void {
  const event: Omit<OperatorActionEvent, 'id'> = {
    kind: 'operator.action',
    projectId,
    runId,
    action,
    operator,
    timestamp: new Date().toISOString(),
  };
  persistAndPublish(db, projectId, event);
}

export function publishAgentInvocationEvent(
  db: Database,
  projectId: string,
  runId: string,
  agentInvocationId: string,
  agent: string,
  action: string,
  status: string,
  errorCode?: string,
): void {
  const event: Omit<AgentInvocationEvent, 'id'> = {
    kind: 'agent.invocation',
    projectId,
    runId,
    agentInvocationId,
    agent,
    action,
    status,
    errorCode,
    timestamp: new Date().toISOString(),
  };
  persistAndPublish(db, projectId, event);
}

export function publishRunUpdatedEvent(
  db: Database,
  projectId: string,
  runId: string,
  fields: string[],
): void {
  const event: Omit<RunUpdatedEvent, 'id'> = {
    kind: 'run.updated',
    projectId,
    runId,
    fields,
    timestamp: new Date().toISOString(),
  };
  persistAndPublish(db, projectId, event);
}

export function publishProjectUpdatedEvent(
  db: Database,
  projectId: string,
  reason: string,
): void {
  const event: Omit<ProjectUpdatedEvent, 'id'> = {
    kind: 'project.updated',
    projectId,
    reason,
    timestamp: new Date().toISOString(),
  };
  persistAndPublish(db, projectId, event);
}

// =============================================================================
// run.updated field constants
// =============================================================================

/** Fields set when a PR is created (handleWriteResult). */
export const RUN_UPDATED_PR_CREATED_FIELDS = ['prUrl', 'prNumber', 'prState'] as const;
/** Fields set when PR state changes (merge, close, reopen). */
export const RUN_UPDATED_PR_STATE_FIELDS = ['prState'] as const;

/** Reset singleton (for testing only) */
export function _resetPublisher(): void {
  singletonPublisher = undefined;
}
