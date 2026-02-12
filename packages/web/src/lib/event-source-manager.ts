/**
 * Singleton EventSource manager.
 *
 * Ref-counted: first subscriber creates the EventSource, last unsubscriber closes it.
 * All hooks share one connection per tab. Dispatches parsed V2 events to all listeners.
 * Exports useSyncExternalStore-compatible getSnapshot/subscribe for readyState.
 */

import type { StreamEventV2 } from '@conductor/shared';

type Listener = (event: StreamEventV2) => void;
type ReadyStateListener = () => void;

let es: EventSource | null = null;
let refCount = 0;
let currentReadyState: number = 2; // EventSource.CLOSED initially
const listeners = new Set<Listener>();
const readyStateListeners = new Set<ReadyStateListener>();

function notifyReadyState(): void {
  for (const fn of readyStateListeners) {
    fn();
  }
}

function createEventSource(): void {
  if (es !== null) return;

  const source = new EventSource('/api/events/stream');
  es = source;
  currentReadyState = source.readyState;

  source.onopen = () => {
    currentReadyState = source.readyState;
    notifyReadyState();
  };

  source.onmessage = (msg) => {
    try {
      const event = JSON.parse(msg.data as string) as StreamEventV2;
      for (const fn of listeners) {
        fn(event);
      }
    } catch {
      // Ignore parse errors (heartbeat comments won't trigger onmessage)
    }
  };

  source.onerror = () => {
    currentReadyState = source.readyState;
    notifyReadyState();
  };
}

function destroyEventSource(): void {
  if (es === null) return;
  es.close();
  es = null;
  currentReadyState = 2; // CLOSED
  notifyReadyState();
}

/**
 * Subscribe to SSE events. Increments ref count; first subscriber creates the EventSource.
 * Returns an unsubscribe function that decrements ref count and closes on last unsubscribe.
 */
export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  refCount++;
  if (refCount === 1) {
    createEventSource();
  }

  return () => {
    listeners.delete(listener);
    refCount--;
    if (refCount === 0) {
      destroyEventSource();
    }
  };
}

/**
 * useSyncExternalStore-compatible: get current readyState snapshot.
 */
export function getSnapshot(): number {
  return currentReadyState;
}

/**
 * useSyncExternalStore-compatible: server snapshot (always CLOSED).
 */
export function getServerSnapshot(): number {
  return 2; // EventSource.CLOSED
}

/**
 * useSyncExternalStore-compatible: subscribe to readyState changes.
 */
export function subscribeReadyState(onStoreChange: () => void): () => void {
  readyStateListeners.add(onStoreChange);
  return () => {
    readyStateListeners.delete(onStoreChange);
  };
}

/** Reset state (for testing only). */
export function _reset(): void {
  destroyEventSource();
  listeners.clear();
  readyStateListeners.clear();
  refCount = 0;
}
