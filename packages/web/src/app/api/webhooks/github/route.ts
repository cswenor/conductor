/**
 * GitHub Webhook Receiver
 *
 * Receives webhooks from GitHub, verifies signatures, persists to database,
 * and enqueues jobs for processing.
 *
 * Key invariant: Webhooks are persisted BEFORE any processing to ensure
 * crash-safe delivery (no lost webhooks).
 */

import { NextRequest, NextResponse } from 'next/server';
import {
  verifyWebhookSignature,
  isGitHubAppInitialized,
  initGitHubApp,
  persistWebhookDelivery,
  updateWebhookStatus,
  extractPayloadSummary,
  computePayloadHash,
  createLogger,
  type WebhookDelivery,
} from '@conductor/shared';
import { getConfig } from '@/lib/config';
import { ensureBootstrap, getDb, getQueues } from '@/lib/bootstrap';

const log = createLogger({ name: 'conductor:webhook-receiver' });

/**
 * Ensure GitHub App is initialized
 */
function ensureGitHubApp(): boolean {
  if (isGitHubAppInitialized()) {
    return true;
  }

  const config = getConfig();

  // Check if GitHub credentials are configured
  if (
    config.githubAppId === '' ||
    config.githubPrivateKey === '' ||
    config.githubWebhookSecret === ''
  ) {
    log.warn('GitHub App credentials not configured');
    return false;
  }

  try {
    initGitHubApp({
      appId: config.githubAppId,
      privateKey: config.githubPrivateKey,
      webhookSecret: config.githubWebhookSecret,
    });
    return true;
  } catch (err) {
    log.error(
      { error: err instanceof Error ? err.message : 'Unknown error' },
      'Failed to initialize GitHub App'
    );
    return false;
  }
}

/**
 * POST /api/webhooks/github
 *
 * Receives GitHub webhook deliveries.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const receivedAt = new Date().toISOString();

  // Extract headers
  const deliveryId = request.headers.get('X-GitHub-Delivery');
  const eventType = request.headers.get('X-GitHub-Event');
  const signature = request.headers.get('X-Hub-Signature-256');

  // Validate required headers
  if (deliveryId === null || eventType === null) {
    log.warn({ deliveryId, eventType }, 'Missing required GitHub headers');
    return NextResponse.json(
      { error: 'Missing required headers' },
      { status: 400 }
    );
  }

  log.info({ deliveryId, eventType }, 'Webhook received');

  // Get raw body for signature verification
  const rawBody = await request.text();

  // Ensure bootstrap is done
  try {
    await ensureBootstrap();
  } catch (err) {
    log.error(
      { error: err instanceof Error ? err.message : 'Unknown error' },
      'Bootstrap failed'
    );
    return NextResponse.json(
      { error: 'Service unavailable' },
      { status: 503 }
    );
  }

  // Verify signature if configured
  let signatureValid = false;
  const githubConfigured = ensureGitHubApp();

  if (githubConfigured && signature !== null) {
    try {
      signatureValid = await verifyWebhookSignature(rawBody, signature);
      if (!signatureValid) {
        log.warn({ deliveryId }, 'Invalid webhook signature');
      }
    } catch (err) {
      log.error(
        { deliveryId, error: err instanceof Error ? err.message : 'Unknown error' },
        'Signature verification error'
      );
    }
  } else if (!githubConfigured) {
    // In development without GitHub config, accept all webhooks
    log.debug({ deliveryId }, 'Skipping signature verification (GitHub not configured)');
    signatureValid = true;
  }

  // Parse payload
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(rawBody) as Record<string, unknown>;
  } catch {
    log.error({ deliveryId }, 'Invalid JSON payload');
    return NextResponse.json(
      { error: 'Invalid JSON payload' },
      { status: 400 }
    );
  }

  // Extract summary and compute hash
  const payloadSummary = extractPayloadSummary(eventType, payload);
  const payloadHash = computePayloadHash(rawBody);

  // Extract common fields
  const action = payload['action'] as string | undefined;
  const repository = payload['repository'] as Record<string, unknown> | undefined;
  const repositoryNodeId = repository?.['node_id'] as string | undefined;
  const sender = payload['sender'] as Record<string, unknown> | undefined;
  const senderId = sender?.['id'] as number | undefined;

  // Build delivery record
  const delivery: WebhookDelivery = {
    deliveryId,
    eventType,
    action,
    repositoryNodeId,
    senderId,
    payloadSummary,
    payloadHash,
    signatureValid,
    status: 'received',
    receivedAt,
  };

  // Persist webhook FIRST (crash-safe)
  const db = await getDb();
  const persistResult = persistWebhookDelivery(db, delivery);

  if (!persistResult.isNew) {
    // Duplicate delivery - return success (idempotent)
    log.info({ deliveryId }, 'Duplicate webhook delivery, returning success');
    return NextResponse.json({ received: true, duplicate: true });
  }

  // Reject if signature is invalid (after persisting for audit)
  if (!signatureValid && githubConfigured) {
    updateWebhookStatus(db, deliveryId, 'failed', {
      error: 'Invalid signature',
    });
    return NextResponse.json(
      { error: 'Invalid signature' },
      { status: 401 }
    );
  }

  // Check if this event type should be processed or ignored
  const ignoredEvents = ['ping', 'installation', 'installation_repositories'];
  if (ignoredEvents.includes(eventType)) {
    updateWebhookStatus(db, deliveryId, 'ignored', {
      ignoreReason: `Event type '${eventType}' is not processed`,
      processedAt: new Date().toISOString(),
    });
    log.info({ deliveryId, eventType }, 'Webhook ignored');
    return NextResponse.json({ received: true, ignored: true });
  }

  // Enqueue job for async processing
  try {
    const queueManager = await getQueues();
    const job = await queueManager.addJob('webhooks', deliveryId, {
      deliveryId,
      eventType,
      action,
      repositoryNodeId,
      payloadSummary,
    });

    // Update status to processing
    updateWebhookStatus(db, deliveryId, 'processing', {
      jobId: job.id ?? deliveryId,
    });

    log.info({ deliveryId, jobId: job.id }, 'Webhook job enqueued');
  } catch (err) {
    log.error(
      { deliveryId, error: err instanceof Error ? err.message : 'Unknown error' },
      'Failed to enqueue webhook job'
    );
    updateWebhookStatus(db, deliveryId, 'failed', {
      error: `Failed to enqueue: ${err instanceof Error ? err.message : 'Unknown error'}`,
    });
    return NextResponse.json(
      { error: 'Failed to process webhook' },
      { status: 500 }
    );
  }

  return NextResponse.json({ received: true });
}

/**
 * GET /api/webhooks/github
 *
 * Health check / info endpoint for webhooks.
 */
export function GET(): NextResponse {
  const config = getConfig();
  const githubConfigured =
    config.githubAppId !== '' &&
    config.githubPrivateKey !== '' &&
    config.githubWebhookSecret !== '';

  return NextResponse.json({
    status: 'ok',
    github_configured: githubConfigured,
    endpoint: '/api/webhooks/github',
    supported_events: [
      'issues',
      'issue_comment',
      'pull_request',
      'pull_request_review',
      'push',
      'check_suite',
      'check_run',
    ],
  });
}
