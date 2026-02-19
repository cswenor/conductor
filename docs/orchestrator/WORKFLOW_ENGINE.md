# Workflow Engine

Status: Normative specification
Audience: Engineering
Updated: 2026-02-19

This document specifies how the orchestrator processes workflows: template selection, transition evaluation, decision logic, dynamic adaptation, multi-run coordination, and failure handling.

---

## 1. Template Selection

When a run starts, the orchestrator selects a workflow template. The template determines the shape of the workflow — which phases exist, what transitions are possible, and what limits apply.

### 1.1 Selection Algorithm

```
Input:  work_item (type, labels, estimated_scope, source)
Output: workflow_template

1. Load all templates for this project (project-specific + global/built-in)
2. Filter by work_item_type match
3. Filter by estimated_scope match (if template specifies scope constraint)
4. Filter by label match (if template specifies label constraint)
5. Score remaining candidates:
   - Project-specific template > global template (+10)
   - Scope match > no scope constraint (+5)
   - Label match > no label constraint (+3)
6. Return highest-scoring template
7. Fallback: 'feature' template (always exists as built-in)
```

Template selection is recorded as a `decision.template_selected` event with the scoring breakdown.

### 1.2 Built-in Templates

Conductor ships with five built-in templates. Projects can customize these or add their own.

#### `feature` (default)

The standard feature development workflow. Used for features, tasks, and any work that doesn't match a more specific template.

```
                    ┌──────────┐
                    │ pending  │
                    └────┬─────┘
                         │ start
                         ▼
                    ┌──────────┐
             ┌──────│ planning │◄─────────────┐
             │      └────┬─────┘              │
             │           │ plan ready         │ plan rejected
             │           ▼                    │
             │      ┌──────────────┐          │
             │      │plan_approval │──────────┘
             │      └────┬─────────┘
             │           │ approved
             │           ▼
             │      ┌──────────────┐
             │      │implementing  │◄─────────┐
             │      └────┬─────────┘          │
             │           │                    │
             │      ┌────┴────┐               │
             │      ▼         ▼               │
             │  ┌────────┐ ┌────────┐         │
             │  │testing │ │linting │         │
             │  └───┬────┘ └───┬────┘         │
             │      │          │              │
             │      ▼          ▼              │
             │  (both pass?)───────── no ─────┘
             │      │ yes                fix & retry
             │      ▼
             │  ┌──────────┐
             │  │reviewing │◄─────────────┐
             │  └────┬─────┘              │
             │       │                    │
             │  ┌────┴─────┐              │
             │  ▼          ▼              │
             │ approved  changes          │
             │  │        requested        │
             │  │          │              │
             │  │          ▼              │
             │  │     ┌─────────┐         │
             │  │     │reworking│─────────┘
             │  │     └─────────┘
             │  ▼
             │ ┌──────────┐
             └►│completed │
               └──────────┘
```

| Phase | Worker Type | Required Capability | Gate |
| --- | --- | --- | --- |
| planning | AI | `planning.create` | — |
| plan_approval | Human (L0-L1) or Auto (L2-L3) | — | `plan_approval` |
| implementing | AI | `implementation.execute` | — |
| testing | Script | `script.test` | `tests_pass` |
| linting | Script | `script.lint` | `tests_pass` (shared gate) |
| reviewing | AI + Human | `review.code` | `code_review` |
| reworking | AI | `implementation.execute` | — |

**Limits:** 3 plan revisions, 3 test fix attempts, 3 review rounds, 72 hours max.

#### `bug_fix`

Simplified workflow for bugs. Skips planning for small bugs.

```
    ┌──────────┐
    │ pending  │
    └────┬─────┘
         │
    ┌────┴──────────────────────┐
    │ (estimated_scope)         │
    │                           │
    ▼ small                     ▼ medium/large
┌──────────────┐          ┌──────────┐
│implementing  │          │ planning │
└────┬─────────┘          └────┬─────┘
     │                         │
     │ ◄──────────────────────┘ (plan approved)
     ▼
┌──────────┐
│testing   │
└────┬─────┘
     │ pass
     ▼
┌──────────┐
│reviewing │
└────┬─────┘
     │ approved
     ▼
┌──────────┐
│completed │
└──────────┘
```

Small bugs (estimated_scope == 'small') go straight to implementation. The planner is skipped because the fix is obvious and planning would be overhead.

#### `spike`

Research-only workflow. No implementation, no review.

```
    ┌──────────┐
    │ pending  │
    └────┬─────┘
         │
         ▼
    ┌──────────┐
    │researching│
    └────┬──────┘
         │ research document produced
         ▼
    ┌──────────┐
    │completed │
    └──────────┘
```

The output is a RESEARCH artifact. No code is written. Use this for "should we use X?" or "how does Y work?" investigations.

#### `epic`

Decompose-and-coordinate workflow for large work items.

```
    ┌──────────┐
    │ pending  │
    └────┬─────┘
         │
         ▼
    ┌──────────┐
    │ planning │──── Overall approach
    └────┬─────┘
         │
         ▼
    ┌──────────────┐
    │decomposing   │──── PM Engine splits into subtasks
    └────┬─────────┘
         │
         ▼
    ┌──────────────┐
    │coordinating  │──── Spawns child runs, manages dependencies
    └────┬─────────┘
         │ all children complete
         ▼
    ┌──────────┐
    │completed │
    └──────────┘
```

See § 5 Multi-Run Coordination for how child runs are managed.

#### `incident`

Expedited workflow for production incidents. Shorter timeouts, relaxed review.

```
    ┌──────────┐
    │ pending  │
    └────┬─────┘
         │ (priority auto-set to 1)
         ▼
    ┌──────────────┐
    │implementing  │
    └────┬─────────┘
         │
         ▼
    ┌──────────┐
    │testing   │
    └────┬─────┘
         │ pass
         ▼
    ┌──────────────┐
    │quick_review  │──── 1 round max, auto-approve at L2+
    └────┬─────────┘
         │
         ▼
    ┌──────────┐
    │completed │
    └──────────┘
```

**Differences from feature:** No planning phase. 1 review round max. Auto-approve at autonomy L2+. Priority auto-set to 1 (highest). Timeout reduced to 4 hours.

### 1.3 Custom Templates

Projects can define custom templates. Common customizations:

- **Add a security review phase** after implementing for projects with security requirements
- **Add a staging deploy phase** after review for projects with staging environments
- **Skip planning** for all work items in a rapid-iteration project
- **Add a documentation phase** after implementation for public-facing projects
- **Change limits** (more review rounds for regulated codebases)

Custom templates are stored in the database (see `DATA_MODEL.md § 3.1`) and versioned. Template changes take effect for new runs only — in-progress runs continue with the template they started with.

---

## 2. Transition Evaluation

The core loop of the workflow engine: when something happens, decide what's next.

### 2.1 The Evaluation Loop

```
Event arrives (task completed, gate evaluated, timer fired, human acted)
    │
    ▼
Acquire run lock (Redis distributed lock)
    │
    ▼
Load run state + current phase + template
    │
    ▼
Get outgoing edges from current phase
    │
    ▼
Sort edges by priority (lower number = evaluated first)
    │
    ▼
For each edge:
    │
    ├── Evaluate condition against event + context
    │   │
    │   ├── Match → Execute transition
    │   │         1. Update run.current_phase
    │   │         2. Record run_phases entry
    │   │         3. Emit run.phase_changed event
    │   │         4. Determine next task (if phase requires work)
    │   │         5. Enqueue task to appropriate queue
    │   │         6. Release run lock
    │   │         DONE
    │   │
    │   └── No match → Try next edge
    │
    └── No edges matched
        │
        ▼
    Consult Decision Engine (§ 2.3) for dynamic routing
        │
        ├── Decision made → Execute transition
        │
        └── No decision → Block run
              1. Set run.state = 'blocked'
              2. Set run.block_reason = 'no_matching_transition'
              3. Emit run.blocked event
              4. Surface for human attention
              5. Release run lock
```

### 2.2 Edge Conditions

Each edge has a condition that determines when it fires. Conditions are evaluated against the current context (event data, run state, artifacts, intelligence).

| Condition Type | Evaluates | Example |
| --- | --- | --- |
| `step_result` | The result of the task that just completed | `{type: "step_result", result: "success"}` |
| `gate_pass` | Whether a gate condition is met | `{type: "gate_pass", gate_id: "tests_pass"}` — valid IDs: `plan_approval`, `tests_pass`, `code_review`, `merge_wait` |
| `gate_fail` | Whether a gate condition failed | `{type: "gate_fail", gate_id: "tests_pass"}` — same valid IDs |
| `counter` | A run counter exceeds a threshold | `{type: "counter", counter: "review_rounds", operator: ">=", value: 3}` |
| `intelligence` | PM Engine query result | `{type: "intelligence", query: "conductor_predict_rework", threshold: 0.7}` |
| `autonomy` | Current autonomy level allows auto-action | `{type: "autonomy", min_level: 2}` |
| `artifact_exists` | A required artifact has been produced | `{type: "artifact_exists", artifact_type: "PLAN"}` |
| `always` | Unconditional (default fallback edge) | `{type: "always"}` |

**Compound conditions** use `and`/`or`:

```json
{
  "type": "and",
  "conditions": [
    {"type": "step_result", "result": "success"},
    {"type": "gate_pass", "gate_id": "lint_pass"}
  ]
}
```

### 2.3 Decision Engine

When no static edge matches, the Decision Engine attempts dynamic routing. This is the intelligence-augmented layer.

```
No static edge matched
    │
    ▼
Query PM Engine (if available):
    - conductor_predict_rework({ work_item_id })
    - conductor_validate_spec_readiness({ work_item_id })
    │
    ▼
Evaluate dynamic rules:
    │
    ├── Rework probability > 0.7 AND no self-review done
    │   → Insert self-review phase before human review
    │
    ├── Readiness score < 50 AND current phase is pre-review
    │   → Block with reason "not_ready_for_review"
    │
    ├── All retry budgets exhausted
    │   → Block with reason "retry_budget_exhausted"
    │
    ├── Run duration > max_duration_hours
    │   → Block with reason "timeout"
    │
    └── None of the above
        → Block with reason "no_matching_transition"
```

Dynamic decisions are recorded as `decision.override_applied` events with full reasoning.

### 2.4 Gate Evaluation

Gates are checkpoints that must pass before a transition can proceed. Gates differ from edge conditions in that they are mandatory — a failed gate blocks the transition even if the edge condition would otherwise match.

| Gate Type | Evaluator | Examples |
| --- | --- | --- |
| Script gate | Script worker | Tests pass, lint clean, build succeeds |
| Quality gate | PM Engine | Readiness score > threshold, scope creep < threshold |
| Human gate | Human worker | Plan approved, code review approved, merge approved |
| Auto gate | Orchestrator | Autonomy level check, counter check |

**Gate evaluation flow:**

```
Phase transition candidate identified
    │
    ▼
Load gates for target phase (from template)
    │
    ▼
For each gate:
    │
    ├── Script gate → Enqueue script task, wait for result
    │   (e.g., run tests, run linter)
    │
    ├── Quality gate → Query PM Engine
    │   (e.g., conductor_validate_spec_readiness, conductor_detect_scope_creep)
    │
    ├── Human gate → Check autonomy level
    │   ├── Level sufficient for auto-approve → Auto-approve
    │   └── Level insufficient → Route to human, wait
    │
    └── Auto gate → Evaluate inline
        (e.g., counter < max, duration < timeout)
    │
    ▼
All gates pass → Proceed with transition
Any gate fails → Handle failure (retry, rework, or block)
```

**Parallel gate evaluation:** Independent gates (e.g., testing + linting) run in parallel. The orchestrator waits for all to complete before proceeding.

---

## 3. Worker Assignment

When a transition results in a new phase that requires work, the orchestrator assigns a task to a worker.

### 3.1 Assignment Algorithm

```
Input:  phase (required_capability, worker_type_preference)
Output: worker_id

1. Load workers with matching capability (from worker_capabilities table)
2. Filter by status: idle OR (active AND current_tasks < max_parallel)
3. Filter by project: worker enabled for this project (project_workers table)
4. Check circuit breaker: if open for this worker_type, skip all of that type
5. If no candidates → task enters 'queued' state, assigned on next availability
6. If candidates exist → rank and assign
```

### 3.2 Ranking

**For script workers:** Deterministic routing. The operation maps to exactly one worker (or a pool of identical workers). No ranking needed — pick any available one.

**For AI workers:** When multiple candidates exist:

```
score = capability_priority_boost * 0.3    -- From worker_capabilities table
      + availability * 0.3                 -- 1 - (current_tasks / max_parallel)
      + success_rate * 0.2                 -- tasks_completed / (completed + failed)
      + area_match * 0.2                   -- PM Engine area expertise (if available)
```

**For human workers:** Route based on role:
- Code review → assigned reviewer (from PR metadata)
- Plan approval → project owner or designated approver
- Security review → security team member
- If no specific assignee, route to the project's default human queue

**For service workers:** Direct routing. The PM Engine is a singleton — always route there.

### 3.3 Assignment Fairness

To prevent one run from monopolizing workers:

1. **Per-run task limit:** A run can have at most 3 active tasks simultaneously.
2. **Priority aging:** Queued tasks gain priority over time (+1 priority per 10 minutes waiting) to prevent starvation.
3. **Round-robin within same priority:** When multiple runs have the same priority, tasks are assigned in FIFO order.

---

## 4. Dynamic Workflow Adaptation

The orchestrator can modify a workflow at runtime. This is the key difference between "templates with adaptation" and either static workflows or fully dynamic ones.

### 4.1 Allowed Modifications

| Modification | Trigger | Example |
| --- | --- | --- |
| **Insert phase** | Intelligence signal or policy | High rework probability → add self-review before human review |
| **Skip phase** | Work item characteristics | Small bug → skip planning phase |
| **Modify limit** | Intelligence or history | Area has high flakiness → increase test retry limit |
| **Add gate** | Policy trigger | Sensitive file detected → add security review gate |
| **Modify timeout** | Run behavior | Worker consistently slow → extend timeout |

### 4.2 Not Allowed

| Action | Reason |
| --- | --- |
| Remove mandatory gates | Human merge gate cannot be removed at any autonomy level |
| Skip completed phases | Cannot rewrite history |
| Modify completed or cancelled runs | Immutable after final state |
| Exceed hard limits | `max_review_rounds` can be increased but cannot exceed a system-wide ceiling (10) |

### 4.3 Modification Flow

```
Signal detected (PM Engine query, policy check, or human request)
    │
    ▼
Create workflow_overrides record with reason and source
    │
    ▼
Emit decision.override_applied event
    │
    ▼
Update in-memory workflow graph for this run
    │
    ▼
Continue transition evaluation with modified graph
```

All modifications are auditable. The `workflow_overrides` table records what changed, why, and who/what triggered it.

---

## 5. Multi-Run Coordination

Epics decompose into multiple child runs that must be coordinated.

### 5.1 Decomposition Flow

```
Epic run enters 'decomposing' phase
    │
    ▼
Orchestrator queries PM Engine: conductor_decompose_work_item({ work_item_id })
    │
    ▼
PM Engine returns subtask list with:
    - Titles, types, acceptance criteria
    - Size estimates
    - Dependency relationships between subtasks
    │
    ▼
Orchestrator creates child work items (via PM Engine)
    │
    ▼
Orchestrator creates child runs, each with:
    - parent_run_id pointing to the epic run
    - Template selected per subtask type
    - Priority inherited from parent (adjustable)
    │
    ▼
Build execution plan:
    - Phase 1: Subtasks with no dependencies (parallel)
    - Phase 2: Subtasks whose Phase 1 dependencies are met
    - Phase N: Remaining subtasks
    │
    ▼
Epic run enters 'coordinating' phase
```

### 5.2 Dependency-Ordered Execution

Child runs are started in dependency order:

```typescript
interface ExecutionPlan {
  parent_run_id: string;
  phases: Array<{
    phase_number: number;
    runs: string[];           // Run IDs that can execute in parallel
    depends_on_phases: number[]; // Previous phases that must complete
  }>;
}
```

The orchestrator starts Phase 1 runs immediately. When all Phase 1 runs complete, Phase 2 starts. And so on.

If a child run fails:
1. Check if the child is on the critical path (other children depend on it).
2. If yes → retry the child. If retry budget exhausted → block the parent.
3. If no → mark as failed, continue with remaining children.
4. Human can override: skip the failed child, retry it, or cancel the epic.

### 5.3 Aggregation

When all child runs complete (or the remaining work is done):

```
Coordinating phase detects: all children in terminal state (completed/cancelled)
    │
    ▼
Aggregate results:
    - Total PRs created
    - Total tests passed/failed
    - Total issues resolved
    - Duration breakdown per child
    │
    ▼
If any children cancelled/failed:
    - Epic marked completed with warnings
    - Summary includes what was skipped and why
    │
    ▼
Record outcome in PM Engine
    │
    ▼
Epic run → completed
```

---

## 6. Failure Handling

### 6.1 Failure Classification

| Source | Detection | Impact | Recovery |
| --- | --- | --- | --- |
| **Worker crash** | Heartbeat timeout (60s) | Task orphaned | Reassign to another worker |
| **Task timeout** | Task exceeds timeout_ms | Phase stuck | Cancel task, create retry task |
| **Task failure (recoverable)** | Worker reports failure | Phase failed | Retry from phase start (up to max_attempts) |
| **Task failure (unrecoverable)** | Worker reports unrecoverable failure | Phase failed permanently | Block run, escalate to human |
| **Queue failure** | Redis connection error | Tasks not delivered | BullMQ auto-reconnect with exponential backoff |
| **PM Engine unavailable** | Tool call timeout/error | Reduced intelligence | Continue with defaults (see OVERVIEW.md § 6) |
| **Orchestrator crash** | Process monitor | All in-flight transitions lost | Recover from database state on restart |

### 6.2 Task Reassignment

When a worker dies:

```
Heartbeat monitor detects: worker heartbeat expired
    │
    ▼
Mark worker as 'dead' in registry
    │
    ▼
Find all tasks with state='running' AND worker_id=dead_worker
    │
    ▼
For each orphaned task:
    │
    ├── Script task (deterministic, idempotent)
    │   → Re-enqueue to the same queue (fresh execution)
    │
    ├── AI task (non-deterministic)
    │   ├── Has checkpoint? → Re-enqueue from checkpoint
    │   └── No checkpoint? → Re-enqueue from phase start
    │
    └── Human task
        → Re-route to another human (or re-notify)
    │
    ▼
Increment task.attempt_number
If attempt_number > max_attempts → block run
```

### 6.3 Circuit Breaker

Prevents cascading failures when a worker type is consistently failing.

```
Worker task fails
    │
    ▼
Increment circuit_breakers.failure_count for that worker_type
    │
    ├── failure_count < threshold → Continue normally
    │
    └── failure_count >= threshold
        │
        ▼
    Open circuit breaker:
        - Set state = 'open'
        - Set opened_at = now()
        - Emit worker.circuit_open event
        - All runs needing this worker_type enter 'blocked'
        │
        ▼
    After cooldown_ms:
        - Set state = 'half_open'
        - Allow ONE test task through
        │
        ├── Test succeeds → Close circuit (reset failure_count)
        └── Test fails → Reopen circuit (reset cooldown)
```

**Circuit breaker thresholds:**

| Worker Type | Threshold | Cooldown |
| --- | --- | --- |
| AI workers | 3 failures in 5 min | 60 seconds |
| Script workers | 5 failures in 5 min | 30 seconds |
| Service workers | 3 failures in 5 min | 120 seconds |

### 6.4 Orchestrator Recovery

If the orchestrator process crashes:

1. On restart, load all runs with `state IN ('active', 'blocked')` from database.
2. For each active run, check if the current task is still being processed:
   - Worker alive and task in progress → resume monitoring
   - Worker dead or task expired → trigger reassignment
3. For each blocked run, re-evaluate block conditions (dependency may have been resolved while orchestrator was down).
4. Resume normal event processing.

This works because all state transitions are persisted to PostgreSQL before being acknowledged. Redis queues are reconstructable from database state.

---

## 7. Rate Limiting and Resource Management

### 7.1 API Rate Limits

| Resource | Limit | Scope | Enforcement |
| --- | --- | --- | --- |
| GitHub API | Per GitHub App rate limit | Global | BullMQ rate limiter |
| AI model API | Token budget per task | Per task | Worker-enforced |
| AI model API | Concurrent requests | Per project | Orchestrator-enforced |
| Script execution | CPU/memory limits | Per worker | OS-level (cgroups/container) |

### 7.2 Token Budget Management

AI workers have per-task token budgets. The orchestrator tracks cumulative token usage per run.

```
Run token budget = sum of all task token budgets for that run
Project token budget = monthly ceiling for all runs in a project
```

When a run approaches its token budget:
1. Warning event emitted at 80% usage.
2. At 100%, the current task is allowed to complete but no new AI tasks are enqueued.
3. The run enters `blocked` with reason `token_budget_exhausted`.
4. Human can increase the budget or cancel the run.

### 7.3 Concurrency Limits

| Limit | Default | Configurable |
| --- | --- | --- |
| Active runs per project | 5 | Yes, per project |
| Active AI tasks globally | 10 | Yes, system-wide |
| Active script tasks globally | 50 | Yes, system-wide |
| Queued tasks per run | 10 | Yes, per template |

---

## 8. Observability

### 8.1 Metrics

| Metric | Type | Labels |
| --- | --- | --- |
| `conductor_runs_active` | Gauge | project, template, state |
| `conductor_runs_total` | Counter | project, template, outcome |
| `conductor_transitions_total` | Counter | project, from_phase, to_phase |
| `conductor_tasks_total` | Counter | operation, worker_type, outcome |
| `conductor_task_duration_seconds` | Histogram | operation, worker_type |
| `conductor_queue_depth` | Gauge | queue_name |
| `conductor_worker_count` | Gauge | worker_type, status |
| `conductor_circuit_breaker_state` | Gauge | worker_type |
| `conductor_pm_engine_latency_seconds` | Histogram | query_type |
| `conductor_pm_engine_available` | Gauge | — |
| `conductor_token_usage` | Counter | project, model |

### 8.2 Tracing

Every run has a `correlation_id`. All BullMQ jobs, task assignments, PM Engine queries, and events carry this ID for end-to-end distributed tracing.

Trace structure:
```
Run (correlation_id)
  └── Phase: planning
      └── Task: planning.create (task_id)
          ├── PM Engine: conductor_suggest_approach
          └── Worker: ai-planner-1
  └── Phase: implementing
      └── Task: implementation.execute (task_id)
          └── Worker: ai-implementer-1
  └── Phase: testing (parallel)
      ├── Task: script.test (task_id) → Worker: script-test-1
      └── Task: script.lint (task_id) → Worker: script-lint-1
  └── Phase: reviewing
      └── Task: review.code (task_id) → Worker: ai-reviewer-1
```

### 8.3 Health Checks

| Endpoint | Checks | Failure Action |
| --- | --- | --- |
| `/health/live` | Process is running | Restart |
| `/health/ready` | DB connected, Redis connected, PM Engine reachable | Remove from load balancer |
| `/health/deep` | All of the above + worker count > 0 + no open circuit breakers | Alert |
