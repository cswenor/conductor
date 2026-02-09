/**
 * Rate Limiter for GitHub Mirroring
 *
 * Prevents comment spam by enforcing a minimum interval between
 * comments for the same run. When rate limited, events are deferred
 * and coalesced into a single comment on the next allowed post.
 */

import type { Database } from 'better-sqlite3';
import { createLogger } from '../logger/index.ts';
import type { EnqueueWriteResult } from '../outbox/index.ts';

const log = createLogger({ name: 'conductor:mirroring:rate-limiter' });

// =============================================================================
// Constants
// =============================================================================

/** Minimum seconds between comments for the same run */
const RATE_LIMIT_SECONDS = 30;

// =============================================================================
// Types
// =============================================================================

export interface MirrorResult {
  enqueued: boolean;
  githubWriteId?: string;
  deferred: boolean;
  error?: string;
}

export interface DeferredEvent {
  deferredEventId: string;
  runId: string;
  eventType: string;
  formattedBody: string;
  idempotencySuffix: string;
  createdAt: string;
}

interface DeferredRow {
  deferred_event_id: string;
  run_id: string;
  event_type: string;
  formatted_body: string;
  idempotency_suffix: string;
  created_at: string;
}

// =============================================================================
// ID Generation
// =============================================================================

function generateDeferredEventId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 8);
  return `def_${timestamp}${random}`;
}

// =============================================================================
// Core Logic
// =============================================================================

/**
 * Check rate limit and either post immediately or defer the event.
 *
 * Algorithm:
 * 1. Check last comment timestamp for this run
 * 2. If within rate limit window, defer the event
 * 3. If allowed: flush deferred events, coalesce with current, post
 *
 * @param db - Database connection
 * @param runId - Run to check rate limit for
 * @param event - Event to post or defer
 * @param enqueueFn - Function that enqueues the write and returns result
 */
export function checkAndMirror(
  db: Database,
  runId: string,
  event: { eventType: string; formattedBody: string; idempotencySuffix: string },
  enqueueFn: (body: string, idempotencyKey: string) => EnqueueWriteResult,
): MirrorResult {
  try {
    // Check last comment timestamp for this run
    const lastComment = db.prepare(`
      SELECT MAX(created_at) as last_at
      FROM github_writes
      WHERE run_id = ? AND kind = 'comment' AND status != 'cancelled'
    `).get(runId) as { last_at: string | null } | undefined;

    const now = new Date();
    const lastAt = lastComment?.last_at !== undefined && lastComment.last_at !== null
      ? new Date(lastComment.last_at)
      : null;

    const secondsSinceLast = lastAt !== null
      ? (now.getTime() - lastAt.getTime()) / 1000
      : Infinity;

    if (secondsSinceLast < RATE_LIMIT_SECONDS) {
      // Rate limited — defer this event
      return deferEvent(db, runId, event);
    }

    // Allowed — flush deferred events and coalesce with current
    const deferred = flushDeferredEvents(db, runId);

    let body: string;
    let idempotencyKey: string;

    if (deferred.length > 0) {
      // Coalesce deferred events with current event
      const allBodies = [
        ...deferred.map((d) => d.formattedBody),
        event.formattedBody,
      ];
      body = allBodies.join('\n\n---\n\n');
      // Use current event's idempotency suffix for the coalesced comment
      idempotencyKey = event.idempotencySuffix;
    } else {
      body = event.formattedBody;
      idempotencyKey = event.idempotencySuffix;
    }

    const result = enqueueFn(body, idempotencyKey);

    return {
      enqueued: result.isNew,
      githubWriteId: result.githubWriteId,
      deferred: false,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    log.error({ runId, error: message }, 'Rate limiter error');
    return {
      enqueued: false,
      deferred: false,
      error: message,
    };
  }
}

/**
 * Defer an event for later posting.
 */
function deferEvent(
  db: Database,
  runId: string,
  event: { eventType: string; formattedBody: string; idempotencySuffix: string },
): MirrorResult {
  try {
    const id = generateDeferredEventId();
    const now = new Date().toISOString();

    db.prepare(`
      INSERT OR IGNORE INTO mirror_deferred_events (
        deferred_event_id, run_id, event_type, formatted_body, idempotency_suffix, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, runId, event.eventType, event.formattedBody, event.idempotencySuffix, now);

    log.debug({ runId, eventType: event.eventType }, 'Event deferred due to rate limit');

    return { enqueued: false, deferred: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    log.error({ runId, error: message }, 'Failed to defer event');
    return { enqueued: false, deferred: false, error: message };
  }
}

/**
 * Flush and delete deferred events for a run, returning them in chronological order.
 */
function flushDeferredEvents(db: Database, runId: string): DeferredEvent[] {
  const rows = db.prepare(`
    SELECT * FROM mirror_deferred_events
    WHERE run_id = ?
    ORDER BY created_at ASC
  `).all(runId) as DeferredRow[];

  if (rows.length === 0) {
    return [];
  }

  // Delete flushed events
  db.prepare('DELETE FROM mirror_deferred_events WHERE run_id = ?').run(runId);

  log.debug({ runId, count: rows.length }, 'Flushed deferred events');

  return rows.map((row) => ({
    deferredEventId: row.deferred_event_id,
    runId: row.run_id,
    eventType: row.event_type,
    formattedBody: row.formatted_body,
    idempotencySuffix: row.idempotency_suffix,
    createdAt: row.created_at,
  }));
}
