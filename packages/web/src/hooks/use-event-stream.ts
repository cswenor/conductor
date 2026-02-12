'use client';

import { useEffect, useRef, useSyncExternalStore } from 'react';
import type { StreamEventV2 } from '@conductor/shared';
import {
  subscribe,
  getSnapshot,
  getServerSnapshot,
  subscribeReadyState,
} from '@/lib/event-source-manager';

/**
 * SSE connection hook — thin wrapper around singleton EventSource manager.
 *
 * Delivers StreamEventV2 events to the provided callback.
 * One EventSource per tab — all hooks share the same connection.
 */
export function useEventStream(
  onEvent: (event: StreamEventV2) => void,
): { readyState: number } {
  const callbackRef = useRef(onEvent);

  // Keep callback ref up to date without re-subscribing
  useEffect(() => {
    callbackRef.current = onEvent;
  });

  useEffect(() => {
    const unsub = subscribe((event: StreamEventV2) => {
      callbackRef.current(event);
    });
    return unsub;
  }, []);

  const readyState = useSyncExternalStore(
    subscribeReadyState,
    getSnapshot,
    getServerSnapshot,
  );

  return { readyState };
}
