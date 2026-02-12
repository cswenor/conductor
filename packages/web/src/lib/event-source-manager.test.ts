/**
 * Tests for the singleton EventSource manager.
 *
 * Covers: ref-counting, lifecycle, dispatch, readyState tracking.
 * Uses a mock EventSource since we're in a node environment.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock EventSource
// ---------------------------------------------------------------------------

type ESHandler = ((event: MessageEvent) => void) | null;
type ESEventHandler = (() => void) | null;

let mockInstance: {
  readyState: number;
  onmessage: ESHandler;
  onopen: ESEventHandler;
  onerror: ESEventHandler;
  close: ReturnType<typeof vi.fn>;
  url: string;
} | null = null;

let constructorCallCount = 0;

class MockEventSource {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;

  readyState = 0;
  onmessage: ESHandler = null;
  onopen: ESEventHandler = null;
  onerror: ESEventHandler = null;
  close = vi.fn();
  url: string;

  constructor(url: string) {
    this.url = url;
    constructorCallCount++;
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    mockInstance = this;
  }
}

// Install mock before imports
vi.stubGlobal('EventSource', MockEventSource);

// Dynamic import after mock is installed
const {
  subscribe,
  getSnapshot,
  getServerSnapshot,
  subscribeReadyState,
  _reset,
} = await import('./event-source-manager.ts');

describe('event-source-manager', () => {
  beforeEach(() => {
    _reset();
    mockInstance = null;
    constructorCallCount = 0;
  });

  afterEach(() => {
    _reset();
  });

  // -------------------------------------------------------------------------
  // Ref counting + lifecycle
  // -------------------------------------------------------------------------

  it('creates EventSource on first subscribe', () => {
    const unsub = subscribe(() => {});
    expect(constructorCallCount).toBe(1);
    expect(mockInstance).not.toBeNull();
    unsub();
  });

  it('does not create additional EventSource for subsequent subscribers', () => {
    const unsub1 = subscribe(() => {});
    const unsub2 = subscribe(() => {});
    expect(constructorCallCount).toBe(1);
    unsub1();
    unsub2();
  });

  it('closes EventSource when last subscriber unsubscribes', () => {
    const unsub1 = subscribe(() => {});
    const unsub2 = subscribe(() => {});
    const closeFn = mockInstance?.close;

    unsub1();
    expect(closeFn).not.toHaveBeenCalled();

    unsub2();
    expect(closeFn).toHaveBeenCalledOnce();
  });

  it('creates a new EventSource when re-subscribing after full close', () => {
    const unsub1 = subscribe(() => {});
    unsub1(); // closes
    expect(constructorCallCount).toBe(1);

    const unsub2 = subscribe(() => {});
    expect(constructorCallCount).toBe(2);
    unsub2();
  });

  // -------------------------------------------------------------------------
  // Dispatch
  // -------------------------------------------------------------------------

  it('dispatches parsed events to all listeners', () => {
    const events1: unknown[] = [];
    const events2: unknown[] = [];
    const unsub1 = subscribe((e) => events1.push(e));
    const unsub2 = subscribe((e) => events2.push(e));

    // Simulate a message
    const data = JSON.stringify({
      kind: 'run.phase_changed',
      projectId: 'proj_1',
      runId: 'run_1',
      fromPhase: 'pending',
      toPhase: 'planning',
      timestamp: '2025-01-01T00:00:00.000Z',
    });
    mockInstance?.onmessage?.({ data } as MessageEvent);

    expect(events1).toHaveLength(1);
    expect(events2).toHaveLength(1);
    expect((events1[0] as Record<string, unknown>)['kind']).toBe('run.phase_changed');

    unsub1();
    unsub2();
  });

  it('does not dispatch to unsubscribed listeners', () => {
    const events: unknown[] = [];
    const unsub1 = subscribe((e) => events.push(e));
    const unsub2 = subscribe(() => {}); // Keep ES alive

    unsub1(); // Unsubscribe first listener

    mockInstance?.onmessage?.({
      data: JSON.stringify({ kind: 'run.phase_changed', projectId: 'p', timestamp: '' }),
    } as MessageEvent);

    expect(events).toHaveLength(0);
    unsub2();
  });

  it('ignores malformed JSON messages', () => {
    const events: unknown[] = [];
    const unsub = subscribe((e) => events.push(e));

    // Should not throw
    mockInstance?.onmessage?.({ data: 'not json' } as MessageEvent);
    expect(events).toHaveLength(0);

    unsub();
  });

  // -------------------------------------------------------------------------
  // readyState tracking
  // -------------------------------------------------------------------------

  it('getServerSnapshot returns CLOSED (2)', () => {
    expect(getServerSnapshot()).toBe(2);
  });

  it('getSnapshot returns CLOSED before any subscription', () => {
    expect(getSnapshot()).toBe(2);
  });

  it('getSnapshot updates when EventSource opens', () => {
    const unsub = subscribe(() => {});
    // Simulate onopen
    if (mockInstance) {
      mockInstance.readyState = 1;
      mockInstance.onopen?.();
    }

    expect(getSnapshot()).toBe(1);
    unsub();
  });

  it('getSnapshot returns CLOSED after all unsubscribe', () => {
    const unsub = subscribe(() => {});
    if (mockInstance) {
      mockInstance.readyState = 1;
      mockInstance.onopen?.();
    }
    unsub(); // Closes EventSource

    expect(getSnapshot()).toBe(2);
  });

  it('notifies readyState listeners on state change', () => {
    const listener = vi.fn();
    const unsubRS = subscribeReadyState(listener);
    const unsub = subscribe(() => {});

    // Simulate onopen
    if (mockInstance) {
      mockInstance.readyState = 1;
      mockInstance.onopen?.();
    }
    expect(listener).toHaveBeenCalled();

    unsubRS();
    unsub();
  });

  it('notifies readyState listeners on error', () => {
    const listener = vi.fn();
    const unsubRS = subscribeReadyState(listener);
    const unsub = subscribe(() => {});

    if (mockInstance) {
      mockInstance.readyState = 0; // CONNECTING (reconnecting)
      mockInstance.onerror?.();
    }
    expect(listener).toHaveBeenCalled();

    unsubRS();
    unsub();
  });

  it('cleans up readyState listener on unsubscribe', () => {
    const listener = vi.fn();
    const unsubRS = subscribeReadyState(listener);
    const unsub = subscribe(() => {});

    unsubRS(); // Remove readyState listener
    listener.mockClear();

    if (mockInstance) {
      mockInstance.readyState = 1;
      mockInstance.onopen?.();
    }
    expect(listener).not.toHaveBeenCalled();

    unsub();
  });

  // -------------------------------------------------------------------------
  // Rapid mount/unmount (timer leak check)
  // -------------------------------------------------------------------------

  it('handles rapid subscribe/unsubscribe cycles without leaking', () => {
    for (let i = 0; i < 10; i++) {
      const unsub = subscribe(() => {});
      unsub();
    }

    // After all cycles, no EventSource should be active
    expect(getSnapshot()).toBe(2);
    expect(constructorCallCount).toBe(10);
  });
});
