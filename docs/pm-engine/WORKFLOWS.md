# Conductor PM Engine Workflows

Status: Normative specification
Audience: Engineering, AI agent developers, platform integrators
Updated: 2026-02-19

---

## 1. What PM Workflows Are

PM processes are not code — they are workflow templates, executed by the same orchestrator that runs development workflows. A triage process is a directed graph of stages, just like a feature development workflow. A sprint planning session is a series of sync and async stages with worker assignments and gates.

This document defines the PM workflow templates that Conductor ships with. Projects can customize them or create new ones, just like development workflow templates.

### Design Principles

1. **Same engine**: PM workflows run on the orchestrator's workflow engine (`orchestrator/WORKFLOW_ENGINE.md`). No separate PM execution layer.
2. **Sync + async**: Each stage has an execution mode. Computations that don't gate the next step run async. Human decisions and on-demand queries run sync. Parallel stages run multiple workers concurrently.
3. **Workers, not functions**: Each stage assigns work to a PM worker role. The worker could be a script, an AI agent, or a hybrid. The workflow doesn't care.
4. **Composable**: PM workflows can trigger development workflows (triage → start a run) and development workflows can trigger PM workflows (run completes → record outcome).
5. **Degradation**: When a PM worker is unavailable, the workflow uses defaults or blocks for human input — never silently fails.

### Stage Execution Modes Reference

| Mode | Symbol in diagrams | Behavior |
| --- | --- | --- |
| sync | `[S]` | Blocks until complete. Result feeds into edge conditions. |
| async | `[A]` | Fire-and-forget or monitored. Does not block. |
| parallel | `[P]` | Multiple stages start simultaneously. Join rule determines when the group resolves. |

---

## 2. Triage Workflow

**Trigger:** New work item created (via webhook, API, or manual entry).
**Duration:** Seconds (fully automated at autonomy L2+) to minutes (human gate at L0-L1).
**Purpose:** Classify, assess, and route a new work item.

```
work_item.created event
    │
    ▼
[P] parallel: classify + find_similar + predict
    ├── [S] classify         (pm.triage.classifier)
    ├── [S] find_similar     (pm.memory.retrieval)
    └── [A] predict_rework   (pm.prediction.rework)
    │
    │ join=all
    ▼
[S] assess_risk              (pm.synthesis.risk_assessor)
    │
    ▼
[S] route                    (orchestrator decision engine)
    │
    ├── spec_readiness >= threshold → move to Ready
    ├── spec_readiness < threshold → leave in Backlog, flag for refinement
    └── duplicate detected → link to existing, prompt for merge/close
    │
    ▼
[A] notify_stakeholders      (notification worker, fire-and-forget)
[A] update_projections       (pm.analytics.velocity, fire-and-forget)
```

### Stage Details

| Stage | Worker Role | Input | Output | Mode |
| --- | --- | --- | --- | --- |
| classify | `pm.triage.classifier` | Work item title, body, labels | `{ item_type, area, subarea, priority_band, confidence }` | sync |
| find_similar | `pm.memory.retrieval` | Work item title, body keywords | `{ similar_items[], max_similarity }` | sync |
| predict_rework | `pm.prediction.rework` | Work item features | `{ rework_probability, risk_level, signals[] }` | async (monitored) |
| assess_risk | `pm.synthesis.risk_assessor` | classify + similar + rework outputs | `{ risk_level, spec_readiness, value_score }` | sync |
| route | Orchestrator | assessment | State transition decision | sync |
| notify_stakeholders | Notification worker | routing decision | Slack/email/webhook | async (fire-and-forget) |
| update_projections | `pm.analytics.velocity` | completion event | Updated velocity projections | async (fire-and-forget) |

### Autonomy Behavior

| Autonomy Level | Gate | Behavior |
| --- | --- | --- |
| L0 | After route | Human must confirm triage classification |
| L1 | After route | Human reviews if confidence < 0.7, otherwise auto-route |
| L2-L3 | None | Fully automated triage |

---

## 3. Sprint Planning Workflow

**Trigger:** Iteration start, manual trigger, or scheduled timer.
**Duration:** Minutes to hours (depends on human involvement).
**Purpose:** Produce a feasible iteration plan with ranked, dependency-ordered work items and confidence intervals.

```
iteration.planning_started event
    │
    ▼
[P] parallel: gather_intelligence
    ├── [S] analyze_capacity     (pm.capacity.model)
    ├── [S] compute_velocity     (pm.analytics.velocity)
    ├── [S] analyze_dependencies (pm.graph.analysis)
    └── [S] compute_risk_radar   (pm.synthesis.risk_radar)
    │
    │ join=all
    ▼
[S] rank_backlog                 (pm.planning.ranker)
    │
    ▼
[S] simulate_scenarios           (pm.prediction.monte_carlo)
    │
    ▼
[S] propose_plan                 (pm.planning.proposer)
    │
    ▼
[S] human_approval               (human gate)
    │
    ├── approved → activate iteration
    └── rejected → refine plan (loop back to rank_backlog)
    │
    ▼
[A] notify_team                  (notification worker)
[A] record_plan_decision         (pm.memory.recorder)
```

### Stage Details

| Stage | Worker Role | Input | Output | Mode |
| --- | --- | --- | --- | --- |
| analyze_capacity | `pm.capacity.model` | Contributor history, iteration length | `{ contributor_forecasts[], bus_factor, availability }` | sync (parallel) |
| compute_velocity | `pm.analytics.velocity` | Historical completions | `{ throughput_7d, throughput_30d, trend }` | sync (parallel) |
| analyze_dependencies | `pm.graph.analysis` | Dependency graph | `{ critical_path, bottlenecks[], execution_order }` | sync (parallel) |
| compute_risk_radar | `pm.synthesis.risk_radar` | All module outputs | `{ overall_risk, dimensions[] }` | sync (parallel) |
| rank_backlog | `pm.planning.ranker` | Ready items, capacity, velocity, risk, dependencies | `{ ranked_items[], committed[], stretch[], excluded[] }` | sync |
| simulate_scenarios | `pm.prediction.monte_carlo` | Ranked items, cycle time distributions, dependency graph | `{ throughput_p50/p80/p90, backlog_completion_dates, wip_scenarios[] }` | sync |
| propose_plan | `pm.planning.proposer` | Ranked items + simulation results | `{ iteration_plan with confidence intervals }` | sync |
| human_approval | Human worker | Proposed plan | approve/reject | sync (gate) |
| notify_team | Notification worker | Approved plan | Slack/email | async (fire-and-forget) |
| record_plan_decision | `pm.memory.recorder` | Plan rationale | Decision record | async (fire-and-forget) |

### Why Gather Intelligence in Parallel

The four gather_intelligence stages are independent — capacity analysis doesn't need velocity results, and dependency analysis doesn't need risk radar output. Running them in parallel (with `join=all`) reduces sprint planning time from sequential `sum(latencies)` to `max(latencies)`.

The downstream stages (rank, simulate, propose) ARE sequential because each depends on the previous output.

---

## 4. Discovery Workflow

**Trigger:** Raw idea submitted (via interface, webhook, or agent).
**Duration:** Minutes (may involve human input for ambiguous ideas).
**Purpose:** Transform an unstructured idea into a well-specified work item.

```
idea.submitted event
    │
    ▼
[S] structure_idea               (pm.discovery.structurer — AI worker)
    │
    ▼
[S] validate_spec                (pm.discovery.validator)
    │
    ├── spec_readiness >= threshold
    │   │
    │   ▼
    │   [P] parallel: enrich
    │   ├── [S] assess_value         (pm.valuation.assessor)
    │   └── [A] find_related         (pm.memory.retrieval)
    │   │
    │   │ join=all
    │   ▼
    │   [S] create_work_item         (data layer mutation)
    │   │
    │   ▼
    │   [S] triage                   (→ triggers Triage Workflow)
    │
    └── spec_readiness < threshold
        │
        ▼
        [S] request_clarification    (human gate — ask for missing info)
        │
        └── loop back to structure_idea with new input
```

### Autonomy Behavior

| Level | Behavior |
| --- | --- |
| L0-L1 | Human reviews structured output before creation |
| L2 | Auto-create if spec_readiness > 0.8, otherwise human review |
| L3 | Fully automated — create and triage without human involvement |

---

## 5. PR Review Workflow

**Trigger:** PR opened, review requested, or manual trigger.
**Duration:** Seconds to minutes.
**Purpose:** Analyze code changes against acceptance criteria, produce calibrated findings.

```
review.requested event
    │
    ▼
[P] parallel: analyze
    ├── [S] analyze_changes      (pm.review.analyzer)
    ├── [S] check_scope          (pm.review.scope_checker)
    └── [A] check_calibration    (pm.calibration.review — monitored)
    │
    │ join=all (sync stages), calibration data available at verdict
    ▼
[S] evaluate_quality             (pm.review.evaluator — AI worker)
    │
    ▼
[S] produce_verdict              (pm.review.verdict)
    │
    ├── approved → emit review.approved event
    ├── changes_requested → emit review.changes_requested event
    └── needs_discussion → route to human reviewer
    │
    ▼
[A] update_calibration           (pm.calibration.review, fire-and-forget)
[A] record_findings              (data layer mutation, fire-and-forget)
```

### Scope Check

The scope checker (`pm.review.scope_checker`) compares the PR's changed files against the work item's planned file set (from the plan artifact). It uses `conductor_detect_scope_creep` intelligence to flag out-of-scope changes. This prevents scope mixing — one of the most common sources of review rounds and rework.

### Calibration Integration

`check_calibration` runs as a monitored async stage. Its output (historical hit rates per finding type, false positive patterns) is available at the `produce_verdict` stage but doesn't block the analysis stages. This means:
- If calibration is slow, analysis and evaluation proceed without it.
- If calibration is available, the verdict uses historical accuracy to adjust finding severity thresholds.
- If calibration is unavailable (new project, no history), default severity thresholds apply.

---

## 6. Retrospective Workflow

**Trigger:** Iteration end or manual trigger.
**Duration:** Seconds (automated analysis) + optional minutes (human discussion).
**Purpose:** Generate data-driven retrospective narrative from iteration metrics.

```
iteration.ended event
    │
    ▼
[P] parallel: gather_metrics
    ├── [S] cycle_time_analysis   (pm.analytics.cycle_time)
    ├── [S] velocity_analysis     (pm.analytics.velocity)
    ├── [S] rework_analysis       (pm.calibration.review + pm.prediction.rework)
    ├── [S] dependency_analysis   (pm.graph.analysis)
    └── [S] capacity_analysis     (pm.capacity.model)
    │
    │ join=all
    ▼
[S] identify_patterns            (pm.synthesis.pattern_miner)
    │
    ▼
[S] generate_narrative           (pm.reporting.retrospective — AI worker)
    │
    ▼
[S] present_to_team              (human interaction — optional at L2+)
    │
    ▼
[A] record_lessons               (pm.memory.recorder)
[A] update_risk_snapshots        (pm.synthesis.risk_radar)
```

### Why Narrative Generation Needs AI

Pattern identification is script work (SQL queries, statistics). But producing a coherent retrospective narrative that explains WHY patterns occurred and WHAT to do about them requires reasoning. This is one of the few PM stages where an AI worker is clearly better than a script.

The generated narrative includes:
- **What went well** — grounded in velocity/cycle time improvements, not vibes
- **What could improve** — grounded in rework rates, bottleneck states, blocked time
- **Action items** — specific, derived from the data, with priority

---

## 7. Release Notes Workflow

**Trigger:** Release tag, manual trigger, or scheduled.
**Duration:** Seconds.
**Purpose:** Generate structured release notes from merged PRs and closed issues.

```
release.tagged event
    │
    ▼
[S] gather_changes               (data layer query — PRs merged since last release)
    │
    ▼
[S] classify_changes             (pm.triage.classifier — reuse triage worker)
    │
    ▼
[S] generate_notes               (pm.reporting.release_notes — AI worker)
    │
    ▼
[A] publish_notes                (notification worker)
```

This is a short, mostly-sequential workflow. The classification stage reuses the same triage classifier worker that handles new work items — one worker role, multiple workflows. The generate_notes stage needs AI to produce stakeholder-friendly summaries from technical PR descriptions.

---

## 8. Outcome Recording Workflow

**Trigger:** Work item reaches terminal state (done/cancelled), PR merged/closed, or manual.
**Duration:** Seconds.
**Purpose:** Close the feedback loop — link outcomes to predictions, decisions, and plans.

```
work_item.completed event
    │
    ▼
[P] parallel: record
    ├── [A] record_outcome         (data layer mutation)
    ├── [A] update_predictions     (pm.prediction.rework — recalibrate)
    ├── [A] update_velocity        (pm.analytics.velocity — recompute)
    └── [A] check_decision_decay   (pm.memory.decay_checker)
    │
    │ join=all (all async, but group monitored)
    ▼
[A] link_outcome_to_decision     (pm.memory.linker)
```

Note: This workflow is entirely async. Every stage runs in the background. No human gates, no blocking. The outcome recording workflow is triggered by events and runs without blocking the development workflow that produced the event.

This is the **learning loop** — the workflow that makes every other PM workflow better over time. Outcomes update rework predictions (Module 4), velocity projections (Module 2), and decision memory (Module 7).

---

## 9. Anomaly Monitoring Workflow

**Trigger:** Timer (runs periodically — default every 15 minutes).
**Duration:** Continuous background.
**Purpose:** Detect unusual patterns and surface early warnings.

```
timer.anomaly_check event
    │
    ▼
[P] parallel: compute_signals
    ├── [A] velocity_signal          (pm.analytics.velocity)
    ├── [A] backlog_signal           (data layer query)
    ├── [A] rework_signal            (pm.prediction.rework — aggregate)
    ├── [A] wip_signal               (data layer query)
    └── [A] dependency_signal        (pm.graph.analysis)
    │
    │ join=all
    ▼
[S] detect_anomalies                 (pm.detection.anomaly)
    │
    ├── anomalies found
    │   │
    │   ▼
    │   [S] corroborate              (pm.detection.anomaly — cross-check)
    │   │
    │   ├── corroborated → [A] alert (notification worker)
    │   └── not corroborated → suppress (cooldown)
    │
    └── no anomalies → done (wait for next timer)
```

### Why This Is Mostly Async

The signal computation stages read from projection tables (pre-computed by other workers). They're fast and independent — no reason to run them sequentially. The detection and corroboration stages ARE sync because the corroboration decision depends on the detection output.

The entire workflow runs on a timer, not on events. This is intentional — anomaly detection is a polling operation, not a reactive one. Events update projections; the anomaly workflow reads projections.

---

## 10. Spec Validation Workflow

**Trigger:** Work item updated, or manual trigger before moving to Ready.
**Duration:** Seconds.
**Purpose:** Assess whether a work item's specification is complete enough for development.

```
work_item.updated event (or manual)
    │
    ▼
[S] validate_spec                (pm.discovery.validator)
    │
    ├── readiness >= threshold
    │   └── [A] update_ai_fields (data layer — update spec_readiness)
    │
    └── readiness < threshold
        ├── [S] identify_gaps    (pm.discovery.validator — detailed mode)
        ├── [A] update_ai_fields (data layer — update spec_readiness)
        └── [A] notify_owner     (notification worker)
```

---

## 11. Connecting PM Workflows to Development Workflows

PM workflows and development workflows are not isolated. They trigger each other through events.

### PM → Development

| PM Event | Development Workflow Triggered |
| --- | --- |
| Triage routes work item to Ready | Sprint planning considers it for next iteration |
| Sprint planning commits work item | Orchestrator can auto-start a development run |
| Discovery creates work item | Triage workflow triggers, then same as above |

### Development → PM

| Development Event | PM Workflow Triggered |
| --- | --- |
| Run completes (success) | Outcome Recording workflow |
| PR opened | PR Review workflow (if configured for auto-review) |
| Run blocked | Anomaly monitoring may detect bottleneck pattern |
| Review requests changes | Outcome Recording updates rework predictions |

### Cross-Workflow Data Flow

```
                Development                      PM
                Workflows                    Workflows
                    │                            │
                    │  run.completed ──────────►  │ Outcome Recording
                    │                            │
                    │  ◄──────── velocity update  │
                    │  (async, background)        │
                    │                            │
                    │  pr.opened ──────────────►  │ PR Review
                    │                            │
                    │  ◄──── review.findings      │
                    │  (feeds into dev rework)    │
                    │                            │
                    │  work_item.created ──────►  │ Triage
                    │                            │
                    │  ◄──── risk_assessment      │
                    │  (orchestrator uses for     │
                    │   template selection)       │
```

This bidirectional flow means PM intelligence continuously informs development decisions, and development outcomes continuously improve PM intelligence. The orchestrator is the hub that routes events between them.

---

## 12. Custom PM Workflows

Projects can define custom PM workflows, just like custom development workflow templates. Common customizations:

- **Add a compliance check** after triage for regulated industries
- **Add a stakeholder approval gate** in sprint planning for multi-team projects
- **Add a cost estimation stage** in triage for projects with budget constraints
- **Replace the AI narrative generator** in retrospectives with a different model or a manual template
- **Add a deployment verification stage** in outcome recording that checks production health after merge

Custom PM workflows are stored in the database alongside development workflow templates. They use the same template schema, the same transition evaluation engine, and the same worker assignment system.
