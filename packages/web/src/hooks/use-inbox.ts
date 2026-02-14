'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import type { StreamEventV2 } from '@conductor/shared';
import { useEventStream } from './use-event-stream';
import {
  getGateLabel,
  getOperatorActionLabel,
  getInvocationStatusLabel,
} from '@/lib/labels';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface InboxItem {
  event: StreamEventV2;
  summary: string;
  taskTitle?: string;
  projectName?: string;
  dedupId: string;
}

// ---------------------------------------------------------------------------
// Event formatting
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Human-readable gate messages by gateId (inbox-specific action wording)
// ---------------------------------------------------------------------------

const GATE_PASSED: Record<string, string> = {
  plan_approval: 'Plan approved',
  tests_pass: 'Tests passed',
  code_review: 'Code review passed',
  merge_wait: 'Merge approved',
};

const GATE_FAILED: Record<string, string> = {
  plan_approval: 'Plan rejected',
  tests_pass: 'Tests failed',
  code_review: 'Code review failed',
  merge_wait: 'Merge rejected',
};

// ---------------------------------------------------------------------------
// Human-readable agent action messages
// ---------------------------------------------------------------------------

const AGENT_ACTIONS: Record<string, string> = {
  create_plan: 'planning',
  review_plan: 'plan review',
  review_code: 'code review',
  apply_changes: 'applying changes',
  run_tests: 'running tests',
};

export function formatEventSummary(event: StreamEventV2): string {
  switch (event.kind) {
    case 'run.phase_changed':
      return `Run moved to ${event.toPhase.replace(/_/g, ' ')}`;
    case 'gate.evaluated': {
      const lookup = event.status === 'passed' ? GATE_PASSED : GATE_FAILED;
      return lookup[event.gateId] ?? `${getGateLabel(event.gateId)} ${event.status}`;
    }
    case 'operator.action':
      return getOperatorActionLabel(event.action);
    case 'agent.invocation': {
      const actionLabel = AGENT_ACTIONS[event.action] ?? event.action.replace(/_/g, ' ');
      if (event.status === 'failed') return `Failed during ${actionLabel}`;
      if (event.status === 'timed_out') return `Timed out during ${actionLabel}`;
      return `${event.agent}: ${getInvocationStatusLabel(event.status)}`;
    }
    case 'run.updated': {
      if (event.fields.includes('prUrl')) return 'Pull request created';
      if (event.fields.includes('prState')) return 'Pull request status changed';
      return 'Run details updated';
    }
    case 'project.updated':
      return 'Project configuration updated';
    case 'refresh_required':
      return 'Refresh required';
    default:
      return (event as StreamEventV2).kind;
  }
}

// ---------------------------------------------------------------------------
// Dedup fingerprinting
// ---------------------------------------------------------------------------

function fingerprint(e: StreamEventV2): string {
  const parts: string[] = [e.kind, e.projectId, e.runId ?? '', e.timestamp];
  switch (e.kind) {
    case 'run.phase_changed':
      parts.push(e.toPhase);
      break;
    case 'gate.evaluated':
      parts.push(e.gateId, e.status);
      break;
    case 'agent.invocation':
      parts.push(e.agentInvocationId, e.status);
      break;
    case 'operator.action':
      parts.push(e.action);
      break;
    case 'run.updated':
      parts.push(...e.fields.slice().sort());
      break;
    case 'project.updated':
      parts.push(e.reason);
      break;
    case 'refresh_required':
      parts.push(e.reason);
      break;
  }
  return parts.map(p => `${p.length}:${p}`).join('|');
}

export function computeDedupId(event: StreamEventV2): string {
  if (event.id !== undefined) return String(event.id);
  return fingerprint(event);
}

// ---------------------------------------------------------------------------
// Unread cursor (localStorage, cross-tab sync)
// ---------------------------------------------------------------------------

const LAST_SEEN_ID_KEY = 'conductor:inbox:lastSeenId';
const LAST_SEEN_TS_KEY = 'conductor:inbox:lastSeenTsMs';

interface UnreadCursor {
  lastSeenId: number;
  lastSeenTsMs: number;
}

export function readCursor(): UnreadCursor {
  try {
    const id = parseInt(localStorage.getItem(LAST_SEEN_ID_KEY) ?? '', 10);
    const ts = parseInt(localStorage.getItem(LAST_SEEN_TS_KEY) ?? '', 10);
    return {
      lastSeenId: Number.isFinite(id) ? id : 0,
      lastSeenTsMs: Number.isFinite(ts) ? ts : 0,
    };
  } catch {
    return { lastSeenId: 0, lastSeenTsMs: 0 };
  }
}

export function writeCursor(lastSeenId: number, lastSeenTsMs: number): void {
  try {
    localStorage.setItem(LAST_SEEN_ID_KEY, String(lastSeenId));
    localStorage.setItem(LAST_SEEN_TS_KEY, String(lastSeenTsMs));
  } catch { /* in-memory only this session */ }
}

export function isUnread(item: InboxItem, cursor: UnreadCursor): boolean {
  const e = item.event;
  if (e.id !== undefined) return e.id > cursor.lastSeenId;
  const tsMs = new Date(e.timestamp).getTime();
  if (!Number.isFinite(tsMs)) return true;
  return tsMs > cursor.lastSeenTsMs;
}

// ---------------------------------------------------------------------------
// Event category helpers
// ---------------------------------------------------------------------------

/** Message events: human-meaningful interactions requiring attention. */
const MESSAGE_KINDS = new Set(['operator.action', 'gate.evaluated']);

/** Agent invocation statuses that are considered routine (filtered out). */
const ROUTINE_AGENT_STATUSES = new Set(['running', 'completed']);

export type InboxTab = 'messages' | 'toasts';

/** Check if an event should be included in the inbox. */
export function shouldIncludeEvent(event: StreamEventV2): boolean {
  if (event.kind === 'gate.evaluated') {
    // Only show resolved gates, not pending ones
    return event.status !== 'pending';
  }
  if (event.kind === 'operator.action') return true;
  if (event.kind === 'agent.invocation') {
    // Only show non-routine agent invocations (errors, blocked, cancelled, timeout)
    return !ROUTINE_AGENT_STATUSES.has(event.status);
  }
  return false;
}

export function categorizeItem(item: InboxItem): InboxTab {
  if (MESSAGE_KINDS.has(item.event.kind)) return 'messages';
  return 'toasts';
}

// ---------------------------------------------------------------------------
// API response type
// ---------------------------------------------------------------------------

type EnrichedApiEvent = StreamEventV2 & {
  projectName?: string;
  taskTitle?: string;
};

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

const MAX_ITEMS = 50;

export function useInbox(): {
  items: InboxItem[];
  unreadCount: number;
  loading: boolean;
  cursor: UnreadCursor;
  markAllRead: () => void;
  markRead: (item: InboxItem) => void;
} {
  const [items, setItems] = useState<InboxItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [cursor, setCursor] = useState<UnreadCursor>({ lastSeenId: 0, lastSeenTsMs: 0 });
  const dedupSetRef = useRef(new Set<string>());
  const prevReadyState = useRef<number>(2); // CLOSED

  // Read initial cursor from localStorage
  useEffect(() => {
    setCursor(readCursor());
  }, []);

  // Cross-tab sync
  useEffect(() => {
    function onStorage(e: StorageEvent): void {
      if (e.key === LAST_SEEN_ID_KEY || e.key === LAST_SEEN_TS_KEY) {
        setCursor(readCursor());
      }
    }
    try {
      window.addEventListener('storage', onStorage);
      return () => window.removeEventListener('storage', onStorage);
    } catch {
      return undefined;
    }
  }, []);

  // Fetch from API
  const fetchEvents = useCallback(async () => {
    try {
      const res = await fetch('/api/events/recent');
      if (res.ok) {
        const data = await res.json() as { events: EnrichedApiEvent[] };
        const newItems: InboxItem[] = data.events
          .filter(shouldIncludeEvent)
          .map(event => ({
            event,
            summary: formatEventSummary(event),
            taskTitle: event.taskTitle,
            projectName: event.projectName,
            dedupId: computeDedupId(event),
          }));
        const newSet = new Set(newItems.map(i => i.dedupId));
        dedupSetRef.current = newSet;
        setItems(newItems);
      }
    } catch {
      // Silently ignore
    } finally {
      setLoading(false);
    }
  }, []);

  // Initial fetch
  useEffect(() => {
    void fetchEvents();
  }, [fetchEvents]);

  // SSE handler
  const onEvent = useCallback((event: StreamEventV2) => {
    if (!shouldIncludeEvent(event)) return;

    const dedupId = computeDedupId(event);
    if (dedupSetRef.current.has(dedupId)) return;

    const newItem: InboxItem = {
      event,
      summary: formatEventSummary(event),
      dedupId,
    };

    setItems(prev => {
      const next = [newItem, ...prev];
      const capped = next.length > MAX_ITEMS ? next.slice(0, MAX_ITEMS) : next;

      // Rebuild dedup set
      const newSet = new Set(capped.map(i => i.dedupId));
      dedupSetRef.current = newSet;

      return capped;
    });
  }, []);

  const { readyState } = useEventStream(onEvent);

  // Re-fetch on SSE (re)connect
  useEffect(() => {
    if (readyState === 1 && prevReadyState.current !== 1) {
      void fetchEvents();
    }
    prevReadyState.current = readyState;
  }, [readyState, fetchEvents]);

  // Compute unread count
  const unreadCount = items.filter(item => isUnread(item, cursor)).length;

  // Mark all read
  const markAllRead = useCallback(() => {
    const ids: number[] = [];
    const timestamps: number[] = [];

    for (const item of items) {
      if (item.event.id !== undefined) {
        ids.push(item.event.id);
      }
      const tsMs = new Date(item.event.timestamp).getTime();
      if (Number.isFinite(tsMs)) {
        timestamps.push(tsMs);
      }
    }

    const currentCursor = readCursor();
    const newId = ids.length > 0 ? Math.max(...ids) : currentCursor.lastSeenId;
    const newTs = timestamps.length > 0 ? Math.max(...timestamps) : currentCursor.lastSeenTsMs;

    writeCursor(newId, newTs);
    setCursor({ lastSeenId: newId, lastSeenTsMs: newTs });
  }, [items]);

  // Mark single item read
  const markRead = useCallback((item: InboxItem) => {
    const currentCursor = readCursor();
    let newId = currentCursor.lastSeenId;
    let newTs = currentCursor.lastSeenTsMs;

    if (item.event.id !== undefined && item.event.id > newId) {
      newId = item.event.id;
    }
    const tsMs = new Date(item.event.timestamp).getTime();
    if (Number.isFinite(tsMs) && tsMs > newTs) {
      newTs = tsMs;
    }

    writeCursor(newId, newTs);
    setCursor({ lastSeenId: newId, lastSeenTsMs: newTs });
  }, []);

  return { items, unreadCount, loading, cursor, markAllRead, markRead };
}
