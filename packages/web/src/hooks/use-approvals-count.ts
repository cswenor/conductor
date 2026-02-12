'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import type { StreamEvent } from '@conductor/shared';
import { useEventStream } from './use-event-stream';

/** Phases that appear in the approvals query (getRunsAwaitingGates). */
const APPROVAL_PHASES = new Set(['awaiting_plan_approval', 'blocked']);

function shouldRefetch(event: StreamEvent): boolean {
  return APPROVAL_PHASES.has(event.toPhase) || APPROVAL_PHASES.has(event.fromPhase);
}

/**
 * Live approvals count powered by SSE + fetch.
 *
 * - Fetches /api/approvals/count on mount (initial value)
 * - Re-fetches when a relevant SSE event arrives
 * - Safety reconciliation every 2 minutes while connected
 * - Falls back to 30s polling if SSE is not open after 5s
 * - Re-fetches immediately on SSE (re)connect
 */
export function useApprovalsCount(): number {
  const [count, setCount] = useState(0);
  const prevReadyState = useRef<number>(EventSource.CONNECTING);
  const fallbackTimer = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
  const reconcileTimer = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
  const sseFailoverTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const fetchCount = useCallback(async () => {
    try {
      const res = await fetch('/api/approvals/count');
      if (res.ok) {
        const data = await res.json() as { count: number };
        setCount(data.count);
      }
    } catch {
      // Silently ignore — badge will show stale value
    }
  }, []);

  const onEvent = useCallback((event: StreamEvent) => {
    if (shouldRefetch(event)) {
      void fetchCount();
    }
  }, [fetchCount]);

  const { readyState } = useEventStream(onEvent);

  // Initial fetch — legitimate data subscription pattern
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void fetchCount();
  }, [fetchCount]);

  // Re-fetch on SSE (re)connect
  useEffect(() => {
    if (readyState === EventSource.OPEN && prevReadyState.current !== EventSource.OPEN) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      void fetchCount();
    }
    prevReadyState.current = readyState;
  }, [readyState, fetchCount]);

  // Safety reconciliation poll (2 minutes) — only while SSE is connected
  useEffect(() => {
    if (readyState === EventSource.OPEN) {
      reconcileTimer.current = setInterval(() => { void fetchCount(); }, 120_000);
    } else if (reconcileTimer.current !== undefined) {
      clearInterval(reconcileTimer.current);
      reconcileTimer.current = undefined;
    }
    return () => {
      if (reconcileTimer.current !== undefined) clearInterval(reconcileTimer.current);
    };
  }, [readyState, fetchCount]);

  // Fallback: if SSE isn't open after 5s, start 30s polling
  useEffect(() => {
    sseFailoverTimer.current = setTimeout(() => {
      if (prevReadyState.current !== EventSource.OPEN) {
        fallbackTimer.current = setInterval(() => { void fetchCount(); }, 30_000);
      }
    }, 5_000);

    return () => {
      if (sseFailoverTimer.current !== undefined) clearTimeout(sseFailoverTimer.current);
      if (fallbackTimer.current !== undefined) clearInterval(fallbackTimer.current);
    };
  }, [fetchCount]);

  // Clear aggressive fallback polling when SSE connects
  useEffect(() => {
    if (readyState === EventSource.OPEN && fallbackTimer.current !== undefined) {
      clearInterval(fallbackTimer.current);
      fallbackTimer.current = undefined;
    }
  }, [readyState]);

  return count;
}
