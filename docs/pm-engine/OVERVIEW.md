# Conductor PM Engine Overview

Status: Vision and principles (entry point)
Audience: Product, engineering, AI agent developers, and operators
Updated: 2026-02-19

This document explains what the Conductor PM engine is, why it exists, and the principles that shape its design.

For implementation detail, see:
- `docs/pm-engine/DATA_MODEL.md` — the data layer (SQLite schema, event store, dependency graph)
- `docs/pm-engine/INTELLIGENCE_MODULES.md` — worker role specifications (algorithms, contracts)
- `docs/pm-engine/WORKFLOWS.md` — PM workflow templates (triage, sprint planning, review, etc.)
- `docs/pm-engine/INTERFACES.md` — tool catalog (MCP, A2A, REST API schemas)

## What This Is

Conductor's PM engine is a project management system designed first for AI agents and second for human visualization.

Traditional PM tools were built around human cognitive constraints: limited working memory, periodic meetings, and manually maintained status views. AI agents have different constraints and strengths: they can process large state continuously, but they require explicit, queryable structure, reliable interfaces, and persistent memory across sessions.

Conductor treats project management as an intelligence system, not a board system.

## 1. The Problem with Traditional PM for AI

### GitHub Projects: Useful Collaboration Surface, Weak AI PM Substrate

GitHub Projects works well for human tracking but creates friction when used as the core PM engine for autonomous agents:

- GraphQL-only mutations: Agents must resolve project IDs, field IDs, option IDs, and item IDs through chained queries before basic updates.
- No first-class dependency graph: Relationships are usually implicit in issue text or comments instead of typed edges that can be computed.
- No forecasting layer: There is no native probabilistic schedule modeling, critical path simulation, or confidence-based commitment planning.
- No learning loop: There is no built-in memory model for decisions, outcomes, false positives, and calibration.
- Rate limits: High-frequency multi-agent workflows can exhaust GraphQL budgets quickly.
- Stale reads and eventual consistency: Agents can write state and immediately read outdated results, causing planning drift.

Net effect: an AI spends too much effort negotiating tooling mechanics instead of product reasoning.

### Jira: Powerful but Built for Human Process Administration

Jira can encode almost any workflow, but that flexibility is expensive for agents:

- Complex API and permission model.
- Heavy, organization-specific schema customization.
- Process patterns optimized for human handoffs and ritualized workflows.
- Integration cost that scales with every custom field and transition rule.

Net effect: agents can operate Jira, but at high cognitive and operational overhead.

### Linear: Cleaner API, Still Human-Centric at the Core

Linear is ergonomically better than legacy systems and easier to automate, but the underlying model remains human-first:

- Views and workflow remain list/board-oriented.
- Dependencies are not the central computational object.
- AI-native capabilities are not foundational: self-calibrating review models, persistent decision memory, and probabilistic planning are not the default operating model.

Net effect: better API design does not equal AI-first PM architecture.

### Why PM for AI Is Fundamentally Different from PM for Humans

Human PM systems optimize for communication rituals. AI PM systems must optimize for computable decision quality.

AI-first PM requires:

- Queryable state over manually curated visual state.
- Explicit graph structure over inferred relationships.
- Continuous risk computation over periodic status review.
- Probabilistic forecasting over single-point estimates.
- Persistent memory over session-local context windows.
- Explainable recommendations over opaque ranking.

The core object is not a board card in a column. The core object is decision-ready state computed from events, graph topology, historical outcomes, and current constraints.

## 2. Eight Principles of AI-Optimized PM

### 1) State Is Queryable, Not Visual

Boards, lists, and timelines are projections. The source of truth is queryable state.

Concrete examples:
- Instead of "open the board and pick something," an agent asks: "What is the highest-value unblocked work item that fits current capacity and reduces critical-path risk?"
- Instead of manually updating a sprint column, the system computes readiness from dependency state, review status, and merge health.

Design implication:
- UI is generated from computed state, not manually curated as canonical truth.

### 2) Dependencies Are First-Class

Dependencies are typed graph edges, not comments.

Concrete examples:
- If task A slips by two days, downstream completion probability and sprint confidence are recomputed automatically.
- A work item marked "In Progress" can still be excluded from sprint commitments if its prerequisite edge remains unresolved.

Design implication:
- The dependency graph is a primary storage and query model, not a metadata add-on.

### 3) Memory Replaces Meetings

Human teams use recurring meetings to rebuild context. Agents need durable memory to avoid re-learning.

Concrete examples:
- A design decision is stored with rationale, assumptions, and expected impact.
- Later outcomes (rework rate, defect escapes, delivery delay) are linked back to that decision.
- Future planning queries include memory retrieval: "show prior decisions with similar dependency shape and outcome profile."

Design implication:
- Knowledge persists across sessions, model upgrades, and operator changes.

### 4) Estimation Is Probabilistic

Single-point estimates hide uncertainty. Planning uses distributions.

Concrete examples:
- Sprint planning runs Monte Carlo simulation on historical cycle-time distributions and dependency constraints.
- Output includes P50 and P80 completion windows, probability of meeting target date, and confidence based on data quality.
- Two candidate sprint scopes can be compared by risk-adjusted outcome, not by nominal story points.

Design implication:
- Commitment is framed as accepted probability, not assumed certainty.

### 5) Risk Is Continuous

Risk should emerge from ongoing signals, not only scheduled review checkpoints.

Concrete examples:
- Risk scores update in near real-time from queue age, dependency churn, reopen rate, review finding severity, WIP skew, and blocked-time accumulation.
- A sprint can be flagged as at-risk before deadlines slip, enabling proactive scope adjustment.

Design implication:
- PM shifts from reactive escalation to active prevention.

### 6) Reviews Self-Calibrate

Review quality improves only when findings are measured against outcomes.

Concrete examples:
- Every finding is labeled over time: true positive, false positive, or missed issue.
- Calibration metrics tune severity thresholds and reviewer heuristics by subsystem and change type.
- Repeated false positives in a category down-weight noisy checks; repeated escapes up-weight relevant checks.

Design implication:
- Review is a closed-loop learning system, not a static gate.

### 7) The System Explains Itself

Recommendations must be inspectable and auditable.

Concrete examples:
- A rank decision includes key drivers: dependency unblocking impact, predicted rework risk, value score, and capacity fit.
- A risk alert includes source signals and trend direction, not just a red status indicator.
- A forecast exposes assumptions, sample size, and confidence interval.

Design implication:
- Explainability is required for trust, debugging, and governance.

### 8) Workers Are Protocol-First, Not Intelligence-First

Not every worker in the system needs to be an AI agent. A linter, a test runner, a deployment script, and a Terraform plan are all workers that communicate through the same protocol as an AI planner or implementer.

Concrete examples:
- An ESLint worker receives an A2A task request with a file list, runs the linter, and returns findings in the standard review response format. It has no LLM. It speaks the same protocol.
- A CI worker monitors a GitHub Actions run and emits status events in the same A2A envelope as an AI reviewer would.
- A notification worker watches for risk threshold breaches and sends Slack messages. It consumes the same event stream.

Design implication:
- The A2A message contract is the universal interface. Worker type (AI agent, deterministic script, human-in-the-loop) is a capability attribute, not an architectural distinction.
- Agent Cards declare capabilities (`can_read_codebase`, `can_write_codebase`, `can_execute_commands`) without assuming intelligence. A script worker has fixed capabilities and no LLM dependency.
- The orchestrator routes work based on declared capabilities, not on whether the worker contains an AI model.

## 3. The Product Development Lifecycle (vs Development Execution)

Conductor models the full product lifecycle, not just the coding part. Each phase has defined inputs, outputs, and transition criteria.

### The Six Phases

| Phase | Primary Actor | Input | Output | Transition Trigger |
| --- | --- | --- | --- | --- |
| 1. Discovery | PM Agent or Human | Raw idea, user feedback, incident report | Structured work item with value profile | Work item created with `spec_readiness >= threshold` |
| 2. Triage | PM Agent | New work item | Classified item (type, area, priority, risk, dependencies, similar items) | Triage assessment persisted, item moved to Ready or Backlog |
| 3. Sprint Planning | PM Agent | Ready backlog, capacity model, dependency graph | Iteration plan with committed/stretch/excluded items, Monte Carlo confidence | Iteration activated, items assigned |
| 4. Development | Planner + Implementer workers (AI or script) | Committed work item, approved plan | Tested patchset, PR | Tests pass, implementation complete |
| 5. Review | Reviewer worker (AI or human) | PR, acceptance criteria, plan | Review verdict (approved/changes requested), calibrated findings | Approved or sent to rework |
| 6. Done | PM Agent | Merged PR, closed issue | Recorded outcome, updated predictions, learning memory | Outcome recorded, work item terminal |

Phase transitions are event-driven, not ceremony-driven. The orchestrator advances work through phases based on gate conditions, not meeting schedules. A work item can flow from Discovery to Done in minutes if all gates pass, or it can sit in any phase until its conditions are met.

### Rework Is a First-Class Loop, Not an Exception

When review requests changes, the item returns to Development with the review findings as input. This is not a failure state — it is a predicted, measured, and optimized loop. The rework prediction module estimates how likely this loop is before development starts, allowing the system to add extra review steps for high-risk items.

### Why Most AI Coding Tools Skip Product Phases

Most AI coding systems optimize the middle of the funnel (development execution):

- Input: one ticket or prompt
- Output: one patch, PR, or code review

They usually skip discovery, triage, and planning because those phases require:

- Cross-item reasoning instead of single-task execution.
- Persistent memory and historical outcome linkage.
- Dependency-aware prioritization at portfolio scope.
- Probabilistic forecasting and tradeoff evaluation.

### How the PM Engine Adds the Missing "What to Build" and "When" Intelligence

Conductor adds the missing upstream and orchestration intelligence:

- Discovery: structures ideas into work items with explicit value, constraints, and dependency candidates.
- Triage: classifies and routes work by urgency, impact, confidence, and risk.
- Sprint planning: computes feasible scope using capacity, graph constraints, and completion distributions.
- Development orchestration: continuously reprioritizes when new blockers or signal changes arrive.
- Review intelligence: links findings to outcomes to improve future planning and review quality.
- Done/learning: compares predicted vs actual outcomes to recalibrate models.

Result: the PM engine governs both execution and product direction quality, not just code throughput.

## 4. Comparison: AI-Optimized PM vs Traditional PM

| PM Activity | Traditional PM (Human-Centric) | AI-Optimized PM (Conductor) |
| --- | --- | --- |
| Board views | Primary working surface and implicit source of truth | Optional projection generated from queryable state |
| Priority setting | Manual ranking, periodic stakeholder negotiation | Continuous scoring using value, urgency, risk, and dependency impact |
| Sprint planning | Meeting-driven commitment, often point-based | Constraint-based planning with Monte Carlo confidence windows |
| Estimation | Single-point estimates (points/days) | Probability distributions with P50/P80 forecasts |
| Retrospectives | Periodic discussion and memory reconstruction | Continuous outcome logging with queryable decision-to-outcome links |
| Risk management | Escalated during standups/reviews after symptoms appear | Continuous signal-derived risk scoring with early anomaly alerts |
| Dependency tracking | Informal notes, labels, or hidden tribal knowledge | Typed graph edges with live downstream impact computation |
| Review process | Static checklists and human judgment | Self-calibrating feedback loop using true/false positive and escape data |
| Knowledge management | Docs + human recollection + chat history | Structured persistent memory retrievable by agents and humans |
| Stakeholder communication | Manual status updates and narrative summaries | Automatically synthesized, explainable status with evidence and confidence |

## 5. Architecture: The Decomposed PM Engine

The PM Engine is not a monolithic service. It decomposes into three layers that align with the rest of Conductor's architecture:

```
┌─────────────────────────────────────────────────────┐
│                  PM Workflows                       │
│  (triage, sprint planning, retrospective, review,   │
│   release notes, discovery, anomaly monitoring)     │
│                                                     │
│  Each workflow is a template executed by the        │
│  orchestrator — same engine that runs dev workflows │
└──────────────────────┬──────────────────────────────┘
                       │ orchestrated by
┌──────────────────────┴──────────────────────────────┐
│                  PM Workers                         │
│  (analytics, prediction, memory, calibration,       │
│   capacity modeling, anomaly detection)             │
│                                                     │
│  Each intelligence module is a worker role.         │
│  Can be script, AI, or hybrid. Pluggable.           │
└──────────────────────┬──────────────────────────────┘
                       │ reads/writes
┌──────────────────────┴──────────────────────────────┐
│                  PM Data Layer                       │
│  (SQLite, event store, dependency graph, work items, │
│   decisions, outcomes, sync, projections)            │
│                                                     │
│  Shared infrastructure. Direct API for reads.       │
│  Workers write through the data layer.              │
└─────────────────────────────────────────────────────┘
```

### 5.1 The Data Layer (Shared Infrastructure)

The data layer is the foundation. It owns:

- **Event store** (`pm_events`) — immutable log of all state transitions, decisions, outcomes. Source of truth for replay and analytics.
- **Work item state** (`pm_work_items`, `pm_work_item_ai_current`) — current state of every work item, AI-computed predictions, and ranking fields.
- **Dependency graph** (`pm_dependencies`, `pm_dependency_closure`, `pm_dependency_metrics`) — typed edges with cycle prevention, transitive closure, and critical path data.
- **Decision memory** (`pm_decisions`, `pm_outcomes`, FTS5 indexes) — persistent knowledge base linking decisions to outcomes.
- **Review findings** (`pm_review_findings`) — calibration data for self-improving review quality.
- **Projections** (`pm_cycle_projections`, `pm_velocity_daily`, `pm_risk_snapshots`, etc.) — derived state for fast reads, rebuilt from events.
- **Sync infrastructure** (`pm_sync_cursors`, `pm_sync_inbox`) — GitHub ↔ Conductor synchronization.

The data layer is exposed through direct API calls (MCP tools, REST, A2A). These are pure data queries — no intelligence computation, no multi-step workflows. Fast, deterministic, cacheable.

**Data layer tools** (direct API, always available):
- `conductor_get_board`, `conductor_list_work_items`, `conductor_get_work_item`
- `conductor_update_work_item`, `conductor_transition_work_item_state`
- `conductor_add_dependency`, `conductor_resolve_dependency`, `conductor_get_dependencies`
- `conductor_record_decision`, `conductor_record_outcome`
- `conductor_sync_project_state`
- `conductor_get_velocity`, `conductor_get_cycle_time_analytics`, `conductor_get_dora_metrics`

### 5.2 Worker Roles (Intelligence Modules)

Each intelligence module from `INTELLIGENCE_MODULES.md` is a **worker role specification**. The module defines what computation happens; the worker system defines how and where it runs.

| Intelligence Module | Worker Role | Typical Implementation | Sync/Async |
| --- | --- | --- | --- |
| Cycle Time Analytics | `pm.analytics.cycle_time` | Script (SQL + math) | Async (projection) |
| Velocity Engine | `pm.analytics.velocity` | Script (SQL + math) | Async (projection) |
| Monte Carlo Simulation | `pm.prediction.monte_carlo` | Script (simulation engine) | Sync (on-demand) |
| Rework Prediction | `pm.prediction.rework` | Script + AI hybrid | Sync (per-item) |
| Dependency Graph Analysis | `pm.graph.analysis` | Script (graph algorithms) | Sync (on-demand) |
| Risk Radar | `pm.synthesis.risk_radar` | Script (aggregation) | Async (periodic snapshot) |
| Decision Memory & Learning | `pm.memory.retrieval` | Script + AI hybrid | Sync (on-demand) |
| Review Calibration | `pm.calibration.review` | Script (statistics) | Async (periodic) |
| Capacity Modeling | `pm.capacity.model` | Script (EWMA + expertise) | Async (periodic) |
| Anomaly Detection | `pm.detection.anomaly` | Script (statistical) | Async (continuous) |

**Why this matters:**

- **Script-first**: Most intelligence modules are pure computation (SQL queries, math, graph algorithms). They don't need LLMs. Making them workers means they have the same lifecycle, monitoring, and failure handling as any other worker.
- **Pluggable**: A team could replace the built-in rework prediction (logistic regression) with a custom ML model that speaks the same worker protocol. The orchestrator doesn't care.
- **Async by default**: Analytics and projections run in the background, updating projection tables. Only on-demand queries (Monte Carlo simulation, rework prediction for a specific item) are sync.
- **Composable**: The Risk Radar worker consumes outputs from Velocity, Rework Prediction, Dependency Graph, Capacity, and Anomaly Detection workers. It's a synthesis worker that composes other worker outputs.

### 5.3 Workflow Templates (PM Processes)

Multi-step PM processes are **workflow templates** executed by the same orchestrator that runs development workflows. A triage process, a sprint planning session, a retrospective — these are all directed graphs of stages with transitions, just like a feature development workflow.

PM workflows use the orchestrator's async/sync stage model (see `orchestrator/WORKFLOW_ENGINE.md § 1.3`):
- **Sync stages** block until complete — wait for human approval, wait for simulation to finish.
- **Async stages** run in the background — update projections, send notifications, record analytics.
- **Parallel stages** run multiple workers concurrently — compute capacity + velocity + risk in parallel during sprint planning.

See `WORKFLOWS.md` for the complete PM workflow template catalog.

**Key PM workflows:**

| Workflow | Trigger | Stages | Typical Duration |
| --- | --- | --- | --- |
| Triage | New work item created | classify → assess risk → find similar → route | Seconds (fully automated at L3) |
| Sprint Planning | Iteration start or manual trigger | analyze capacity → rank backlog → simulate → propose plan → approve | Minutes (with human approval gate) |
| Retrospective | Iteration end or manual trigger | gather metrics → identify patterns → synthesize narrative → present | Seconds (automated) to minutes (human discussion) |
| PR Review | PR opened or review requested | analyze changes → check scope → evaluate quality → produce verdict | Seconds to minutes |
| Release Notes | Release tag or manual trigger | gather PRs → classify changes → generate narrative | Seconds |
| Discovery | Raw idea submitted | structure → validate spec → assess value → create work item | Minutes (may need human input) |
| Anomaly Monitoring | Continuous (timer-driven) | compute baselines → detect deviations → corroborate → alert | Continuous background |

### 5.4 How It All Connects

The three layers interact through well-defined interfaces:

```
Human submits idea
    │
    ▼
Orchestrator: start PM workflow "discovery"
    │
    ├── [sync] Worker: pm.triage.classifier — classifies type, area, priority
    │   └── reads: pm_work_items (for similar items), pm_decisions_fts (for context)
    │
    ├── [async] Worker: pm.prediction.rework — predicts rework risk
    │   └── reads: pm_outcomes (historical), pm_review_findings (calibration data)
    │
    ├── [sync] Worker: pm.memory.retrieval — finds relevant past decisions
    │   └── reads: pm_decisions, pm_outcomes, FTS5 indexes
    │
    ├── [sync] Human gate: approve triage assessment
    │
    └── [sync] Data layer: create work item, emit event
```

The orchestrator doesn't know these workers are "PM intelligence." It sees workers with capabilities, assigns them tasks via the standard protocol, and advances the workflow based on their results. The PM Engine is not special — it's workers and data, coordinated by the same orchestrator that coordinates everything else.

This means:
- You can add a custom intelligence module by registering a new worker with the appropriate capability.
- You can replace a built-in module by registering a worker with higher priority for the same capability.
- PM workflows share the same failure handling, retry logic, circuit breakers, and observability as development workflows.
- A PM workflow stage can trigger a development workflow (triage creates a work item → orchestrator starts a feature development run) and vice versa (development run completes → outcome recording PM workflow triggers).

## 6. Design Constraints

Conductor's architecture is shaped by explicit constraints:

- **Local-first**: SQLite-backed data layer with no mandatory cloud dependency. The PM data layer and script workers run entirely locally.
- **Decomposed, not monolithic**: The PM Engine is three layers (data, workers, workflows), not one service. Each layer can be deployed, scaled, and replaced independently.
- **Same orchestrator**: PM workflows use the same orchestrator as development workflows. No separate PM execution engine.
- **Worker protocol**: PM intelligence workers speak the same A2A protocol as all other workers. A PM analytics script worker is architecturally identical to a lint script worker.
- **Dual interface**: MCP endpoint for AI agents, REST API for programmatic access, and web UI for human operators. All interfaces query the same data layer.
- **GitHub as collaboration layer, not PM layer**: Issues/PRs remain collaboration artifacts while PM intelligence is computed in Conductor's data layer.
- **SDK-first agents**: First-class support for Claude Code SDK, Codex SDK, and other AI agent SDKs as PM workers.
- **Self-hosted deployment**: OpenClaw-inspired operational model for teams that require control, data locality, and offline resilience.

These constraints are product decisions, not temporary implementation shortcuts.

## 7. What This Enables

The decomposed architecture enables capabilities that are hard or impossible in monolithic PM systems:

- **Fully autonomous product development loop**: discovery → triage → planning → execution → review → learning. Each phase is a workflow template with pluggable workers.
- **AI PM that improves over time**: Linked outcome memory and calibration workers continuously refine predictions. Swap out the prediction model without touching the workflow.
- **Sprint planning grounded in data**: Monte Carlo simulation workers consume capacity and cycle time worker outputs. The sprint planning workflow orchestrates them with async parallel stages for speed.
- **Continuous risk detection**: Anomaly detection workers run as async background stages, updating risk snapshots without blocking any workflow.
- **Cross-session intelligence**: The data layer persists context across agent runs, tool changes, and handoffs. Any worker can query it.
- **Custom intelligence**: Register a new worker with a PM capability to extend the intelligence layer. No core code changes needed.
- **Mixed sync/async PM operations**: Sprint planning runs capacity + velocity + risk radar workers in parallel (async), then runs Monte Carlo simulation (sync), then presents results to human (sync gate). The orchestrator manages the concurrency.

## 8. Further Reading

| Document | Content |
| --- | --- |
| `DATA_MODEL.md` | The PM data layer — SQLite schema, event store, dependency graph, projections |
| `INTELLIGENCE_MODULES.md` | Worker role specifications — algorithms, contracts, and caching for each intelligence module |
| `WORKFLOWS.md` | PM workflow templates — triage, sprint planning, review, retrospective, and more |
| `INTERFACES.md` | Complete tool catalog — MCP, A2A, and REST API schemas for data layer and worker operations |
| `../orchestrator/OVERVIEW.md` | The orchestrator that executes PM workflows (and dev workflows) |
| `../orchestrator/WORKFLOW_ENGINE.md` | Template system including async/sync stage execution modes |
| `../workers/OVERVIEW.md` | Worker model — roles, providers, configuration |
| `../workers/PROTOCOL.md` | Wire protocol that PM workers (and all workers) speak |

## Closing Perspective

Conductor does not treat AI as an assistant to human PM rituals. It treats PM itself as a computable intelligence problem — decomposed into data, workers, and workflows like everything else in the system.

The PM engine exists to answer, continuously and explainably:

- What should we build next?
- What can we commit to with confidence?
- Where is risk accumulating right now?
- What are we learning from outcomes, and how should that change the next plan?

These answers come from the composition of workers (intelligence modules), orchestrated through workflows (PM processes), grounded in shared data (the event store and dependency graph). The same architecture that runs a feature development workflow runs a sprint planning workflow. The same protocol that a linter speaks is the protocol a Monte Carlo simulator speaks.

That is the foundation for reliable, autonomous, AI-optimized product development.
