# Workflow Template Syntax and Schema

> **Status:** Normative. This defines the workflow phase enumeration, transition rules, gate definitions, step mapping, workflow configuration schema, routing decisions, versioning mechanics, and built-in template designs for Conductor.

## 1. Template Architecture

Conductor's workflow system has three layers:

```
┌─────────────────────────────────────────────┐
│  Workflow Templates (Spec)                    │  Built-in DAG designs
│  (which phases, in what order, with gates)    │  (docs/orchestrator/WORKFLOW_ENGINE.md)
├─────────────────────────────────────────────┤
│  Workflow Config (Implemented)                │  Per-step AI parameters
│  (model, tokens, temperature, tool profile)   │  4-layer resolution
├─────────────────────────────────────────────┤
│  Routing Decision (Implemented)               │  Per-run gate customization
│  (required gates, optional gates, reasoning)  │  Stored at routing time
└─────────────────────────────────────────────┘
```

**Templates** (spec-level designs in `docs/orchestrator/WORKFLOW_ENGINE.md`) define workflow patterns. **Config** (implemented in `packages/shared/src/workflow-config/`) defines AI parameters per step. **Routing** (partially implemented) customizes gates per run.

> **Implementation status:** The runtime implements a single hardcoded phase graph (§ 2) with configurable gates. The five named template designs (§ 5) are spec-level — they describe intended behavior but are not yet selectable via a `template_id` field. No `workflow_templates` table or template selection engine exists in runtime code.

---

## 2. Phase Enumeration (RunPhase)

**Source:** `packages/shared/src/types/index.ts`

```typescript
export type RunPhase =
  | 'pending'
  | 'planning'
  | 'awaiting_plan_approval'
  | 'executing'
  | 'awaiting_review'
  | 'blocked'
  | 'completed'
  | 'cancelled';
```

| Phase | Type | Description |
|-------|------|-------------|
| `pending` | Setup | Worktree creation, routing decision |
| `planning` | AI | Planner agent creates/revises plan |
| `awaiting_plan_approval` | Human gate | Operator reviews and approves plan |
| `executing` | AI | Implementer agent writes code, tests, creates PR |
| `awaiting_review` | Mixed | AI reviewer + human code review |
| `blocked` | Suspended | Error or limit hit; operator intervention needed |
| `completed` | Terminal | Cleanup, outcome recording |
| `cancelled` | Terminal | Aborted by operator |

> **Note:** The spec documents (`docs/orchestrator/WORKFLOW_ENGINE.md`) describe additional phases (`checking`, `awaiting_merge`) that are not yet in the `RunPhase` type. The current implementation handles testing within `executing` and merge within `awaiting_review`.

### 2.1 Valid Transitions

**Source:** `packages/shared/src/orchestrator/index.ts:58`

```typescript
export const VALID_TRANSITIONS: Record<RunPhase, ReadonlyArray<RunPhase>> = {
  pending:                 ['planning', 'blocked', 'cancelled'],
  planning:                ['awaiting_plan_approval', 'blocked', 'cancelled'],
  awaiting_plan_approval:  ['planning', 'executing', 'blocked', 'cancelled'],
  executing:               ['awaiting_review', 'blocked', 'cancelled'],
  awaiting_review:         ['executing', 'completed', 'blocked', 'cancelled'],
  blocked:                 ['pending', 'planning', 'awaiting_plan_approval',
                            'executing', 'awaiting_review', 'cancelled'],
  completed:               [],
  cancelled:               [],
};
```

**Rules:**
- `blocked` can transition back to any non-terminal phase (recovery)
- `completed` and `cancelled` are terminal (no outbound transitions)
- Every non-terminal phase can transition to `blocked` or `cancelled`
- The graph is a **cyclic FSM** with controlled retry/recovery loops:
  - `awaiting_plan_approval → planning` (revision loop)
  - `awaiting_review → executing` (rework loop)
  - `blocked → any non-terminal` (recovery)

---

## 3. Run Steps (Micro-Level)

**Source:** `packages/shared/src/types/index.ts`

Within each phase, one or more steps execute:

```typescript
export type RunStep =
  | 'setup_worktree'
  | 'route'
  | 'planner_create_plan'
  | 'reviewer_review_plan'
  | 'wait_plan_approval'
  | 'implementer_apply_changes'
  | 'tester_run_tests'
  | 'reviewer_review_code'
  | 'create_pr'
  | 'wait_pr_merge'
  | 'cleanup';
```

### 3.1 Step-to-Phase Mapping

| Phase | Steps | Notes |
|-------|-------|-------|
| `pending` | `setup_worktree`, `route` | Sequential |
| `planning` | `planner_create_plan`, `reviewer_review_plan` | Sequential |
| `awaiting_plan_approval` | `wait_plan_approval` | Human gate |
| `executing` | `implementer_apply_changes`, `tester_run_tests`, `create_pr` | Implementation + testing |
| `awaiting_review` | `reviewer_review_code`, `wait_pr_merge` | Review + merge |
| `completed` / `cancelled` | `cleanup` | Terminal |

---

## 4. Gate Definitions

**Source:** `packages/shared/src/gates/gate-definitions.ts`

Gates are checkpoints that must pass before a phase transition proceeds.

### 4.1 Built-In Gates

| Gate ID | Kind | Required | Configuration | Has Evaluator? |
|---------|------|----------|---------------|----------------|
| `plan_approval` | `human` | Yes | Timeout: 72h, reminder: every 24h | Yes |
| `tests_pass` | `automatic` | Yes | Max retries: 3, timeout: 15min, skip: not allowed | Yes |
| `code_review` | `automatic` | Yes | Max rounds: 3, accept with issues: allowed | Definition only (no evaluator) |
| `merge_wait` | `human` | Yes | — | Definition only (no evaluator) |

> **Note:** `code_review` and `merge_wait` have gate definitions (seed data) but no evaluator implementation in `packages/shared/src/gates/evaluators/`. They are metadata-only in the current runtime — the evaluator registry only implements `plan_approval` and `tests_pass`.

### 4.2 Gate Types

**Source:** `packages/shared/src/types/index.ts`

```typescript
type GateKind = 'automatic' | 'human' | 'policy';
type GateStatus = 'pending' | 'passed' | 'failed';
```

| Kind | Evaluation | Operator Override |
|------|-----------|-------------------|
| `automatic` | System evaluates (test results, lint output) | Can grant exception with justification |
| `human` | Operator explicitly approves/rejects | N/A (operator IS the gate) |
| `policy` | Policy engine evaluates against rules | Can grant exception with scope |

Gate evaluations can return `pending` (not yet decidable), `passed`, or `failed`.

### 4.3 Default Phase-Gate Mapping

**Source:** `packages/shared/src/orchestrator/index.ts:217`

```typescript
const DEFAULT_PHASE_GATES: Record<string, string[]> = {
  awaiting_plan_approval: ['plan_approval'],
  executing:               ['tests_pass'],   // Checked after implementation, before awaiting_review
};

const DEFAULT_REQUIRED_GATES = ['plan_approval', 'tests_pass', 'code_review', 'merge_wait'];
const DEFAULT_OPTIONAL_GATES: string[] = [];
```

**Gate evaluation at phase boundaries:**
- `plan_approval` is evaluated when transitioning out of `awaiting_plan_approval`
- `tests_pass` is evaluated when transitioning out of `executing` (before `awaiting_review`)
- `code_review` and `merge_wait` are in the required list but have no phase mapping — they are not enforced at any transition boundary in the current implementation

### 4.4 Gate Evaluation Flow

**Source:** `packages/shared/src/orchestrator/index.ts:412` — `evaluateGatesAndTransition(db, run, phase, transition)`

```
Phase transition requested
  → evaluateGatesAndTransition(db, run, phase, transition)
    → Look up DEFAULT_PHASE_GATES for current phase
    → Filter to gates that are in the run's required gates list
    → For each applicable gate:
        → Call evaluator (evaluateGate)
        → Persist evaluation event
    → If ALL applicable gates pass:
        → Execute phase transition atomically
    → If ANY gate fails or is pending:
        → Return without transitioning (no auto-block)
        → Caller decides next action
```

> **Note:** On gate failure, the function returns `{ transitioned: false }` — it does not automatically transition the run to `blocked`. The caller (worker/orchestrator) decides whether to retry, block, or take other action.

---

## 5. Built-In Workflow Templates (Spec-Level)

**Source:** `docs/orchestrator/WORKFLOW_ENGINE.md`

These templates describe intended workflow patterns. They are **spec-level designs** — the runtime does not yet have a template selection engine. The current runtime implements the "feature" pattern as the single hardcoded workflow.

### 5.1 Feature (Default — Currently Active)

```
pending → planning → awaiting_plan_approval → executing → awaiting_review → completed
                        ↕ (revision loop)        ↕ (rework loop)
```

| Parameter | Value |
|-----------|-------|
| Plan revisions | Max 3 (BlockedReasonCode: `max_plan_revisions`) |
| Review rounds | Max 3 (BlockedReasonCode: `max_review_rounds`) |
| Gates | `plan_approval`, `tests_pass` (enforced); `code_review`, `merge_wait` (defined but not enforced) |

### 5.2 Bug Fix (Spec Only)

Conditional planning — small bugs would skip the planning phase.

```
Small bug:  pending → executing → awaiting_review → completed
Large bug:  pending → planning → awaiting_plan_approval → executing → awaiting_review → completed
```

> **Not implemented:** No scope estimation or conditional phase skipping logic exists in runtime.

### 5.3 Spike (Spec Only)

Research-only template — no implementation phase.

```
pending → planning → completed
```

> **Not implemented:** No template selection to restrict phases.

### 5.4 Epic (Spec Only)

Decomposes into child runs with dependency management.

> **Not implemented:** No child run spawning or `ExecutionPlan` schema in runtime.

### 5.5 Incident (Spec Only)

Fast-track template for production incidents.

> **Not implemented:** No expedited workflow or auto-approve logic in runtime.

---

## 6. Workflow Configuration Schema

**Source:** `packages/shared/src/workflow-config/index.ts`

### 6.1 StepConfig Schema

Each workflow step can be configured with AI parameters:

```typescript
interface StepConfig {
  model?: string;               // AI model ID (e.g., 'claude-sonnet-4-20250514')
  maxTokens?: number;           // Max output tokens
  temperature?: number;         // Sampling temperature
  toolProfile?: string;         // 'readonly' | 'inspect' | 'full'
  sandboxProfile?: string;      // Sandbox configuration
  budgets?: {
    maxInputTokens?: number;    // Input token cap
    maxOutputTokens?: number;   // Output token cap
    maxDurationMs?: number;     // Wall-clock timeout
  };
  backend?: 'raw' | 'agent_sdk';  // Execution backend
}
```

### 6.2 WorkflowConfig Schema

```typescript
interface WorkflowConfig {
  planner?: StepConfig;         // AI planner configuration
  reviewerPlan?: StepConfig;    // Plan reviewer configuration
  implementer?: StepConfig;     // AI implementer configuration
  reviewerCode?: StepConfig;    // Code reviewer configuration
}
```

### 6.3 Tool Profile Constraints

| Step | Allowed Profiles | Rationale |
|------|-----------------|-----------|
| `planner` | `readonly`, `inspect` | Planners must not mutate code |
| `reviewerPlan` | `readonly`, `inspect` | Reviewers must not mutate code |
| `reviewerCode` | `readonly`, `inspect` | Reviewers must not mutate code |
| `implementer` | `full` | Only implementers can write |

### 6.4 Four-Layer Resolution

Configuration resolves in priority order (highest wins):

```
1. Run Overlay (mutable while paused)     ← Operator edits
2. Run Snapshot (immutable at creation)    ← Frozen from project config
3. Project Config (per-project)            ← DB storage
4. MVP Defaults (hard-coded)               ← Baseline
```

**Storage (migrations 022-023):**

| Column | Table | Purpose |
|--------|-------|---------|
| `workflow_config_json` | `projects` | Project-level config |
| `workflow_snapshot_json` | `runs` | Immutable snapshot at run creation |
| `workflow_overlay_json` | `runs` | Mutable overlay (editable while paused) |
| `workflow_epoch` | `runs` | Mutation counter for stale job detection |

### 6.5 Config Validation

- **Write-time (strict):** Unknown top-level step keys rejected (e.g., typo `plannerr` → error). Nested step fields are sanitized (unknown keys stripped).
- **Read-time (loose):** Unknown keys ignored (forward compatibility with newer config versions)

---

## 7. Routing Decisions

**Source:** `packages/shared/src/db/migrations/001_initial_schema.ts` — `routing_decisions` table

```typescript
interface RoutingDecision {
  routing_decision_id: string;
  run_id: string;
  inputs_json: string;         // Issue type, estimated scope, sensitivity, repo profile
  agent_graph_json: string;    // Which agents participate and in what order
  required_gates_json: string; // Customized gate list for this run
  optional_gates_json: string; // Optional gates (parsed but not used by gate evaluation)
  reasoning: string;           // Why this routing was chosen
  decided_at: string;
}
```

**Current implementation:**
- The `routing_decisions` table exists in the schema
- The `required_gates_json` field can override `DEFAULT_REQUIRED_GATES` for a specific run
- `optional_gates_json` is parsed but **not used** by the gate evaluation logic — only required gates are checked
- `createRun()` does **not** automatically insert a routing decision — callers must create one separately if needed
- No template selection field exists in the table; routing decisions customize gates, not template shapes

**Determinism:** When a routing decision exists, its inputs are snapshotted. Replay uses stored values for reproducibility.

---

## 8. Template Versioning

### 8.1 Workflow Epoch

**Source:** `packages/shared/src/runs/workflow-mutations.ts`

The `workflow_epoch` counter on each run tracks mutations:

| Event | Epoch Change |
|-------|-------------|
| Run creation | Set to 0 |
| `applyWorkflowOverlay` (config edit while paused) | Incremented |
| `rewindRun` (rewind to earlier step while paused) | Incremented |
| Normal phase transitions | **Not incremented** |

**Stale job prevention:** Jobs carry the epoch at dispatch. The worker checks epoch on each job and skips mismatched ones, preventing orphaned work from interfering with the new workflow state.

### 8.2 Mid-Run Changes

| Scenario | Behavior |
|----------|----------|
| Config edited while paused | Overlay applied, epoch incremented, stale jobs rejected |
| Config edited while active | Not allowed — must pause first |
| Project config changed | Only affects new runs; in-progress runs use their snapshot |
| Gate definitions updated | **Affects in-progress runs** — gate configs are read live at evaluation time, not snapshotted |

### 8.3 Rewind Checkpoints

**Source:** `packages/shared/src/runs/checkpoints.ts`

Paused runs can rewind to earlier phases:

```typescript
type RewindCheckpoint =
  | 'planning:start'           // → planner_create_plan
  | 'awaiting_plan_approval'   // → wait_plan_approval
  | 'executing:start'          // → implementer_apply_changes
  | 'awaiting_review';         // → reviewer_review_code
```

**Rewind mechanics:**
- Only works on paused runs
- Target step must be in the `REWIND_STEP_TO_PHASE` mapping (no ordering enforcement beyond valid checkpoints)
- Increments `workflow_epoch` (stale job protection)
- Context mode: `preserve` (builds summary of prior work) or `truncate` (discard context)
- CAS guard: run must be paused with no active invocations

---

## 9. Workflow Mutations (Pause-Only Operations)

**Source:** `packages/shared/src/runs/workflow-mutations.ts`

Two operations modify a run's workflow, both requiring the run to be paused:

### 9.1 applyWorkflowOverlay

Edit AI parameters while paused:

1. Validate config strictly (reject unknown top-level keys, enforce tool profile constraints)
2. Record operator action in audit log
3. Atomically update `workflow_overlay_json` + increment `workflow_epoch`
4. Publish `operator.action` and `run.updated` events

### 9.2 rewindRun

Rewind to an earlier checkpoint while paused:

1. Validate target step is in `REWIND_STEP_TO_PHASE` mapping
2. Create audit event with reason
3. Increment `workflow_epoch`
4. Set run phase and step to checkpoint target
5. Publish events

**Both operations enforce:** CAS guard (run must be paused, no active invocations).

---

## 10. Validation Rules

### 10.1 Runtime Validation

| Rule | Enforcement | Location |
|------|------------|----------|
| Phase transitions must be in `VALID_TRANSITIONS` | Runtime (optimistic lock) | `orchestrator/index.ts` `transitionPhase()` |
| Tool profiles match step constraints | Write-time | `workflow-config/index.ts` |
| Config top-level keys are known | Write-time (strict) | `workflow-config/index.ts` |
| Rewind target in `REWIND_STEP_TO_PHASE` | Runtime | `runs/workflow-mutations.ts` |

### 10.2 Known Validation Gaps

| Gap | Description | Risk |
|-----|------------|------|
| Unknown gates silently ignored | Gates not in the evaluator registry are skipped, not rejected | Low — only predefined gates are used |
| Required gates can be replaced via routing | `required_gates_json` can override defaults without validation | Medium — could accidentally skip required gates |
| No template-level validation | No `workflow_templates` schema to validate against | Low — single hardcoded template |
| Gate definitions read live | In-progress runs affected by gate definition changes | Medium — could change gate behavior mid-run |

### 10.3 Cycle Analysis

The transition graph is a **cyclic FSM**, not a DAG:

- **Revision loop:** `awaiting_plan_approval → planning → awaiting_plan_approval` (bounded by `max_plan_revisions`)
- **Rework loop:** `awaiting_review → executing → awaiting_review` (bounded by `max_review_rounds`)
- **Recovery:** `blocked → any non-terminal → ... → blocked` (operator-driven)

Cycles are bounded by `BlockedReasonCode` limits (`max_plan_revisions`, `max_review_rounds`, `rate_limit_exhausted`), preventing infinite loops.

---

## 11. Cross-References

| Topic | Document |
|-------|----------|
| Workflow execution engine spec | `docs/orchestrator/WORKFLOW_ENGINE.md` |
| Run state machine and phases | `docs/RUN_STATE_MACHINE.md` |
| Phase enums and blocked reasons | `docs/ENUMS.md` § 1 |
| Rate limiting and budget enforcement | `docs/RATE_LIMITING.md` |
| Policy enforcement | `docs/POLICIES.md` |

---

## Appendix A: Codex Adversarial Review Resolution

**Review date:** 2026-02-20
**Reviewer:** Codex (read-only sandbox)
**Findings:** 18 total — 13 BLOCKING, 1 HIGH, 4 MEDIUM

| # | Severity | Section | Finding | Resolution |
|---|----------|---------|---------|------------|
| 1 | BLOCKING | §2 Phases | `checking` and `awaiting_merge` not in RunPhase type | Removed; documented as spec-only phases not yet in code |
| 2 | BLOCKING | §2.1 Transitions | Table included non-existent phases | Replaced with exact `VALID_TRANSITIONS` from orchestrator |
| 3 | BLOCKING | §3 RunStep | `linter_check`, `security_scan` not in type; step mapping wrong | Corrected to actual 11 RunStep values; fixed phase mapping |
| 4 | BLOCKING | §4.3 Phase gates | `tests_pass` mapped to `checking` | Corrected to `executing` per actual code |
| 5 | BLOCKING | §4.1 Gates | `code_review`/`merge_wait` have no evaluators | Added "Has Evaluator?" column; documented as definition-only |
| 6 | BLOCKING | §4.4 Gate flow | Wrong function signature; auto-block claim | Fixed signature; documented return-without-transition behavior |
| 7 | BLOCKING | §5 Templates | `docs/WORKFLOW_ENGINE.md` path wrong; templates presented as runtime | Fixed path; clearly labeled all non-feature templates as spec-only |
| 8 | HIGH | §5.2-5.5 | Template-specific rules not implemented | Marked each as "Not implemented" with clear labels |
| 9 | BLOCKING | §7 Routing | Claims createRun inserts routing decision; no template_id field | Corrected: callers create separately; no template selection |
| 10 | BLOCKING | §7 Routing | `optional_gates_json` unused by evaluation | Added note about parsing without usage |
| 11 | BLOCKING | §8 Dynamic adaptation | `workflow_overrides` table doesn't exist | Removed entire dynamic adaptation section; documented actual pause-only mutations |
| 12 | BLOCKING | §8.2 Gate changes | Claimed gate definitions don't affect in-progress runs | Corrected: gate configs read live at evaluation time |
| 13 | BLOCKING | §8.3 Rewind | Claimed "earlier than current" ordering enforcement | Corrected: validates against `REWIND_STEP_TO_PHASE` mapping only |
| 14 | BLOCKING | §10 Validation | Gate existence and required-gate invariants claimed as enforced | Documented as validation gaps instead |
| 15 | BLOCKING | §10.2 Cycle detection | Claimed acyclic DAG | Corrected to cyclic FSM with bounded loops |
| 16 | BLOCKING | §4.2 GateStatus | Only listed `passed`/`failed` | Added `pending` to match actual type |
| 17 | MEDIUM | §6.5 Validation | Strict mode scope unclear | Clarified top-level vs nested key behavior |
| 18 | BLOCKING | §11/Appendix | Wrong doc paths; unverified claims | Corrected cross-reference paths |
