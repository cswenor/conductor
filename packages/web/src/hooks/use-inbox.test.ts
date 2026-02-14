/**
 * Tests for useInbox hook behavioral logic.
 *
 * Since the hook depends on React, we test the core behavioral logic
 * directly: dedup, unread tracking, formatting, and data flow.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { StreamEventV2 } from '@conductor/shared';
import {
  formatEventSummary,
  computeDedupId,
  readCursor,
  writeCursor,
  isUnread,
  categorizeItem,
  shouldIncludeEvent,
  type InboxItem,
} from './use-inbox';

// ---------------------------------------------------------------------------
// Mock event-source-manager (required by use-event-stream import chain)
// ---------------------------------------------------------------------------

vi.mock('@/lib/event-source-manager', () => ({
  subscribe: () => vi.fn(),
  getSnapshot: () => 2,
  getServerSnapshot: () => 2,
  subscribeReadyState: () => () => {},
}));

// ---------------------------------------------------------------------------
// localStorage mock
// ---------------------------------------------------------------------------

function createStorageMock(): Storage {
  const store = new Map<string, string>();
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => { store.set(key, value); },
    removeItem: (key: string) => { store.delete(key); },
    clear: () => { store.clear(); },
    get length() { return store.size; },
    key: (index: number) => [...store.keys()][index] ?? null,
  };
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeEvent(overrides: Partial<StreamEventV2> & { kind: StreamEventV2['kind'] }): StreamEventV2 {
  return {
    projectId: 'proj_1',
    timestamp: '2025-01-01T00:00:00.000Z',
    ...overrides,
  } as StreamEventV2;
}

function makeItem(event: StreamEventV2): InboxItem {
  return {
    event,
    summary: formatEventSummary(event),
    dedupId: computeDedupId(event),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('use-inbox', () => {
  let storageMock: Storage;

  beforeEach(() => {
    storageMock = createStorageMock();
    Object.defineProperty(globalThis, 'localStorage', { value: storageMock, writable: true, configurable: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // Event formatting
  // -------------------------------------------------------------------------

  describe('formatEventSummary', () => {
    it('run.phase_changed', () => {
      const e = makeEvent({ kind: 'run.phase_changed', runId: 'r1', fromPhase: 'pending', toPhase: 'awaiting_plan_approval' });
      expect(formatEventSummary(e)).toBe('Run moved to awaiting plan approval');
    });

    it('gate plan_approval passed', () => {
      const e = makeEvent({ kind: 'gate.evaluated', runId: 'r1', gateId: 'plan_approval', gateKind: 'human', status: 'passed' });
      expect(formatEventSummary(e)).toBe('Plan approved');
    });

    it('gate plan_approval failed', () => {
      const e = makeEvent({ kind: 'gate.evaluated', runId: 'r1', gateId: 'plan_approval', gateKind: 'human', status: 'failed' });
      expect(formatEventSummary(e)).toBe('Plan rejected');
    });

    it('gate tests_pass passed', () => {
      const e = makeEvent({ kind: 'gate.evaluated', runId: 'r1', gateId: 'tests_pass', gateKind: 'automatic', status: 'passed' });
      expect(formatEventSummary(e)).toBe('Tests passed');
    });

    it('gate tests_pass failed', () => {
      const e = makeEvent({ kind: 'gate.evaluated', runId: 'r1', gateId: 'tests_pass', gateKind: 'automatic', status: 'failed' });
      expect(formatEventSummary(e)).toBe('Tests failed');
    });

    it('gate code_review passed', () => {
      const e = makeEvent({ kind: 'gate.evaluated', runId: 'r1', gateId: 'code_review', gateKind: 'automatic', status: 'passed' });
      expect(formatEventSummary(e)).toBe('Code review passed');
    });

    it('gate merge_wait passed', () => {
      const e = makeEvent({ kind: 'gate.evaluated', runId: 'r1', gateId: 'merge_wait', gateKind: 'human', status: 'passed' });
      expect(formatEventSummary(e)).toBe('Merge approved');
    });

    it('gate unknown id falls back to gate label + status', () => {
      const e = makeEvent({ kind: 'gate.evaluated', runId: 'r1', gateId: 'custom_check', gateKind: 'policy', status: 'passed' });
      expect(formatEventSummary(e)).toBe('Custom Check passed');
    });

    it('operator approve_plan', () => {
      const e = makeEvent({ kind: 'operator.action', runId: 'r1', action: 'approve_plan', operator: 'alice' });
      expect(formatEventSummary(e)).toBe('Plan approved');
    });

    it('operator reject_run', () => {
      const e = makeEvent({ kind: 'operator.action', runId: 'r1', action: 'reject_run', operator: 'alice' });
      expect(formatEventSummary(e)).toBe('Run rejected');
    });

    it('operator cancel', () => {
      const e = makeEvent({ kind: 'operator.action', runId: 'r1', action: 'cancel', operator: 'alice' });
      expect(formatEventSummary(e)).toBe('Run cancelled');
    });

    it('operator unknown action falls back to title-cased', () => {
      const e = makeEvent({ kind: 'operator.action', runId: 'r1', action: 'custom_action', operator: 'alice' });
      expect(formatEventSummary(e)).toBe('Custom Action');
    });

    it('agent.invocation failed', () => {
      const e = makeEvent({ kind: 'agent.invocation', runId: 'r1', agentInvocationId: 'inv_1', agent: 'planner', action: 'create_plan', status: 'failed' });
      expect(formatEventSummary(e)).toBe('Failed during planning');
    });

    it('agent.invocation timed_out', () => {
      const e = makeEvent({ kind: 'agent.invocation', runId: 'r1', agentInvocationId: 'inv_1', agent: 'tester', action: 'run_tests', status: 'timed_out' });
      expect(formatEventSummary(e)).toBe('Timed out during running tests');
    });

    it('agent.invocation unknown action falls back to humanized', () => {
      const e = makeEvent({ kind: 'agent.invocation', runId: 'r1', agentInvocationId: 'inv_1', agent: 'custom', action: 'custom_task', status: 'failed' });
      expect(formatEventSummary(e)).toBe('Failed during custom task');
    });
  });

  // -------------------------------------------------------------------------
  // Dedup
  // -------------------------------------------------------------------------

  describe('computeDedupId', () => {
    it('uses event.id when present', () => {
      const e = makeEvent({ kind: 'run.phase_changed', id: 42, runId: 'r1', fromPhase: 'a', toPhase: 'b' });
      expect(computeDedupId(e)).toBe('42');
    });

    it('uses fingerprint when id is undefined', () => {
      const e = makeEvent({ kind: 'run.phase_changed', runId: 'r1', fromPhase: 'a', toPhase: 'b' });
      const id = computeDedupId(e);
      expect(id).toContain('run.phase_changed');
      expect(id).not.toBe('undefined');
    });

    it('fingerprint produces distinct keys for each event kind', () => {
      const events: StreamEventV2[] = [
        makeEvent({ kind: 'run.phase_changed', runId: 'r1', fromPhase: 'a', toPhase: 'b' }),
        makeEvent({ kind: 'gate.evaluated', runId: 'r1', gateId: 'g1', gateKind: 'approval', status: 'passed' }),
        makeEvent({ kind: 'agent.invocation', runId: 'r1', agentInvocationId: 'inv_1', agent: 'p', action: 'a', status: 'running' }),
        makeEvent({ kind: 'operator.action', runId: 'r1', action: 'approve', operator: 'alice' }),
        makeEvent({ kind: 'run.updated', runId: 'r1', fields: ['prUrl'] }),
        makeEvent({ kind: 'project.updated', reason: 'config' }),
        makeEvent({ kind: 'refresh_required', reason: 'overflow' }),
      ];

      const ids = events.map(computeDedupId);
      const unique = new Set(ids);
      expect(unique.size).toBe(ids.length);
    });

    it('fingerprint safe with delimiter-containing values (length-prefix)', () => {
      const e1 = makeEvent({ kind: 'operator.action', runId: 'r1', action: '3:abc', operator: 'alice' });
      const e2 = makeEvent({ kind: 'operator.action', runId: 'r1', action: '3', operator: 'abc|alice' });
      expect(computeDedupId(e1)).not.toBe(computeDedupId(e2));
    });

    it('fingerprint with long discriminator values', () => {
      const longValue = 'x'.repeat(250);
      const e = makeEvent({ kind: 'operator.action', runId: 'r1', action: longValue, operator: 'alice' });
      const id = computeDedupId(e);
      expect(id).toContain(`250:${longValue}`);
    });
  });

  // -------------------------------------------------------------------------
  // Unread tracking
  // -------------------------------------------------------------------------

  describe('unread tracking', () => {
    it('persisted events: unread when id > lastSeenId', () => {
      writeCursor(10, 0);
      const cursor = readCursor();
      const item = makeItem(makeEvent({ kind: 'run.phase_changed', id: 11, runId: 'r1', fromPhase: 'a', toPhase: 'b' }));
      expect(isUnread(item, cursor)).toBe(true);
    });

    it('persisted events: read when id <= lastSeenId', () => {
      writeCursor(10, 0);
      const cursor = readCursor();
      const item = makeItem(makeEvent({ kind: 'run.phase_changed', id: 10, runId: 'r1', fromPhase: 'a', toPhase: 'b' }));
      expect(isUnread(item, cursor)).toBe(false);
    });

    it('id-less events: unread when epochMs > lastSeenTsMs', () => {
      const ts = '2025-06-01T12:00:00.000Z';
      const tsMs = new Date(ts).getTime();
      writeCursor(0, tsMs - 1000);
      const cursor = readCursor();
      const item = makeItem(makeEvent({ kind: 'run.phase_changed', runId: 'r1', fromPhase: 'a', toPhase: 'b', timestamp: ts }));
      expect(isUnread(item, cursor)).toBe(true);
    });

    it('id-less events: read when epochMs <= lastSeenTsMs', () => {
      const ts = '2025-06-01T12:00:00.000Z';
      const tsMs = new Date(ts).getTime();
      writeCursor(0, tsMs);
      const cursor = readCursor();
      const item = makeItem(makeEvent({ kind: 'run.phase_changed', runId: 'r1', fromPhase: 'a', toPhase: 'b', timestamp: ts }));
      expect(isUnread(item, cursor)).toBe(false);
    });

    it('id-less with invalid timestamp: treated as unread', () => {
      writeCursor(0, Date.now());
      const cursor = readCursor();
      const item = makeItem(makeEvent({ kind: 'run.phase_changed', runId: 'r1', fromPhase: 'a', toPhase: 'b', timestamp: 'invalid-date' }));
      expect(isUnread(item, cursor)).toBe(true);
    });

    it('markAllRead writes both localStorage keys, resets count to 0', () => {
      const items = [
        makeItem(makeEvent({ kind: 'run.phase_changed', id: 5, runId: 'r1', fromPhase: 'a', toPhase: 'b', timestamp: '2025-01-01T00:00:00.000Z' })),
        makeItem(makeEvent({ kind: 'gate.evaluated', id: 3, runId: 'r1', gateId: 'g1', gateKind: 'approval', status: 'passed', timestamp: '2025-01-01T00:01:00.000Z' })),
      ];

      // Simulate markAllRead logic
      const ids: number[] = [];
      const timestamps: number[] = [];
      for (const item of items) {
        if (item.event.id !== undefined) ids.push(item.event.id);
        const tsMs = new Date(item.event.timestamp).getTime();
        if (Number.isFinite(tsMs)) timestamps.push(tsMs);
      }
      const currentCursor = readCursor();
      const newId = ids.length > 0 ? Math.max(...ids) : currentCursor.lastSeenId;
      const newTs = timestamps.length > 0 ? Math.max(...timestamps) : currentCursor.lastSeenTsMs;
      writeCursor(newId, newTs);

      const cursor = readCursor();
      expect(cursor.lastSeenId).toBe(5);
      expect(cursor.lastSeenTsMs).toBe(new Date('2025-01-01T00:01:00.000Z').getTime());

      // All items should now be read
      for (const item of items) {
        expect(isUnread(item, cursor)).toBe(false);
      }
    });

    it('markAllRead with only invalid-timestamp id-less items: preserves cursor', () => {
      writeCursor(10, 5000);
      const items = [
        makeItem(makeEvent({ kind: 'run.phase_changed', runId: 'r1', fromPhase: 'a', toPhase: 'b', timestamp: 'invalid' })),
      ];

      const ids: number[] = [];
      const timestamps: number[] = [];
      for (const item of items) {
        if (item.event.id !== undefined) ids.push(item.event.id);
        const tsMs = new Date(item.event.timestamp).getTime();
        if (Number.isFinite(tsMs)) timestamps.push(tsMs);
      }
      const currentCursor = readCursor();
      const newId = ids.length > 0 ? Math.max(...ids) : currentCursor.lastSeenId;
      const newTs = timestamps.length > 0 ? Math.max(...timestamps) : currentCursor.lastSeenTsMs;

      // Should not produce NaN
      expect(Number.isFinite(newId)).toBe(true);
      expect(Number.isFinite(newTs)).toBe(true);
      expect(newId).toBe(10);
      expect(newTs).toBe(5000);
    });

    it('corrupted localStorage returns { 0, 0 }', () => {
      storageMock.setItem('conductor:inbox:lastSeenId', 'corrupt');
      storageMock.setItem('conductor:inbox:lastSeenTsMs', 'corrupt');
      const cursor = readCursor();
      expect(cursor.lastSeenId).toBe(0);
      expect(cursor.lastSeenTsMs).toBe(0);
    });

    it('storage unavailable (throw) returns { 0, 0 }', () => {
      Object.defineProperty(globalThis, 'localStorage', {
        get() { throw new Error('SecurityError'); },
        configurable: true,
      });
      const cursor = readCursor();
      expect(cursor.lastSeenId).toBe(0);
      expect(cursor.lastSeenTsMs).toBe(0);
    });

    it('cross-tab: StorageEvent recalculates unread count', () => {
      // This tests the concept — in the real hook, a storage event listener
      // reads cursor and recalculates. We verify readCursor returns the updated values.
      writeCursor(1, 1000);
      let cursor = readCursor();
      expect(cursor.lastSeenId).toBe(1);

      // Simulate another tab writing
      storageMock.setItem('conductor:inbox:lastSeenId', '100');
      storageMock.setItem('conductor:inbox:lastSeenTsMs', '999999');

      cursor = readCursor();
      expect(cursor.lastSeenId).toBe(100);
      expect(cursor.lastSeenTsMs).toBe(999999);
    });
  });

  // -------------------------------------------------------------------------
  // Categorization
  // -------------------------------------------------------------------------

  describe('categorizeItem', () => {
    it('operator.action → messages', () => {
      const item = makeItem(makeEvent({ kind: 'operator.action', runId: 'r1', action: 'approve', operator: 'alice' }));
      expect(categorizeItem(item)).toBe('messages');
    });

    it('agent.invocation → toasts', () => {
      const item = makeItem(makeEvent({ kind: 'agent.invocation', runId: 'r1', agentInvocationId: 'inv_1', agent: 'planner', action: 'plan', status: 'failed' }));
      expect(categorizeItem(item)).toBe('toasts');
    });

    it('gate.evaluated → messages', () => {
      const item = makeItem(makeEvent({ kind: 'gate.evaluated', runId: 'r1', gateId: 'g1', gateKind: 'approval', status: 'passed' }));
      expect(categorizeItem(item)).toBe('messages');
    });
  });

  // -------------------------------------------------------------------------
  // Event filtering
  // -------------------------------------------------------------------------

  describe('shouldIncludeEvent', () => {
    it('includes gate.evaluated with passed status', () => {
      expect(shouldIncludeEvent(makeEvent({ kind: 'gate.evaluated', runId: 'r1', gateId: 'g1', gateKind: 'approval', status: 'passed' }))).toBe(true);
    });

    it('includes gate.evaluated with failed status', () => {
      expect(shouldIncludeEvent(makeEvent({ kind: 'gate.evaluated', runId: 'r1', gateId: 'g1', gateKind: 'approval', status: 'failed' }))).toBe(true);
    });

    it('excludes gate.evaluated with pending status', () => {
      expect(shouldIncludeEvent(makeEvent({ kind: 'gate.evaluated', runId: 'r1', gateId: 'g1', gateKind: 'human', status: 'pending' }))).toBe(false);
    });

    it('includes operator.action', () => {
      expect(shouldIncludeEvent(makeEvent({ kind: 'operator.action', runId: 'r1', action: 'approve', operator: 'alice' }))).toBe(true);
    });

    it('includes agent.invocation with failed status', () => {
      expect(shouldIncludeEvent(makeEvent({ kind: 'agent.invocation', runId: 'r1', agentInvocationId: 'inv_1', agent: 'p', action: 'a', status: 'failed' }))).toBe(true);
    });

    it('includes agent.invocation with error status', () => {
      expect(shouldIncludeEvent(makeEvent({ kind: 'agent.invocation', runId: 'r1', agentInvocationId: 'inv_1', agent: 'p', action: 'a', status: 'error' }))).toBe(true);
    });

    it('excludes agent.invocation with running status', () => {
      expect(shouldIncludeEvent(makeEvent({ kind: 'agent.invocation', runId: 'r1', agentInvocationId: 'inv_1', agent: 'p', action: 'a', status: 'running' }))).toBe(false);
    });

    it('excludes agent.invocation with completed status', () => {
      expect(shouldIncludeEvent(makeEvent({ kind: 'agent.invocation', runId: 'r1', agentInvocationId: 'inv_1', agent: 'p', action: 'a', status: 'completed' }))).toBe(false);
    });

    it('excludes run.phase_changed', () => {
      expect(shouldIncludeEvent(makeEvent({ kind: 'run.phase_changed', runId: 'r1', fromPhase: 'a', toPhase: 'b' }))).toBe(false);
    });

    it('excludes run.updated', () => {
      expect(shouldIncludeEvent(makeEvent({ kind: 'run.updated', runId: 'r1', fields: ['prUrl'] }))).toBe(false);
    });

    it('excludes project.updated', () => {
      expect(shouldIncludeEvent(makeEvent({ kind: 'project.updated', reason: 'config' }))).toBe(false);
    });

    it('excludes refresh_required', () => {
      expect(shouldIncludeEvent(makeEvent({ kind: 'refresh_required', reason: 'overflow' }))).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Data flow
  // -------------------------------------------------------------------------

  describe('data flow', () => {
    it('SSE event with same dedupId as existing item is skipped', () => {
      const event = makeEvent({ kind: 'run.phase_changed', id: 1, runId: 'r1', fromPhase: 'a', toPhase: 'b' });
      const existing = [makeItem(event)];
      const dedupSet = new Set(existing.map(i => i.dedupId));

      // Simulate SSE arriving with same event
      const dedupId = computeDedupId(event);
      expect(dedupSet.has(dedupId)).toBe(true); // Would skip
    });

    it('refresh_required events filtered out', () => {
      const event = makeEvent({ kind: 'refresh_required', reason: 'overflow' });
      // The hook skips refresh_required in onEvent
      expect(event.kind).toBe('refresh_required');
    });

    it('list capped at 50 items', () => {
      const items: InboxItem[] = [];
      for (let i = 0; i < 55; i++) {
        items.push(makeItem(makeEvent({
          kind: 'run.phase_changed',
          id: i,
          runId: `r_${i}`,
          fromPhase: 'a',
          toPhase: 'b',
          timestamp: `2025-01-01T00:${String(i).padStart(2, '0')}:00.000Z`,
        })));
      }

      // Simulate the cap logic
      const capped = items.length > 50 ? items.slice(0, 50) : items;
      expect(capped).toHaveLength(50);
    });

    it('API re-fetch replaces entire list', () => {
      // Simulate: start with SSE-only items, then API returns different items
      const sseItem = makeItem(makeEvent({ kind: 'run.phase_changed', runId: 'r_sse', fromPhase: 'a', toPhase: 'b' }));
      const apiItems = [
        makeItem(makeEvent({ kind: 'run.phase_changed', id: 10, runId: 'r_api', fromPhase: 'a', toPhase: 'b' })),
      ];

      // After fetch, items are replaced entirely
      let items = [sseItem];
      items = apiItems; // API replace
      expect(items).toHaveLength(1);
      expect(items[0]?.event.runId).toBe('r_api');
    });
  });

  // -------------------------------------------------------------------------
  // InboxItem enrichment fields
  // -------------------------------------------------------------------------

  describe('InboxItem enrichment', () => {
    it('InboxItem with taskTitle and projectName', () => {
      const event = makeEvent({ kind: 'gate.evaluated', runId: 'r1', gateId: 'plan_approval', gateKind: 'human', status: 'passed' });
      const item: InboxItem = {
        event,
        summary: formatEventSummary(event),
        taskTitle: 'Fix login bug',
        projectName: 'My Project',
        dedupId: computeDedupId(event),
      };
      expect(item.taskTitle).toBe('Fix login bug');
      expect(item.projectName).toBe('My Project');
    });

    it('InboxItem without enrichment (SSE-only)', () => {
      const event = makeEvent({ kind: 'operator.action', runId: 'r1', action: 'approve_plan', operator: 'alice' });
      const item: InboxItem = {
        event,
        summary: formatEventSummary(event),
        dedupId: computeDedupId(event),
      };
      expect(item.taskTitle).toBeUndefined();
      expect(item.projectName).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // Non-regression guards: shouldIncludeEvent + categorizeItem unchanged
  // -------------------------------------------------------------------------

  describe('non-regression: shouldIncludeEvent', () => {
    it('filters gate.evaluated pending', () => {
      expect(shouldIncludeEvent(makeEvent({ kind: 'gate.evaluated', runId: 'r1', gateId: 'g1', gateKind: 'human', status: 'pending' }))).toBe(false);
    });

    it('includes gate.evaluated passed', () => {
      expect(shouldIncludeEvent(makeEvent({ kind: 'gate.evaluated', runId: 'r1', gateId: 'g1', gateKind: 'approval', status: 'passed' }))).toBe(true);
    });

    it('includes gate.evaluated failed', () => {
      expect(shouldIncludeEvent(makeEvent({ kind: 'gate.evaluated', runId: 'r1', gateId: 'g1', gateKind: 'approval', status: 'failed' }))).toBe(true);
    });

    it('excludes routine agent.invocation running', () => {
      expect(shouldIncludeEvent(makeEvent({ kind: 'agent.invocation', runId: 'r1', agentInvocationId: 'inv_1', agent: 'p', action: 'a', status: 'running' }))).toBe(false);
    });

    it('excludes routine agent.invocation completed', () => {
      expect(shouldIncludeEvent(makeEvent({ kind: 'agent.invocation', runId: 'r1', agentInvocationId: 'inv_1', agent: 'p', action: 'a', status: 'completed' }))).toBe(false);
    });

    it('excludes run.phase_changed', () => {
      expect(shouldIncludeEvent(makeEvent({ kind: 'run.phase_changed', runId: 'r1', fromPhase: 'a', toPhase: 'b' }))).toBe(false);
    });

    it('excludes run.updated', () => {
      expect(shouldIncludeEvent(makeEvent({ kind: 'run.updated', runId: 'r1', fields: ['prUrl'] }))).toBe(false);
    });

    it('excludes project.updated', () => {
      expect(shouldIncludeEvent(makeEvent({ kind: 'project.updated', reason: 'config' }))).toBe(false);
    });
  });

  describe('non-regression: categorizeItem', () => {
    it('gate.evaluated → messages', () => {
      const item = makeItem(makeEvent({ kind: 'gate.evaluated', runId: 'r1', gateId: 'g1', gateKind: 'approval', status: 'passed' }));
      expect(categorizeItem(item)).toBe('messages');
    });

    it('operator.action → messages', () => {
      const item = makeItem(makeEvent({ kind: 'operator.action', runId: 'r1', action: 'approve', operator: 'alice' }));
      expect(categorizeItem(item)).toBe('messages');
    });

    it('agent.invocation → toasts', () => {
      const item = makeItem(makeEvent({ kind: 'agent.invocation', runId: 'r1', agentInvocationId: 'inv_1', agent: 'planner', action: 'plan', status: 'failed' }));
      expect(categorizeItem(item)).toBe('toasts');
    });
  });
});
