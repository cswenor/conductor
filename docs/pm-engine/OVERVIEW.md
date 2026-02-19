# Conductor PM Engine Overview

Status: Vision and principles (entry point)
Audience: Product, engineering, AI agent developers, and operators
Updated: 2026-02-19

This document explains what the Conductor PM engine is, why it exists, and the principles that shape its design.

For implementation detail, see:
- `docs/pm-engine/DATA_MODEL.md`
- `docs/pm-engine/INTELLIGENCE_MODULES.md`
- `docs/pm-engine/INTERFACES.md`

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

## 2. Seven Principles of AI-Optimized PM

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

## 3. The Product Development Lifecycle (vs Development Execution)

Conductor models the full product lifecycle:

1. Product Discovery
2. Triage
3. Sprint Planning
4. Development
5. Review
6. Done

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

## 5. The Intelligence Stack

The PM engine is layered so each level enables the next.

### Foundation: Event Stream + Dependency Graph

- Immutable event log for issue, PR, review, and state transitions.
- Typed dependency graph capturing blockers, prerequisites, and related work.
- Deterministic state reconstruction from events + graph.

### Analytics: Cycle Times, Velocity, and DORA

- Cycle time decomposition (queued, active, review, blocked).
- Throughput and velocity trends with segment filters.
- Delivery quality and reliability indicators, including DORA-aligned metrics.

### Prediction: Monte Carlo + Rework Prediction

- Monte Carlo schedule simulation from historical distributions and active constraints.
- Date-confidence estimates for backlog slices and sprint scopes.
- Rework likelihood prediction from change characteristics and historical outcomes.

### Memory: Decision + Outcome Tracking

- Decisions captured with rationale, assumptions, and context.
- Outcomes linked back to original decisions and forecasts.
- Retrieval by similarity for planning, review, and triage augmentation.

### Synthesis: Risk Radar, Sprint Planning, Anomaly Detection

- Risk radar combining analytics, prediction, and live graph state.
- Sprint planner producing ranked, feasible scope options with confidence levels.
- Anomaly detection for drift (unexpected queue growth, review noise spikes, dependency churn).

Each layer is useful independently, but the full value comes from composition.

## 6. Design Constraints

Conductor's architecture is shaped by explicit constraints:

- Local-first: SQLite-backed operation with no mandatory cloud dependency.
- Dual interface: MCP endpoint for AI agents and web UI for human operators.
- GitHub as collaboration layer, not PM layer: issues/PRs remain collaboration artifacts while PM intelligence is computed in Conductor.
- SDK-first agents: first-class support for Claude Code SDK and Codex SDK integration patterns.
- Self-hosted deployment: OpenClaw-inspired operational model for teams that require control, data locality, and offline resilience.

These constraints are product decisions, not temporary implementation shortcuts.

## 7. What This Enables

This architecture enables capabilities that are hard or impossible in human-first PM systems:

- Fully autonomous product development loop:
  discovery -> triage -> planning -> execution -> review -> learning.
- AI PM that improves over time through linked outcome memory and calibration.
- Sprint planning grounded in observed distributions and graph constraints, not gut feeling.
- Continuous risk detection that surfaces emerging failure modes before cascade.
- Cross-session intelligence that preserves context across agent runs, tool changes, and handoffs.

## Closing Perspective

Conductor does not treat AI as an assistant to human PM rituals. It treats PM itself as a computable intelligence problem.

The PM engine exists to answer, continuously and explainably:

- What should we build next?
- What can we commit to with confidence?
- Where is risk accumulating right now?
- What are we learning from outcomes, and how should that change the next plan?

That is the foundation for reliable, autonomous, AI-optimized product development.
