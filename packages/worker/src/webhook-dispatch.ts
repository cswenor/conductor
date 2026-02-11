/**
 * Webhook dispatch for PR events.
 *
 * Extracted from processWebhook so that PR merge/state handling runs
 * regardless of whether the webhook created a new event or was a duplicate.
 * This closes a P0 crash-retry gap: on duplicate webhook delivery after
 * crash recovery, the dispatch still fires.
 */

import type { TransitionInput, TransitionResult, getDatabase } from '@conductor/shared';
import { handlePrMerged, handlePrStateChange } from './merge-handler.ts';

type Db = ReturnType<typeof getDatabase>;
type MirrorFn = (input: TransitionInput, result: TransitionResult) => void;
type ScheduleCleanupFn = (runId: string) => Promise<void>;

export async function dispatchPrWebhook(
  db: Db,
  normalized: { eventType: string; prNodeId?: string },
  mirrorFn: MirrorFn,
  scheduleCleanupFn: ScheduleCleanupFn,
): Promise<void> {
  if (normalized.prNodeId === undefined) return;

  if (normalized.eventType === 'pr.merged') {
    await handlePrMerged(db, normalized.prNodeId, mirrorFn, scheduleCleanupFn);
  } else if (normalized.eventType === 'pr.closed') {
    handlePrStateChange(db, normalized.prNodeId, 'closed');
  } else if (normalized.eventType === 'pr.reopened') {
    handlePrStateChange(db, normalized.prNodeId, 'open');
  }
}
