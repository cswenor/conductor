/**
 * Shared client-side DTO types for API responses.
 *
 * These mirror the shapes returned by the Next.js API routes.
 * Keep in sync with the API route handlers when fields change.
 */

/** Summary of a run, returned by GET /api/runs and embedded in other responses. */
export interface RunSummary {
  runId: string;
  taskId: string;
  projectId: string;
  repoId: string;
  runNumber: number;
  phase: string;
  step: string;
  status: string;
  taskTitle: string;
  projectName: string;
  repoFullName: string;
  branch: string;
  blockedReason?: string;
  prUrl?: string;
  prNumber?: number;
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  result?: string;
}

/** Paginated runs response from GET /api/runs. */
export interface RunsResponse {
  runs: RunSummary[];
  total: number;
}

/** An item requiring operator attention, returned by GET /api/approvals. */
export interface ApprovalItem {
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
  contextSummary?: string;
  blockedContext?: Record<string, unknown>;
}

/** Response from GET /api/approvals. */
export interface ApprovalsResponse {
  planApprovals: ApprovalItem[];
  escalations: ApprovalItem[];
  policyExceptions: ApprovalItem[];
  total: number;
  projects: ProjectOption[];
}

/** Lightweight project reference used in filter dropdowns. */
export interface ProjectOption {
  id: string;
  name: string;
}
