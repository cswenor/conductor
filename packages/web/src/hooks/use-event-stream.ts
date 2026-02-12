'use client';

import { useEffect, useRef, useState } from 'react';
import type { StreamEvent } from '@conductor/shared';

/**
 * SSE connection manager.
 *
 * Creates an EventSource to /api/events/stream and dispatches parsed
 * events to the provided callback. Automatically reconnects on error
 * (EventSource default behavior).
 */
export function useEventStream(
  onEvent: (event: StreamEvent) => void,
): { readyState: number } {
  const [readyState, setReadyState] = useState<number>(EventSource.CONNECTING);
  const esRef = useRef<EventSource | null>(null);
  const callbackRef = useRef(onEvent);

  // Keep callback ref up to date without re-creating EventSource
  useEffect(() => {
    callbackRef.current = onEvent;
  });

  useEffect(() => {
    const es = new EventSource('/api/events/stream');
    esRef.current = es;

    es.onopen = () => {
      setReadyState(EventSource.OPEN);
    };

    es.onmessage = (msg) => {
      try {
        const event = JSON.parse(msg.data as string) as StreamEvent;
        callbackRef.current(event);
      } catch {
        // Ignore parse errors (e.g. heartbeat comments won't trigger onmessage)
      }
    };

    es.onerror = () => {
      setReadyState(es.readyState);
    };

    return () => {
      es.close();
      esRef.current = null;
    };
  }, []);

  return { readyState };
}
