import {
  listRuns,
  countRuns,
  listProjects,
  getRunsAwaitingGates,
  deriveGateState,
  getLatestGateEvaluation,
  getLatestArtifact,
  getTask,
  getRepo,
  type Database,
  type RunPhase,
} from '@conductor/shared';
import type { RunSummary, ApprovalItem } from '@/lib/types';
import { excerptMarkdown } from '@/lib/utils';

export interface DashboardData {
  activeRuns: RunSummary[];
  recentlyCompleted: RunSummary[];
  approvals: ApprovalItem[];
  stats: {
    active: number;
    queued: number;
    needsYou: number;
    completedToday: number;
  };
}

export function fetchDashboardData(db: Database, userId: string): DashboardData {
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const completedAfter = todayStart.toISOString();

  const activePhases: RunPhase[] = ['planning', 'executing', 'awaiting_review'];
  const completedPhases: RunPhase[] = ['completed', 'cancelled'];

  const activeRuns = listRuns(db, {
    userId,
    phases: activePhases,
    excludePaused: true,
    limit: 10,
  });

  const recentlyCompleted = listRuns(db, {
    userId,
    phases: completedPhases,
    limit: 5,
  });

  const activeCount = countRuns(db, {
    userId,
    phases: activePhases,
    excludePaused: true,
  });

  const queuedCount = countRuns(db, {
    userId,
    phases: ['pending'],
  });

  const completedTodayCount = countRuns(db, {
    userId,
    phases: completedPhases,
    completedAfter,
  });

  // Assemble approvals
  const projects = listProjects(db, { userId });
  const now = Date.now();
  const allApprovals: ApprovalItem[] = [];

  for (const project of projects) {
    const awaitingRuns = getRunsAwaitingGates(db, project.projectId);

    for (const run of awaitingRuns) {
      const task = getTask(db, run.taskId);
      const repo = getRepo(db, run.repoId);
      const taskTitle = task?.githubTitle ?? 'Unknown task';
      const repoFullName = repo?.githubFullName ?? 'Unknown repo';
      const waitDurationMs = now - new Date(run.updatedAt).getTime();

      if (run.phase === 'awaiting_plan_approval') {
        const planGate = getLatestGateEvaluation(db, run.runId, 'plan_approval');
        const planArtifact = getLatestArtifact(db, run.runId, 'plan');
        const contextSummary = planArtifact?.contentMarkdown !== undefined
          ? excerptMarkdown(planArtifact.contentMarkdown)
          : undefined;

        allApprovals.push({
          runId: run.runId,
          phase: run.phase,
          taskId: run.taskId,
          repoId: run.repoId,
          taskTitle,
          repoFullName,
          projectName: project.name,
          projectId: project.projectId,
          updatedAt: run.updatedAt,
          waitDurationMs,
          gateType: 'plan_approval',
          latestGateStatus: planGate?.status,
          latestGateReason: planGate?.reason,
          contextSummary,
        });
      } else if (run.phase === 'blocked') {
        const blockedCtx = run.blockedContextJson !== undefined
          ? JSON.parse(run.blockedContextJson) as Record<string, unknown>
          : undefined;

        if (run.blockedReason === 'policy_exception_required') {
          const policyId = (blockedCtx?.['policy_id'] as string) ?? undefined;
          const constraintKind = (blockedCtx?.['constraint_kind'] as string) ?? undefined;
          const contextSummary = policyId !== undefined
            ? `Policy: ${policyId}${constraintKind !== undefined ? ` (${constraintKind})` : ''}`
            : undefined;
          const gateState = deriveGateState(db, run.runId);

          allApprovals.push({
            runId: run.runId,
            phase: run.phase,
            blockedReason: run.blockedReason,
            taskId: run.taskId,
            repoId: run.repoId,
            taskTitle,
            repoFullName,
            projectName: project.name,
            projectId: project.projectId,
            updatedAt: run.updatedAt,
            waitDurationMs,
            gateType: 'policy_exception',
            latestGateStatus: gateState['plan_approval'],
            contextSummary,
            blockedContext: blockedCtx,
          });
        } else {
          const testsGate = getLatestGateEvaluation(db, run.runId, 'tests_pass');
          const gateState = deriveGateState(db, run.runId);
          const contextSummary = testsGate?.reason
            ?? (blockedCtx?.['error'] as string)
            ?? run.blockedReason
            ?? undefined;

          allApprovals.push({
            runId: run.runId,
            phase: run.phase,
            blockedReason: run.blockedReason,
            taskId: run.taskId,
            repoId: run.repoId,
            taskTitle,
            repoFullName,
            projectName: project.name,
            projectId: project.projectId,
            updatedAt: run.updatedAt,
            waitDurationMs,
            gateType: 'escalation',
            latestGateStatus: gateState['tests_pass'],
            latestGateReason: testsGate?.reason,
            contextSummary,
            blockedContext: blockedCtx,
          });
        }
      }
    }
  }

  // Sort by wait time and take top 5
  allApprovals.sort((a, b) => b.waitDurationMs - a.waitDurationMs);
  const approvals = allApprovals.slice(0, 5);

  return {
    activeRuns,
    recentlyCompleted,
    approvals,
    stats: {
      active: activeCount,
      queued: queuedCount,
      needsYou: allApprovals.length,
      completedToday: completedTodayCount,
    },
  };
}
