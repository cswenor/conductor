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
import { formatCoalescedComment, truncateComment } from './formatter.ts';

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
  /** Concise one-line description used for coalesced comments */
  summary: string;
  idempotencySuffix: string;
  createdAt: string;
}

interface DeferredRow {
  deferred_event_id: string;
  run_id: string;
  event_type: string;
  formatted_body: string;
  summary: string;
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
 * Context for structured coalesced comment formatting.
 * When provided, coalesced comments use the structured format from formatCoalescedComment.
 */
export interface CoalesceContext {
  runNumber: number;
  runId: string;
  conductorBaseUrl?: string;
}

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
 * @param coalesceCtx - Optional context for structured coalesced formatting
 */
export function checkAndMirror(
  db: Database,
  runId: string,
  event: {
    eventType: string;
    formattedBody: string;
    /** Concise one-line description for coalesced comments */
    summary: string;
    idempotencySuffix: string;
  },
  enqueueFn: (body: string, idempotencyKey: string) => EnqueueWriteResult,
  coalesceCtx?: CoalesceContext,
): MirrorResult {
  try {
    // Check last comment timestamp for this run.
    // Intentionally includes queued/pending/failed writes (not just completed).
    // This prevents comment floods even when writes are still in-flight or retrying.
    // Only cancelled writes are excluded since they'll never be posted.
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

    // Allowed — read deferred events and coalesce with current
    const deferred = getDeferredEvents(db, runId);

    let body: string;
    let idempotencyKey: string;

    if (deferred.length > 0) {
      // Coalesce deferred events with current event using concise summaries
      if (coalesceCtx !== undefined) {
        const events = [
          ...deferred.map((d) => ({ timestamp: d.createdAt, body: d.summary })),
          { timestamp: new Date().toISOString(), body: event.summary },
        ];
        body = truncateComment(formatCoalescedComment(
          coalesceCtx.runNumber,
          events,
          coalesceCtx.conductorBaseUrl,
          coalesceCtx.runId,
        ));
      } else {
        // Fallback: concatenate summaries (for tests without full context)
        const allSummaries = [
          ...deferred.map((d) => d.summary || d.formattedBody),
          event.summary || event.formattedBody,
        ];
        body = allSummaries.join('\n\n---\n\n');
      }
      // Use current event's idempotency suffix for the coalesced comment
      idempotencyKey = event.idempotencySuffix;
    } else {
      body = event.formattedBody;
      idempotencyKey = event.idempotencySuffix;
    }

    const result = enqueueFn(body, idempotencyKey);

    // Delete deferred events only AFTER a new write was created.
    // If enqueueFn returned an idempotent duplicate (isNew === false), deferred
    // events are preserved so they can be flushed on the next successful post.
    if (deferred.length > 0 && result.isNew) {
      deleteDeferredEvents(db, runId);
    }

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
  event: { eventType: string; formattedBody: string; summary: string; idempotencySuffix: string },
): MirrorResult {
  try {
    const id = generateDeferredEventId();
    const now = new Date().toISOString();

    db.prepare(`
      INSERT OR IGNORE INTO mirror_deferred_events (
        deferred_event_id, run_id, event_type, formatted_body, summary, idempotency_suffix, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, runId, event.eventType, event.formattedBody, event.summary, event.idempotencySuffix, now);

    log.debug({ runId, eventType: event.eventType }, 'Event deferred due to rate limit');

    return { enqueued: false, deferred: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    log.error({ runId, error: message }, 'Failed to defer event');
    return { enqueued: false, deferred: false, error: message };
  }
}

/**
 * Read deferred events for a run in chronological order (does NOT delete them).
 */
function getDeferredEvents(db: Database, runId: string): DeferredEvent[] {
  const rows = db.prepare(`
    SELECT * FROM mirror_deferred_events
    WHERE run_id = ?
    ORDER BY created_at ASC
  `).all(runId) as DeferredRow[];

  if (rows.length === 0) {
    return [];
  }

  return rows.map((row) => ({
    deferredEventId: row.deferred_event_id,
    runId: row.run_id,
    eventType: row.event_type,
    formattedBody: row.formatted_body,
    summary: row.summary,
    idempotencySuffix: row.idempotency_suffix,
    createdAt: row.created_at,
  }));
}

/**
 * Delete all deferred events for a run. Called after successful enqueue.
 */
function deleteDeferredEvents(db: Database, runId: string): void {
  db.prepare('DELETE FROM mirror_deferred_events WHERE run_id = ?').run(runId);
  log.debug({ runId }, 'Deleted deferred events after successful enqueue');
}

/**
 * Flush stale deferred events for runs that haven't had a mirror call recently.
 * Used by the periodic orphan-flush job to prevent deferred events from being
 * stranded indefinitely.
 *
 * Returns the number of runs flushed.
 */
export function flushStaleDeferredEvents(
  db: Database,
  enqueueFnForRun: (runId: string) => ((body: string, idempotencyKey: string) => EnqueueWriteResult) | null,
  staleThresholdSeconds: number = 60,
): number {
  // Find runs with deferred events older than the threshold
  const staleRuns = db.prepare(`
    SELECT DISTINCT run_id FROM mirror_deferred_events
    WHERE created_at <= datetime('now', '-' || ? || ' seconds')
  `).all(staleThresholdSeconds) as Array<{ run_id: string }>;

  let flushedCount = 0;

  for (const row of staleRuns) {
    const runId = row.run_id;
    const deferred = getDeferredEvents(db, runId);
    if (deferred.length === 0) continue;

    const enqueueFn = enqueueFnForRun(runId);
    if (enqueueFn === null) {
      log.debug({ runId }, 'No enqueue function for stale run — skipping flush');
      continue;
    }

    const body = deferred.map((d) => d.summary || d.formattedBody).join('\n\n---\n\n');
    const idempotencyKey = `${runId}:mirror:flush:${Date.now()}`;

    try {
      const flushResult = enqueueFn(body, idempotencyKey);
      if (flushResult.isNew) {
        deleteDeferredEvents(db, runId);
        flushedCount++;
        log.info({ runId, eventCount: deferred.length }, 'Flushed stale deferred events');
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      log.error({ runId, error: message }, 'Failed to flush stale deferred events');
    }
  }

  return flushedCount;
}
