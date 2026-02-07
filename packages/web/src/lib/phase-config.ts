/**
 * Phase configuration and UI helpers for the V2 UX.
 *
 * Maps canonical RunPhase values to display labels and badge variants,
 * and provides helpers for the intent-driven Work page tabs.
 */

import type { RunPhase, RunStatus } from '@conductor/shared';

export interface PhaseDisplay {
  label: string;
  variant: 'default' | 'secondary' | 'destructive' | 'success' | 'warning' | 'outline';
}

export const phaseConfig: Record<RunPhase, PhaseDisplay> = {
  pending:                { label: 'Pending',           variant: 'secondary' },
  planning:               { label: 'Planning',          variant: 'secondary' },
  awaiting_plan_approval: { label: 'Awaiting Approval', variant: 'secondary' },
  executing:              { label: 'Executing',         variant: 'secondary' },
  awaiting_review:        { label: 'Awaiting Review',   variant: 'secondary' },
  blocked:                { label: 'Blocked',           variant: 'destructive' },
  completed:              { label: 'Completed',         variant: 'success' },
  cancelled:              { label: 'Cancelled',         variant: 'secondary' },
};

/**
 * Returns the human-readable UI label for a phase.
 * Falls back to the raw phase string for unknown values.
 */
export function getPhaseLabel(phase: string): string {
  const config = phaseConfig[phase as RunPhase];
  return config?.label ?? phase;
}

/**
 * Returns the badge variant for a phase.
 * Falls back to 'secondary' for unknown values.
 */
export function getPhaseVariant(phase: string): PhaseDisplay['variant'] {
  const config = phaseConfig[phase as RunPhase];
  return config?.variant ?? 'secondary';
}

export type WorkTab = 'active' | 'queued' | 'blocked' | 'completed';

/**
 * Maps a run's phase and status to the appropriate Work page tab.
 *
 * Tab groupings (by operator intent):
 *   Active:    planning, executing, awaiting_review (non-paused)
 *   Queued:    pending
 *   Blocked:   awaiting_plan_approval, blocked, plus any paused run
 *   Completed: completed, cancelled
 */
export function getWorkTab(phase: string, status?: RunStatus): WorkTab {
  // Paused runs always show in Blocked regardless of phase
  if (status === 'paused') return 'blocked';

  switch (phase) {
    case 'pending':
      return 'queued';
    case 'planning':
    case 'executing':
    case 'awaiting_review':
      return 'active';
    case 'awaiting_plan_approval':
    case 'blocked':
      return 'blocked';
    case 'completed':
    case 'cancelled':
      return 'completed';
    default:
      return 'active';
  }
}

/** Phase sets for each Work tab, used for API queries. */
export const workTabPhases: Record<WorkTab, readonly RunPhase[]> = {
  active:    ['planning', 'executing', 'awaiting_review'],
  queued:    ['pending'],
  blocked:   ['awaiting_plan_approval', 'blocked'],
  completed: ['completed', 'cancelled'],
};

/**
 * Formats an ISO date string as a relative time ago (e.g. "5m ago", "2h ago").
 */
export function timeAgo(dateString: string): string {
  const date = new Date(dateString);
  const now = new Date();
  const seconds = Math.floor((now.getTime() - date.getTime()) / 1000);

  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

/**
 * Formats a wait duration in milliseconds to a short string (e.g. "5m", "2h").
 */
export function formatWaitDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}

/**
 * Formats an ISO date string to a locale-aware timestamp string.
 */
export function formatTimestamp(dateString: string): string {
  return new Date(dateString).toLocaleString();
}

/**
 * Formats a duration in milliseconds to a human-readable string.
 *
 *   formatDuration(30_000)       → "30s"
 *   formatDuration(720_000)      → "12m"
 *   formatDuration(5_400_000)    → "1h 30m"
 *   formatDuration(172_800_000)  → "2d"
 *   formatDuration(90_000_000)   → "1d 1h"
 */
export function formatDuration(ms: number): string {
  if (ms < 0) return '0s';

  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) {
    const remainingHours = hours % 24;
    return remainingHours > 0 ? `${days}d ${remainingHours}h` : `${days}d`;
  }
  if (hours > 0) {
    const remainingMinutes = minutes % 60;
    return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
  }
  if (minutes > 0) {
    return `${minutes}m`;
  }
  return `${seconds}s`;
}
