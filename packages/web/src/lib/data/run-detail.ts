import {
  getRun,
  getTask,
  getProject,
  getRepo,
  canAccessProject,
  listRunEvents,
  deriveGateState,
  listGateEvaluations,
  listOperatorActions,
  getRunGateConfig,
  listAgentInvocations,
  getAgentMessageCountsByRun,
  type Database,
  type Run,
} from '@conductor/shared';
import type { AuthUser } from '@/lib/auth/middleware';

export interface RunDetailData {
  run: Run;
  task: {
    taskId: string;
    githubTitle: string;
    githubIssueNumber: number;
    githubType: string;
    githubState: string;
  } | null;
  repo: {
    repoId: string;
    githubFullName: string;
    githubOwner: string;
    githubName: string;
  } | null;
  events: ReturnType<typeof listRunEvents>;
  gates: Record<string, string>;
  gateEvaluations: ReturnType<typeof listGateEvaluations>;
  operatorActions: ReturnType<typeof listOperatorActions>;
  agentInvocations: ReturnType<typeof listAgentInvocations>;
  messageCounts: Record<string, number>;
  requiredGates: string[];
  optionalGates: string[];
}

export function fetchRunDetail(
  db: Database,
  user: AuthUser,
  runId: string,
): RunDetailData | null {
  const run = getRun(db, runId);
  if (run === null) return null;

  const project = getProject(db, run.projectId);
  if (project === null || !canAccessProject(user, project)) return null;

  const task = getTask(db, run.taskId);
  const repo = getRepo(db, run.repoId);
  const events = listRunEvents(db, run.runId);
  const gates = deriveGateState(db, run.runId);
  const gateEvaluations = listGateEvaluations(db, run.runId);
  const operatorActions = listOperatorActions(db, run.runId);
  const agentInvocations = listAgentInvocations(db, run.runId);
  const messageCounts = getAgentMessageCountsByRun(db, run.runId);
  const { requiredGates, optionalGates } = getRunGateConfig(db, run.runId);

  return {
    run,
    task: task !== null ? {
      taskId: task.taskId,
      githubTitle: task.githubTitle,
      githubIssueNumber: task.githubIssueNumber,
      githubType: task.githubType,
      githubState: task.githubState,
    } : null,
    repo: repo !== null ? {
      repoId: repo.repoId,
      githubFullName: repo.githubFullName,
      githubOwner: repo.githubOwner,
      githubName: repo.githubName,
    } : null,
    events,
    gates,
    gateEvaluations,
    operatorActions,
    agentInvocations,
    messageCounts,
    requiredGates,
    optionalGates,
  };
}
