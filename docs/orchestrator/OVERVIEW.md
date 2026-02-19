# Conductor Orchestrator

Status: Normative specification
Audience: Engineering, AI agent developers, platform integrators
Updated: 2026-02-19

---

## 1. What the Orchestrator Is

The orchestrator is the hub of Conductor. Everything else — the PM Engine, AI agents, shell scripts, human reviewers, external services — connects through it. The orchestrator never executes work itself. It decides what needs to happen, finds the right worker, assigns the task, monitors progress, and handles failures.

```
                    ┌─────────────────────┐
                    │                     │
    Human ────────► │                     │ ◄──── Webhooks
  Interfaces        │    Orchestrator     │       (GitHub, GitLab, ...)
  (Web UI,          │       (Hub)         │
   OpenClaw,        │                     │ ◄──── MCP Clients
   REST API)        │                     │       (Claude Code, Cursor, ...)
                    └──────────┬──────────┘
                               │
              ┌────────┬───────┼───────┬────────┐
              │        │       │       │        │
              ▼        ▼       ▼       ▼        ▼
           ┌─────┐ ┌─────┐ ┌─────┐ ┌─────┐ ┌─────┐
           │ PM  │ │ AI  │ │Shell│ │Human│ │Svc  │
           │Eng. │ │Agent│ │Scrpt│ │     │ │     │
           └─────┘ └─────┘ └─────┘ └─────┘ └─────┘
           tool     worker  worker  worker  worker
```

The orchestrator has two relationships with the things it coordinates:

1. **Tools** it queries for information (PM Engine, external APIs). The orchestrator calls them and uses their output to make decisions.
2. **Workers** it assigns tasks to (AI agents, scripts, humans, services). The orchestrator sends them work and monitors their progress.

The PM Engine is the most-queried tool, but architecturally it is not special. The orchestrator queries it the same way it queries any other service.

---

## 2. Design Principles

### 2.1 Workers Are Abstract

A "worker" is anything that can accept a task and produce a result. A bash script that runs ESLint. A Claude Code agent that writes an implementation. A human reviewer who approves a PR. A Python script that runs database migrations.

The orchestrator does not care what is inside the worker. It cares about:
- What capabilities does this worker declare?
- Is it available right now?
- Did it succeed or fail?

This means a shell script and an AI agent have the same interface, the same lifecycle, and the same monitoring. There is no "lesser" worker category.

### 2.2 Workflows Are Directed Graphs

Real software work is not linear. A feature might need rework after review. A bug fix might need replanning when the root cause turns out to be different. An epic decomposes into subtasks that run in parallel with dependencies between them.

Workflows in Conductor are directed graphs:
- **Nodes** are phases (planning, implementing, reviewing, testing, deploying)
- **Edges** are transitions with conditions (test passed, review rejected, timeout exceeded)
- **Loops** are first-class (rework cycles are normal, not exceptions)
- **Branches** are conditional (small bugs skip planning, high-risk changes add extra review)

### 2.3 The Orchestrator Delegates, Never Executes

The orchestrator coordinates. It does not:
- Run LLM inference (AI workers do that)
- Execute shell commands (script workers do that)
- Make code changes (implementer workers do that)
- Evaluate policy rules directly (the policy engine does that)
- Talk to humans directly (interfaces do that)

If the orchestrator is doing work, the architecture is wrong. The orchestrator's job is to decide WHAT needs to happen and WHO should do it. The workers decide HOW.

### 2.4 Intelligence Is Advisory

The PM Engine provides predictions, historical context, risk assessments, and recommendations. The orchestrator uses this intelligence to make better decisions — but it is not bound by it.

If the PM Engine predicts high rework probability, the orchestrator might add an extra review step. But the orchestrator can also ignore that prediction if other signals contradict it. The PM Engine advises; the orchestrator decides.

If the PM Engine is unavailable, the orchestrator continues with sensible defaults. Degraded, not broken.

### 2.5 Multiple Interfaces, One Orchestrator

Humans interact with Conductor through multiple interfaces:
- **Web UI** — the primary interface for most users
- **OpenClaw** — an optional self-hosted CLI interface with built-in safety enforcement
- **REST API** — for programmatic access and custom integrations
- **MCP** — for AI coding tools that want to interact with the orchestrator

All interfaces talk to the same orchestrator. There is no interface-specific logic in the orchestrator — interfaces are presentation layers that translate between the human/tool and the orchestrator's task protocol.

### 2.6 Event-Driven, Not Request-Driven

The orchestrator is primarily reactive. Events arrive (webhook received, task completed, timer fired, human approved) and the orchestrator evaluates what should happen next.

This means:
- Every action produces an event
- Events are the source of truth for history
- Transitions happen because events trigger them, not because a scheduler polls for changes
- The event stream is the complete audit trail

### 2.7 Fail Explicit

No silent failures. No swallowed errors. No fallback defaults that hide problems.

When something fails:
- The failure is recorded as an event
- The affected run enters a visible "blocked" or "failed" state
- The orchestrator determines whether to retry, escalate, or stop
- Humans can see what failed and why in the interface

---

## 3. Architecture

### 3.1 Core Components

The orchestrator consists of five internal subsystems:

| Subsystem | Responsibility | Details |
| --- | --- | --- |
| **Event Processor** | Receives and routes events from all sources | Webhooks, worker results, timer events, human actions |
| **Workflow Engine** | Evaluates transitions and advances runs through phases | See `WORKFLOW_ENGINE.md` |
| **Worker Manager** | Tracks worker registry, health, and task assignment | See `WORKER_MODEL.md` (in `DATA_MODEL.md`) |
| **Task Queue** | Distributes tasks to workers with priority and retry | BullMQ-backed |
| **Decision Engine** | Evaluates conditions using context, intelligence, and policy | Combines event data, PM Engine queries, and policy checks |

### 3.2 What the Orchestrator Owns

The orchestrator is the single source of truth for:
- **Run state** — which phase each run is in, what happened, what's next
- **Worker registry** — which workers are registered, their status, their capabilities
- **Task assignments** — which worker is working on which task
- **Workflow templates** — the graph definitions that govern how work flows
- **Queue state** — pending, active, and dead-letter tasks

The orchestrator does NOT own:
- **Work item state** — the PM Engine owns issue/PR lifecycle (Backlog → Ready → Active → Done)
- **Code** — workers produce code, the orchestrator just tracks the artifacts
- **Policy definitions** — stored in the policy engine, the orchestrator queries them
- **Historical intelligence** — the PM Engine owns cycle times, predictions, memory

### 3.3 Separation from PM Engine

This is worth stating explicitly because it is a common source of confusion:

| Concern | Owner |
| --- | --- |
| "What should we work on next?" | PM Engine (suggest_next_issue, plan_sprint) |
| "How should we work on it?" | Orchestrator (workflow template selection, worker assignment) |
| "Is this task making progress?" | Orchestrator (run phase tracking, health monitoring) |
| "How has this type of work gone historically?" | PM Engine (cycle times, rework rates, memory) |
| "Should we add an extra review step?" | Orchestrator (decision engine, using PM Engine intelligence) |
| "What is the project's overall health?" | PM Engine (dashboard, DORA metrics, velocity) |

The PM Engine is a tool the orchestrator queries. The orchestrator is the execution layer that turns PM Engine recommendations into actual work.

---

## 4. Run Lifecycle

A "run" is a single execution of a workflow for a work item. When someone says "work on issue #42", the orchestrator creates a run.

### 4.1 Run States

```
    ┌─────────┐
    │ pending │──── Created, waiting to start
    └────┬────┘
         │ start
         ▼
    ┌─────────┐
    │ active  │──── A worker is executing the current phase
    └────┬────┘
         │
    ┌────┴──────────────────┐
    │                       │
    ▼                       ▼
┌─────────┐          ┌──────────┐
│completed│          │  blocked │──── Waiting for dependency, human, or retry
└─────────┘          └────┬─────┘
                          │ unblock
                          ▼
                     ┌─────────┐
                     │ active  │
                     └─────────┘

    (from any state)
         │ cancel
         ▼
    ┌──────────┐
    │cancelled │
    └──────────┘
```

A run is `active` when a worker is processing a task for it. A run is `blocked` when it is waiting for something — a dependency, a human approval, a retry cooldown, a circuit breaker to close.

### 4.2 Phases vs States

Run **state** is the orchestrator's view: pending, active, blocked, completed, cancelled.

Run **phase** is the workflow position: planning, implementing, testing, reviewing, etc. Phases are defined by the workflow template and vary by work item type.

A run can be `active` in the `reviewing` phase, or `blocked` in the `implementing` phase (waiting for a dependency).

### 4.3 Phase Transitions

When a worker completes a task:
1. The orchestrator receives the task result (success, failure, needs-input).
2. The Decision Engine evaluates the workflow edges from the current phase.
3. The first matching edge determines the next phase.
4. If the next phase requires a different worker, the orchestrator assigns a new task.
5. If no edge matches, the run enters `blocked` and surfaces for human attention.

This is the core loop. Everything else — workflow templates, worker selection, intelligence queries — serves this loop.

---

## 5. Worker Categories

Conductor has four categories of workers. They all share the same task interface, but their characteristics differ:

### 5.1 Script Workers

**The backbone of automation.** Most workflow steps are scripts, not AI agents.

| Property | Value |
| --- | --- |
| LLM required | No |
| Deterministic | Yes (same input → same output) |
| Latency | Fast (seconds) |
| Cost | Minimal (compute only) |
| Parallelism | High (many can run concurrently) |
| Examples | ESLint, Prettier, test runners, build scripts, deploy scripts, database migrations, notification senders, metrics collectors, file validators |

Script workers are the most common worker type. A typical workflow might have 8 script steps for every 1 AI step. They are fast, cheap, and deterministic — the ideal worker for anything that doesn't require reasoning.

### 5.2 AI Workers

**For tasks that require reasoning, creativity, or natural language understanding.**

| Property | Value |
| --- | --- |
| LLM required | Yes |
| Deterministic | No |
| Latency | Slow (seconds to minutes) |
| Cost | Significant (token-based) |
| Parallelism | Limited by API rate limits and budget |
| Examples | Planner, implementer, code reviewer, researcher, documentation writer |

AI workers are powerful but expensive. Use them where scripts can't do the job — understanding requirements, writing code, reviewing logic, producing research.

### 5.3 Service Workers

**Long-running processes that accept tasks continuously.**

| Property | Value |
| --- | --- |
| LLM required | Varies |
| Deterministic | Varies |
| Latency | Varies |
| Cost | Fixed (always running) |
| Parallelism | Service-defined |
| Examples | PM Engine (singleton), CI/CD service, monitoring service, notification hub |

The PM Engine is the primary service worker. It is always available, stateful (backed by SQLite), and provides the intelligence layer. Other services (CI/CD, monitoring) may also register as service workers.

### 5.4 Human Workers

**For decisions and approvals that require human judgment.**

| Property | Value |
| --- | --- |
| LLM required | No (the human IS the intelligence) |
| Deterministic | No |
| Latency | High (minutes to hours) |
| Cost | Highest (human attention) |
| Parallelism | Limited (humans context-switch poorly) |
| Examples | Code reviewer, product owner, security auditor, release approver |

Human workers receive tasks through the interface (Web UI notification, OpenClaw message, email, Slack). They respond through the same interface. The orchestrator treats human responses identically to AI or script responses.

### 5.5 Unified Worker Interface

All four categories share the same protocol:

```
Orchestrator → Worker:  task_request  { operation, input, constraints }
Worker → Orchestrator:  task_progress { percent, message }     (optional, streaming)
Worker → Orchestrator:  task_result   { state, output, artifacts }
```

The orchestrator doesn't know or care whether the worker is a bash script, a Claude agent, a human, or a microservice. The protocol is identical.

---

## 6. Intelligence Integration

The orchestrator queries the PM Engine at defined decision points:

| Decision Point | PM Engine Query | How It's Used |
| --- | --- | --- |
| Run start | `predict_rework`, `suggest_approach`, `get_issue_dependencies` | Template modification, blocker detection, context injection |
| Template selection | `triage_issue` | Work item type and scope estimation |
| Worker assignment | `get_team_capacity`, `get_history_insights` | Area expertise matching, hotspot awareness |
| Gate evaluation | `check_readiness`, `detect_scope_creep` | Auto-approve decisions, scope drift detection |
| Run completion | `record_outcome`, `record_decision` | Memory for future intelligence |
| Failure triage | `explain_delay`, `predict_completion` | Root cause context, revised estimates |

These are NOT continuous queries. They happen at specific moments in the workflow to avoid excessive overhead. Between decision points, the orchestrator operates on the information it already has.

When the PM Engine is unavailable, the orchestrator uses sensible defaults:
- Rework prediction unavailable → assume moderate risk, proceed normally
- Approach suggestion unavailable → let the worker figure it out
- Scope creep detection unavailable → proceed to review without scope check
- Record outcome unavailable → queue for later delivery when PM Engine recovers
- Decompose unavailable → block epic runs (cannot decompose without intelligence)

---

## 7. Autonomy Levels

The orchestrator supports configurable autonomy levels that control how much human involvement is required:

| Level | Name | Human Role | Auto-Approved |
| --- | --- | --- | --- |
| L0 | Full oversight | Approves every step | Nothing |
| L1 | Plan approval | Approves plans, reviews results | Script execution, tests |
| L2 | Result review | Reviews outcomes, intervenes on risk | Plans (if quality score > threshold), script execution |
| L3 | Exception-based | Only intervenes on failures or policy violations | Everything except merge and policy-flagged changes |

Autonomy level is set per-project and can be overridden per-run. The orchestrator enforces it at every gate by checking whether the current action requires human approval at the configured level.

Higher autonomy means faster execution but less human control. The right level depends on the team's trust in the system and the risk tolerance of the project.

---

## 8. Further Reading

| Document | Content |
| --- | --- |
| `DATA_MODEL.md` | Storage schema — runs, tasks, workers, workflow templates, events |
| `WORKFLOW_ENGINE.md` | Template system, transition evaluation, decision logic, dynamic adaptation |
| `INTERFACES.md` | Human interfaces (Web UI, OpenClaw, API), worker protocols, notification channels |
| `../pm-engine/OVERVIEW.md` | PM Engine — the intelligence layer the orchestrator queries |
| `../pm-engine/INTERFACES.md` | PM Engine tool catalog — the specific queries available |
