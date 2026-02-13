/**
 * DB-only cleanup dispatch.
 *
 * Extracted from processCleanup so the switch-case wiring
 * can be tested with a real in-memory database.
 */

import { pruneStreamEvents, pruneAgentMessages, getDatabase } from '@conductor/shared';

type Db = ReturnType<typeof getDatabase>;

export interface DbCleanupResult {
  type: string;
  pruned: number;
}

/**
 * Dispatch DB-only cleanup operations.
 * Returns the result, or null if the type is not a DB-only cleanup.
 */
export function dispatchDbCleanup(
  db: Db,
  type: string,
): DbCleanupResult | null {
  switch (type) {
    case 'stream_events':
      return { type, pruned: pruneStreamEvents(db) };
    case 'agent_messages':
      return { type, pruned: pruneAgentMessages(db, 30) };
    default:
      return null;
  }
}
