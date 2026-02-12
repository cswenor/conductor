'use client';

import { useEffect, useRef, useCallback, useSyncExternalStore } from 'react';
import { useRouter } from 'next/navigation';
import type { StreamEventV2 } from '@conductor/shared';
import {
  subscribe,
  getSnapshot,
  getServerSnapshot,
  subscribeReadyState,
} from '@/lib/event-source-manager';

export interface UseLiveRefreshOptions {
  /** Filter predicate — only matching events trigger refresh. Default: all events. */
  filter?: (event: StreamEventV2) => boolean;
  /** Debounce window for coalescing burst events. Default: 500ms. */
  debounceMs?: number;
  /** Minimum interval between refreshes. Default: 2000ms. */
  minIntervalMs?: number;
  /** Safety reconciliation poll interval while SSE connected. Default: 120_000ms (2 min). */
  reconcileMs?: number;
  /** Fallback poll interval if SSE not open after 5s. Default: 30_000ms. */
  fallbackPollMs?: number;
  /** Disable the hook (e.g. for terminal states). Default: true. */
  enabled?: boolean;
}

/**
 * Auto-refresh the current page via `router.refresh()` when relevant SSE events arrive.
 *
 * Features:
 * - Debounce: coalesces burst events (e.g. pending→planning→executing = 1 refresh)
 * - Min interval: max 1 refresh per minIntervalMs under load
 * - Visibility gating: skips refresh when tab hidden, refreshes on re-focus if stale
 * - Reconciliation: safety poll while SSE connected
 * - Fallback: polling if SSE not open after 5s
 * - Re-fetch on reconnect: immediate refresh when SSE re-opens
 * - refresh_required: bypasses filter, triggers immediate (debounced) refresh
 */
export function useLiveRefresh(options?: UseLiveRefreshOptions): void {
  const {
    filter,
    debounceMs = 500,
    minIntervalMs = 2000,
    reconcileMs = 120_000,
    fallbackPollMs = 30_000,
    enabled = true,
  } = options ?? {};

  const router = useRouter();
  const filterRef = useRef(filter);
  const lastRefreshRef = useRef(0);
  const staleWhileHiddenRef = useRef(false);
  const prevReadyStateRef = useRef<number>(2); // CLOSED

  useEffect(() => {
    filterRef.current = filter;
  });

  const readyState = useSyncExternalStore(
    subscribeReadyState,
    getSnapshot,
    getServerSnapshot,
  );

  const doRefresh = useCallback(() => {
    // Skip refresh if tab is hidden — mark stale for re-focus
    if (typeof document !== 'undefined' && document.hidden) {
      staleWhileHiddenRef.current = true;
      return;
    }

    const now = Date.now();
    const elapsed = now - lastRefreshRef.current;
    if (elapsed < minIntervalMs) {
      return; // Throttled — the debounce timer will retry
    }

    lastRefreshRef.current = now;
    router.refresh();
  }, [router, minIntervalMs]);

  // Main SSE subscription effect — handles debounce, event filtering, and fallback
  useEffect(() => {
    if (!enabled) return;

    let debounceTimer: ReturnType<typeof setTimeout> | undefined;
    let fallbackTimer: ReturnType<typeof setInterval> | undefined;
    let reconcileTimer: ReturnType<typeof setInterval> | undefined;

    const scheduleRefresh = () => {
      if (debounceTimer !== undefined) {
        clearTimeout(debounceTimer);
      }
      debounceTimer = setTimeout(() => {
        debounceTimer = undefined;
        doRefresh();
      }, debounceMs);
    };

    const unsub = subscribe((event: StreamEventV2) => {
      // refresh_required bypasses filters
      if (event.kind === 'refresh_required') {
        scheduleRefresh();
        return;
      }

      // Apply user filter
      if (filterRef.current !== undefined && !filterRef.current(event)) {
        return;
      }

      scheduleRefresh();
    });

    // Fallback: if SSE not open after 5s, start polling
    const failoverTimeout = setTimeout(() => {
      if (prevReadyStateRef.current !== 1) {
        fallbackTimer = setInterval(() => {
          doRefresh();
        }, fallbackPollMs);
      }
    }, 5000);

    // Safety reconciliation poll (while connected) — start if already open
    if (readyState === 1) {
      reconcileTimer = setInterval(() => {
        doRefresh();
      }, reconcileMs);
    }

    return () => {
      unsub();
      if (debounceTimer !== undefined) clearTimeout(debounceTimer);
      if (fallbackTimer !== undefined) clearInterval(fallbackTimer);
      if (failoverTimeout !== undefined) clearTimeout(failoverTimeout);
      if (reconcileTimer !== undefined) clearInterval(reconcileTimer);
    };
  }, [enabled, debounceMs, fallbackPollMs, reconcileMs, readyState, doRefresh]);

  // Re-fetch on SSE (re)connect
  useEffect(() => {
    if (!enabled) return;
    if (readyState === 1 && prevReadyStateRef.current !== 1) {
      doRefresh();
    }
    prevReadyStateRef.current = readyState;
  }, [readyState, enabled, doRefresh]);

  // Visibility change: refresh on re-focus if stale
  useEffect(() => {
    if (!enabled) return;

    const handleVisibility = () => {
      if (!document.hidden && staleWhileHiddenRef.current) {
        staleWhileHiddenRef.current = false;
        doRefresh();
      }
    };

    document.addEventListener('visibilitychange', handleVisibility);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, [enabled, doRefresh]);
}
