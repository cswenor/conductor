/**
 * Pure helpers for the run detail page.
 *
 * Extracted so they can be unit-tested without a DOM environment.
 */

const ACTION_LABELS: Record<string, string> = {
  create_plan: 'Planning',
  review_plan: 'Plan Review',
  apply_changes: 'Implementation',
  run_tests: 'Test Execution',
};

/**
 * Returns a human-readable label for an agent action string.
 * Falls back to title-cased version of the raw action.
 */
export function getActionLabel(action: string): string {
  return ACTION_LABELS[action] ?? action.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

/**
 * Extracts a short human-readable summary from a run event's payload.
 * Returns "—" for unrecognised event types or malformed payloads.
 */
export function getEventSummary(event: { type: string; payload: unknown }): string {
  try {
    const p = event.payload as Record<string, unknown>;
    switch (event.type) {
      case 'phase.transitioned': {
        const from = typeof p['from'] === 'string' ? p['from'] : '?';
        const to = typeof p['to'] === 'string' ? p['to'] : '?';
        return `${from} → ${to}`;
      }
      case 'agent.failed':
        return (p['errorMessage'] as string) ?? (p['error_message'] as string) ?? '—';
      case 'agent.started':
      case 'agent.completed': {
        const agent = (p['agent'] as string) ?? '';
        const action = (p['action'] as string) ?? '';
        return agent + (action ? `: ${getActionLabel(action)}` : '');
      }
      default:
        return '—';
    }
  } catch {
    return '—';
  }
}
