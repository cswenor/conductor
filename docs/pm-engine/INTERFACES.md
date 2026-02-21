# Conductor PM Engine Interfaces (MCP + A2A + Web API)

Status: Vision — Not implemented in v0.1. Design-only; not yet built. Do not use as implementation reference for the current codebase.
Owner: PM Engine
Updated: 2026-02-19

## Scope
This document is the normative interface specification for Conductor PM Engine across three transports:
- MCP tools (`conductor_*`) for AI agents.
- A2A messages for delegated agent workflows.
- Web API for human UI and external systems.

Every capability in this document is transport-equivalent: same semantic input contract, same semantic output contract, same side effects, same authorization and policy checks.

## Implementation Tiers

All 55 tools are specified here for completeness. They are grouped into implementation tiers to guide build order:

| Tier | Tools | Rationale |
| --- | --- | --- |
| **Tier 1 (MVP)** ~20 tools | Board/workflow CRUD (get_board, list/get/update/transition work items), dependency management (add/resolve/get), triage, plan iteration, suggest next, start/cancel/get run, list runs, record decision/outcome, sync, velocity, cycle time | Core loop: triage → plan → execute → review → learn |
| **Tier 2 (Intelligence)** ~15 tools | Monte Carlo, rework prediction, risk radar, anomalies, standup/retro generation, PR review, PR impact, scope creep detection, approve/reject plan, retry run, workflow health | Prediction, quality gates, and operational intelligence |
| **Tier 3 (Advanced)** ~17 tools | Backlog forecast, delay simulation/explanation, estimate comparison, graph export/analysis/critical path, capacity modeling, session context builder, spec validation, backlog ranking, decompose work item, assign iteration items, release notes, query/suggest memory | Portfolio optimization, advanced analytics, full memory system |

All tiers share the same schemas and service layer. Tiering affects build priority, not architecture.

## Transport Parity and Schema Deduplication

Each atomic operation has exactly ONE canonical input schema and ONE canonical output schema. The MCP tool, A2A message payload, and Web API request body all use the same schema.

- MCP: `conductor_{operation}` tool with input/output schemas defined in Part 1.
- A2A: The A2A workflow payload wraps the same input schema inside the A2A envelope.
- Web API: `POST /api/pm/tools/{tool_name}` with the MCP input schema as request body.

**When to define separate A2A payloads (Part 3):**
Part 3 defines composite workflow payloads for multi-step agent interactions that orchestrate multiple tool calls into a single request/response cycle (e.g., triage includes similar items + predictions; review includes PR diff + findings + verdict). These composite payloads SHOULD compose Part 1 schemas by reference (`$ref` or embedding) rather than redefining fields. Single-tool A2A calls MUST use the MCP schema directly — do NOT create a wrapper payload for a 1:1 mapping.

## Normative Terms
- MUST: required for compliant implementation.
- SHOULD: recommended unless there is a documented reason to differ.
- MAY: optional.

## Transport Parity Contract
A capability is implemented once in the PM service layer, then exposed via:
- MCP: exact tool names defined in Part 1.
- A2A: `operation` values defined in Part 3.
- Web API: `POST /api/pm/tools/{tool_name}` for direct tool calls.

## Shared Envelopes and Types
```ts
import { z } from 'zod/v4';

// -----------------------------------------------------------------------------
// Primitive and JSON types
// -----------------------------------------------------------------------------

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() => z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
  z.array(JsonValueSchema),
  z.record(z.string(), JsonValueSchema),
]));

export const IsoDateTime = z.string().datetime({ offset: true });
export const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const ProjectId = z.string().min(1);
export const RepoId = z.string().min(1);
export const RunId = z.string().min(1);
export const TaskId = z.string().min(1);
export const WorkItemId = z.number().int().positive();
export const WorkItemUid = z.string().min(1);
export const IterationId = z.number().int().positive();
export const DependencyId = z.number().int().positive();
export const DecisionId = z.number().int().positive();
export const OutcomeId = z.number().int().positive();

export const SortDirection = z.enum(['asc', 'desc']);

export const WorkItemType = z.enum(['epic', 'feature', 'bug', 'chore', 'spike', 'incident', 'task']);
export const WorkItemState = z.enum(['backlog', 'ready', 'in_progress', 'blocked', 'in_review', 'done', 'cancelled']);
// Priority uses numeric bands (p0=critical through p4=lowest) for extensibility.
// Human-readable mapping: p0=critical, p1=high, p2=normal, p3=low, p4=backlog.
// The claude-pm-toolkit used string labels (critical/high/normal/low).
// Conductor standardizes on p0-p4 with display labels resolved at presentation layer.
export const PriorityBand = z.enum(['p0', 'p1', 'p2', 'p3', 'p4']);
export const RiskLevel = z.enum(['low', 'medium', 'high', 'critical']);

export const DependencyType = z.enum(['blocks', 'prerequisite', 'related']);
export const DependencyStrength = z.enum(['hard', 'soft', 'informational']);
export const DependencyStatus = z.enum(['active', 'resolved', 'invalidated']);

export const IterationKind = z.enum(['sprint', 'continuous', 'release', 'milestone', 'ad_hoc']);
export const PlanningMode = z.enum(['scrum', 'kanban', 'hybrid']);
export const IterationState = z.enum(['planned', 'active', 'closed', 'archived']);
export const CommitmentLevel = z.enum(['committed', 'stretch', 'candidate', 'carryover']);

export const RunPhase = z.enum([
  'pending',
  'planning',
  'awaiting_plan_approval',
  'executing',
  'awaiting_review',
  'blocked',
  'completed',
  'cancelled',
]);

// NOTE: Workflow templates use descriptive phase names (e.g., 'plan_approval',
// 'implementing', 'reviewing', 'testing', 'reworking') that are more human-readable.
// The orchestrator maps these to RunPhase values via the template's phase_mapping table:
//   template 'plan_approval'  → RunPhase 'awaiting_plan_approval'
//   template 'implementing'   → RunPhase 'executing'
//   template 'testing'        → RunPhase 'executing' (sub-phase)
//   template 'reviewing'      → RunPhase 'awaiting_review'
//   template 'reworking'      → RunPhase 'executing' (sub-phase)
// See WORKFLOW_ENGINE.md § 1.2 for template phase definitions.

export const RunStep = z.enum([
  'setup_worktree',
  'route',
  'planner_create_plan',
  'reviewer_review_plan',
  'wait_plan_approval',
  'implementer_apply_changes',
  'tester_run_tests',
  'reviewer_review_code',
  'create_pr',
  'wait_pr_merge',
  'cleanup',
]);

export const RunStatus = z.enum(['active', 'paused', 'blocked', 'finished']);

export const GateStatus = z.enum(['pending', 'passed', 'failed']);
export const GateId = z.enum(['plan_approval', 'tests_pass', 'code_review', 'merge_wait']);

export const PaginationSchema = z.object({
  limit: z.number().int().min(1).max(200).default(50),
  cursor: z.string().optional(),
  offset: z.number().int().min(0).default(0),
});

export const CursorPageSchema = z.object({
  next_cursor: z.string().optional(),
  total_estimate: z.number().int().min(0).optional(),
});

export const DateRangeSchema = z.object({
  from: IsoDateTime.optional(),
  to: IsoDateTime.optional(),
});

export const ActorSchema = z.object({
  actor_id: z.string().min(1),
  actor_type: z.enum(['human', 'agent', 'system', 'external']),
});

// -----------------------------------------------------------------------------
// Error and result envelope
// -----------------------------------------------------------------------------

export const ToolErrorCode = z.enum([
  'UNAUTHORIZED',
  'FORBIDDEN',
  'NOT_FOUND',
  'VALIDATION_ERROR',
  'CONFLICT',
  'PRECONDITION_FAILED',
  'STATE_TRANSITION_INVALID',
  'DEPENDENCY_CYCLE',
  'DEPENDENCY_UNRESOLVED',
  'RUN_PHASE_INVALID',
  'GATE_REQUIRED',
  'POLICY_BLOCKED',
  'INSUFFICIENT_DATA',
  'RATE_LIMITED',
  'TIMEOUT',
  'INTERNAL_ERROR',
]);

export const ToolErrorSchema = z.object({
  code: ToolErrorCode,
  message: z.string(),
  details: z.record(z.string(), JsonValueSchema).optional(),
  retryable: z.boolean().default(false),
});

export const ToolMetaSchema = z.object({
  request_id: z.string().min(1),
  project_id: ProjectId.optional(),
  as_of: IsoDateTime,
  schema_version: z.literal('1.1'),
});

export const makeToolResultSchema = <T extends z.ZodTypeAny>(dataSchema: T) => z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), data: dataSchema, meta: ToolMetaSchema }),
  z.object({ ok: z.literal(false), error: ToolErrorSchema, meta: ToolMetaSchema }),
]);

// -----------------------------------------------------------------------------
// Web API and direct A2A pass-through wrappers
// -----------------------------------------------------------------------------

export const WebToolRequestSchema = z.object({
  tool: z.string().regex(/^conductor_[a-z0-9_]+$/),
  input: z.record(z.string(), JsonValueSchema),
  actor: ActorSchema,
  request_id: z.string().min(1),
});

export const WebToolResponseSchema = z.object({
  ok: z.boolean(),
  data: JsonValueSchema.optional(),
  error: ToolErrorSchema.optional(),
  meta: ToolMetaSchema,
});

export const A2AToolCallSchema = z.object({
  operation: z.string().regex(/^conductor_[a-z0-9_]+$/),
  input: z.record(z.string(), JsonValueSchema),
});

export const A2AToolResultSchema = z.object({
  operation: z.string().regex(/^conductor_[a-z0-9_]+$/),
  ok: z.boolean(),
  data: JsonValueSchema.optional(),
  error: ToolErrorSchema.optional(),
});
```

## Shared Domain Schemas
```ts
import { z } from 'zod/v4';

export const WorkItemEstimateSchema = z.object({
  p50_hours: z.number().min(0).optional(),
  p80_hours: z.number().min(0).optional(),
  p95_hours: z.number().min(0).optional(),
});

export const WorkItemPredictionSchema = z.object({
  computed_at: IsoDateTime,
  spec_readiness: z.number().min(0).max(1).nullable().optional(),
  rework_probability: z.number().min(0).max(1).nullable().optional(),
  bottleneck_score: z.number().min(0).max(100).nullable().optional(),
  forecast_confidence: z.number().min(0).max(1).nullable().optional(),
  value_score: z.number().min(0).nullable().optional(),
  wsjf_score: z.number().nullable().optional(),
  next_action: z.string().nullable().optional(),
  rationale: z.record(z.string(), JsonValueSchema).optional(),
  estimates: WorkItemEstimateSchema.optional(),
});

export const WorkItemSummarySchema = z.object({
  work_item_id: WorkItemId,
  work_item_uid: WorkItemUid,
  project_id: ProjectId,
  primary_repo_id: RepoId.nullable().optional(),
  parent_work_item_id: WorkItemId.nullable().optional(),
  title: z.string().min(1),
  item_type: WorkItemType,
  state: WorkItemState,
  priority_band: PriorityBand,
  risk_level: RiskLevel,
  area: z.string().nullable().optional(),
  subarea: z.string().nullable().optional(),
  owner_actor_id: z.string().nullable().optional(),
  due_at: IsoDateTime.nullable().optional(),
  blocked_by_active_count: z.number().int().min(0).default(0),
  labels: z.array(z.string()).default([]),
  updated_at: IsoDateTime,
});

export const WorkItemDetailSchema = WorkItemSummarySchema.extend({
  body_md: z.string().default(''),
  acceptance_criteria_md: z.string().default(''),
  source_of_truth: z.enum(['conductor', 'github', 'imported']).default('conductor'),
  started_at: IsoDateTime.nullable().optional(),
  completed_at: IsoDateTime.nullable().optional(),
  cancelled_at: IsoDateTime.nullable().optional(),
  created_at: IsoDateTime,
  version: z.number().int().min(0),
  ai_current: WorkItemPredictionSchema.optional(),
});

export const WorkItemHistoryEventSchema = z.object({
  event_id: z.string().min(1),
  event_type: z.string().min(1),
  occurred_at: IsoDateTime,
  actor_id: z.string().nullable().optional(),
  payload: z.record(z.string(), JsonValueSchema),
});

export const DependencyEdgeSchema = z.object({
  dependency_id: DependencyId,
  predecessor_work_item_id: WorkItemId,
  successor_work_item_id: WorkItemId,
  dependency_type: DependencyType,
  strength: DependencyStrength,
  status: DependencyStatus,
  lag_hours: z.number().min(0),
  rationale: z.string().optional(),
  created_by_actor_id: z.string().min(1),
  created_at: IsoDateTime,
  resolved_by_actor_id: z.string().nullable().optional(),
  resolved_at: IsoDateTime.nullable().optional(),
});

export const DependencyNodeSchema = z.object({
  work_item_id: WorkItemId,
  title: z.string(),
  state: WorkItemState,
  item_type: WorkItemType,
  priority_band: PriorityBand,
  risk_level: RiskLevel,
  is_on_critical_path: z.boolean().optional(),
});

export const DependencyGraphMetricsSchema = z.object({
  node_count: z.number().int().min(0),
  edge_count: z.number().int().min(0),
  active_edge_count: z.number().int().min(0),
  cycle_count: z.number().int().min(0),
  critical_path_hours_p50: z.number().min(0),
  critical_path_hours_p80: z.number().min(0),
  recomputed_at: IsoDateTime.optional(),
});

export const IterationSummarySchema = z.object({
  iteration_id: IterationId.optional(),
  iteration_uid: z.string().optional(),
  project_id: ProjectId,
  name: z.string().min(1),
  iteration_kind: IterationKind,
  planning_mode: PlanningMode,
  state: IterationState,
  objective_md: z.string().default(''),
  start_at: IsoDateTime.nullable().optional(),
  end_at: IsoDateTime.nullable().optional(),
  capacity_hours: z.number().min(0).nullable().optional(),
  wip_limit: z.number().int().min(0).nullable().optional(),
});

export const IterationCandidateSchema = z.object({
  work_item_id: WorkItemId,
  title: z.string(),
  commitment_level: CommitmentLevel,
  rank_in_iteration: z.number().int().positive().optional(),
  planned_hours: z.number().min(0).optional(),
  estimate_hours_p50: z.number().min(0).optional(),
  estimate_hours_p80: z.number().min(0).optional(),
  reasons: z.array(z.string()).default([]),
});

export const CapacitySummarySchema = z.object({
  hours_p50: z.number().min(0),
  hours_p80: z.number().min(0),
  confidence: z.number().min(0).max(1),
  remaining_hours_p50: z.number().min(0).optional(),
  remaining_hours_p80: z.number().min(0).optional(),
});

export const TriageAssessmentSchema = z.object({
  item_type: WorkItemType,
  area: z.string().nullable().optional(),
  subarea: z.string().nullable().optional(),
  priority_band: PriorityBand,
  risk_level: RiskLevel,
  spec_readiness: z.number().min(0).max(1),
  value_score: z.number().min(0).optional(),
  rework_probability: z.number().min(0).max(1).optional(),
  confidence: z.number().min(0).max(1),
});

export const SimilarItemSchema = z.object({
  work_item_id: WorkItemId,
  title: z.string(),
  similarity: z.number().min(0).max(1),
  outcome_hint: z.enum(['positive', 'neutral', 'negative']).optional(),
});

// ReviewFindingSchema aligns with pm_review_findings DB table.
// DB columns: source, review_context, category, severity, disposition.
// Interface uses the same vocabulary to avoid mapping ambiguity.
export const ReviewFindingSchema = z.object({
  finding_id: z.string().optional(),
  category: z.enum(['correctness', 'security', 'performance', 'maintainability', 'testing', 'spec', 'scope']),
  severity: z.enum(['blocking', 'high', 'medium', 'low', 'suggestion']),
  review_context: z.enum(['code_review', 'plan_review', 'spec_review', 'pr_comment', 'ci_check']).default('code_review'),
  location: z.string().min(1),
  issue: z.string().min(1),
  fix: z.string().min(1),
  confidence: z.number().min(0).max(1).optional(),
});

export const RiskDimensionSchema = z.object({
  dimension: z.enum([
    'scope',
    'dependency',
    'quality',
    'delivery',
    'operational',
    'stakeholder',
    'knowledge',
  ]),
  score: z.number().min(0).max(100),
  trend: z.enum(['up', 'flat', 'down']),
  evidence: z.array(z.string()).default([]),
});

export const RunSummarySchema = z.object({
  run_id: RunId,
  task_id: TaskId,
  project_id: ProjectId,
  repo_id: RepoId,
  run_number: z.number().int().min(1),
  phase: RunPhase,
  step: RunStep,
  status: RunStatus,
  branch: z.string(),
  base_branch: z.string(),
  blocked_reason: z.string().nullable().optional(),
  pr_number: z.number().int().positive().nullable().optional(),
  pr_url: z.string().url().nullable().optional(),
  started_at: IsoDateTime,
  updated_at: IsoDateTime,
  completed_at: IsoDateTime.nullable().optional(),
  result: z.string().nullable().optional(),
  result_reason: z.string().nullable().optional(),
});

export const RunDetailSchema = RunSummarySchema.extend({
  parent_run_id: RunId.nullable().optional(),
  supersedes_run_id: RunId.nullable().optional(),
  paused_at: IsoDateTime.nullable().optional(),
  paused_by: z.string().nullable().optional(),
  blocked_context: z.record(z.string(), JsonValueSchema).optional(),
  implementer_backend: z.enum(['raw', 'agent_sdk']),
  head_sha: z.string().nullable().optional(),
  pr_node_id: z.string().nullable().optional(),
  plan_revisions: z.number().int().min(0),
  test_fix_attempts: z.number().int().min(0),
  review_rounds: z.number().int().min(0),
  approval_cycle: z.number().int().min(0),
  workflow_epoch: z.number().int().min(0),
});

export const RunTimelineEventSchema = z.object({
  event_id: z.string().min(1),
  sequence: z.number().int().min(1),
  type: z.string().min(1),
  occurred_at: IsoDateTime,
  phase_from: RunPhase.optional(),
  phase_to: RunPhase.optional(),
  step: RunStep.optional(),
  summary: z.string().optional(),
});

export const RunArtifactSchema = z.object({
  artifact_id: z.string().min(1),
  artifact_type: z.enum([
    // Development artifacts
    'PLAN', 'PLAN_METADATA', 'CODE', 'PATCHSET', 'TEST_REPORT',
    // Review artifacts
    'REVIEW', 'REVIEW_FINDINGS', 'REVIEW_VERDICT',
    // Research artifacts
    'RESEARCH',
    // PM reporting artifacts
    'STANDUP', 'RETRO', 'RELEASE_NOTES',
    // Operational artifacts
    'DEPLOY_LOG', 'METRICS', 'CUSTOM',
  ]),
  created_at: IsoDateTime,
  uri: z.string().optional(),
  content_type: z.string().optional(),
  checksum: z.string().optional(),
});
```

## Part 1: MCP Tool Catalog (55 Tools)

All tools return `makeToolResultSchema(<OutputSchema>)` and MUST enforce project-scoped authz before execution.

### 1. Board and Workflow (9)

#### Schemas
```ts
import { z } from 'zod/v4';

export const ConductorGetBoardInputSchema = z.object({
  project_id: ProjectId,
  states: z.array(WorkItemState).optional(),
  include_metrics: z.boolean().default(true),
  include_blocked_reasons: z.boolean().default(true),
  limit_per_state: z.number().int().min(1).max(200).default(50),
});

export const ConductorGetBoardOutputSchema = z.object({
  lanes: z.array(z.object({
    state: WorkItemState,
    total: z.number().int().min(0),
    wip_limit: z.number().int().min(0).nullable().optional(),
    items: z.array(WorkItemSummarySchema),
  })),
  health: z.object({
    health_score: z.number().min(0).max(100),
    blocked_ratio: z.number().min(0).max(1),
    stale_item_count: z.number().int().min(0),
    wip_violation_count: z.number().int().min(0),
    updated_at: IsoDateTime,
  }),
});

export const ConductorListWorkItemsInputSchema = z.object({
  project_id: ProjectId,
  query: z.string().optional(),
  states: z.array(WorkItemState).optional(),
  item_types: z.array(WorkItemType).optional(),
  priorities: z.array(PriorityBand).optional(),
  risks: z.array(RiskLevel).optional(),
  owner_actor_ids: z.array(z.string()).optional(),
  labels: z.array(z.string()).optional(),
  sort_by: z.enum(['updated_at', 'wsjf_score', 'value_score', 'due_at', 'state']).default('updated_at'),
  sort_direction: SortDirection.default('desc'),
  pagination: PaginationSchema.optional(),
});

export const ConductorListWorkItemsOutputSchema = z.object({
  items: z.array(WorkItemSummarySchema),
  page: CursorPageSchema,
});

export const ConductorGetWorkItemInputSchema = z.object({
  project_id: ProjectId,
  work_item_id: WorkItemId.optional(),
  work_item_uid: WorkItemUid.optional(),
  include_history: z.boolean().default(true),
  include_dependencies: z.boolean().default(true),
  include_predictions: z.boolean().default(true),
}).refine((v) => v.work_item_id !== undefined || v.work_item_uid !== undefined, {
  message: 'Either work_item_id or work_item_uid is required',
});

export const ConductorGetWorkItemOutputSchema = z.object({
  work_item: WorkItemDetailSchema,
  history: z.array(WorkItemHistoryEventSchema).optional(),
  dependencies: z.object({
    predecessors: z.array(DependencyEdgeSchema),
    successors: z.array(DependencyEdgeSchema),
  }).optional(),
  predictions: WorkItemPredictionSchema.optional(),
});

export const ConductorUpdateWorkItemInputSchema = z.object({
  project_id: ProjectId,
  work_item_id: WorkItemId,
  expected_version: z.number().int().min(0).optional(),
  patch: z.object({
    title: z.string().min(1).optional(),
    body_md: z.string().optional(),
    acceptance_criteria_md: z.string().optional(),
    item_type: WorkItemType.optional(),
    priority_band: PriorityBand.optional(),
    risk_level: RiskLevel.optional(),
    area: z.string().optional(),
    subarea: z.string().optional(),
    owner_actor_id: z.string().nullable().optional(),
    due_at: IsoDateTime.nullable().optional(),
    estimated_cycle_hours_p50: z.number().min(0).optional(),
    estimated_cycle_hours_p80: z.number().min(0).optional(),
    value_score: z.number().min(0).optional(),
  }).refine((v) => Object.keys(v).length > 0, { message: 'patch must contain at least one field' }),
  reason: z.string().optional(),
});

export const ConductorUpdateWorkItemOutputSchema = z.object({
  work_item: WorkItemDetailSchema,
  updated_fields: z.array(z.string()).min(1),
  version: z.number().int().min(0),
});

export const ConductorTransitionWorkItemStateInputSchema = z.object({
  project_id: ProjectId,
  work_item_id: WorkItemId,
  to_state: WorkItemState,
  reason: z.string().optional(),
  force: z.boolean().default(false),
  correlation_id: z.string().optional(),
});

export const ConductorTransitionWorkItemStateOutputSchema = z.object({
  work_item_id: WorkItemId,
  from_state: WorkItemState,
  to_state: WorkItemState,
  changed_at: IsoDateTime,
  event_id: z.string().min(1),
});

export const ConductorAddDependencyInputSchema = z.object({
  project_id: ProjectId,
  predecessor_work_item_id: WorkItemId,
  successor_work_item_id: WorkItemId,
  dependency_type: DependencyType.default('blocks'),
  strength: DependencyStrength.default('hard'),
  lag_hours: z.number().min(0).default(0),
  rationale: z.string().optional(),
});

export const ConductorAddDependencyOutputSchema = z.object({
  dependency: DependencyEdgeSchema,
  graph_version: z.string().min(1),
});

export const ConductorResolveDependencyInputSchema = z.object({
  project_id: ProjectId,
  dependency_id: DependencyId.optional(),
  predecessor_work_item_id: WorkItemId.optional(),
  successor_work_item_id: WorkItemId.optional(),
  resolution_note: z.string().optional(),
}).refine((v) => v.dependency_id !== undefined || (v.predecessor_work_item_id !== undefined && v.successor_work_item_id !== undefined), {
  message: 'dependency_id or (predecessor_work_item_id + successor_work_item_id) is required',
});

export const ConductorResolveDependencyOutputSchema = z.object({
  dependency_id: DependencyId,
  resolved_at: IsoDateTime,
  potentially_unblocked_work_item_ids: z.array(WorkItemId),
});

export const ConductorGetDependenciesInputSchema = z.object({
  project_id: ProjectId,
  work_item_id: WorkItemId.optional(),
  direction: z.enum(['predecessors', 'successors', 'both']).default('both'),
  depth: z.number().int().min(1).max(10).default(3),
  include_resolved: z.boolean().default(false),
});

export const ConductorGetDependenciesOutputSchema = z.object({
  nodes: z.array(DependencyNodeSchema),
  edges: z.array(DependencyEdgeSchema),
  metrics: DependencyGraphMetricsSchema.optional(),
});

export const ConductorSyncProjectStateInputSchema = z.object({
  project_id: ProjectId,
  repo_ids: z.array(RepoId).optional(),
  mode: z.enum(['delta', 'backfill', 'full']).default('delta'),
  since: IsoDateTime.optional(),
  dry_run: z.boolean().default(false),
});

export const ConductorSyncProjectStateOutputSchema = z.object({
  mode: z.enum(['delta', 'backfill', 'full']),
  dry_run: z.boolean(),
  accepted: z.number().int().min(0),
  skipped: z.number().int().min(0),
  sync_job_id: z.string().optional(),
  cursor_advanced_to: IsoDateTime.optional(),
});
```

#### Tool Catalog
| Tool | Description | Input schema | Output format | Side effects | Error conditions |
|---|---|---|---|---|---|
| `conductor_get_board` | Read current board lanes and lane health before selecting work. | `ConductorGetBoardInputSchema` | `ToolResult<ConductorGetBoardOutputSchema>` | None | `UNAUTHORIZED`, `FORBIDDEN`, `NOT_FOUND`, `VALIDATION_ERROR` |
| `conductor_list_work_items` | Query backlog/board items with filters and pagination. | `ConductorListWorkItemsInputSchema` | `ToolResult<ConductorListWorkItemsOutputSchema>` | None | `UNAUTHORIZED`, `FORBIDDEN`, `NOT_FOUND`, `VALIDATION_ERROR` |
| `conductor_get_work_item` | Fetch one work item with optional history, dependency, and prediction enrichments. | `ConductorGetWorkItemInputSchema` | `ToolResult<ConductorGetWorkItemOutputSchema>` | None | `UNAUTHORIZED`, `FORBIDDEN`, `NOT_FOUND`, `VALIDATION_ERROR` |
| `conductor_update_work_item` | Patch non-state fields with optimistic locking via `expected_version`. | `ConductorUpdateWorkItemInputSchema` | `ToolResult<ConductorUpdateWorkItemOutputSchema>` | Updates `pm_work_items`; emits `work_item.updated`. | `UNAUTHORIZED`, `FORBIDDEN`, `NOT_FOUND`, `VALIDATION_ERROR`, `CONFLICT` |
| `conductor_transition_work_item_state` | Perform validated workflow state transition; this is the only state mutation tool. | `ConductorTransitionWorkItemStateInputSchema` | `ToolResult<ConductorTransitionWorkItemStateOutputSchema>` | Updates state timestamps; emits `work_item.state_changed` (+ completion/reopen events as applicable). | `UNAUTHORIZED`, `FORBIDDEN`, `NOT_FOUND`, `VALIDATION_ERROR`, `STATE_TRANSITION_INVALID`, `DEPENDENCY_UNRESOLVED`, `POLICY_BLOCKED` |
| `conductor_add_dependency` | Add dependency edge and trigger graph recomputation. | `ConductorAddDependencyInputSchema` | `ToolResult<ConductorAddDependencyOutputSchema>` | Inserts `pm_dependencies`; recomputes closure/metrics; emits `dependency.added`. | `UNAUTHORIZED`, `FORBIDDEN`, `NOT_FOUND`, `VALIDATION_ERROR`, `CONFLICT`, `DEPENDENCY_CYCLE` |
| `conductor_resolve_dependency` | Resolve active dependency edge and recalculate unblocked candidates. | `ConductorResolveDependencyInputSchema` | `ToolResult<ConductorResolveDependencyOutputSchema>` | Marks dependency resolved; recomputes closure/metrics; emits `dependency.resolved`. | `UNAUTHORIZED`, `FORBIDDEN`, `NOT_FOUND`, `VALIDATION_ERROR`, `CONFLICT` |
| `conductor_get_dependencies` | Read dependency graph slice for item or project scope. | `ConductorGetDependenciesInputSchema` | `ToolResult<ConductorGetDependenciesOutputSchema>` | None | `UNAUTHORIZED`, `FORBIDDEN`, `NOT_FOUND`, `VALIDATION_ERROR` |
| `conductor_sync_project_state` | Trigger source sync before planning/analytics when freshness matters. | `ConductorSyncProjectStateInputSchema` | `ToolResult<ConductorSyncProjectStateOutputSchema>` | Enqueues/executes sync; updates sync cursor and inbox rows; emits `sync.*`. | `UNAUTHORIZED`, `FORBIDDEN`, `NOT_FOUND`, `VALIDATION_ERROR`, `RATE_LIMITED`, `INTERNAL_ERROR` |

### 2. Triage and Planning (9)

#### Schemas
```ts
import { z } from 'zod/v4';

export const ConductorTriageWorkItemInputSchema = z.object({
  project_id: ProjectId,
  work_item_id: WorkItemId,
  mode: z.enum(['quick', 'full']).default('full'),
  include_similar_items: z.boolean().default(true),
  include_predictions: z.boolean().default(true),
  persist: z.boolean().default(true),
});

export const ConductorTriageWorkItemOutputSchema = z.object({
  triage: TriageAssessmentSchema,
  rationale: z.array(z.string()),
  clarifications_needed: z.array(z.string()),
  suggested_next_actions: z.array(z.string()),
  similar_items: z.array(SimilarItemSchema).optional(),
});

export const ConductorDecomposeWorkItemInputSchema = z.object({
  project_id: ProjectId,
  work_item_id: WorkItemId,
  target_subtask_count: z.number().int().min(2).max(12).optional(),
  max_subtask_p80_hours: z.number().min(1).max(200).default(16),
  include_dependency_order: z.boolean().default(true),
  create_subtasks: z.boolean().default(false),
});

export const SubtaskDraftSchema = z.object({
  title: z.string().min(1),
  body_md: z.string().default(''),
  acceptance_criteria_md: z.string().default(''),
  item_type: WorkItemType,
  estimate_hours_p50: z.number().min(0).optional(),
  estimate_hours_p80: z.number().min(0).optional(),
  rank: z.number().int().positive().optional(),
  created_work_item_id: WorkItemId.optional(),
});

export const DependencyDraftSchema = z.object({
  predecessor_index: z.number().int().min(0),
  successor_index: z.number().int().min(0),
  dependency_type: DependencyType,
  strength: DependencyStrength,
  created_dependency_id: DependencyId.optional(),
});

export const ConductorDecomposeWorkItemOutputSchema = z.object({
  parent_work_item_id: WorkItemId,
  subtasks: z.array(SubtaskDraftSchema),
  dependency_edges: z.array(DependencyDraftSchema),
  uncovered_requirements: z.array(z.string()),
});

export const ConductorPlanIterationInputSchema = z.object({
  project_id: ProjectId,
  iteration_id: IterationId.optional(),
  iteration_name: z.string().min(1).optional(),
  iteration_kind: IterationKind.default('sprint'),
  planning_mode: PlanningMode.default('scrum'),
  horizon_days: z.number().int().min(3).max(90).default(14),
  capacity_hours: z.number().min(0).optional(),
  wip_limit: z.number().int().min(0).optional(),
  candidate_work_item_ids: z.array(WorkItemId).optional(),
  objective: z.string().optional(),
  persist: z.boolean().default(false),
});

export const IterationExclusionSchema = z.object({
  work_item_id: WorkItemId,
  reason: z.string().min(1),
});

export const ConductorPlanIterationOutputSchema = z.object({
  iteration: IterationSummarySchema,
  selected_items: z.array(IterationCandidateSchema),
  stretch_items: z.array(IterationCandidateSchema),
  excluded_items: z.array(IterationExclusionSchema),
  capacity: CapacitySummarySchema,
  risks: z.array(z.string()).default([]),
});

export const ConductorAssignIterationItemsInputSchema = z.object({
  project_id: ProjectId,
  iteration_id: IterationId,
  replace_existing: z.boolean().default(false),
  assignments: z.array(z.object({
    work_item_id: WorkItemId,
    commitment_level: CommitmentLevel.default('committed'),
    rank_in_iteration: z.number().int().min(1).optional(),
    planned_hours: z.number().min(0).optional(),
  })).min(1),
});

export const ConductorAssignIterationItemsOutputSchema = z.object({
  iteration_id: IterationId,
  assigned_count: z.number().int().min(0),
  removed_count: z.number().int().min(0),
  capacity_remaining_hours: z.number().min(0).optional(),
});

export const ConductorSuggestNextWorkItemInputSchema = z.object({
  project_id: ProjectId,
  actor_id: z.string().optional(),
  limit: z.number().int().min(1).max(20).default(5),
  consider_current_wip: z.boolean().default(true),
  include_rationale: z.boolean().default(true),
});

export const ConductorSuggestNextWorkItemOutputSchema = z.object({
  suggestions: z.array(z.object({
    work_item_id: WorkItemId,
    score: z.number(),
    rationale: z.array(z.string()),
    blockers: z.number().int().min(0),
  })),
});

export const ConductorBuildSessionContextInputSchema = z.object({
  project_id: ProjectId,
  actor_id: z.string().optional(),
  focus: z.enum(['planning', 'execution', 'review']).default('execution'),
  max_items: z.number().int().min(1).max(20).default(6),
  max_tokens: z.number().int().min(1000).max(100000).default(12000),
  record_session: z.boolean().default(false),
});

export const ConductorBuildSessionContextOutputSchema = z.object({
  focus: z.enum(['planning', 'execution', 'review']),
  token_estimate: z.number().int().min(0),
  context_packet: z.object({
    work_items: z.array(WorkItemDetailSchema),
    dependencies: z.array(DependencyEdgeSchema),
    decisions: z.array(z.object({
      decision_id: DecisionId,
      title: z.string(),
      summary_md: z.string(),
      decided_at: IsoDateTime,
    })),
    risks: z.array(RiskDimensionSchema),
  }),
  session_id: z.string().optional(),
});

export const ConductorRankBacklogInputSchema = z.object({
  project_id: ProjectId,
  strategy: z.enum(['wsjf', 'value_risk', 'due_date', 'custom']).default('wsjf'),
  include_blocked: z.boolean().default(false),
  limit: z.number().int().min(1).max(500).default(100),
  custom_weights: z.object({
    value: z.number().min(0).optional(),
    urgency: z.number().min(0).optional(),
    risk_reduction: z.number().min(0).optional(),
    effort_inverse: z.number().min(0).optional(),
  }).optional(),
});

export const ConductorRankBacklogOutputSchema = z.object({
  strategy: z.enum(['wsjf', 'value_risk', 'due_date', 'custom']),
  ranked_items: z.array(z.object({
    work_item_id: WorkItemId,
    rank: z.number().int().positive(),
    score: z.number(),
    score_breakdown: z.record(z.string(), z.number()).optional(),
  })),
});

export const ConductorValidateSpecReadinessInputSchema = z.object({
  project_id: ProjectId,
  work_item_id: WorkItemId,
  strict: z.boolean().default(false),
  checklist: z.array(z.string()).optional(),
  persist: z.boolean().default(true),
});

export const ConductorValidateSpecReadinessOutputSchema = z.object({
  work_item_id: WorkItemId,
  readiness_score: z.number().min(0).max(1),
  pass: z.boolean(),
  missing_sections: z.array(z.string()),
  contradictions: z.array(z.string()),
  recommendations: z.array(z.string()),
});

export const ConductorDetectScopeCreepInputSchema = z.object({
  project_id: ProjectId,
  run_id: RunId.optional(),
  work_item_id: WorkItemId.optional(),
  compare_against: z.enum(['approved_plan', 'initial_issue', 'both']).default('approved_plan'),
  include_diff: z.boolean().default(true),
  record_event: z.boolean().default(true),
}).refine((v) => v.run_id !== undefined || v.work_item_id !== undefined, {
  message: 'run_id or work_item_id is required',
});

export const ScopeChangeSchema = z.object({
  change_type: z.enum(['added', 'removed', 'modified']),
  subject: z.enum(['file', 'requirement', 'task', 'dependency']),
  identifier: z.string(),
  summary: z.string(),
});

export const ConductorDetectScopeCreepOutputSchema = z.object({
  scope_creep_score: z.number().min(0).max(1),
  added_scope: z.array(ScopeChangeSchema),
  removed_scope: z.array(ScopeChangeSchema),
  out_of_scope_files: z.array(z.string()).optional(),
  recommendation: z.string(),
});
```

#### Tool Catalog
| Tool | Description | Input schema | Output format | Side effects | Error conditions |
|---|---|---|---|---|---|
| `conductor_triage_work_item` | Classify and score item risk/readiness/value before planning. | `ConductorTriageWorkItemInputSchema` | `ToolResult<ConductorTriageWorkItemOutputSchema>` | If `persist=true`: updates `pm_work_item_ai_current` and appends `pm_work_item_ai_history`; emits `prediction.refreshed` + `work_item.updated`. | `UNAUTHORIZED`, `FORBIDDEN`, `NOT_FOUND`, `VALIDATION_ERROR`, `INSUFFICIENT_DATA` |
| `conductor_decompose_work_item` | Decompose large item into implementable subtasks and ordering edges. | `ConductorDecomposeWorkItemInputSchema` | `ToolResult<ConductorDecomposeWorkItemOutputSchema>` | If `create_subtasks=true`: inserts child items and dependencies; emits item and graph events. | `UNAUTHORIZED`, `FORBIDDEN`, `NOT_FOUND`, `VALIDATION_ERROR`, `CONFLICT` |
| `conductor_plan_iteration` | Produce dependency-aware iteration plan with capacity confidence. | `ConductorPlanIterationInputSchema` | `ToolResult<ConductorPlanIterationOutputSchema>` | If `persist=true`: upserts `pm_iterations` and `pm_iteration_items`; emits `iteration.*`. | `UNAUTHORIZED`, `FORBIDDEN`, `NOT_FOUND`, `VALIDATION_ERROR`, `CONFLICT`, `INSUFFICIENT_DATA` |
| `conductor_assign_iteration_items` | Commit explicit iteration assignments and rank/commitment metadata. | `ConductorAssignIterationItemsInputSchema` | `ToolResult<ConductorAssignIterationItemsOutputSchema>` | Mutates `pm_iteration_items`; may remove previous rows when `replace_existing=true`. | `UNAUTHORIZED`, `FORBIDDEN`, `NOT_FOUND`, `VALIDATION_ERROR`, `CONFLICT` |
| `conductor_suggest_next_work_item` | Recommend highest-value unblocked next work for actor/team. | `ConductorSuggestNextWorkItemInputSchema` | `ToolResult<ConductorSuggestNextWorkItemOutputSchema>` | None | `UNAUTHORIZED`, `FORBIDDEN`, `NOT_FOUND`, `VALIDATION_ERROR`, `INSUFFICIENT_DATA` |
| `conductor_build_session_context` | Build bounded context packet for planning/execution/review sessions. | `ConductorBuildSessionContextInputSchema` | `ToolResult<ConductorBuildSessionContextOutputSchema>` | Optional session audit insert/event when `record_session=true`. | `UNAUTHORIZED`, `FORBIDDEN`, `NOT_FOUND`, `VALIDATION_ERROR` |
| `conductor_rank_backlog` | Score and rank backlog using strategy-specific weighting. | `ConductorRankBacklogInputSchema` | `ToolResult<ConductorRankBacklogOutputSchema>` | None | `UNAUTHORIZED`, `FORBIDDEN`, `NOT_FOUND`, `VALIDATION_ERROR`, `INSUFFICIENT_DATA` |
| `conductor_validate_spec_readiness` | Validate requirement quality and ambiguity before execution. | `ConductorValidateSpecReadinessInputSchema` | `ToolResult<ConductorValidateSpecReadinessOutputSchema>` | If `persist=true`: updates latest AI readiness fields; emits `work_item.updated`. | `UNAUTHORIZED`, `FORBIDDEN`, `NOT_FOUND`, `VALIDATION_ERROR` |
| `conductor_detect_scope_creep` | Detect drift from approved or initial scope. | `ConductorDetectScopeCreepInputSchema` | `ToolResult<ConductorDetectScopeCreepOutputSchema>` | If `record_event=true`: emits governance event. | `UNAUTHORIZED`, `FORBIDDEN`, `NOT_FOUND`, `VALIDATION_ERROR`, `INSUFFICIENT_DATA` |

### 3. Analytics (8)

#### Schemas
```ts
import { z } from 'zod/v4';

export const ConductorGetVelocityInputSchema = z.object({
  project_id: ProjectId,
  range: DateRangeSchema.optional(),
  bucket: z.enum(['day', 'week']).default('day'),
  include_seasonality: z.boolean().default(true),
});

export const ConductorGetVelocityOutputSchema = z.object({
  velocity: z.object({
    throughput_7d: z.number().min(0),
    throughput_30d: z.number().min(0),
    output_7d: z.number(),
    output_30d: z.number(),
  }),
  trend: z.object({
    throughput: z.object({ window: z.enum(['7d', '30d']), state: z.enum(['accelerating', 'stable', 'decelerating']), slope_per_day: z.number() }),
    output: z.object({ window: z.enum(['7d', '30d']), state: z.enum(['accelerating', 'stable', 'decelerating']), slope_per_day: z.number() }),
  }),
  daily_series: z.array(z.object({ date: IsoDate, throughput: z.number().min(0), output: z.number() })),
  seasonality: z.array(z.object({ day_of_week: z.number().int().min(0).max(6), throughput_factor: z.number() })).optional(),
});

export const ConductorGetCycleTimeAnalyticsInputSchema = z.object({
  project_id: ProjectId,
  range: DateRangeSchema.optional(),
  area: z.string().optional(),
  item_type: WorkItemType.optional(),
  include_time_in_state: z.boolean().default(true),
});

export const ConductorGetCycleTimeAnalyticsOutputSchema = z.object({
  summary: z.object({
    completed_cycles: z.number().int().min(0),
    aborted_cycles: z.number().int().min(0),
    cycle_hours: z.object({ p50: z.number().nullable(), p80: z.number().nullable(), p90: z.number().nullable(), p95: z.number().nullable() }),
    flow_efficiency: z.number().min(0).max(1).nullable(),
  }),
  time_in_state: z.array(z.object({ state: WorkItemState, avg_hours: z.number().min(0), p80_hours: z.number().min(0), share: z.number().min(0).max(1) })).optional(),
  bottleneck: z.object({ state: WorkItemState, criterion: z.string(), p80_hours: z.number().min(0) }).optional(),
  outliers: z.array(z.object({ work_item_id: WorkItemId, cycle_hours: z.number().min(0), zscore: z.number() })).optional(),
});

export const ConductorGetDoraMetricsInputSchema = z.object({
  project_id: ProjectId,
  repo_id: RepoId.optional(),
  range: DateRangeSchema.optional(),
});

export const DoraMetricSchema = z.object({
  value: z.number().nullable(),
  unit: z.string(),
  benchmark_band: z.enum(['elite', 'high', 'medium', 'low', 'unknown']).default('unknown'),
});

export const ConductorGetDoraMetricsOutputSchema = z.object({
  deployment_frequency: DoraMetricSchema,
  lead_time_for_changes: DoraMetricSchema,
  change_failure_rate: DoraMetricSchema,
  mttr: DoraMetricSchema,
  sample_size: z.number().int().min(0),
});

export const ConductorGetIterationAnalyticsInputSchema = z.object({
  project_id: ProjectId,
  iteration_id: IterationId.optional(),
  include_burndown: z.boolean().default(true),
});

export const ConductorGetIterationAnalyticsOutputSchema = z.object({
  iteration: IterationSummarySchema,
  commitment_reliability: z.number().min(0).max(1),
  spillover_rate: z.number().min(0).max(1),
  scope_change_rate: z.number().min(0).max(1),
  burndown: z.array(z.object({ date: IsoDate, remaining_hours: z.number().min(0), completed_items: z.number().int().min(0) })).optional(),
});

export const ConductorGetWorkflowHealthInputSchema = z.object({
  project_id: ProjectId,
  range: DateRangeSchema.optional(),
  include_wip_aging: z.boolean().default(true),
  include_gate_waits: z.boolean().default(true),
});

export const ConductorGetWorkflowHealthOutputSchema = z.object({
  health_score: z.number().min(0).max(100),
  blocked_ratio: z.number().min(0).max(1),
  queue_times: z.array(z.object({ state: WorkItemState, p50_hours: z.number().min(0), p80_hours: z.number().min(0) })),
  gate_waits: z.array(z.object({ gate_id: GateId, p50_hours: z.number().min(0), p80_hours: z.number().min(0) })).optional(),
  stale_wip: z.array(z.object({ work_item_id: WorkItemId, state: WorkItemState, age_hours: z.number().min(0) })).optional(),
});

export const ConductorGetHistoryInsightsInputSchema = z.object({
  project_id: ProjectId,
  range: DateRangeSchema.optional(),
  include_recommendations: z.boolean().default(true),
});

export const ConductorGetHistoryInsightsOutputSchema = z.object({
  insights: z.array(z.object({
    insight_id: z.string(),
    category: z.enum(['throughput', 'quality', 'scope', 'risk', 'process']),
    summary: z.string(),
    confidence: z.number().min(0).max(1),
    evidence: z.array(z.string()),
  })),
  recommendations: z.array(z.string()).optional(),
  confidence: z.number().min(0).max(1),
});

export const ConductorGetRiskRadarInputSchema = z.object({
  project_id: ProjectId,
  range: DateRangeSchema.optional(),
});

export const ConductorGetRiskRadarOutputSchema = z.object({
  overall_risk: z.number().min(0).max(100),
  risk_level: RiskLevel,
  dimensions: z.array(RiskDimensionSchema),
});

export const ConductorGetAnomaliesInputSchema = z.object({
  project_id: ProjectId,
  range: DateRangeSchema.optional(),
  min_level: RiskLevel.default('medium'),
  include_acknowledged: z.boolean().default(false),
});

export const ConductorGetAnomaliesOutputSchema = z.object({
  anomalies: z.array(z.object({
    anomaly_id: z.string().min(1),
    detected_at: IsoDateTime,
    level: RiskLevel,
    type: z.enum(['velocity_drop', 'backlog_growth_spike', 'rework_spike', 'wip_limit_violation', 'stale_item_accumulation', 'gate_regression']),
    summary: z.string(),
    evidence: z.array(z.string()),
    acknowledged: z.boolean().default(false),
  })),
  generated_at: IsoDateTime,
});
```

#### Tool Catalog
| Tool | Description | Input schema | Output format | Side effects | Error conditions |
|---|---|---|---|---|---|
| `conductor_get_velocity` | Throughput/output trends for planning confidence. | `ConductorGetVelocityInputSchema` | `ToolResult<ConductorGetVelocityOutputSchema>` | None | `UNAUTHORIZED`, `FORBIDDEN`, `NOT_FOUND`, `VALIDATION_ERROR`, `INSUFFICIENT_DATA` |
| `conductor_get_cycle_time_analytics` | Cycle-time distributions and bottlenecks by scope. | `ConductorGetCycleTimeAnalyticsInputSchema` | `ToolResult<ConductorGetCycleTimeAnalyticsOutputSchema>` | None | `UNAUTHORIZED`, `FORBIDDEN`, `NOT_FOUND`, `VALIDATION_ERROR`, `INSUFFICIENT_DATA` |
| `conductor_get_dora_metrics` | DORA metrics for delivery reliability baselines. | `ConductorGetDoraMetricsInputSchema` | `ToolResult<ConductorGetDoraMetricsOutputSchema>` | None | `UNAUTHORIZED`, `FORBIDDEN`, `NOT_FOUND`, `VALIDATION_ERROR`, `INSUFFICIENT_DATA` |
| `conductor_get_iteration_analytics` | Iteration quality metrics (commitment, spillover, churn). | `ConductorGetIterationAnalyticsInputSchema` | `ToolResult<ConductorGetIterationAnalyticsOutputSchema>` | None | `UNAUTHORIZED`, `FORBIDDEN`, `NOT_FOUND`, `VALIDATION_ERROR` |
| `conductor_get_workflow_health` | Queue, WIP, and gate wait health signals. | `ConductorGetWorkflowHealthInputSchema` | `ToolResult<ConductorGetWorkflowHealthOutputSchema>` | None | `UNAUTHORIZED`, `FORBIDDEN`, `NOT_FOUND`, `VALIDATION_ERROR`, `INSUFFICIENT_DATA` |
| `conductor_get_history_insights` | Pattern mining and recommendations from historical outcomes. | `ConductorGetHistoryInsightsInputSchema` | `ToolResult<ConductorGetHistoryInsightsOutputSchema>` | None | `UNAUTHORIZED`, `FORBIDDEN`, `NOT_FOUND`, `VALIDATION_ERROR`, `INSUFFICIENT_DATA` |
| `conductor_get_risk_radar` | Seven-dimension risk profile and aggregate risk level. | `ConductorGetRiskRadarInputSchema` | `ToolResult<ConductorGetRiskRadarOutputSchema>` | None | `UNAUTHORIZED`, `FORBIDDEN`, `NOT_FOUND`, `VALIDATION_ERROR`, `INSUFFICIENT_DATA` |
| `conductor_get_anomalies` | Anomaly feed for velocity, backlog, quality, and flow drift. | `ConductorGetAnomaliesInputSchema` | `ToolResult<ConductorGetAnomaliesOutputSchema>` | None | `UNAUTHORIZED`, `FORBIDDEN`, `NOT_FOUND`, `VALIDATION_ERROR`, `INSUFFICIENT_DATA` |

### 4. Prediction (5)

#### Schemas
```ts
import { z } from 'zod/v4';

export const ConductorPredictCompletionInputSchema = z.object({
  project_id: ProjectId,
  work_item_id: WorkItemId.optional(),
  backlog_work_item_ids: z.array(WorkItemId).optional(),
  include_dependencies: z.boolean().default(true),
  confidence_levels: z.array(z.number().min(0.5).max(0.99)).default([0.5, 0.8, 0.95]),
}).refine((v) => v.work_item_id !== undefined || (v.backlog_work_item_ids?.length ?? 0) > 0, {
  message: 'work_item_id or backlog_work_item_ids is required',
});

export const ConductorPredictCompletionOutputSchema = z.object({
  subject: z.object({
    scope: z.enum(['work_item', 'backlog_slice']),
    work_item_ids: z.array(WorkItemId),
  }),
  completion_forecast: z.array(z.object({
    confidence: z.number().min(0.5).max(0.99),
    predicted_date: IsoDate,
  })),
  confidence: z.number().min(0).max(1),
  assumptions: z.array(z.string()).default([]),
});

export const ConductorPredictReworkInputSchema = z.object({
  project_id: ProjectId,
  work_item_id: WorkItemId,
  include_mitigations: z.boolean().default(true),
});

export const ConductorPredictReworkOutputSchema = z.object({
  work_item_id: WorkItemId,
  rework_probability: z.number().min(0).max(1),
  risk_level: RiskLevel,
  weighted_signals: z.array(z.object({
    name: z.string(),
    value: z.number().min(0).max(1),
    weight: z.number().min(0).max(1),
    contribution: z.number(),
    evidence: z.string(),
  })),
  mitigations: z.array(z.string()).optional(),
});

export const ConductorRunMonteCarloInputSchema = z.object({
  project_id: ProjectId,
  backlog_work_item_ids: z.array(WorkItemId).optional(),
  horizon_days: z.number().int().min(1).max(365).default(30),
  trials: z.number().int().min(100).max(100000).default(10000),
  wip_limit: z.number().int().min(1).max(50).default(4),
  seed: z.number().int().optional(),
});

export const ConductorRunMonteCarloOutputSchema = z.object({
  simulation: z.object({
    trials: z.number().int().min(100),
    seed: z.number().int(),
    horizon_days: z.number().int().min(1),
    wip_limit: z.number().int().min(1),
  }),
  throughput_distribution: z.object({
    p50: z.number(),
    p80: z.number(),
    p90: z.number(),
    p95: z.number(),
    histogram: z.array(z.object({ bin_start: z.number(), bin_end: z.number(), count: z.number().int().min(0) })),
  }),
  backlog_completion: z.object({
    target_items: z.number().int().min(1),
    p50_date: IsoDate,
    p80_date: IsoDate,
    p95_date: IsoDate,
  }).optional(),
  wip_scenarios: z.array(z.object({
    wip_limit: z.number().int().min(1),
    throughput_p50: z.number(),
    completion_p80_date: IsoDate.optional(),
  })).optional(),
});

export const ConductorForecastBacklogInputSchema = z.object({
  project_id: ProjectId,
  horizon_days: z.number().int().min(7).max(365).default(90),
  intake_rate_mode: z.enum(['historical', 'manual']).default('historical'),
  manual_intake_per_week: z.number().min(0).optional(),
  completion_rate_mode: z.enum(['historical', 'simulation']).default('historical'),
});

export const ConductorForecastBacklogOutputSchema = z.object({
  horizon_days: z.number().int().min(7),
  forecast_series: z.array(z.object({
    date: IsoDate,
    expected_backlog_size: z.number().min(0),
    p50_open: z.number().min(0),
    p80_open: z.number().min(0),
  })),
  breach_points: z.array(z.object({
    date: IsoDate,
    threshold: z.string(),
    expected_value: z.number(),
  })),
  confidence: z.number().min(0).max(1),
});

export const ConductorSimulateDependencyDelayInputSchema = z.object({
  project_id: ProjectId,
  source_work_item_id: WorkItemId,
  delay_days: z.number().min(0.1).max(180),
  target_iteration_id: IterationId.optional(),
  include_impacted_paths: z.boolean().default(true),
});

export const ConductorSimulateDependencyDelayOutputSchema = z.object({
  source_work_item_id: WorkItemId,
  delay_days: z.number().min(0.1),
  impacted_items: z.array(z.object({
    work_item_id: WorkItemId,
    path_length: z.number().int().min(1),
    projected_slip_days_p80: z.number().min(0),
  })),
  projected_slip_days: z.object({ p50: z.number().min(0), p80: z.number().min(0), p95: z.number().min(0) }),
});
```

#### Tool Catalog
| Tool | Description | Input schema | Output format | Side effects | Error conditions |
|---|---|---|---|---|---|
| `conductor_predict_completion` | Predict completion dates for one item or backlog slice. | `ConductorPredictCompletionInputSchema` | `ToolResult<ConductorPredictCompletionOutputSchema>` | None | `UNAUTHORIZED`, `FORBIDDEN`, `NOT_FOUND`, `VALIDATION_ERROR`, `INSUFFICIENT_DATA` |
| `conductor_predict_rework` | Predict rework probability and top contributing signals. | `ConductorPredictReworkInputSchema` | `ToolResult<ConductorPredictReworkOutputSchema>` | None | `UNAUTHORIZED`, `FORBIDDEN`, `NOT_FOUND`, `VALIDATION_ERROR`, `INSUFFICIENT_DATA` |
| `conductor_run_monte_carlo` | Stochastic simulation of throughput and completion scenarios. | `ConductorRunMonteCarloInputSchema` | `ToolResult<ConductorRunMonteCarloOutputSchema>` | None (read/compute only) | `UNAUTHORIZED`, `FORBIDDEN`, `NOT_FOUND`, `VALIDATION_ERROR`, `INSUFFICIENT_DATA`, `RATE_LIMITED` |
| `conductor_forecast_backlog` | Forecast backlog pressure over configured horizon. | `ConductorForecastBacklogInputSchema` | `ToolResult<ConductorForecastBacklogOutputSchema>` | None | `UNAUTHORIZED`, `FORBIDDEN`, `NOT_FOUND`, `VALIDATION_ERROR`, `INSUFFICIENT_DATA` |
| `conductor_simulate_dependency_delay` | Simulate downstream schedule impact from dependency delay shock. | `ConductorSimulateDependencyDelayInputSchema` | `ToolResult<ConductorSimulateDependencyDelayOutputSchema>` | None | `UNAUTHORIZED`, `FORBIDDEN`, `NOT_FOUND`, `VALIDATION_ERROR`, `INSUFFICIENT_DATA` |

### 5. Memory (4)

#### Schemas
```ts
import { z } from 'zod/v4';

export const ConductorRecordDecisionInputSchema = z.object({
  project_id: ProjectId,
  work_item_id: WorkItemId.optional(),
  repo_id: RepoId.optional(),
  area: z.string().default('general'),
  decision_kind: z.enum(['architecture', 'product', 'workflow', 'incident_response', 'policy', 'estimation', 'other']).default('other'),
  title: z.string().min(1),
  summary_md: z.string().min(1),
  rationale_md: z.string().default(''),
  alternatives_json: z.array(z.record(z.string(), JsonValueSchema)).default([]),
  expected_outcome_md: z.string().optional(),
  status: z.enum(['proposed', 'accepted', 'superseded', 'rejected']).default('accepted'),
  confidence: z.number().min(0).max(1).optional(),
  decided_at: IsoDateTime.default(new Date().toISOString()),
  decided_by_actor_id: z.string().min(1),
  supersedes_decision_id: DecisionId.optional(),
  keywords: z.array(z.string()).default([]),
});

export const ConductorRecordDecisionOutputSchema = z.object({
  decision_id: DecisionId,
  decision_uid: z.string().min(1),
  status: z.enum(['proposed', 'accepted', 'superseded', 'rejected']),
  created_at: IsoDateTime,
});

export const ConductorRecordOutcomeInputSchema = z.object({
  project_id: ProjectId,
  work_item_id: WorkItemId.optional(),
  repo_id: RepoId.optional(),
  decision_id: DecisionId.optional(),
  area: z.string().optional(),
  outcome_type: z.enum(['delivered', 'partial', 'rework', 'rollback', 'incident', 'abandoned']),
  summary_md: z.string().min(1),
  root_cause_md: z.string().optional(),
  lessons_md: z.string().optional(),
  impact_json: z.record(z.string(), JsonValueSchema).default({}),
  quality_score: z.number().min(0).max(1).optional(),
  cycle_hours: z.number().min(0).optional(),
  keywords: z.array(z.string()).default([]),
  recorded_by_actor_id: z.string().min(1),
});

export const ConductorRecordOutcomeOutputSchema = z.object({
  outcome_id: OutcomeId,
  outcome_uid: z.string().min(1),
  outcome_type: z.enum(['delivered', 'partial', 'rework', 'rollback', 'incident', 'abandoned']),
  created_at: IsoDateTime,
});

export const ConductorQueryMemoryInputSchema = z.object({
  project_id: ProjectId,
  query: z.string().optional(),
  memory_type: z.enum(['decision', 'outcome', 'all']).default('all'),
  area: z.string().optional(),
  work_item_id: WorkItemId.optional(),
  limit: z.number().int().min(1).max(100).default(20),
});

export const ConductorQueryMemoryOutputSchema = z.object({
  matches: z.array(z.object({
    memory_type: z.enum(['decision', 'outcome']),
    memory_id: z.number().int().positive(),
    score: z.number(),
    headline: z.string(),
    summary: z.string(),
  })),
});

export const ConductorSuggestApproachInputSchema = z.object({
  project_id: ProjectId,
  work_item_id: WorkItemId.optional(),
  area: z.string().optional(),
  prompt: z.string().min(1),
  top_k: z.number().int().min(1).max(20).default(5),
});

export const ConductorSuggestApproachOutputSchema = z.object({
  suggested_approaches: z.array(z.object({
    title: z.string(),
    rationale: z.string(),
    confidence: z.number().min(0).max(1),
    supporting_memory_ids: z.array(z.number().int().positive()),
  })),
  cautions: z.array(z.string()),
  supporting_memory_ids: z.array(z.number().int().positive()),
});
```

#### Tool Catalog
| Tool | Description | Input schema | Output format | Side effects | Error conditions |
|---|---|---|---|---|---|
| `conductor_record_decision` | Persist decision rationale for future retrieval/calibration. | `ConductorRecordDecisionInputSchema` | `ToolResult<ConductorRecordDecisionOutputSchema>` | Inserts `pm_decisions` (+ tags/FTS updates); emits `decision.recorded`/`decision.superseded`. | `UNAUTHORIZED`, `FORBIDDEN`, `NOT_FOUND`, `VALIDATION_ERROR`, `CONFLICT` |
| `conductor_record_outcome` | Persist delivery outcome for learning and forecast calibration. | `ConductorRecordOutcomeInputSchema` | `ToolResult<ConductorRecordOutcomeOutputSchema>` | Inserts `pm_outcomes` (+ tags/FTS updates); emits `outcome.recorded`. | `UNAUTHORIZED`, `FORBIDDEN`, `NOT_FOUND`, `VALIDATION_ERROR`, `CONFLICT` |
| `conductor_query_memory` | Semantic/keyword retrieval across decisions and outcomes. | `ConductorQueryMemoryInputSchema` | `ToolResult<ConductorQueryMemoryOutputSchema>` | None | `UNAUTHORIZED`, `FORBIDDEN`, `NOT_FOUND`, `VALIDATION_ERROR` |
| `conductor_suggest_approach` | Synthesize recommended approach from prior successful memory. | `ConductorSuggestApproachInputSchema` | `ToolResult<ConductorSuggestApproachOutputSchema>` | None | `UNAUTHORIZED`, `FORBIDDEN`, `NOT_FOUND`, `VALIDATION_ERROR`, `INSUFFICIENT_DATA` |

### 6. Operations (6)

#### Schemas
```ts
import { z } from 'zod/v4';

export const ConductorGenerateStandupInputSchema = z.object({
  project_id: ProjectId,
  date: IsoDate.default(new Date().toISOString().slice(0, 10)),
  audience: z.enum(['team', 'stakeholder']).default('team'),
  include_blockers: z.boolean().default(true),
  include_risks: z.boolean().default(true),
  format: z.enum(['markdown', 'json']).default('markdown'),
});

export const ConductorGenerateStandupOutputSchema = z.object({
  date: IsoDate,
  format: z.enum(['markdown', 'json']),
  standup_markdown: z.string().optional(),
  standup_json: z.object({
    yesterday: z.array(z.string()),
    today: z.array(z.string()),
    blockers: z.array(z.string()),
    risks: z.array(z.string()),
  }).optional(),
});

export const ConductorGenerateRetrospectiveInputSchema = z.object({
  project_id: ProjectId,
  iteration_id: IterationId.optional(),
  range: DateRangeSchema.optional(),
  include_action_items: z.boolean().default(true),
  format: z.enum(['markdown', 'json']).default('markdown'),
});

export const ConductorGenerateRetrospectiveOutputSchema = z.object({
  format: z.enum(['markdown', 'json']),
  retrospective_markdown: z.string().optional(),
  retrospective_json: z.object({
    went_well: z.array(z.string()),
    needs_improvement: z.array(z.string()),
    action_items: z.array(z.string()),
  }).optional(),
  action_items: z.array(z.string()).optional(),
});

export const ConductorGenerateReleaseNotesInputSchema = z.object({
  project_id: ProjectId,
  repo_id: RepoId.optional(),
  from_ref: z.string().optional(),
  to_ref: z.string().optional(),
  range: DateRangeSchema.optional(),
  include_commits: z.boolean().default(true),
  include_known_issues: z.boolean().default(true),
  format: z.enum(['markdown', 'json']).default('markdown'),
});

export const ConductorGenerateReleaseNotesOutputSchema = z.object({
  format: z.enum(['markdown', 'json']),
  release_notes_markdown: z.string().optional(),
  release_notes_json: z.object({
    features: z.array(z.string()),
    fixes: z.array(z.string()),
    known_issues: z.array(z.string()),
    commits: z.array(z.object({ sha: z.string(), summary: z.string() })).optional(),
  }).optional(),
  included_runs: z.number().int().min(0),
  included_prs: z.number().int().min(0),
});

export const ConductorReviewPullRequestInputSchema = z.object({
  project_id: ProjectId,
  run_id: RunId.optional(),
  pr_number: z.number().int().positive().optional(),
  pr_node_id: z.string().optional(),
  review_mode: z.enum(['summary', 'full', 'adversarial']).default('adversarial'),
  post_comment: z.boolean().default(false),
  persist_findings: z.boolean().default(false),
}).refine((v) => v.run_id !== undefined || v.pr_number !== undefined || v.pr_node_id !== undefined, {
  message: 'run_id or pr_number or pr_node_id is required',
});

export const ConductorReviewPullRequestOutputSchema = z.object({
  verdict: z.enum(['APPROVED', 'CHANGES_REQUESTED', 'NEEDS_DISCUSSION']),
  summary: z.string(),
  findings: z.array(ReviewFindingSchema),
  posted_comment_url: z.string().url().optional(),
  persisted_finding_count: z.number().int().min(0).optional(),
});

export const ConductorAnalyzePrImpactInputSchema = z.object({
  project_id: ProjectId,
  run_id: RunId.optional(),
  pr_number: z.number().int().positive().optional(),
  pr_node_id: z.string().optional(),
  include_dependency_impact: z.boolean().default(true),
  include_risk_delta: z.boolean().default(true),
  include_test_impact: z.boolean().default(true),
}).refine((v) => v.run_id !== undefined || v.pr_number !== undefined || v.pr_node_id !== undefined, {
  message: 'run_id or pr_number or pr_node_id is required',
});

export const ConductorAnalyzePrImpactOutputSchema = z.object({
  changed_files: z.array(z.string()),
  impacted_work_items: z.array(WorkItemId),
  dependency_impact: z.object({ added_edges: z.number().int().min(0), removed_edges: z.number().int().min(0), changed_critical_paths: z.number().int().min(0) }).optional(),
  risk_delta: z.object({ before: z.number().min(0).max(1), after: z.number().min(0).max(1) }).optional(),
  test_impact: z.object({ impacted_test_suites: z.array(z.string()), missing_coverage_files: z.array(z.string()) }).optional(),
});

export const ConductorExplainDelayInputSchema = z.object({
  project_id: ProjectId,
  work_item_id: WorkItemId.optional(),
  run_id: RunId.optional(),
  baseline_date: IsoDate.optional(),
  include_mitigations: z.boolean().default(true),
}).refine((v) => v.work_item_id !== undefined || v.run_id !== undefined, {
  message: 'work_item_id or run_id is required',
});

export const ConductorExplainDelayOutputSchema = z.object({
  delay_days: z.number(),
  contributing_factors: z.array(z.object({ factor: z.string(), weight: z.number().min(0), evidence: z.string() })),
  mitigations: z.array(z.string()).optional(),
});
```

#### Tool Catalog
| Tool | Description | Input schema | Output format | Side effects | Error conditions |
|---|---|---|---|---|---|
| `conductor_generate_standup` | Generate standup summary for date/audience. | `ConductorGenerateStandupInputSchema` | `ToolResult<ConductorGenerateStandupOutputSchema>` | None | `UNAUTHORIZED`, `FORBIDDEN`, `NOT_FOUND`, `VALIDATION_ERROR` |
| `conductor_generate_retrospective` | Generate retrospective from iteration/range evidence. | `ConductorGenerateRetrospectiveInputSchema` | `ToolResult<ConductorGenerateRetrospectiveOutputSchema>` | None | `UNAUTHORIZED`, `FORBIDDEN`, `NOT_FOUND`, `VALIDATION_ERROR`, `INSUFFICIENT_DATA` |
| `conductor_generate_release_notes` | Build release notes from runs/PRs/outcomes. | `ConductorGenerateReleaseNotesInputSchema` | `ToolResult<ConductorGenerateReleaseNotesOutputSchema>` | None | `UNAUTHORIZED`, `FORBIDDEN`, `NOT_FOUND`, `VALIDATION_ERROR` |
| `conductor_review_pull_request` | Structured PR review with optional posting and persistence. | `ConductorReviewPullRequestInputSchema` | `ToolResult<ConductorReviewPullRequestOutputSchema>` | Optional GitHub comment write; optional `pm_review_findings` inserts. | `UNAUTHORIZED`, `FORBIDDEN`, `NOT_FOUND`, `VALIDATION_ERROR`, `POLICY_BLOCKED` |
| `conductor_analyze_pr_impact` | Analyze PR blast radius (dependency, risk, test impact). | `ConductorAnalyzePrImpactInputSchema` | `ToolResult<ConductorAnalyzePrImpactOutputSchema>` | None | `UNAUTHORIZED`, `FORBIDDEN`, `NOT_FOUND`, `VALIDATION_ERROR`, `INSUFFICIENT_DATA` |
| `conductor_explain_delay` | Explain contributors to schedule delay and mitigations. | `ConductorExplainDelayInputSchema` | `ToolResult<ConductorExplainDelayOutputSchema>` | None | `UNAUTHORIZED`, `FORBIDDEN`, `NOT_FOUND`, `VALIDATION_ERROR`, `INSUFFICIENT_DATA` |

### 7. Graph (4)

#### Schemas
```ts
import { z } from 'zod/v4';

export const ConductorAnalyzeDependencyGraphInputSchema = z.object({
  project_id: ProjectId,
  include_metrics: z.boolean().default(true),
  include_cycles: z.boolean().default(true),
  include_execution_order: z.boolean().default(true),
});

export const ConductorAnalyzeDependencyGraphOutputSchema = z.object({
  graph_summary: DependencyGraphMetricsSchema,
  critical_path: z.object({ work_item_ids: z.array(WorkItemId), length_hours_p50: z.number().min(0), length_hours_p80: z.number().min(0) }).optional(),
  bottlenecks: z.array(z.object({ work_item_id: WorkItemId, centrality: z.number().min(0), reason: z.string() })).optional(),
  cycles: z.array(z.array(WorkItemId)).optional(),
  execution_order: z.array(WorkItemId).optional(),
});

export const ConductorGetCriticalPathInputSchema = z.object({
  project_id: ProjectId,
  iteration_id: IterationId.optional(),
  include_estimates: z.boolean().default(true),
});

export const ConductorGetCriticalPathOutputSchema = z.object({
  critical_path: z.object({
    work_item_ids: z.array(WorkItemId),
    length_hours: z.number().min(0),
    slack_hours: z.number().min(0).optional(),
  }),
});

export const ConductorExportDependencyGraphInputSchema = z.object({
  project_id: ProjectId,
  format: z.enum(['json', 'mermaid', 'dot']).default('mermaid'),
  include_resolved: z.boolean().default(false),
  depth: z.number().int().min(1).max(20).optional(),
  root_work_item_id: WorkItemId.optional(),
});

export const ConductorExportDependencyGraphOutputSchema = z.discriminatedUnion('format', [
  z.object({
    format: z.literal('json'),
    graph_json: z.object({ nodes: z.array(DependencyNodeSchema), edges: z.array(DependencyEdgeSchema) }),
  }),
  z.object({
    format: z.literal('mermaid'),
    graph_mermaid: z.string().min(1),
  }),
  z.object({
    format: z.literal('dot'),
    graph_dot: z.string().min(1),
  }),
]);

export const ConductorCompareEstimatesVsActualsInputSchema = z.object({
  project_id: ProjectId,
  range: DateRangeSchema.optional(),
  group_by: z.enum(['area', 'item_type', 'owner', 'none']).default('area'),
  percentile: z.array(z.number().min(0.5).max(0.99)).default([0.5, 0.8]),
});

export const ConductorCompareEstimatesVsActualsOutputSchema = z.object({
  comparison: z.array(z.object({
    group_key: z.string(),
    estimated_hours_p50: z.number().min(0).nullable(),
    estimated_hours_p80: z.number().min(0).nullable(),
    actual_hours_p50: z.number().min(0).nullable(),
    actual_hours_p80: z.number().min(0).nullable(),
    bias_ratio: z.number().nullable(),
    sample_size: z.number().int().min(0),
  })),
  bias_summary: z.object({
    tendency: z.enum(['underestimate', 'balanced', 'overestimate']),
    median_bias_ratio: z.number().nullable(),
  }),
  calibration_recommendations: z.array(z.string()),
});
```

#### Tool Catalog
| Tool | Description | Input schema | Output format | Side effects | Error conditions |
|---|---|---|---|---|---|
| `conductor_analyze_dependency_graph` | Full dependency DAG analysis (critical path, cycles, bottlenecks). | `ConductorAnalyzeDependencyGraphInputSchema` | `ToolResult<ConductorAnalyzeDependencyGraphOutputSchema>` | None | `UNAUTHORIZED`, `FORBIDDEN`, `NOT_FOUND`, `VALIDATION_ERROR`, `INSUFFICIENT_DATA` |
| `conductor_get_critical_path` | Return critical path for project or iteration scope. | `ConductorGetCriticalPathInputSchema` | `ToolResult<ConductorGetCriticalPathOutputSchema>` | None | `UNAUTHORIZED`, `FORBIDDEN`, `NOT_FOUND`, `VALIDATION_ERROR`, `INSUFFICIENT_DATA` |
| `conductor_export_dependency_graph` | Export dependency graph for visualization/rendering. | `ConductorExportDependencyGraphInputSchema` | `ToolResult<ConductorExportDependencyGraphOutputSchema>` | None | `UNAUTHORIZED`, `FORBIDDEN`, `NOT_FOUND`, `VALIDATION_ERROR` |
| `conductor_compare_estimates_vs_actuals` | Quantify estimation bias and calibration guidance. | `ConductorCompareEstimatesVsActualsInputSchema` | `ToolResult<ConductorCompareEstimatesVsActualsOutputSchema>` | None | `UNAUTHORIZED`, `FORBIDDEN`, `NOT_FOUND`, `VALIDATION_ERROR`, `INSUFFICIENT_DATA` |

### 8. Run Management (7)

#### Run Phase Transition Graph

Run phases form a directed graph, not a linear sequence. This allows rework loops, replanning, and parallel execution paths.

```text
                    ┌─────────────────────────────────────┐
                    │                                     ▼
pending ──► planning ──► awaiting_plan_approval ──► executing ──► awaiting_review ──► completed
                ▲              │                      │    ▲          │
                │              │                      │    │          │
                │              ▼                      ▼    │          ▼
                │          cancelled              blocked ─┘      cancelled
                │                                     │
                └─────────────────────────────────────┘
                        (retry with rewind_to=planning:start)
```

Valid transitions:
| From | To | Trigger |
| --- | --- | --- |
| `pending` | `planning` | Run started, planner worker assigned |
| `planning` | `awaiting_plan_approval` | Plan artifact created |
| `planning` | `cancelled` | Cancel requested |
| `awaiting_plan_approval` | `executing` | Plan approved (human or AI per autonomy level) |
| `awaiting_plan_approval` | `planning` | Plan rejected with revision request |
| `awaiting_plan_approval` | `cancelled` | Cancel requested |
| `executing` | `awaiting_review` | Implementation complete, tests pass |
| `executing` | `blocked` | Tests fail, dependency unresolved, or policy block |
| `executing` | `cancelled` | Cancel requested |
| `blocked` | `executing` | Blocker resolved (retry) |
| `blocked` | `planning` | Retry with `rewind_to=planning:start` (redesign) |
| `blocked` | `cancelled` | Cancel after max retries |
| `awaiting_review` | `completed` | Review approved |
| `awaiting_review` | `executing` | Changes requested (rework loop) |
| `awaiting_review` | `cancelled` | Cancel requested |

The `rewind_to` parameter on `conductor_retry_run` enables non-linear recovery: a blocked run can go back to planning (not just retry execution) when the failure requires a fundamentally different approach.

#### Schemas
```ts
import { z } from 'zod/v4';

export const ConductorStartRunInputSchema = z.object({
  project_id: ProjectId,
  task_id: TaskId.optional(),
  work_item_id: WorkItemId.optional(),
  repo_id: RepoId.optional(),
  base_branch: z.string().default('main'),
  implementer_backend: z.enum(['raw', 'agent_sdk']).default('raw'),
  triggered_by_actor_id: z.string().min(1),
  auto_approve_plan: z.boolean().default(false),
}).refine((v) => v.task_id !== undefined || v.work_item_id !== undefined, {
  message: 'task_id or work_item_id is required',
});

export const ConductorStartRunOutputSchema = z.object({
  run: RunDetailSchema,
  queue_job_id: z.string().optional(),
});

export const ConductorApproveRunPlanInputSchema = z.object({
  run_id: RunId,
  actor_id: z.string().min(1),
  comment: z.string().optional(),
});

export const ConductorApproveRunPlanOutputSchema = z.object({
  outcome: z.enum(['approved', 'already_decided']),
  run: RunDetailSchema,
});

export const ConductorRejectRunPlanInputSchema = z.object({
  run_id: RunId,
  actor_id: z.string().min(1),
  reason: z.string().min(1),
  cancel_run: z.boolean().default(true),
});

export const ConductorRejectRunPlanOutputSchema = z.object({
  outcome: z.enum(['rejected', 'already_decided', 'sent_to_planning']),
  run: RunDetailSchema,
});

export const ConductorCancelRunInputSchema = z.object({
  run_id: RunId,
  actor_id: z.string().min(1),
  reason: z.string().optional(),
});

export const ConductorCancelRunOutputSchema = z.object({
  outcome: z.enum(['cancelled', 'already_terminal']),
  run: RunDetailSchema,
});

export const ConductorRetryRunInputSchema = z.object({
  run_id: RunId,
  actor_id: z.string().min(1),
  // Valid rewind targets from blocked: planning:start or executing:start (see Run Phase Transition Graph).
  // awaiting_plan_approval and awaiting_review are not valid rewind targets — they are gate states, not entry points.
  rewind_to: z.enum(['planning:start', 'executing:start']).optional(),
  context_mode: z.enum(['preserve', 'truncate']).default('preserve'),
  comment: z.string().optional(),
});

export const ConductorRetryRunOutputSchema = z.object({
  outcome: z.enum(['enqueued', 'noop']),
  run: RunDetailSchema,
  retry_job_id: z.string().optional(),
});

export const ConductorGetRunStatusInputSchema = z.object({
  run_id: RunId,
  include_timeline: z.boolean().default(true),
  include_gate_state: z.boolean().default(true),
  include_artifacts: z.boolean().default(false),
});

export const ConductorGetRunStatusOutputSchema = z.object({
  run: RunDetailSchema,
  status: RunStatus,
  gates: z.object({
    plan_approval: GateStatus.optional(),
    tests_pass: GateStatus.optional(),
    code_review: GateStatus.optional(),
    merge_wait: GateStatus.optional(),
  }).optional(),
  timeline: z.array(RunTimelineEventSchema).optional(),
  artifacts: z.array(RunArtifactSchema).optional(),
});

export const ConductorListRunsInputSchema = z.object({
  project_id: ProjectId.optional(),
  phases: z.array(RunPhase).optional(),
  include_paused: z.boolean().default(true),
  exclude_paused: z.boolean().default(false),
  result: z.string().optional(),
  has_pr_url: z.boolean().optional(),
  sort_by: z.enum(['updated_at', 'completed_at']).default('updated_at'),
  sort_dir: SortDirection.default('desc'),
  pagination: PaginationSchema.optional(),
});

export const ConductorListRunsOutputSchema = z.object({
  runs: z.array(RunSummarySchema),
  page: CursorPageSchema,
});
```

#### Tool Catalog
| Tool | Description | Input schema | Output format | Side effects | Error conditions |
|---|---|---|---|---|---|
| `conductor_start_run` | Create and enqueue run for task/work item. | `ConductorStartRunInputSchema` | `ToolResult<ConductorStartRunOutputSchema>` | Creates run record and operator action; enqueues orchestrator start. | `UNAUTHORIZED`, `FORBIDDEN`, `NOT_FOUND`, `VALIDATION_ERROR`, `CONFLICT`, `POLICY_BLOCKED` |
| `conductor_approve_run_plan` | Approve plan when run is awaiting plan approval gate. | `ConductorApproveRunPlanInputSchema` | `ToolResult<ConductorApproveRunPlanOutputSchema>` | Records operator action; transitions phase; enqueues execution. | `UNAUTHORIZED`, `FORBIDDEN`, `NOT_FOUND`, `VALIDATION_ERROR`, `RUN_PHASE_INVALID`, `CONFLICT` |
| `conductor_reject_run_plan` | Reject plan and either cancel run or return to planning. | `ConductorRejectRunPlanInputSchema` | `ToolResult<ConductorRejectRunPlanOutputSchema>` | Records operator action; transitions run phase/state. | `UNAUTHORIZED`, `FORBIDDEN`, `NOT_FOUND`, `VALIDATION_ERROR`, `RUN_PHASE_INVALID`, `CONFLICT` |
| `conductor_cancel_run` | Cancel active/awaiting/blocked run and trigger cleanup flow. | `ConductorCancelRunInputSchema` | `ToolResult<ConductorCancelRunOutputSchema>` | Records operator action; transitions to `cancelled`; enqueues cleanup. | `UNAUTHORIZED`, `FORBIDDEN`, `NOT_FOUND`, `VALIDATION_ERROR`, `RUN_PHASE_INVALID`, `CONFLICT` |
| `conductor_retry_run` | Retry blocked/failed path with optional rewind checkpoint. | `ConductorRetryRunInputSchema` | `ToolResult<ConductorRetryRunOutputSchema>` | Records operator action; enqueues retry/resume; updates rewind context metadata. | `UNAUTHORIZED`, `FORBIDDEN`, `NOT_FOUND`, `VALIDATION_ERROR`, `RUN_PHASE_INVALID`, `CONFLICT` |
| `conductor_get_run_status` | Read full run status view (phase, gates, timeline, artifacts). | `ConductorGetRunStatusInputSchema` | `ToolResult<ConductorGetRunStatusOutputSchema>` | None | `UNAUTHORIZED`, `FORBIDDEN`, `NOT_FOUND`, `VALIDATION_ERROR` |
| `conductor_list_runs` | List runs by project/phase/status/result filters. | `ConductorListRunsInputSchema` | `ToolResult<ConductorListRunsOutputSchema>` | None | `UNAUTHORIZED`, `FORBIDDEN`, `VALIDATION_ERROR` |

### 9. Event Subscription (3)

These tools enable push-based notification when state changes occur. Without event subscription, consumers must poll — which is inefficient for real-time orchestration and external integrations.

#### Schemas
```ts
import { z } from 'zod/v4';

export const EventFilterSchema = z.object({
  event_types: z.array(z.string()).optional(),
  entity_types: z.array(z.string()).optional(),
  work_item_ids: z.array(WorkItemId).optional(),
  run_ids: z.array(RunId).optional(),
  min_severity: RiskLevel.optional(),
});

// Persistent subscriptions are webhook/a2a_callback only (stored in pm_event_subscriptions).
// SSE and WebSocket are connection-based and handled at the transport layer, not stored.
export const ConductorSubscribeEventsInputSchema = z.object({
  project_id: ProjectId,
  subscriber_id: z.string().min(1),
  subscriber_type: z.enum(['webhook', 'a2a_callback']),
  callback_url: z.string().url(), // Required — push-based delivery needs a target URL.
  filter: EventFilterSchema.optional(),
  ttl_hours: z.number().int().min(1).max(720).default(24),
});

export const ConductorSubscribeEventsOutputSchema = z.object({
  subscription_id: z.string().min(1),
  subscriber_id: z.string().min(1),
  expires_at: IsoDateTime,
  filter: EventFilterSchema.optional(),
});

export const ConductorUnsubscribeEventsInputSchema = z.object({
  subscription_id: z.string().min(1),
});

export const ConductorUnsubscribeEventsOutputSchema = z.object({
  subscription_id: z.string().min(1),
  unsubscribed_at: IsoDateTime,
});

export const ConductorListSubscriptionsInputSchema = z.object({
  project_id: ProjectId,
  subscriber_id: z.string().optional(),
  include_expired: z.boolean().default(false),
});

export const ConductorListSubscriptionsOutputSchema = z.object({
  subscriptions: z.array(z.object({
    subscription_id: z.string().min(1),
    subscriber_id: z.string().min(1),
    subscriber_type: z.enum(['webhook', 'a2a_callback']),
    callback_url: z.string().url(),
    filter: EventFilterSchema.optional(),
    created_at: IsoDateTime,
    expires_at: IsoDateTime,
    is_active: z.boolean(),
    consecutive_failures: z.number().int().min(0).default(0),
  })),
});
```

#### Tool Catalog
| Tool | Description | Input schema | Output format | Side effects | Error conditions |
|---|---|---|---|---|---|
| `conductor_subscribe_events` | Register for push notifications on PM events matching filter criteria. | `ConductorSubscribeEventsInputSchema` | `ToolResult<ConductorSubscribeEventsOutputSchema>` | Creates subscription record; begins event delivery to callback. | `UNAUTHORIZED`, `FORBIDDEN`, `NOT_FOUND`, `VALIDATION_ERROR`, `CONFLICT` |
| `conductor_unsubscribe_events` | Cancel an active event subscription. | `ConductorUnsubscribeEventsInputSchema` | `ToolResult<ConductorUnsubscribeEventsOutputSchema>` | Marks subscription inactive; stops event delivery. | `UNAUTHORIZED`, `FORBIDDEN`, `NOT_FOUND` |
| `conductor_list_subscriptions` | List active event subscriptions for a project. | `ConductorListSubscriptionsInputSchema` | `ToolResult<ConductorListSubscriptionsOutputSchema>` | None | `UNAUTHORIZED`, `FORBIDDEN`, `NOT_FOUND`, `VALIDATION_ERROR` |

**Event delivery format:** When a subscribed event fires, the system delivers an A2A-formatted notification to the callback URL:

```json
{
  "protocol": "a2a/1.0",
  "message_type": "event_notification",
  "subscription_id": "sub_abc123",
  "event": {
    "event_id": "evt_789",
    "event_type": "work_item.state_changed",
    "project_id": "proj_1",
    "occurred_at": "2026-02-19T18:30:00Z",
    "payload": { "work_item_id": 42, "from_state": "in_progress", "to_state": "done" }
  }
}
```

## Part 2: A2A Agent Card Specification

### Agent Card Schema (Normative)
```ts
import { z } from 'zod/v4';

export const AgentSkillSchema = z.object({
  skill_id: z.string().min(1),
  name: z.string().min(1),
  operation: z.string().min(1),
  description: z.string().min(1),
  input_schema_ref: z.string().min(1),
  output_schema_ref: z.string().min(1),
});

export const AgentCardSchema = z.object({
  card_id: z.string().min(1),
  version: z.literal('1.0'),
  display_name: z.string().min(1),
  agent_type: z.enum(['pm', 'planner', 'implementer', 'reviewer', 'script']),
  description: z.string().min(1),
  skills: z.array(AgentSkillSchema).min(1),
  capabilities: z.object({
    accepts_operations: z.array(z.string()).min(1),
    emits_artifacts: z.array(z.string()).default([]),
    mcp_tools_allowed: z.array(z.string()).min(1),
    can_read_codebase: z.boolean(),
    can_write_codebase: z.boolean(),
    can_execute_commands: z.boolean(),
    requires_llm: z.boolean().default(true),
    max_parallel_tasks: z.number().int().min(1).default(1),
    requires_human_gate_for: z.array(z.string()).default([]),
  }),
  input_format: z.object({
    mime: z.literal('application/json'),
    schema_ref: z.string().min(1),
  }),
  output_format: z.object({
    mime: z.literal('application/json'),
    schema_ref: z.string().min(1),
  }),
});
```

### PM Agent Card
```json
{
  "card_id": "conductor.pm-agent",
  "version": "1.0",
  "display_name": "PM Intelligence Agent",
  "agent_type": "pm",
  "description": "Owns triage, planning, forecasting, risk, and PM operations.",
  "skills": [
    {
      "skill_id": "triage",
      "name": "Triage Work Item",
      "operation": "pm.triage",
      "description": "Classify and score incoming work.",
      "input_schema_ref": "TriageRequestPayloadSchema",
      "output_schema_ref": "TriageResponsePayloadSchema"
    },
    {
      "skill_id": "plan_iteration",
      "name": "Plan Iteration",
      "operation": "pm.plan_iteration",
      "description": "Build capacity-aware, dependency-safe sprint plans.",
      "input_schema_ref": "SprintPlanRequestPayloadSchema",
      "output_schema_ref": "SprintPlanResponsePayloadSchema"
    },
    {
      "skill_id": "forecast",
      "name": "Forecast",
      "operation": "pm.forecast",
      "description": "Produce completion and risk forecasts.",
      "input_schema_ref": "ConductorPredictCompletionInputSchema",
      "output_schema_ref": "ConductorPredictCompletionOutputSchema"
    },
    {
      "skill_id": "record_outcome",
      "name": "Record Outcome",
      "operation": "pm.record_outcome",
      "description": "Capture delivery outcomes for learning loops.",
      "input_schema_ref": "OutcomeRecordingRequestPayloadSchema",
      "output_schema_ref": "OutcomeRecordingResponsePayloadSchema"
    }
  ],
  "capabilities": {
    "accepts_operations": [
      "pm.triage",
      "pm.decompose",
      "pm.plan_iteration",
      "pm.suggest_next",
      "pm.forecast",
      "pm.risk",
      "pm.record_outcome"
    ],
    "emits_artifacts": ["PLAN", "STANDUP", "RETRO", "RELEASE_NOTES", "METRICS"],
    "mcp_tools_allowed": [
      "conductor_triage_work_item",
      "conductor_decompose_work_item",
      "conductor_plan_iteration",
      "conductor_suggest_next_work_item",
      "conductor_predict_completion",
      "conductor_get_risk_radar",
      "conductor_record_outcome"
    ],
    "can_read_codebase": false,
    "can_write_codebase": false,
    "can_execute_commands": false,
    "max_parallel_tasks": 4,
    "requires_human_gate_for": ["plan_approval", "policy_exception", "merge"]
  },
  "input_format": {
    "mime": "application/json",
    "schema_ref": "A2AWorkflowRequestEnvelopeSchema"
  },
  "output_format": {
    "mime": "application/json",
    "schema_ref": "A2AWorkflowResponseEnvelopeSchema"
  }
}
```

### Planner Agent Card
```json
{
  "card_id": "conductor.planner-agent",
  "version": "1.0",
  "display_name": "Planner Agent",
  "agent_type": "planner",
  "description": "Reads project/code context and produces executable implementation plans.",
  "skills": [
    {
      "skill_id": "create_plan",
      "name": "Create Plan",
      "operation": "planning.create",
      "description": "Generate a file-aware implementation plan mapped to acceptance criteria.",
      "input_schema_ref": "PlanRequestPayloadSchema",
      "output_schema_ref": "PlanResponsePayloadSchema"
    },
    {
      "skill_id": "revise_plan",
      "name": "Revise Plan",
      "operation": "planning.revise",
      "description": "Revise plan from reviewer/operator feedback.",
      "input_schema_ref": "PlanRequestPayloadSchema",
      "output_schema_ref": "PlanResponsePayloadSchema"
    }
  ],
  "capabilities": {
    "accepts_operations": ["planning.create", "planning.revise", "planning.scope_map"],
    "emits_artifacts": ["PLAN"],
    "mcp_tools_allowed": [
      "conductor_get_work_item",
      "conductor_get_dependencies",
      "conductor_query_memory",
      "conductor_validate_spec_readiness",
      "conductor_detect_scope_creep"
    ],
    "can_read_codebase": true,
    "can_write_codebase": false,
    "can_execute_commands": false,
    "max_parallel_tasks": 2,
    "requires_human_gate_for": ["plan_approval"]
  },
  "input_format": {
    "mime": "application/json",
    "schema_ref": "PlanRequestPayloadSchema"
  },
  "output_format": {
    "mime": "application/json",
    "schema_ref": "PlanResponsePayloadSchema"
  }
}
```

### Implementer Agent Card
```json
{
  "card_id": "conductor.implementer-agent",
  "version": "1.0",
  "display_name": "Implementer Agent",
  "agent_type": "implementer",
  "description": "Applies approved plans, writes code, runs tests, and prepares PR artifacts.",
  "skills": [
    {
      "skill_id": "execute_plan",
      "name": "Implement Plan",
      "operation": "implementation.execute",
      "description": "Produce patchset aligned to approved plan.",
      "input_schema_ref": "ImplementationRequestPayloadSchema",
      "output_schema_ref": "ImplementationResponsePayloadSchema"
    },
    {
      "skill_id": "prepare_pr",
      "name": "Prepare PR",
      "operation": "implementation.prepare_pr",
      "description": "Prepare PR metadata and publication payload.",
      "input_schema_ref": "ImplementationRequestPayloadSchema",
      "output_schema_ref": "ImplementationResponsePayloadSchema"
    }
  ],
  "capabilities": {
    "accepts_operations": ["implementation.execute", "implementation.test", "implementation.prepare_pr"],
    "emits_artifacts": ["CODE", "PATCHSET", "TEST_REPORT"],
    "mcp_tools_allowed": [
      "conductor_get_run_status",
      "conductor_detect_scope_creep",
      "conductor_analyze_pr_impact",
      "conductor_explain_delay"
    ],
    "can_read_codebase": true,
    "can_write_codebase": true,
    "can_execute_commands": true,
    "max_parallel_tasks": 1,
    "requires_human_gate_for": ["policy_exception", "merge"]
  },
  "input_format": {
    "mime": "application/json",
    "schema_ref": "ImplementationRequestPayloadSchema"
  },
  "output_format": {
    "mime": "application/json",
    "schema_ref": "ImplementationResponsePayloadSchema"
  }
}
```

### Reviewer Agent Card
```json
{
  "card_id": "conductor.reviewer-agent",
  "version": "1.0",
  "display_name": "Reviewer Agent",
  "agent_type": "reviewer",
  "description": "Reviews plans and code for correctness, scope integrity, and policy compliance.",
  "skills": [
    {
      "skill_id": "review_plan",
      "name": "Review Plan",
      "operation": "review.plan",
      "description": "Adversarial plan review against acceptance criteria.",
      "input_schema_ref": "ReviewRequestPayloadSchema",
      "output_schema_ref": "ReviewResponsePayloadSchema"
    },
    {
      "skill_id": "review_code",
      "name": "Review Code",
      "operation": "review.code",
      "description": "Adversarial code review with explicit findings.",
      "input_schema_ref": "ReviewRequestPayloadSchema",
      "output_schema_ref": "ReviewResponsePayloadSchema"
    }
  ],
  "capabilities": {
    "accepts_operations": ["review.plan", "review.code", "review.scope"],
    "emits_artifacts": ["REVIEW"],
    "mcp_tools_allowed": [
      "conductor_review_pull_request",
      "conductor_detect_scope_creep",
      "conductor_get_workflow_health",
      "conductor_compare_estimates_vs_actuals"
    ],
    "can_read_codebase": true,
    "can_write_codebase": false,
    "can_execute_commands": true,
    "max_parallel_tasks": 2,
    "requires_human_gate_for": ["plan_approval", "merge", "policy_exception"]
  },
  "input_format": {
    "mime": "application/json",
    "schema_ref": "ReviewRequestPayloadSchema"
  },
  "output_format": {
    "mime": "application/json",
    "schema_ref": "ReviewResponsePayloadSchema"
  }
}
```

### Script Worker Card

Not every worker is an AI agent. Linters, test runners, deployment scripts, and CI monitors are all workers that communicate through the same A2A protocol. The Script Worker card represents deterministic, non-AI workers.

```json
{
  "card_id": "conductor.script-worker",
  "version": "1.0",
  "display_name": "Script Worker",
  "agent_type": "script",
  "description": "Deterministic worker that executes structured scripts (linting, testing, deployment, CI monitoring) and reports results via A2A protocol. No LLM dependency.",
  "skills": [
    {
      "skill_id": "execute_script",
      "name": "Execute Script",
      "operation": "script.execute",
      "description": "Run a configured script and return structured results.",
      "input_schema_ref": "ScriptExecutionRequestPayloadSchema",
      "output_schema_ref": "ScriptExecutionResponsePayloadSchema"
    }
  ],
  "capabilities": {
    "accepts_operations": ["script.execute", "script.lint", "script.test", "script.typecheck", "script.deploy", "script.monitor"],
    "emits_artifacts": ["TEST_REPORT", "DEPLOY_LOG", "METRICS"],
    "mcp_tools_allowed": [
      "conductor_get_run_status",
      "conductor_detect_scope_creep"
    ],
    "can_read_codebase": true,
    "can_write_codebase": false,
    "can_execute_commands": true,
    "requires_llm": false,
    "max_parallel_tasks": 8,
    "requires_human_gate_for": ["deploy_production"]
  },
  "input_format": {
    "mime": "application/json",
    "schema_ref": "ScriptExecutionRequestPayloadSchema"
  },
  "output_format": {
    "mime": "application/json",
    "schema_ref": "ScriptExecutionResponsePayloadSchema"
  }
}
```

Key differences from AI agent cards:
- `requires_llm: false` — no model API key or token budget needed.
- `max_parallel_tasks: 8` — deterministic workers can scale higher than AI agents.
- `agent_type: "script"` — the orchestrator knows this worker has fixed behavior; no need for prompt engineering or context window management.
- The A2A message format is identical. The orchestrator does not need to know whether a worker is AI or script — it routes based on declared capabilities.

## Part 3: A2A Message Contracts

### Base Envelope (Normative)
```ts
import { z } from 'zod/v4';

export const A2ATaskState = z.enum([
  'submitted',
  'working',
  'input-required',
  'completed',
  'failed',
  'cancelled',
]);

export const A2AArtifactRefSchema = z.object({
  artifact_id: z.string().min(1),
  artifact_type: z.string().min(1),
  uri: z.string().optional(),
  content_type: z.string().optional(),
});

// Canonical operation registry. Every operation used in workflow templates,
// role capabilities, and task routing MUST appear here. CI validates this
// enum against ROLES.md § 7 Operation Reference.
//
// Schema coverage: PM operations (pm.*) have explicit A2A workflow contracts
// below (§ Workflow Contracts). Development operations (planning.*, implementation.*,
// review.*, research.*, docs.*, script.*, gate.*) use the generic task.request/
// task.result format from PROTOCOL.md § 1.5/1.8. Their input/output shapes are
// determined by the worker's role spec (ROLES.md), not by A2A-specific schemas.
export const A2AWorkflowOperation = z.enum([
  // PM operations
  'pm.triage',
  'pm.decompose',
  'pm.plan_iteration',
  'pm.suggest_next',
  'pm.forecast',
  'pm.risk',
  'pm.record_outcome',
  'pm.standup',
  'pm.retrospective',
  'pm.release_notes',
  // Planning operations
  'planning.create',
  'planning.revise',
  'planning.scope_map',
  // Implementation operations
  'implementation.execute',
  'implementation.fix',
  'implementation.test',
  'implementation.prepare_pr',
  // Review operations
  'review.plan',
  'review.code',
  'review.scope',
  'review.security',
  'review.requirements',
  // Research operations
  'research.investigate',
  'research.evaluate',
  // Documentation operations
  'docs.generate',
  'docs.update',
  // Script operations
  'script.execute',
  'script.lint',
  'script.test',
  'script.typecheck',
  'script.build',
  'script.format',
  'script.deploy',
  'script.monitor',
  'script.security_scan',
  'script.migrate',
  'script.notify',
  'script.metrics',
  'script.validate',
  'script.ci_trigger',
  'script.ci_status',
  // Gate operations
  'gate.plan_approval',
  'gate.merge_approval',
  'gate.scope_approval',
]);

// A2A message types: task_request, task_result, event_notification
export const A2AMessageType = z.enum(['task_request', 'task_result', 'event_notification']);

export const A2AEventNotificationSchema = z.object({
  protocol: z.literal('a2a/1.0'),
  message_type: z.literal('event_notification'),
  subscription_id: z.string().min(1),
  event: z.object({
    event_id: z.string().min(1),
    event_type: z.string().min(1),
    project_id: ProjectId,
    occurred_at: IsoDateTime,
    payload: z.record(z.string(), JsonValueSchema),
  }),
});

// A2A envelope wraps the internal task format (see ../workers/PROTOCOL.md § 1.5).
// The orchestrator's message router translates between internal dispatch (compact
// `type` field, structured input/constraints) and A2A envelopes (versioned protocol
// header, generic payload, agent routing). Workers never see the A2A envelope directly.
export const A2AWorkflowRequestEnvelopeSchema = z.object({
  protocol: z.literal('a2a/1.0'),
  message_type: z.literal('task_request'),
  task_id: z.string().min(1),
  correlation_id: z.string().min(1),
  operation: A2AWorkflowOperation,
  source_agent_id: z.string().min(1),
  target_agent_id: z.string().min(1),
  project_id: ProjectId,
  run_id: RunId.optional(),
  requested_at: IsoDateTime,
  ttl_seconds: z.number().int().min(1).max(86400).default(1800),
  payload: z.record(z.string(), JsonValueSchema),
});

export const A2AWorkflowResponseEnvelopeSchema = z.object({
  protocol: z.literal('a2a/1.0'),
  message_type: z.literal('task_result'),
  task_id: z.string().min(1),
  correlation_id: z.string().min(1),
  operation: A2AWorkflowOperation,
  state: A2ATaskState,
  responded_at: IsoDateTime,
  payload: z.record(z.string(), JsonValueSchema).optional(),
  error: ToolErrorSchema.optional(),
  artifacts: z.array(A2AArtifactRefSchema).default([]),
});
```

### Workflow Contracts

#### 1. Triage request/response
```ts
export const TriageRequestPayloadSchema = z.object({
  operation: z.literal('pm.triage'),
  project_id: ProjectId,
  work_item_id: WorkItemId,
  include_similar_items: z.boolean().default(true),
  include_predictions: z.boolean().default(true),
  persist: z.boolean().default(true),
});

export const TriageResponsePayloadSchema = z.object({
  operation: z.literal('pm.triage'),
  triage: TriageAssessmentSchema,
  rationale: z.array(z.string()),
  clarifications_needed: z.array(z.string()),
  suggested_next_actions: z.array(z.string()),
  similar_items: z.array(SimilarItemSchema).optional(),
});
```

#### 2. Sprint plan request/response
```ts
export const SprintPlanRequestPayloadSchema = z.object({
  operation: z.literal('pm.plan_iteration'),
  project_id: ProjectId,
  iteration_id: IterationId.optional(),
  planning_mode: PlanningMode.default('scrum'),
  horizon_days: z.number().int().min(3).max(90).default(14),
  capacity_hours: z.number().min(0),
  wip_limit: z.number().int().min(1),
  candidate_work_item_ids: z.array(WorkItemId).min(1),
  objective: z.string().optional(),
  confidence_target: z.number().min(0.5).max(0.99).default(0.8),
});

export const SprintPlanResponsePayloadSchema = z.object({
  operation: z.literal('pm.plan_iteration'),
  iteration: IterationSummarySchema,
  selected_items: z.array(IterationCandidateSchema),
  stretch_items: z.array(IterationCandidateSchema),
  excluded_items: z.array(IterationExclusionSchema),
  capacity_summary: CapacitySummarySchema,
  risks: z.array(z.string()),
  recommendations: z.array(z.string()),
});
```

#### 3. Plan request/response
```ts
export const PlanRequestPayloadSchema = z.object({
  operation: z.literal('planning.create'),
  project_id: ProjectId,
  run_id: RunId.optional(),
  work_item_id: WorkItemId,
  issue: z.object({
    title: z.string(),
    body_md: z.string(),
    acceptance_criteria: z.array(z.string()).default([]),
  }),
  triage: TriageAssessmentSchema,
  constraints: z.object({
    max_files_touched: z.number().int().positive().optional(),
    sensitive_paths: z.array(z.string()).default([]),
    required_gates: z.array(GateId).default([]),
  }),
  context_packet: z.object({
    dependencies: z.array(DependencyEdgeSchema).default([]),
    memory_matches: z.array(z.object({
      memory_type: z.enum(['decision', 'outcome']),
      memory_id: z.number().int().positive(),
      summary: z.string(),
    })).default([]),
  }).optional(),
});

export const PlanResponsePayloadSchema = z.object({
  operation: z.literal('planning.create'),
  artifact_type: z.literal('PLAN'),
  plan: z.object({
    summary: z.string(),
    steps: z.array(z.object({ id: z.string(), description: z.string(), files: z.array(z.string()) })),
    acceptance_mapping: z.record(z.string(), z.array(z.string())),
    risks: z.array(z.string()),
    test_strategy: z.array(z.string()),
    estimate_hours_p50: z.number().min(0),
    estimate_hours_p80: z.number().min(0),
  }),
  open_questions: z.array(z.string()),
});
```

#### 4. Implementation request/response
```ts
export const ImplementationRequestPayloadSchema = z.object({
  operation: z.literal('implementation.execute'),
  project_id: ProjectId,
  run_id: RunId,
  work_item_id: WorkItemId,
  plan_artifact_id: z.string().min(1),
  approved_plan: PlanResponsePayloadSchema.shape.plan,
  workspace: z.object({
    worktree_path: z.string().min(1),
    base_branch: z.string().min(1),
    target_branch: z.string().min(1),
  }),
  policy_context: z.object({
    max_files_changed: z.number().int().positive().optional(),
    protected_paths: z.array(z.string()).default([]),
  }).optional(),
});

export const ImplementationResponsePayloadSchema = z.object({
  operation: z.literal('implementation.execute'),
  artifact_type: z.literal('PATCHSET'),
  implementation: z.object({
    changed_files: z.array(z.string()),
    commits: z.array(z.object({ sha: z.string(), message: z.string() })),
    test_results: z.object({
      command: z.string(),
      passed: z.boolean(),
      exit_code: z.number().int(),
      summary: z.string(),
    }),
    notes: z.array(z.string()),
  }),
  blocked: z.boolean().default(false),
  blocker_reason: z.string().optional(),
});
```

#### 5. Review request/response
```ts
export const ReviewRequestPayloadSchema = z.object({
  operation: z.enum(['review.plan', 'review.code']),
  project_id: ProjectId,
  run_id: RunId.optional(),
  work_item_id: WorkItemId,
  target_artifact: z.object({
    type: z.enum(['PLAN', 'PATCHSET', 'PR_DIFF']),
    artifact_id: z.string().min(1),
  }),
  acceptance_criteria: z.array(z.string()).default([]),
  review_mode: z.enum(['summary', 'full', 'adversarial']).default('adversarial'),
});

export const ReviewResponsePayloadSchema = z.object({
  operation: z.enum(['review.plan', 'review.code']),
  artifact_type: z.literal('REVIEW'),
  review: z.object({
    verdict: z.enum(['APPROVED', 'CHANGES_REQUESTED', 'NEEDS_DISCUSSION']),
    summary: z.string(),
    findings: z.array(ReviewFindingSchema),
    scope_alignment: z.object({
      in_scope: z.boolean(),
      notes: z.array(z.string()),
    }),
  }),
});
```

#### 6. Outcome recording request/response
```ts
export const OutcomeRecordingRequestPayloadSchema = z.object({
  operation: z.literal('pm.record_outcome'),
  project_id: ProjectId,
  run_id: RunId.optional(),
  work_item_id: WorkItemId.optional(),
  decision_id: DecisionId.optional(),
  outcome_type: z.enum(['delivered', 'partial', 'rework', 'rollback', 'incident', 'abandoned']),
  summary_md: z.string().min(1),
  root_cause_md: z.string().optional(),
  lessons_md: z.string().optional(),
  quality_score: z.number().min(0).max(1).optional(),
  cycle_hours: z.number().min(0).optional(),
  recorded_by_actor_id: z.string().min(1),
});

export const OutcomeRecordingResponsePayloadSchema = z.object({
  operation: z.literal('pm.record_outcome'),
  outcome_id: OutcomeId,
  outcome_uid: z.string(),
  created_at: IsoDateTime,
  linked_learning_updates: z.array(z.string()),
});
```

#### 7. Script execution request/response
```ts
export const ScriptExecutionRequestPayloadSchema = z.object({
  operation: z.enum(['script.execute', 'script.lint', 'script.test', 'script.typecheck', 'script.deploy', 'script.monitor']),
  project_id: ProjectId,
  run_id: RunId.optional(),
  work_item_id: WorkItemId.optional(),
  script_id: z.string().min(1),
  workspace: z.object({
    worktree_path: z.string().min(1),
    base_branch: z.string().min(1),
  }).optional(),
  args: z.record(z.string(), JsonValueSchema).default({}),
  timeout_seconds: z.number().int().min(1).max(3600).default(300),
});

export const ScriptExecutionResponsePayloadSchema = z.object({
  operation: z.enum(['script.execute', 'script.lint', 'script.test', 'script.typecheck', 'script.deploy', 'script.monitor']),
  script_id: z.string().min(1),
  exit_code: z.number().int(),
  passed: z.boolean(),
  summary: z.string(),
  findings: z.array(ReviewFindingSchema).default([]),
  artifacts: z.array(A2AArtifactRefSchema).default([]),
  duration_seconds: z.number().min(0),
});
```

Script workers use the same A2A envelope (`A2AWorkflowRequestEnvelopeSchema` / `A2AWorkflowResponseEnvelopeSchema`) as AI agents. The orchestrator does not need to know whether a worker is AI or script — it routes based on the `operation` field and the worker's declared capabilities in its Agent Card.

#### 8. Decompose request/response
```ts
export const DecomposeRequestPayloadSchema = z.object({
  operation: z.literal('pm.decompose'),
  project_id: ProjectId,
  work_item_id: WorkItemId,
  max_subtasks: z.number().int().min(2).max(20).default(8),
  include_dependencies: z.boolean().default(true),
});

export const DecomposeResponsePayloadSchema = z.object({
  operation: z.literal('pm.decompose'),
  subtasks: z.array(z.object({
    title: z.string(),
    type: WorkItemType,
    area: z.string().optional(),
    acceptance_criteria: z.array(z.string()),
    size_estimate: z.enum(['xs', 'sm', 'md', 'lg', 'xl']),
    risk_level: RiskLevel,
    dependencies: z.array(z.string()).default([]),
  })),
  critical_path: z.array(z.string()),
  parallelization_ratio: z.number().min(0).max(1),
  execution_phases: z.array(z.object({
    phase: z.number().int(),
    subtask_titles: z.array(z.string()),
  })),
});
```

#### 9. Suggest next request/response
```ts
export const SuggestNextRequestPayloadSchema = z.object({
  operation: z.literal('pm.suggest_next'),
  project_id: ProjectId,
  max_suggestions: z.number().int().min(1).max(10).default(5),
  focus_area: z.string().optional(),
});

export const SuggestNextResponsePayloadSchema = z.object({
  operation: z.literal('pm.suggest_next'),
  suggestions: z.array(z.object({
    work_item_id: WorkItemId,
    title: z.string(),
    score: z.number().min(0).max(100),
    rationale: z.array(z.string()),
    estimated_hours_p50: z.number().min(0).optional(),
  })),
});
```

#### 10. Forecast request/response
```ts
export const ForecastRequestPayloadSchema = z.object({
  operation: z.literal('pm.forecast'),
  project_id: ProjectId,
  item_count: z.number().int().min(1),
  sprint_days: z.number().int().min(1).max(90).default(14),
  wip_limit: z.number().int().min(1).default(1),
  area: z.string().optional(),
});

export const ForecastResponsePayloadSchema = z.object({
  operation: z.literal('pm.forecast'),
  throughput_percentiles: z.record(z.string(), z.number()),
  completion_probability: z.number().min(0).max(1),
  completion_dates: z.object({
    p50: IsoDateTime,
    p80: IsoDateTime,
    p95: IsoDateTime,
  }),
  histogram: z.array(z.object({ bucket: z.number(), count: z.number() })),
});
```

#### 11. Risk radar request/response
```ts
export const RiskRadarRequestPayloadSchema = z.object({
  operation: z.literal('pm.risk'),
  project_id: ProjectId,
  range: DateRangeSchema.optional(),
});

export const RiskRadarResponsePayloadSchema = z.object({
  operation: z.literal('pm.risk'),
  overall_risk: z.number().min(0).max(100),
  risk_level: RiskLevel,
  dimensions: z.array(RiskDimensionSchema),
  mitigations: z.array(z.object({
    dimension: z.string(),
    action: z.string(),
    priority: z.enum(['high', 'medium', 'low']),
  })),
});
```

#### 12. Plan revision request/response
```ts
export const PlanRevisionRequestPayloadSchema = z.object({
  operation: z.literal('planning.revise'),
  project_id: ProjectId,
  run_id: RunId,
  work_item_id: WorkItemId,
  original_plan_artifact_id: z.string().min(1),
  revision_reason: z.enum(['review_feedback', 'scope_change', 'implementation_blocker', 'user_request']),
  feedback: z.array(z.object({
    source: z.string(),
    comment: z.string(),
  })),
});

export const PlanRevisionResponsePayloadSchema = z.object({
  operation: z.literal('planning.revise'),
  artifact_type: z.literal('PLAN'),
  plan: PlanResponsePayloadSchema.shape.plan,
  changes_summary: z.array(z.string()),
  open_questions: z.array(z.string()),
});
```

#### 13. Scope map request/response
```ts
export const ScopeMapRequestPayloadSchema = z.object({
  operation: z.literal('planning.scope_map'),
  project_id: ProjectId,
  work_item_id: WorkItemId,
  plan_artifact_id: z.string().min(1).optional(),
  acceptance_criteria: z.array(z.string()),
});

export const ScopeMapResponsePayloadSchema = z.object({
  operation: z.literal('planning.scope_map'),
  scope_map: z.array(z.object({
    criterion: z.string(),
    files: z.array(z.string()),
    tests: z.array(z.string()),
    status: z.enum(['planned', 'in_progress', 'done', 'not_started']),
  })),
  out_of_scope_detected: z.array(z.string()),
});
```

#### 14. Test execution request/response
```ts
export const TestExecutionRequestPayloadSchema = z.object({
  operation: z.literal('implementation.test'),
  project_id: ProjectId,
  run_id: RunId.optional(),
  work_item_id: WorkItemId.optional(),
  workspace: z.object({
    worktree_path: z.string().min(1),
    base_branch: z.string().min(1),
  }),
  test_scope: z.enum(['unit', 'integration', 'e2e', 'all']).default('all'),
  changed_files: z.array(z.string()).default([]),
});

export const TestExecutionResponsePayloadSchema = z.object({
  operation: z.literal('implementation.test'),
  artifact_type: z.literal('TEST_REPORT'),
  passed: z.boolean(),
  exit_code: z.number().int(),
  total: z.number().int().min(0),
  passed_count: z.number().int().min(0),
  failed_count: z.number().int().min(0),
  skipped_count: z.number().int().min(0),
  summary: z.string(),
  failures: z.array(z.object({
    test_name: z.string(),
    file: z.string(),
    error: z.string(),
  })).default([]),
  duration_seconds: z.number().min(0),
});
```

#### 15. PR preparation request/response
```ts
export const PreparePrRequestPayloadSchema = z.object({
  operation: z.literal('implementation.prepare_pr'),
  project_id: ProjectId,
  run_id: RunId,
  work_item_id: WorkItemId,
  workspace: z.object({
    worktree_path: z.string().min(1),
    base_branch: z.string().min(1),
    target_branch: z.string().min(1),
  }),
  acceptance_criteria: z.array(z.string()).default([]),
  plan_artifact_id: z.string().min(1).optional(),
});

export const PreparePrResponsePayloadSchema = z.object({
  operation: z.literal('implementation.prepare_pr'),
  pr_number: z.number().int().positive(),
  pr_url: z.string().url(),
  title: z.string(),
  body_md: z.string(),
  changed_files: z.array(z.string()),
  commit_count: z.number().int().min(1),
});
```

#### 16. Scope review request/response
```ts
export const ScopeReviewRequestPayloadSchema = z.object({
  operation: z.literal('review.scope'),
  project_id: ProjectId,
  run_id: RunId.optional(),
  work_item_id: WorkItemId,
  plan_artifact_id: z.string().min(1),
  changed_files: z.array(z.string()),
  acceptance_criteria: z.array(z.string()),
});

export const ScopeReviewResponsePayloadSchema = z.object({
  operation: z.literal('review.scope'),
  in_scope: z.boolean(),
  scope_creep_ratio: z.number().min(0).max(1),
  out_of_scope_files: z.array(z.object({
    file: z.string(),
    reason: z.string(),
  })),
  untouched_plan_files: z.array(z.string()),
  verdict: z.enum(['CLEAN', 'MINOR_DRIFT', 'SCOPE_CREEP']),
  recommendations: z.array(z.string()),
});
```

## Part 4: Autonomy Levels

### Policy Schema (Normative)
```ts
import { z } from 'zod/v4';

export const AutonomyLevelSchema = z.union([
  z.literal(0),
  z.literal(1),
  z.literal(2),
  z.literal(3),
]);

export const GateControlSchema = z.object({
  plan_approval: z.enum(['human_required', 'ai_allowed']),
  tests_pass: z.enum(['enforced', 'can_skip_with_human_exception']),
  code_review: z.enum(['enforced', 'can_warn']),
  merge_wait: z.enum(['human_required', 'ai_allowed']),
});

export const AutonomyPolicySchema = z.object({
  level: AutonomyLevelSchema,
  run_controls: z.object({
    allow_ai_start_run: z.boolean(),
    allow_ai_approve_plan: z.boolean(),
    allow_ai_reject_plan: z.boolean(),
    allow_ai_cancel_run: z.boolean(),
    allow_ai_retry_run: z.boolean(),
  }),
  gate_controls: GateControlSchema,
  merge_controls: z.object({
    allow_ai_merge: z.boolean(),
    require_green_ci: z.boolean(),
    max_risk_level_for_auto_merge: RiskLevel,
    disallow_merge_if_scope_creep_over: z.number().min(0).max(1),
  }),
  risk_controls: z.object({
    max_rework_probability_for_autonomous_execute: z.number().min(0).max(1),
    max_parallel_runs: z.number().int().min(1).max(100),
    max_files_changed_without_human_review: z.number().int().min(1).max(10000),
    blocked_retry_limit: z.number().int().min(0).max(20),
  }),
  policy_controls: z.object({
    require_human_for_policy_exception: z.boolean(),
    allow_sensitive_path_write_without_human: z.boolean(),
    allow_secret_policy_bypass: z.literal(false),
  }),
  audit_controls: z.object({
    require_decision_logging: z.boolean().default(true),
    require_outcome_logging: z.boolean().default(true),
    require_trace_ids: z.boolean().default(true),
    mirror_operator_actions_to_github: z.boolean().default(true),
  }),
  safety_controls: z.object({
    kill_switch_enabled: z.boolean().default(true),
    auto_pause_on_policy_block: z.boolean().default(true),
    auto_pause_on_repeated_failures: z.boolean().default(true),
    repeated_failure_threshold: z.number().int().min(1).max(20).default(3),
  }),
});
```

### Level Definitions
| Level | Intent | Effective policies |
|---|---|---|
| `0` | Human approves everything | `allow_ai_start_run=false`, `allow_ai_approve_plan=false`, `allow_ai_retry_run=false`, `allow_ai_merge=false`, all gates human-required where applicable. |
| `1` | AI triages and suggests, human decides | AI can triage/decompose/rank/forecast; cannot start runs or approve plans; merge and policy exceptions human-only. |
| `2` | AI plans and executes, human approves gates | AI can start, execute, retry, cancel; plan approval and merge remain human-required; tests/code review gates enforced. |
| `3` | AI operates fully, human reviews outcomes | AI can start/approve/retry/cancel and merge when risk + CI policy passes; human remains escalation authority via kill switch and exception controls. |

### Default Policy Matrix
| Policy | L0 | L1 | L2 | L3 |
|---|---:|---:|---:|---:|
| `allow_ai_start_run` | false | false | true | true |
| `allow_ai_approve_plan` | false | false | false | true |
| `allow_ai_reject_plan` | false | false | true | true |
| `allow_ai_cancel_run` | false | false | true | true |
| `allow_ai_retry_run` | false | false | true | true |
| `plan_approval` | human_required | human_required | human_required | ai_allowed |
| `merge_wait` | human_required | human_required | human_required | ai_allowed |
| `allow_ai_merge` | false | false | false | true |
| `max_risk_level_for_auto_merge` | low | low | medium | high |
| `max_rework_probability_for_autonomous_execute` | 0.00 | 0.35 | 0.55 | 0.75 |
| `require_human_for_policy_exception` | true | true | true | true |

### Guardrails (Non-Overridable)
- Worktree boundaries, credential boundaries, and project authorization are always enforced.
- Secret detection and protected path policies cannot be bypassed by autonomy level.
- Every mutating action MUST include actor identity and `request_id`.
- Run phase transitions remain orchestrator-mediated and event-backed.
- Kill switch MUST stop new autonomous dispatch immediately.
- Policy exceptions remain human-only unless explicitly changed in a future schema version.

### Human Gate Timeout Escalation Ladder

When a human gate (plan_approval, merge_approval, scope_approval, code review) times out:

```
Step 1: Primary assignee timeout (configurable, default 4h for approval, 24h for review)
  → Notify backup assignee (if configured)
  → Event: gate_escalation { step: 1, from: primary, to: backup }

Step 2: Backup assignee timeout (same timeout as primary)
  → Notify team channel
  → Event: gate_escalation { step: 2, from: backup, to: team }

Step 3: Team channel timeout (configurable, default 48h)
  → Terminal escalation policy applies:
    - 'auto_reject': Run cancelled with reason "gate_timeout"
    - 'auto_approve': Gate auto-approved (ONLY if autonomy >= L3)
    - 'block': Run blocked indefinitely, requires manual intervention
    - 'cancel': Run cancelled (default)
  → Event: gate_terminal_escalation { policy: <chosen>, gate: <gate_id> }
```

The terminal escalation policy is configured per gate in the project settings. Default is `cancel`.

**Startup validation:** If a project's autonomy level requires human gates (L0-L2), the orchestrator MUST verify at startup that at least one routable assignee exists for each required gate. If not, emit a `configuration_warning` event and log a warning. Runs will still start but may block at gates.

### Quality Gate Thresholds

Security scan and other quality checks have configurable blocking thresholds:

```ts
export const QualityGateThresholds = z.object({
  security_scan_block_threshold: z.enum(['low', 'medium', 'high', 'critical']).default('medium'),
  lint_block_threshold: z.enum(['warning', 'error']).default('error'),
  test_coverage_minimum: z.number().min(0).max(100).default(0), // 0 = no minimum
  type_error_tolerance: z.number().int().min(0).default(0), // 0 = zero tolerance
});
```

### Escalation Triggers (All Levels)
A run MUST escalate to human attention (`phase=blocked`) when:
- A policy check blocks at pre-push or merge boundary.
- A required gate fails with no configured automatic retry path.
- Retry attempts exceed `blocked_retry_limit`.
- Required artifacts are missing after retry.
- A required decision returns `INSUFFICIENT_DATA`.
- No worker variant is available for a structurally required capability (not a transient unavailability — provider outage is handled by failover, but zero registered variants for a capability is a configuration error).

## Implementation Notes
- Use `zod/v4` consistently.
- Keep tool output envelope identical across MCP/A2A/Web transports.
- Mutating tools SHOULD accept idempotency metadata at transport layer (`request_id` + actor + operation).
- Breaking schema changes MUST bump `schema_version` and maintain one deprecation window.
