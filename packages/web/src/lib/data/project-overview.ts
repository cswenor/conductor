import {
  listRuns,
  countRuns,
  type Database,
  type RunPhase,
} from '@conductor/shared';
import type { RunSummary } from '@/lib/types';

export interface ProjectOverviewData {
  activeCount: number;
  blockedCount: number;
  awaitingApprovalCount: number;
  completedThisWeekCount: number;
  blockedRuns: RunSummary[];
  awaitingApprovalRuns: RunSummary[];
  lastShippedPr: RunSummary | null;
}

export function fetchProjectOverviewData(
  db: Database,
  projectId: string,
): ProjectOverviewData {
  const weekStart = new Date();
  weekStart.setDate(weekStart.getDate() - 7);
  weekStart.setHours(0, 0, 0, 0);
  const completedAfter = weekStart.toISOString();

  const activePhases: RunPhase[] = ['planning', 'executing', 'awaiting_review'];

  const activeCount = countRuns(db, {
    projectId,
    phases: activePhases,
    excludePaused: true,
  });

  const blockedCount = countRuns(db, {
    projectId,
    phases: ['blocked'],
  });

  const awaitingApprovalCount = countRuns(db, {
    projectId,
    phases: ['awaiting_plan_approval'],
  });

  const completedThisWeekCount = countRuns(db, {
    projectId,
    phases: ['completed'],
    completedAfter,
  });

  const blockedRuns = listRuns(db, {
    projectId,
    phases: ['blocked'],
    limit: 5,
    sortDir: 'asc',
  });

  const awaitingApprovalRuns = listRuns(db, {
    projectId,
    phases: ['awaiting_plan_approval'],
    limit: 5,
    sortDir: 'asc',
  });

  const lastShippedCandidates = listRuns(db, {
    projectId,
    phases: ['completed'],
    result: 'success',
    hasPrUrl: true,
    sortBy: 'completed_at',
    sortDir: 'desc',
    limit: 1,
  });

  return {
    activeCount,
    blockedCount,
    awaitingApprovalCount,
    completedThisWeekCount,
    blockedRuns,
    awaitingApprovalRuns,
    lastShippedPr: lastShippedCandidates[0] ?? null,
  };
}
