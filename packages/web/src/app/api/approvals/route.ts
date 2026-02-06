/**
 * Approvals API
 *
 * List runs awaiting operator decisions, grouped by gate type.
 * Returns plan approvals, failure escalations, and policy exceptions.
 */

import { NextResponse } from 'next/server';
import {
  createLogger,
  listProjects,
  getRunsAwaitingGates,
  deriveGateState,
  getLatestGateEvaluation,
  getLatestArtifact,
  getTask,
  getRepo,
} from '@conductor/shared';
import { ensureBootstrap, getDb } from '@/lib/bootstrap';
import { withAuth, type AuthenticatedRequest } from '@/lib/auth';

const log = createLogger({ name: 'conductor:api:approvals' });

interface ApprovalItem {
  runId: string;
  phase: string;
  blockedReason?: string;
  taskId: string;
  repoId: string;
  taskTitle: string;
  repoFullName: string;
  projectName: string;
  projectId: string;
  updatedAt: string;
  waitDurationMs: number;
  gateType: 'plan_approval' | 'escalation' | 'policy_exception';
  latestGateStatus?: string;
  latestGateReason?: string;
  /** Short context summary: plan excerpt, test failure, or violation details */
  contextSummary?: string;
  /** Blocked context details (for policy exceptions) */
  blockedContext?: Record<string, unknown>;
}

/** Truncate markdown to a short excerpt (first non-heading paragraph, max 200 chars). */
function excerptMarkdown(md: string, maxLen = 200): string {
  const lines = md.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    // Skip headings, empty lines, and frontmatter
    if (trimmed === '' || trimmed.startsWith('#') || trimmed.startsWith('---')) continue;
    if (trimmed.length > maxLen) return `${trimmed.slice(0, maxLen)}...`;
    return trimmed;
  }
  return md.slice(0, maxLen);
}

/**
 * GET /api/approvals
 *
 * List all pending approvals for the authenticated user's projects.
 * Grouped by gate type: plan approvals, escalations, policy exceptions.
 */
export const GET = withAuth(async (request: AuthenticatedRequest): Promise<NextResponse> => {
  try {
    await ensureBootstrap();
    const db = await getDb();

    const url = new URL(request.url);
    const filterProjectId = url.searchParams.get('projectId');

    // Get user's projects
    const projects = listProjects(db, { userId: request.user.userId });
    const now = Date.now();

    const planApprovals: ApprovalItem[] = [];
    const escalations: ApprovalItem[] = [];
    const policyExceptions: ApprovalItem[] = [];

    for (const project of projects) {
      if (filterProjectId !== null && project.projectId !== filterProjectId) {
        continue;
      }

      const awaitingRuns = getRunsAwaitingGates(db, project.projectId);

      for (const run of awaitingRuns) {
        const task = getTask(db, run.taskId);
        const repo = getRepo(db, run.repoId);
        const taskTitle = task?.githubTitle ?? 'Unknown task';
        const repoFullName = repo?.githubFullName ?? 'Unknown repo';
        const waitDurationMs = now - new Date(run.updatedAt).getTime();

        // Get latest gate evaluation for context
        const gateState = deriveGateState(db, run.runId);
        let latestGateStatus: string | undefined;
        let latestGateReason: string | undefined;

        if (run.phase === 'awaiting_plan_approval') {
          const planGate = getLatestGateEvaluation(db, run.runId, 'plan_approval');
          latestGateStatus = planGate?.status;
          latestGateReason = planGate?.reason;

          // Plan excerpt for context
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
          });
        } else if (run.phase === 'blocked') {
          // Parse blocked context for detail extraction
          const blockedCtx = run.blockedContextJson !== undefined
            ? JSON.parse(run.blockedContextJson) as Record<string, unknown>
            : undefined;

          if (run.blockedReason === 'policy_exception_required') {
            // Extract policy violation details from blocked context
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
            // retry_limit_exceeded, gate_failed, etc.
            // Extract failure details from gate evaluation or blocked context
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

    // Sort by wait time within each group (oldest first)
    const sortByWait = (a: ApprovalItem, b: ApprovalItem) => b.waitDurationMs - a.waitDurationMs;
    planApprovals.sort(sortByWait);
    escalations.sort(sortByWait);
    policyExceptions.sort(sortByWait);

    // Collect unique projects for filter dropdown
    const projectOptions = projects.map(p => ({ id: p.projectId, name: p.name }));

    return NextResponse.json({
      planApprovals,
      escalations,
      policyExceptions,
      total: planApprovals.length + escalations.length + policyExceptions.length,
      projects: projectOptions,
    });
  } catch (err) {
    log.error(
      { error: err instanceof Error ? err.message : 'Unknown error' },
      'Failed to list approvals'
    );
    return NextResponse.json(
      { error: 'Failed to list approvals' },
      { status: 500 }
    );
  }
});
