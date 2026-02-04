/**
 * Events Module
 *
 * Handles event normalization, persistence, and querying.
 * Events are the core of Conductor's audit trail and state machine.
 */

import type { Database } from 'better-sqlite3';
import { createLogger } from '../logger/index';
import type { EventClass, EventSource } from '../types/index';

const log = createLogger({ name: 'conductor:events' });

// =============================================================================
// Normalized Event Types
// =============================================================================

/**
 * Normalized inbound event types from GitHub webhooks
 */
export type InboundEventType =
  // Installation events
  | 'installation.created'
  | 'installation.deleted'
  | 'installation.suspend'
  | 'installation.unsuspend'
  | 'installation_repositories.added'
  | 'installation_repositories.removed'
  // Issue events
  | 'issue.opened'
  | 'issue.edited'
  | 'issue.closed'
  | 'issue.reopened'
  | 'issue.assigned'
  | 'issue.unassigned'
  | 'issue.labeled'
  | 'issue.unlabeled'
  // Issue comment events
  | 'issue_comment.created'
  | 'issue_comment.edited'
  | 'issue_comment.deleted'
  // Pull request events
  | 'pr.opened'
  | 'pr.edited'
  | 'pr.closed'
  | 'pr.merged'
  | 'pr.reopened'
  | 'pr.synchronize'
  | 'pr.ready_for_review'
  | 'pr.converted_to_draft'
  // Pull request review events
  | 'pr.review_submitted'
  | 'pr.review_dismissed'
  // Push events
  | 'push.received'
  // Check events
  | 'check_suite.completed'
  | 'check_run.completed';

/**
 * Internal event types (decisions, signals)
 */
export type InternalEventType =
  // Phase transitions
  | 'phase.transitioned'
  // Agent events
  | 'agent.started'
  | 'agent.completed'
  | 'agent.failed'
  // Gate events
  | 'gate.evaluated'
  | 'gate.passed'
  | 'gate.failed'
  // Operator events
  | 'operator.action'
  // System events
  | 'system.timeout'
  | 'system.retry';

export type NormalizedEventType = InboundEventType | InternalEventType;

// =============================================================================
// Event Record Types
// =============================================================================

/**
 * Event record for persistence
 */
export interface EventRecord {
  eventId: string;
  projectId: string;
  repoId?: string;
  taskId?: string;
  runId?: string;
  type: NormalizedEventType;
  class: EventClass;
  payload: Record<string, unknown>;
  sequence?: number;
  idempotencyKey: string;
  createdAt: string;
  processedAt?: string;
  causationId?: string;
  correlationId?: string;
  source: EventSource;
}

/**
 * Input for creating a new event
 */
export interface CreateEventInput {
  projectId: string;
  repoId?: string;
  taskId?: string;
  runId?: string;
  type: NormalizedEventType;
  class: EventClass;
  payload: Record<string, unknown>;
  idempotencyKey: string;
  causationId?: string;
  correlationId?: string;
  source: EventSource;
  /** When provided, use this sequence instead of auto-allocating. Used by the orchestrator. */
  sequence?: number;
}

// =============================================================================
// Webhook Normalization
// =============================================================================

/**
 * Result of normalizing a webhook
 */
export interface NormalizedWebhook {
  eventType: NormalizedEventType;
  class: EventClass;
  payload: Record<string, unknown>;
  idempotencyKey: string;
  repoNodeId?: string;
  issueNodeId?: string;
  prNodeId?: string;
}

/**
 * Normalize a GitHub webhook into an internal event
 */
export function normalizeWebhook(
  deliveryId: string,
  githubEventType: string,
  action: string | undefined,
  payloadSummary: Record<string, unknown>
): NormalizedWebhook | null {
  const baseKey = `webhook:${deliveryId}`;

  // Extract common fields
  const repo = payloadSummary['repository'] as Record<string, unknown> | undefined;
  const repoNodeId = repo?.['node_id'] as string | undefined;

  switch (githubEventType) {
    case 'issues': {
      const issue = payloadSummary['issue'] as Record<string, unknown> | undefined;
      const issueNodeId = issue?.['node_id'] as string | undefined;

      const eventType = mapIssueAction(action);
      if (eventType === null) return null;

      return {
        eventType,
        class: 'fact',
        payload: {
          issue: issue,
          action,
        },
        idempotencyKey: `${baseKey}:issue:${action}`,
        repoNodeId,
        issueNodeId,
      };
    }

    case 'issue_comment': {
      const issue = payloadSummary['issue'] as Record<string, unknown> | undefined;
      const issueNodeId = issue?.['node_id'] as string | undefined;
      const comment = payloadSummary['comment'] as Record<string, unknown> | undefined;

      const eventType = mapIssueCommentAction(action);
      if (eventType === null) return null;

      return {
        eventType,
        class: 'fact',
        payload: {
          issue,
          comment,
          action,
        },
        idempotencyKey: `${baseKey}:comment:${String(comment?.['id'] ?? 'unknown')}`,
        repoNodeId,
        issueNodeId,
      };
    }

    case 'pull_request': {
      const pr = payloadSummary['pull_request'] as Record<string, unknown> | undefined;
      const prNodeId = pr?.['node_id'] as string | undefined;
      const merged = pr?.['merged'] as boolean | undefined;

      const eventType = mapPullRequestAction(action, merged);
      if (eventType === null) return null;

      return {
        eventType,
        class: 'fact',
        payload: {
          pull_request: pr,
          action,
          merged,
        },
        idempotencyKey: `${baseKey}:pr:${action}${merged === true ? ':merged' : ''}`,
        repoNodeId,
        prNodeId,
      };
    }

    case 'pull_request_review': {
      const pr = payloadSummary['pull_request'] as Record<string, unknown> | undefined;
      const prNodeId = pr?.['node_id'] as string | undefined;
      const review = payloadSummary['review'] as Record<string, unknown> | undefined;

      const eventType = mapPullRequestReviewAction(action);
      if (eventType === null) return null;

      return {
        eventType,
        class: 'fact',
        payload: {
          pull_request: pr,
          review,
          action,
        },
        idempotencyKey: `${baseKey}:review:${String(review?.['id'] ?? 'unknown')}`,
        repoNodeId,
        prNodeId,
      };
    }

    case 'push': {
      return {
        eventType: 'push.received',
        class: 'fact',
        payload: {
          ref: payloadSummary['ref'],
          before: payloadSummary['before'],
          after: payloadSummary['after'],
          commits_count: payloadSummary['commits_count'],
        },
        idempotencyKey: `${baseKey}:push:${String(payloadSummary['after'] ?? 'unknown')}`,
        repoNodeId,
      };
    }

    case 'check_suite': {
      const checkSuite = payloadSummary['check_suite'] as Record<string, unknown> | undefined;
      if (action !== 'completed') return null;

      return {
        eventType: 'check_suite.completed',
        class: 'fact',
        payload: {
          check_suite: checkSuite,
          action,
        },
        idempotencyKey: `${baseKey}:check_suite:${String(checkSuite?.['id'] ?? 'unknown')}`,
        repoNodeId,
      };
    }

    case 'check_run': {
      const checkRun = payloadSummary['check_run'] as Record<string, unknown> | undefined;
      if (action !== 'completed') return null;

      return {
        eventType: 'check_run.completed',
        class: 'fact',
        payload: {
          check_run: checkRun,
          action,
        },
        idempotencyKey: `${baseKey}:check_run:${String(checkRun?.['id'] ?? 'unknown')}`,
        repoNodeId,
      };
    }

    case 'installation': {
      const installation = payloadSummary['installation'] as Record<string, unknown> | undefined;
      const installationId = installation?.['id'] as number | undefined;

      const eventType = mapInstallationAction(action);
      if (eventType === null) return null;

      return {
        eventType,
        class: 'fact',
        payload: {
          installation,
          action,
          sender: payloadSummary['sender'],
        },
        idempotencyKey: `${baseKey}:installation:${String(installationId ?? 'unknown')}:${action}`,
      };
    }

    case 'installation_repositories': {
      const installation = payloadSummary['installation'] as Record<string, unknown> | undefined;
      const installationId = installation?.['id'] as number | undefined;
      const repositoriesAdded = payloadSummary['repositories_added'] as Array<Record<string, unknown>> | undefined;
      const repositoriesRemoved = payloadSummary['repositories_removed'] as Array<Record<string, unknown>> | undefined;

      const eventType = mapInstallationRepositoriesAction(action);
      if (eventType === null) return null;

      return {
        eventType,
        class: 'fact',
        payload: {
          installation,
          repositories_added: repositoriesAdded,
          repositories_removed: repositoriesRemoved,
          action,
        },
        idempotencyKey: `${baseKey}:installation_repos:${String(installationId ?? 'unknown')}:${action}`,
      };
    }

    default:
      log.debug({ githubEventType, action }, 'Unhandled webhook event type');
      return null;
  }
}

function mapInstallationAction(action: string | undefined): InboundEventType | null {
  switch (action) {
    case 'created': return 'installation.created';
    case 'deleted': return 'installation.deleted';
    case 'suspend': return 'installation.suspend';
    case 'unsuspend': return 'installation.unsuspend';
    default: return null;
  }
}

function mapInstallationRepositoriesAction(action: string | undefined): InboundEventType | null {
  switch (action) {
    case 'added': return 'installation_repositories.added';
    case 'removed': return 'installation_repositories.removed';
    default: return null;
  }
}

function mapIssueAction(action: string | undefined): InboundEventType | null {
  switch (action) {
    case 'opened': return 'issue.opened';
    case 'edited': return 'issue.edited';
    case 'closed': return 'issue.closed';
    case 'reopened': return 'issue.reopened';
    case 'assigned': return 'issue.assigned';
    case 'unassigned': return 'issue.unassigned';
    case 'labeled': return 'issue.labeled';
    case 'unlabeled': return 'issue.unlabeled';
    default: return null;
  }
}

function mapIssueCommentAction(action: string | undefined): InboundEventType | null {
  switch (action) {
    case 'created': return 'issue_comment.created';
    case 'edited': return 'issue_comment.edited';
    case 'deleted': return 'issue_comment.deleted';
    default: return null;
  }
}

function mapPullRequestAction(
  action: string | undefined,
  merged: boolean | undefined
): InboundEventType | null {
  if (action === 'closed' && merged === true) {
    return 'pr.merged';
  }

  switch (action) {
    case 'opened': return 'pr.opened';
    case 'edited': return 'pr.edited';
    case 'closed': return 'pr.closed';
    case 'reopened': return 'pr.reopened';
    case 'synchronize': return 'pr.synchronize';
    case 'ready_for_review': return 'pr.ready_for_review';
    case 'converted_to_draft': return 'pr.converted_to_draft';
    default: return null;
  }
}

function mapPullRequestReviewAction(action: string | undefined): InboundEventType | null {
  switch (action) {
    case 'submitted': return 'pr.review_submitted';
    case 'dismissed': return 'pr.review_dismissed';
    default: return null;
  }
}

// =============================================================================
// Event Persistence
// =============================================================================

/**
 * Generate a unique event ID
 */
export function generateEventId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 10);
  return `evt_${timestamp}${random}`;
}

/**
 * Create and persist an event
 *
 * Returns null if the event already exists (idempotent).
 */
export function createEvent(
  db: Database,
  input: CreateEventInput
): EventRecord | null {
  // Enforce phase.transitioned exclusivity: only orchestrator source allowed
  if (input.type === 'phase.transitioned' && input.source !== 'orchestrator') {
    throw new Error('phase.transitioned events can only be created with source=orchestrator');
  }

  const eventId = generateEventId();
  const createdAt = new Date().toISOString();

  // Check for existing event with same idempotency key
  const existingStmt = db.prepare(
    'SELECT event_id FROM events WHERE idempotency_key = ?'
  );
  const existing = existingStmt.get(input.idempotencyKey) as { event_id: string } | undefined;

  if (existing !== undefined) {
    log.debug(
      { idempotencyKey: input.idempotencyKey, existingEventId: existing.event_id },
      'Duplicate event, skipping'
    );
    return null;
  }

  // Use provided sequence (from orchestrator) or auto-allocate for run events
  let sequence: number | undefined;
  if (input.sequence !== undefined) {
    sequence = input.sequence;
  } else if (input.runId !== undefined) {
    const seqStmt = db.prepare(
      'SELECT COALESCE(MAX(sequence), 0) + 1 as next_seq FROM events WHERE run_id = ?'
    );
    const seqResult = seqStmt.get(input.runId) as { next_seq: number };
    sequence = seqResult.next_seq;
  }

  const insertStmt = db.prepare(`
    INSERT INTO events (
      event_id, project_id, repo_id, task_id, run_id,
      type, class, payload_json, sequence, idempotency_key,
      created_at, causation_id, correlation_id, source
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  insertStmt.run(
    eventId,
    input.projectId,
    input.repoId ?? null,
    input.taskId ?? null,
    input.runId ?? null,
    input.type,
    input.class,
    JSON.stringify(input.payload),
    sequence ?? null,
    input.idempotencyKey,
    createdAt,
    input.causationId ?? null,
    input.correlationId ?? null,
    input.source
  );

  log.info(
    { eventId, type: input.type, class: input.class, runId: input.runId },
    'Event created'
  );

  return {
    eventId,
    projectId: input.projectId,
    repoId: input.repoId,
    taskId: input.taskId,
    runId: input.runId,
    type: input.type,
    class: input.class,
    payload: input.payload,
    sequence,
    idempotencyKey: input.idempotencyKey,
    createdAt,
    causationId: input.causationId,
    correlationId: input.correlationId,
    source: input.source,
  };
}

/**
 * Get an event by ID
 */
export function getEvent(db: Database, eventId: string): EventRecord | null {
  const stmt = db.prepare('SELECT * FROM events WHERE event_id = ?');
  const row = stmt.get(eventId) as Record<string, unknown> | undefined;

  if (row === undefined) return null;

  return rowToEvent(row);
}

/**
 * List events for a run
 */
export function listRunEvents(
  db: Database,
  runId: string,
  options?: { limit?: number; offset?: number }
): EventRecord[] {
  const limit = options?.limit ?? 100;
  const offset = options?.offset ?? 0;

  const stmt = db.prepare(
    'SELECT * FROM events WHERE run_id = ? ORDER BY sequence ASC LIMIT ? OFFSET ?'
  );
  const rows = stmt.all(runId, limit, offset) as Array<Record<string, unknown>>;

  return rows.map(rowToEvent);
}

/**
 * List events for a project
 */
export function listProjectEvents(
  db: Database,
  projectId: string,
  options?: { limit?: number; offset?: number; type?: string }
): EventRecord[] {
  const limit = options?.limit ?? 100;
  const offset = options?.offset ?? 0;

  let sql = 'SELECT * FROM events WHERE project_id = ?';
  const params: (string | number)[] = [projectId];

  if (options?.type !== undefined) {
    sql += ' AND type = ?';
    params.push(options.type);
  }

  sql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);

  const stmt = db.prepare(sql);
  const rows = stmt.all(...params) as Array<Record<string, unknown>>;

  return rows.map(rowToEvent);
}

/**
 * Mark an event as processed
 */
export function markEventProcessed(db: Database, eventId: string): void {
  const stmt = db.prepare(
    'UPDATE events SET processed_at = ? WHERE event_id = ?'
  );
  stmt.run(new Date().toISOString(), eventId);
}

function rowToEvent(row: Record<string, unknown>): EventRecord {
  return {
    eventId: row['event_id'] as string,
    projectId: row['project_id'] as string,
    repoId: row['repo_id'] as string | undefined,
    taskId: row['task_id'] as string | undefined,
    runId: row['run_id'] as string | undefined,
    type: row['type'] as NormalizedEventType,
    class: row['class'] as EventClass,
    payload: JSON.parse(row['payload_json'] as string) as Record<string, unknown>,
    sequence: row['sequence'] as number | undefined,
    idempotencyKey: row['idempotency_key'] as string,
    createdAt: row['created_at'] as string,
    processedAt: row['processed_at'] as string | undefined,
    causationId: row['causation_id'] as string | undefined,
    correlationId: row['correlation_id'] as string | undefined,
    source: (row['source'] as EventSource) ?? 'webhook',
  };
}
