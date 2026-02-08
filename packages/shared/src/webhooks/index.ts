/**
 * Webhook Service Module
 *
 * Handles webhook persistence and job enqueuing.
 * Ensures webhooks are stored before any processing (crash-safe).
 */

import type { Database } from 'better-sqlite3';
import { createLogger } from '../logger/index.ts';
import { redact } from '../redact/index.ts';
import type { WebhookStatus } from '../types/index.ts';

const log = createLogger({ name: 'conductor:webhooks' });

/**
 * Webhook delivery record for persistence
 */
export interface WebhookDelivery {
  deliveryId: string;
  eventType: string;
  action?: string;
  repositoryNodeId?: string;
  senderId?: number;
  payloadSummary: Record<string, unknown>;
  payloadHash: string;
  signatureValid: boolean;
  status: WebhookStatus;
  receivedAt: string;
}

/**
 * Result of persisting a webhook
 */
export interface PersistWebhookResult {
  deliveryId: string;
  isNew: boolean;
  status: WebhookStatus;
}

/**
 * Extract a summary from a webhook payload
 *
 * This extracts only the essential fields needed for processing,
 * avoiding storage of potentially sensitive data.
 */
export function extractPayloadSummary(
  eventType: string,
  payload: Record<string, unknown>
): Record<string, unknown> {
  const summary: Record<string, unknown> = {};

  // Common fields
  if (payload['action'] !== undefined) {
    summary['action'] = payload['action'];
  }

  // Repository info
  const repo = payload['repository'] as Record<string, unknown> | undefined;
  if (repo !== undefined) {
    summary['repository'] = {
      node_id: repo['node_id'],
      full_name: repo['full_name'],
      default_branch: repo['default_branch'],
    };
  }

  // Sender info
  const sender = payload['sender'] as Record<string, unknown> | undefined;
  if (sender !== undefined) {
    summary['sender'] = {
      id: sender['id'],
      login: sender['login'],
      type: sender['type'],
    };
  }

  // Installation info
  const installation = payload['installation'] as Record<string, unknown> | undefined;
  if (installation !== undefined) {
    summary['installation'] = {
      id: installation['id'],
    };
  }

  // Event-specific fields
  switch (eventType) {
    case 'issues':
    case 'issue_comment': {
      const issue = payload['issue'] as Record<string, unknown> | undefined;
      if (issue !== undefined) {
        summary['issue'] = {
          node_id: issue['node_id'],
          number: issue['number'],
          title: issue['title'],
          state: issue['state'],
        };
      }
      if (eventType === 'issue_comment') {
        const comment = payload['comment'] as Record<string, unknown> | undefined;
        if (comment !== undefined) {
          summary['comment'] = {
            id: comment['id'],
            node_id: comment['node_id'],
          };
        }
      }
      break;
    }

    case 'pull_request':
    case 'pull_request_review': {
      const pr = payload['pull_request'] as Record<string, unknown> | undefined;
      if (pr !== undefined) {
        summary['pull_request'] = {
          node_id: pr['node_id'],
          number: pr['number'],
          title: pr['title'],
          state: pr['state'],
          merged: pr['merged'],
          head: {
            ref: (pr['head'] as Record<string, unknown> | undefined)?.['ref'],
            sha: (pr['head'] as Record<string, unknown> | undefined)?.['sha'],
          },
          base: {
            ref: (pr['base'] as Record<string, unknown> | undefined)?.['ref'],
          },
        };
      }
      if (eventType === 'pull_request_review') {
        const review = payload['review'] as Record<string, unknown> | undefined;
        if (review !== undefined) {
          summary['review'] = {
            id: review['id'],
            node_id: review['node_id'],
            state: review['state'],
          };
        }
      }
      break;
    }

    case 'push': {
      summary['ref'] = payload['ref'];
      summary['before'] = payload['before'];
      summary['after'] = payload['after'];
      const commits = payload['commits'] as Array<Record<string, unknown>> | undefined;
      if (commits !== undefined) {
        summary['commits_count'] = commits.length;
      }
      break;
    }

    case 'check_suite':
    case 'check_run': {
      const checkSuite = payload['check_suite'] as Record<string, unknown> | undefined;
      if (checkSuite !== undefined) {
        summary['check_suite'] = {
          id: checkSuite['id'],
          node_id: checkSuite['node_id'],
          status: checkSuite['status'],
          conclusion: checkSuite['conclusion'],
        };
      }
      const checkRun = payload['check_run'] as Record<string, unknown> | undefined;
      if (checkRun !== undefined) {
        summary['check_run'] = {
          id: checkRun['id'],
          node_id: checkRun['node_id'],
          name: checkRun['name'],
          status: checkRun['status'],
          conclusion: checkRun['conclusion'],
        };
      }
      break;
    }

    case 'installation': {
      // Extract full installation details for installation events
      const installation = payload['installation'] as Record<string, unknown> | undefined;
      if (installation !== undefined) {
        const account = installation['account'] as Record<string, unknown> | undefined;
        summary['installation'] = {
          id: installation['id'],
          node_id: installation['node_id'],
          account: account !== undefined ? {
            id: account['id'],
            login: account['login'],
            type: account['type'],
            node_id: account['node_id'],
          } : undefined,
          target_type: installation['target_type'],
          permissions: installation['permissions'],
        };
      }
      break;
    }

    case 'installation_repositories': {
      // Extract installation and repository changes
      const installation = payload['installation'] as Record<string, unknown> | undefined;
      if (installation !== undefined) {
        const account = installation['account'] as Record<string, unknown> | undefined;
        summary['installation'] = {
          id: installation['id'],
          node_id: installation['node_id'],
          account: account !== undefined ? {
            id: account['id'],
            login: account['login'],
            type: account['type'],
          } : undefined,
        };
      }
      const repositoriesAdded = payload['repositories_added'] as Array<Record<string, unknown>> | undefined;
      const repositoriesRemoved = payload['repositories_removed'] as Array<Record<string, unknown>> | undefined;
      if (repositoriesAdded !== undefined) {
        summary['repositories_added'] = repositoriesAdded.map(r => ({
          id: r['id'],
          node_id: r['node_id'],
          name: r['name'],
          full_name: r['full_name'],
          private: r['private'],
        }));
      }
      if (repositoriesRemoved !== undefined) {
        summary['repositories_removed'] = repositoriesRemoved.map(r => ({
          id: r['id'],
          node_id: r['node_id'],
          name: r['name'],
          full_name: r['full_name'],
        }));
      }
      break;
    }
  }

  return summary;
}

/**
 * Compute a hash of the payload for deduplication and integrity
 */
export function computePayloadHash(payload: string): string {
  // Use the redact module's hash computation for consistency
  const result = redact({ _raw: payload });
  return result.payloadHash;
}

/**
 * Persist a webhook delivery to the database
 *
 * This is the first thing that happens when a webhook is received.
 * If the delivery already exists (by delivery_id), it's considered a duplicate.
 */
export function persistWebhookDelivery(
  db: Database,
  delivery: WebhookDelivery
): PersistWebhookResult {
  // Use INSERT OR IGNORE to handle race conditions atomically
  // This prevents unique constraint errors when concurrent requests
  // try to insert the same delivery_id
  const insertStmt = db.prepare(`
    INSERT OR IGNORE INTO webhook_deliveries (
      delivery_id,
      event_type,
      action,
      repository_node_id,
      sender_id,
      payload_summary_json,
      payload_hash,
      signature_valid,
      status,
      received_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const result = insertStmt.run(
    delivery.deliveryId,
    delivery.eventType,
    delivery.action ?? null,
    delivery.repositoryNodeId ?? null,
    delivery.senderId ?? null,
    JSON.stringify(delivery.payloadSummary),
    delivery.payloadHash,
    delivery.signatureValid ? 1 : 0,
    delivery.status,
    delivery.receivedAt
  );

  // If changes === 0, the row already existed (INSERT was ignored)
  if (result.changes === 0) {
    // Get the existing status
    const existingStmt = db.prepare(
      'SELECT status FROM webhook_deliveries WHERE delivery_id = ?'
    );
    const existing = existingStmt.get(delivery.deliveryId) as { status: string } | undefined;

    log.info(
      { deliveryId: delivery.deliveryId, existingStatus: existing?.status },
      'Duplicate webhook delivery'
    );

    return {
      deliveryId: delivery.deliveryId,
      isNew: false,
      status: (existing?.status as WebhookStatus) ?? 'received',
    };
  }

  log.info(
    {
      deliveryId: delivery.deliveryId,
      eventType: delivery.eventType,
      action: delivery.action,
    },
    'Webhook delivery persisted'
  );

  return {
    deliveryId: delivery.deliveryId,
    isNew: true,
    status: delivery.status,
  };
}

/**
 * Update webhook delivery status
 */
export function updateWebhookStatus(
  db: Database,
  deliveryId: string,
  status: WebhookStatus,
  options?: {
    jobId?: string;
    error?: string;
    ignoreReason?: string;
    processedAt?: string;
  }
): void {
  const updates: string[] = ['status = ?'];
  const values: (string | null)[] = [status];

  if (options?.jobId !== undefined) {
    updates.push('job_id = ?');
    values.push(options.jobId);
  }
  if (options?.error !== undefined) {
    updates.push('error = ?');
    values.push(options.error);
  }
  if (options?.ignoreReason !== undefined) {
    updates.push('ignore_reason = ?');
    values.push(options.ignoreReason);
  }
  if (options?.processedAt !== undefined) {
    updates.push('processed_at = ?');
    values.push(options.processedAt);
  }

  values.push(deliveryId);

  const stmt = db.prepare(
    `UPDATE webhook_deliveries SET ${updates.join(', ')} WHERE delivery_id = ?`
  );
  stmt.run(...values);
}

/**
 * Get a webhook delivery by ID
 */
export function getWebhookDelivery(
  db: Database,
  deliveryId: string
): WebhookDelivery | null {
  const stmt = db.prepare('SELECT * FROM webhook_deliveries WHERE delivery_id = ?');
  const row = stmt.get(deliveryId) as Record<string, unknown> | undefined;

  if (row === undefined) {
    return null;
  }

  return {
    deliveryId: row['delivery_id'] as string,
    eventType: row['event_type'] as string,
    action: row['action'] as string | undefined,
    repositoryNodeId: row['repository_node_id'] as string | undefined,
    senderId: row['sender_id'] as number | undefined,
    payloadSummary: JSON.parse(row['payload_summary_json'] as string) as Record<string, unknown>,
    payloadHash: row['payload_hash'] as string,
    signatureValid: (row['signature_valid'] as number) === 1,
    status: row['status'] as WebhookStatus,
    receivedAt: row['received_at'] as string,
  };
}

/**
 * List recent webhook deliveries
 */
export function listWebhookDeliveries(
  db: Database,
  options?: {
    status?: WebhookStatus;
    limit?: number;
    offset?: number;
  }
): WebhookDelivery[] {
  const limit = options?.limit ?? 50;
  const offset = options?.offset ?? 0;

  let sql = 'SELECT * FROM webhook_deliveries';
  const params: (string | number)[] = [];

  if (options?.status !== undefined) {
    sql += ' WHERE status = ?';
    params.push(options.status);
  }

  sql += ' ORDER BY received_at DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);

  const stmt = db.prepare(sql);
  const rows = stmt.all(...params) as Array<Record<string, unknown>>;

  return rows.map((row) => ({
    deliveryId: row['delivery_id'] as string,
    eventType: row['event_type'] as string,
    action: row['action'] as string | undefined,
    repositoryNodeId: row['repository_node_id'] as string | undefined,
    senderId: row['sender_id'] as number | undefined,
    payloadSummary: JSON.parse(row['payload_summary_json'] as string) as Record<string, unknown>,
    payloadHash: row['payload_hash'] as string,
    signatureValid: (row['signature_valid'] as number) === 1,
    status: row['status'] as WebhookStatus,
    receivedAt: row['received_at'] as string,
  }));
}
