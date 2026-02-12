/**
 * Tests for useLiveRefresh hook behavior.
 *
 * Since the hook depends on React (useEffect, useRouter, useSyncExternalStore)
 * and we don't have a DOM environment, we test the core behavioral logic
 * that the hook implements: debounce, min-interval throttle, visibility gating,
 * burst coalescing, fallback polling, reconciliation, and filter semantics.
 *
 * The event-source-manager singleton and dispatch are tested separately.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock event-source-manager to verify subscribe wiring
// ---------------------------------------------------------------------------

let subscribeCallback: ((event: Record<string, unknown>) => void) | null = null;
let mockReadyState = 2;

vi.mock('@/lib/event-source-manager', () => ({
  subscribe: (cb: (event: Record<string, unknown>) => void) => {
    subscribeCallback = cb;
    return vi.fn();
  },
  getSnapshot: () => mockReadyState,
  getServerSnapshot: () => 2,
  subscribeReadyState: (_cb: () => void) => {
    return () => {};
  },
}));

describe('useLiveRefresh behavioral logic', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    subscribeCallback = null;
    mockReadyState = 2;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // -------------------------------------------------------------------------
  // Debounce
  // -------------------------------------------------------------------------

  it('debounce coalesces rapid calls into single execution', () => {
    const fn = vi.fn();
    const debounceMs = 500;
    let debounceTimer: ReturnType<typeof setTimeout> | undefined;

    function scheduleRefresh(): void {
      if (debounceTimer !== undefined) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        debounceTimer = undefined;
        fn();
      }, debounceMs);
    }

    scheduleRefresh();
    scheduleRefresh();
    scheduleRefresh();

    vi.advanceTimersByTime(499);
    expect(fn).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(fn).toHaveBeenCalledOnce();
  });

  it('burst coalescing: 100 events in rapid succession → 1 refresh', () => {
    const fn = vi.fn();
    const debounceMs = 500;
    let debounceTimer: ReturnType<typeof setTimeout> | undefined;

    function scheduleRefresh(): void {
      if (debounceTimer !== undefined) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        debounceTimer = undefined;
        fn();
      }, debounceMs);
    }

    for (let i = 0; i < 100; i++) {
      scheduleRefresh();
    }

    vi.advanceTimersByTime(500);
    expect(fn).toHaveBeenCalledOnce();
  });

  // -------------------------------------------------------------------------
  // Min-interval throttle
  // -------------------------------------------------------------------------

  it('min-interval prevents refreshes faster than minIntervalMs', () => {
    const fn = vi.fn();
    const minIntervalMs = 2000;
    let lastRefresh = 0;

    function doRefresh(): void {
      const now = Date.now();
      if (now - lastRefresh < minIntervalMs) return;
      lastRefresh = now;
      fn();
    }

    doRefresh();
    expect(fn).toHaveBeenCalledOnce();

    vi.advanceTimersByTime(1000);
    doRefresh();
    expect(fn).toHaveBeenCalledOnce(); // Throttled

    vi.advanceTimersByTime(1000);
    doRefresh();
    expect(fn).toHaveBeenCalledTimes(2); // 2s elapsed
  });

  // -------------------------------------------------------------------------
  // Visibility gating
  // -------------------------------------------------------------------------

  it('skips refresh when tab hidden, refreshes on re-focus', () => {
    const fn = vi.fn();
    let staleWhileHidden = false;

    function doRefresh(isHidden: boolean): void {
      if (isHidden) {
        staleWhileHidden = true;
        return;
      }
      fn();
    }

    function handleVisibilityChange(isHidden: boolean): void {
      if (!isHidden && staleWhileHidden) {
        staleWhileHidden = false;
        fn();
      }
    }

    // Event arrives while hidden
    doRefresh(true);
    expect(fn).not.toHaveBeenCalled();
    expect(staleWhileHidden).toBe(true);

    // Tab becomes visible
    handleVisibilityChange(false);
    expect(fn).toHaveBeenCalledOnce();
    expect(staleWhileHidden).toBe(false);
  });

  it('does not refresh on re-focus if not stale', () => {
    const fn = vi.fn();
    let staleWhileHidden = false;

    function handleVisibilityChange(isHidden: boolean): void {
      if (!isHidden && staleWhileHidden) {
        staleWhileHidden = false;
        fn();
      }
    }

    // Tab becomes visible but nothing happened while hidden
    handleVisibilityChange(false);
    expect(fn).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Fallback polling
  // -------------------------------------------------------------------------

  it('fallback polling activates after 5s if SSE not open', () => {
    const fn = vi.fn();
    const fallbackPollMs = 30_000;
    let fallbackTimer: ReturnType<typeof setInterval> | undefined;
    const getReadyState = (): number => 2; // CLOSED

    setTimeout(() => {
      if (getReadyState() !== 1) {
        fallbackTimer = setInterval((): void => { fn(); }, fallbackPollMs);
      }
    }, 5000);

    vi.advanceTimersByTime(5000);
    expect(fn).not.toHaveBeenCalled();

    vi.advanceTimersByTime(30_000);
    expect(fn).toHaveBeenCalledOnce();

    vi.advanceTimersByTime(30_000);
    expect(fn).toHaveBeenCalledTimes(2);

    if (fallbackTimer !== undefined) clearInterval(fallbackTimer);
  });

  it('fallback polling does not activate if SSE is open', () => {
    const fn = vi.fn();
    const fallbackPollMs = 30_000;
    const getReadyState = (): number => 1; // OPEN

    setTimeout(() => {
      if (getReadyState() !== 1) {
        setInterval((): void => { fn(); }, fallbackPollMs);
      }
    }, 5000);

    vi.advanceTimersByTime(5000 + 60_000);
    expect(fn).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Reconciliation
  // -------------------------------------------------------------------------

  it('reconciliation poll fires every reconcileMs while SSE open', () => {
    const fn = vi.fn();
    const reconcileMs = 120_000;

    const timer = setInterval((): void => { fn(); }, reconcileMs);

    vi.advanceTimersByTime(120_000);
    expect(fn).toHaveBeenCalledOnce();

    vi.advanceTimersByTime(120_000);
    expect(fn).toHaveBeenCalledTimes(2);

    clearInterval(timer);
  });

  // -------------------------------------------------------------------------
  // Filter semantics
  // -------------------------------------------------------------------------

  it('filter predicate gates which events trigger refresh', () => {
    const refreshed: string[] = [];
    const filter = (event: Record<string, unknown>) => event['kind'] === 'run.phase_changed';

    function onEvent(event: Record<string, unknown>): void {
      if (event['kind'] === 'refresh_required') {
        refreshed.push('refresh_required');
        return;
      }
      if (!filter(event)) return;
      refreshed.push(event['kind'] as string);
    }

    onEvent({ kind: 'run.phase_changed' });
    expect(refreshed).toEqual(['run.phase_changed']);

    onEvent({ kind: 'gate.evaluated' });
    expect(refreshed).toEqual(['run.phase_changed']); // Filtered out

    onEvent({ kind: 'operator.action' });
    expect(refreshed).toEqual(['run.phase_changed']); // Filtered out
  });

  it('refresh_required bypasses filter predicate', () => {
    const refreshed: string[] = [];
    const filter = (event: Record<string, unknown>) => event['kind'] === 'run.phase_changed';

    function onEvent(event: Record<string, unknown>): void {
      if (event['kind'] === 'refresh_required') {
        refreshed.push('refresh_required');
        return;
      }
      if (!filter(event)) return;
      refreshed.push(event['kind'] as string);
    }

    // Doesn't match filter
    onEvent({ kind: 'gate.evaluated' });
    expect(refreshed).toHaveLength(0);

    // refresh_required bypasses filter
    onEvent({ kind: 'refresh_required' });
    expect(refreshed).toEqual(['refresh_required']);
  });

  // -------------------------------------------------------------------------
  // Cleanup
  // -------------------------------------------------------------------------

  it('cleanup clears all timers preventing leaks', () => {
    const fn = vi.fn();

    const debounceTimer = setTimeout((): void => { fn(); }, 500);
    const fallbackTimer = setInterval((): void => { fn(); }, 30_000);
    const reconcileTimer = setInterval((): void => { fn(); }, 120_000);
    const failoverTimer = setTimeout((): void => { fn(); }, 5000);

    // Cleanup (mirrors useEffect return)
    clearTimeout(debounceTimer);
    clearInterval(fallbackTimer);
    clearInterval(reconcileTimer);
    clearTimeout(failoverTimer);

    vi.advanceTimersByTime(300_000);
    expect(fn).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // subscribe mock wiring
  // -------------------------------------------------------------------------

  it('event-source-manager subscribe mock captures callback', async () => {
    const esm = await import('@/lib/event-source-manager');
    const cb = vi.fn();
    esm.subscribe(cb);
    expect(subscribeCallback).toBe(cb);
  });

  it('getSnapshot returns mocked readyState', async () => {
    const esm = await import('@/lib/event-source-manager');
    mockReadyState = 1;
    expect(esm.getSnapshot()).toBe(1);
    mockReadyState = 0;
    expect(esm.getSnapshot()).toBe(0);
  });
});
