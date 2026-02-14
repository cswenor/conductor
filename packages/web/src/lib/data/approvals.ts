import {
  listProjects,
  getRunsAwaitingGates,
  deriveGateState,
  getLatestGateEvaluation,
  getLatestArtifact,
  getTask,
  getRepo,
  type Database,
} from '@conductor/shared';
import type { ApprovalItem, ApprovalsResponse, ProjectOption } from '@/lib/types';
import { excerptMarkdown } from '@/lib/utils';

export function fetchApprovalsData(
  db: Database,
  userId: string,
  filterProjectId?: string,
): ApprovalsResponse {
  const projects = listProjects(db, { userId });
  const now = Date.now();

  const planApprovals: ApprovalItem[] = [];
  const escalations: ApprovalItem[] = [];
  const policyExceptions: ApprovalItem[] = [];

  for (const project of projects) {
    if (filterProjectId !== undefined && project.projectId !== filterProjectId) {
      continue;
    }

    const awaitingRuns = getRunsAwaitingGates(db, project.projectId);

    for (const run of awaitingRuns) {
      const task = getTask(db, run.taskId);
      const repo = getRepo(db, run.repoId);
      const taskTitle = task?.githubTitle ?? 'Unknown task';
      const repoFullName = repo?.githubFullName ?? 'Unknown repo';
      const waitDurationMs = now - new Date(run.updatedAt).getTime();

      const gateState = deriveGateState(db, run.runId);
      let latestGateStatus: string | undefined;
      let latestGateReason: string | undefined;

      if (run.phase === 'awaiting_plan_approval') {
        const planGate = getLatestGateEvaluation(db, run.runId, 'plan_approval');
        latestGateStatus = planGate?.status;
        latestGateReason = planGate?.reason;

        const planArtifact = getLatestArtifact(db, run.runId, 'plan');
        const contextSummary = planArtifact?.contentMarkdown !== undefined
          ? excerptMarkdown(planArtifact.contentMarkdown)
          : undefined;

        planApprovals.push({
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
          latestGateStatus,
          latestGateReason,
          contextSummary,
          contextDetail: planArtifact?.contentMarkdown,
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

          policyExceptions.push({
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
            latestGateReason,
            contextSummary,
            blockedContext: blockedCtx,
          });
        } else {
          const testsGate = getLatestGateEvaluation(db, run.runId, 'tests_pass');
          const contextSummary = testsGate?.reason
            ?? (blockedCtx?.['error'] as string)
            ?? run.blockedReason
            ?? undefined;

          escalations.push({
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

  const sortByWait = (a: ApprovalItem, b: ApprovalItem) => b.waitDurationMs - a.waitDurationMs;
  planApprovals.sort(sortByWait);
  escalations.sort(sortByWait);
  policyExceptions.sort(sortByWait);

  const projectOptions: ProjectOption[] = projects.map(p => ({ id: p.projectId, name: p.name }));

  return {
    planApprovals,
    escalations,
    policyExceptions,
    total: planApprovals.length + escalations.length + policyExceptions.length,
    projects: projectOptions,
  };
}
