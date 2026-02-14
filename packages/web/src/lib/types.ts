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

/** An item requiring operator attention. Used by lib/data/approvals.ts and dashboard.ts. */
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
  contextDetail?: string;
  blockedContext?: Record<string, unknown>;
}

/** Approvals data shape used by lib/data/approvals.ts. */
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

/** Analytics metrics shape used by the analytics page. */
export interface AnalyticsResponse {
  totalRuns: number;
  completedRuns: number;
  successRate: number;
  avgCycleTimeMs: number;
  avgApprovalWaitMs: number;
  runsByPhase: Record<string, number>;
  runsByProject: Array<{ projectId: string; projectName: string; count: number }>;
  recentCompletions: Array<{ date: string; count: number }>;
}
