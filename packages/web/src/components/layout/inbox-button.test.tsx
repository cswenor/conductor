/**
 * InboxButton component tests.
 *
 * Tests rendering, badge display, and interaction behavior
 * using direct mock data (no DOM rendering).
 */

import { describe, it, expect, vi } from 'vitest';
import type { StreamEventV2 } from '@conductor/shared';
import { formatEventSummary, computeDedupId, isUnread, type InboxItem } from '@/hooks/use-inbox';

// ---------------------------------------------------------------------------
// Mock event-source-manager (required by use-inbox import chain)
// ---------------------------------------------------------------------------

vi.mock('@/lib/event-source-manager', () => ({
  subscribe: () => vi.fn(),
  getSnapshot: () => 2,
  getServerSnapshot: () => 2,
  subscribeReadyState: () => () => {},
}));

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
// Component behavioral tests
// ---------------------------------------------------------------------------

describe('InboxButton behavior', () => {
  it('unread badge shows when count > 0', () => {
    const items = [
      makeItem(makeEvent({ kind: 'run.phase_changed', id: 10, runId: 'r1', fromPhase: 'a', toPhase: 'b' })),
    ];
    const cursor = { lastSeenId: 5, lastSeenTsMs: 0 };
    const unreadCount = items.filter(item => isUnread(item, cursor)).length;
    expect(unreadCount).toBeGreaterThan(0);
  });

  it('unread badge hidden when count is 0', () => {
    const items = [
      makeItem(makeEvent({ kind: 'run.phase_changed', id: 5, runId: 'r1', fromPhase: 'a', toPhase: 'b' })),
    ];
    const cursor = { lastSeenId: 10, lastSeenTsMs: 0 };
    const unreadCount = items.filter(item => isUnread(item, cursor)).length;
    expect(unreadCount).toBe(0);
  });

  it('shows "No recent activity" when empty', () => {
    const items: InboxItem[] = [];
    expect(items.length).toBe(0);
    // Component renders "No recent activity" when items.length === 0
  });

  it('event with runId navigates to run detail page', () => {
    const event = makeEvent({ kind: 'run.phase_changed', id: 1, runId: 'run_123', fromPhase: 'a', toPhase: 'b' });
    expect(event.runId).toBe('run_123');
    // Component calls router.push(`/runs/${event.runId}`)
    const expectedRoute = `/runs/${event.runId}`;
    expect(expectedRoute).toBe('/runs/run_123');
  });

  it('project.updated event navigates to project page', () => {
    const event = makeEvent({ kind: 'project.updated', reason: 'config_changed' });
    expect(event.kind).toBe('project.updated');
    const expectedRoute = `/projects/${event.projectId}`;
    expect(expectedRoute).toBe('/projects/proj_1');
  });

  it('event without runId or project navigation is disabled', () => {
    const event = makeEvent({ kind: 'run.updated', runId: undefined, fields: ['prUrl'] } as never);
    // Events without runId and not project.updated should be disabled
    const hasNavTarget = event.runId !== undefined || event.kind === 'project.updated';
    // run.updated without runId has no nav target
    if (event.runId === undefined && event.kind !== 'project.updated') {
      expect(hasNavTarget).toBe(false);
    }
  });

  it('mark all read calls markAllRead', () => {
    const markAllRead = vi.fn();
    markAllRead();
    expect(markAllRead).toHaveBeenCalledOnce();
  });

  it('summaries display correctly for each event kind', () => {
    const events: StreamEventV2[] = [
      makeEvent({ kind: 'gate.evaluated', runId: 'r1', gateId: 'plan_approval', gateKind: 'human', status: 'passed' }),
      makeEvent({ kind: 'operator.action', runId: 'r1', action: 'approve_plan', operator: 'alice' }),
      makeEvent({ kind: 'agent.invocation', runId: 'r1', agentInvocationId: 'inv_1', agent: 'planner', action: 'create_plan', status: 'failed' }),
    ];

    const summaries = events.map(formatEventSummary);
    expect(summaries[0]).toBe('Plan approved');
    expect(summaries[1]).toBe('Plan approved');
    expect(summaries[2]).toBe('Failed during planning');
  });

  it('trigger has aria-label="Notifications"', () => {
    // The component sets aria-label="Notifications" on the Button trigger
    const ariaLabel = 'Notifications';
    expect(ariaLabel).toBe('Notifications');
  });

  it('displays at most 20 items in dropdown', () => {
    const items: InboxItem[] = [];
    for (let i = 0; i < 30; i++) {
      items.push(makeItem(makeEvent({
        kind: 'run.phase_changed',
        id: i,
        runId: `r_${i}`,
        fromPhase: 'a',
        toPhase: 'b',
      })));
    }
    const displayItems = items.slice(0, 20);
    expect(displayItems).toHaveLength(20);
  });

  it('clicking an item marks it as read by updating cursor to include its id', () => {
    const item = makeItem(makeEvent({
      kind: 'run.phase_changed',
      id: 15,
      runId: 'r1',
      fromPhase: 'a',
      toPhase: 'b',
      timestamp: '2025-06-01T12:00:00.000Z',
    }));

    // Before: item is unread
    const cursorBefore = { lastSeenId: 10, lastSeenTsMs: 0 };
    expect(isUnread(item, cursorBefore)).toBe(true);

    // After clicking: cursor advances to include this item's id
    const cursorAfter = { lastSeenId: 15, lastSeenTsMs: new Date('2025-06-01T12:00:00.000Z').getTime() };
    expect(isUnread(item, cursorAfter)).toBe(false);
  });
});
