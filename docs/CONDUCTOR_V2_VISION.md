# Conductor v2: AI-Native Product Development Platform

> **Date:** 2026-02-19
> **Status:** Design Document — Captures strategic direction, lessons learned from claude-pm-toolkit, and architectural decisions for Conductor v2.
> **Context:** This document synthesizes lessons from building 52 PM Intelligence MCP tools in claude-pm-toolkit, research into OpenClaw's self-hosted model, and the emerging A2A/MCP/AG-UI protocol stack.

---

## Executive Summary

Conductor v1 is a development execution engine: issue in, PR out. Conductor v2 becomes a **full product development platform** — from idea to shipped code — that is equally operable by humans through a web UI and by AI agents through MCP/A2A interfaces.

Three strategic shifts:

1. **Self-hosted, OpenClaw-style** — Local-first daemon, your data stays on your machine, no cloud dependency beyond LLM API keys
2. **Own the PM layer** — Replace GitHub Projects with AI-optimized project management built on local SQLite, dependency graphs, Monte Carlo forecasting, and persistent learning
3. **Dual interface** — Every capability accessible through both the human web UI and an MCP server for AI autonomous operation

---

## Why Pull Away from GitHub Project Management

### The Problem with GitHub Projects for AI

GitHub Projects v2 is designed for humans clicking through a web UI. For AI agents, it's hostile:

| Problem | Impact |
|---------|--------|
| **GraphQL-only field mutations** | Every field update requires discovering field IDs, option IDs, and item IDs through 3-4 chained GraphQL queries |
| **No dependency graph** | GitHub has no native issue dependency tracking — just text references like "blocked by #42" |
| **No forecasting** | No cycle time data, no velocity metrics, no completion predictions |
| **No persistent learning** | Every session starts from zero — no memory of what approaches worked, what caused rework |
| **Rate limits** | 5000 points/hour GraphQL budget burns fast when syncing project state |
| **Stale reads** | Project field values are eventually consistent — reads after writes can return old data |
| **No bulk operations** | Moving 10 issues requires 10 separate GraphQL mutations |
| **Schema fragility** | Field IDs change when projects are recreated; option IDs are opaque UUIDs |

### What We Built Instead (claude-pm-toolkit)

In claude-pm-toolkit, we replaced GitHub Projects with **local-first SQLite** and built 52 MCP tools that give AI agents superpowers:

**Board & Workflow (8 tools):**
- `get_board_summary` — Instant board snapshot with health score
- `get_issue_status` — Current state, priority, labels, assignees
- `move_issue` — State transitions with WIP limit enforcement
- `sync_from_github` — Pull latest from GitHub into local DB
- `add_dependency` / `get_issue_dependencies` — First-class dependency tracking with cycle detection
- `bulk_move` / `bulk_triage` — Batch operations

**Analytics & Intelligence (12 tools):**
- `get_velocity` — 7-day and 30-day velocity windows
- `get_cycle_times` — Active-to-Done duration per issue
- `get_sprint_analytics` — Cycle time percentiles, bottleneck detection, flow efficiency
- `get_dora_metrics` — Deployment frequency, lead time, change failure rate, MTTR
- `get_history_insights` — Git hotspots, file coupling, commit patterns
- `get_workflow_health` — Cross-issue health scores, stale detection
- `get_knowledge_risk` — Bus factor analysis, knowledge decay
- `get_team_capacity` — Contributor profiles, throughput forecasting
- `get_context_efficiency` — AI context waste measurement per issue
- `detect_patterns` — Cross-cutting anomaly detection and early warnings
- `get_review_calibration` — Review finding hit rates and false positive tracking
- `check_decision_decay` — Detect stale architectural decisions

**Prediction & Simulation (5 tools):**
- `predict_completion` — P50/P80/P95 completion dates using historical data
- `predict_rework` — Probability of rework before approval
- `simulate_sprint` — Monte Carlo throughput simulation (10K trials)
- `forecast_backlog` — "When will these N items be done?"
- `simulate_dependency_change` — "What if issue X slips by N days?"

**Memory & Learning (4 tools):**
- `record_decision` — Persist architectural/approach decisions to JSONL
- `record_outcome` — Record what happened (merged, rework, reverted, abandoned)
- `get_memory_insights` — Analyze patterns across all recorded decisions and outcomes
- `suggest_approach` — Query past decisions and lessons for new work in a specific area

**Triage & Planning (8 tools):**
- `conductor_triage_work_item` — One-call complete issue intelligence (tier, type, area, priority, size, risk, rework probability, similar past work)
- `auto_label` — AI classification from issue content analysis
- `decompose_issue` — Break large issues into dependency-ordered subtasks
- `plan_sprint` — AI-powered sprint planning combining dependency graph + capacity + Monte Carlo
- `suggest_next_issue` — Recommend best issue to work on next
- `optimize_session` — Context-aware session planning for maximum impact
- `detect_scope_creep` — Compare implementation to plan, flag drift
- `check_readiness` — Pre-review validation score

**Operations & Reporting (8 tools):**
- `generate_standup` — Auto-generated daily standup from activity
- `generate_retro` — Data-driven sprint retrospective
- `generate_release_notes` — Structured release notes from merged PRs
- `get_project_dashboard` — Comprehensive health report synthesizing all modules
- `get_risk_radar` — Executive risk dashboard
- `review_pr` — Structured PR analysis with verdict
- `analyze_pr_impact` — Blast radius analysis before merge
- `explain_delay` — Root cause analysis for stuck issues

**Graph & Visualization (3 tools):**
- `analyze_dependency_graph` — DAG analysis: critical path, bottlenecks, cycles
- `visualize_dependencies` — ASCII art and Mermaid diagram rendering
- `compare_estimates` — Predicted vs actual cycle time accuracy

**Context & Recovery (4 tools):**
- `recover_context` — Full context recovery to resume work on an issue
- `get_session_history` — Cross-session event history
- `get_event_stream` — Query structured event stream
- `record_review_outcome` — Close the feedback loop on review findings

### The Key Insight

**GitHub is great for collaboration artifacts (issues, PRs, comments). It is terrible for project intelligence.** The right architecture uses GitHub for what it's good at (human-readable discussion, code review, CI) and owns everything else locally:

```
GitHub owns:           Conductor owns:
  - Issue discussions     - Workflow state machine
  - PR reviews            - Dependency graph
  - CI/CD checks          - Cycle time analytics
  - Code hosting          - Sprint forecasting
  - Comments              - Decision memory
                          - Rework prediction
                          - Capacity modeling
                          - Risk assessment
```

---

## Architecture: Self-Hosted Product Development Platform

### Design Principles

1. **Local-first** — All state in local SQLite. No cloud dependency beyond LLM API keys and GitHub API.
2. **Dual interface** — Every capability available through web UI (for humans) and MCP server (for AI agents). Same core API, two presentation layers.
3. **A2A between agents** — Workers communicate using the A2A protocol's Task/Message/Part model over BullMQ.
4. **MCP for tools** — Each agent accesses external capabilities through MCP (filesystem, testing, GitHub API).
5. **Own the PM layer** — Project management is a core competency, not a GitHub integration.
6. **SDK-first agents** — Use Claude Code SDK and Codex SDK rather than raw API calls. Roll our own only when SDKs prove insufficient.

### System Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│                      Conductor Gateway                            │
│                                                                   │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────┐   │
│  │   Web UI     │  │  MCP Server  │  │   A2A Endpoint       │   │
│  │  (Next.js)   │  │  (52+ tools) │  │   (Task delegation)  │   │
│  │              │  │              │  │                      │   │
│  │  Human       │  │  AI agents   │  │  External agents     │   │
│  │  interface   │  │  (Claude     │  │  can delegate work   │   │
│  │              │  │   Code, etc) │  │  to Conductor        │   │
│  └──────┬───────┘  └──────┬───────┘  └──────────┬───────────┘   │
│         └─────────────┬───┴──────────────┬──────┘               │
│                 ┌─────▼─────┐                                    │
│                 │ Core API  │  ← Single source of truth for      │
│                 │           │    all operations                   │
│                 └─────┬─────┘                                    │
│         ┌─────────────┼─────────────────┐                        │
│    ┌────▼────┐   ┌────▼────┐   ┌────────▼────────┐              │
│    │ SQLite  │   │ BullMQ  │   │ PM Intelligence  │              │
│    │ (state) │   │ (queue) │   │ Engine           │              │
│    │         │   │         │   │ (analytics,      │              │
│    │ - runs  │   │ A2A     │   │  prediction,     │              │
│    │ - board │   │ Tasks   │   │  memory,         │              │
│    │ - deps  │   │ over    │   │  simulation)     │              │
│    │ - events│   │ Redis   │   │                  │              │
│    │ - memory│   │         │   │                  │              │
│    └─────────┘   └────┬────┘   └──────────────────┘              │
│                       │                                           │
│              ┌────────▼────────┐                                  │
│              │   Agent Workers │                                  │
│              │                 │                                  │
│              │  ┌───────────┐  │                                  │
│              │  │ PM Agent  │  │  Triage, decompose, plan sprint │
│              │  └───────────┘  │                                  │
│              │  ┌───────────┐  │                                  │
│              │  │ Planner   │  │  Read issue + codebase → plan   │
│              │  └───────────┘  │                                  │
│              │  ┌───────────┐  │                                  │
│              │  │Implementer│  │  Execute plan → code + tests    │
│              │  └───────────┘  │                                  │
│              │  ┌───────────┐  │                                  │
│              │  │ Reviewer  │  │  Review code, validate scope    │
│              │  └───────────┘  │                                  │
│              │  ┌───────────┐  │                                  │
│              │  │ Test Agent│  │  Run tests, report results      │
│              │  └───────────┘  │                                  │
│              └─────────────────┘                                  │
└──────────────────────────────────────────────────────────────────┘
                          │
                          ▼
┌──────────────────────────────────────────────────────────────────┐
│                    External Services                              │
│   GitHub (issues, PRs, webhooks)  │  LLM APIs (Claude, etc)     │
└──────────────────────────────────────────────────────────────────┘
```

---

## The Product Development Lifecycle

Conductor v1 has only development execution. v2 adds a full product lifecycle:

```
                    Conductor v2 Lifecycle
                    ═══════════════════════

  ┌─────────────┐   ┌─────────┐   ┌──────────────┐
  │   Product    │   │         │   │   Sprint     │
  │  Discovery   │──▶│ Triage  │──▶│  Planning    │
  │             │   │         │   │              │
  │  - Ideation │   │ - Class │   │ - Capacity   │
  │  - Decompose│   │ - Score │   │ - Forecast   │
  │  - Deps     │   │ - Route │   │ - Order      │
  └─────────────┘   └─────────┘   └──────┬───────┘
       PM Agent       PM Agent        PM Agent
                                          │
                                          ▼
                                   ┌──────────────┐
                                   │  Development  │
                                   │              │
                                   │ - Plan       │
                                   │ - Implement  │
                                   │ - Test       │
                                   │ - Self-review│
                                   └──────┬───────┘
                                   Dev Agents
                                          │
                                          ▼
                                   ┌──────────────┐    ┌──────────┐
                                   │    Review    │    │          │
                                   │              │──▶ │   Done   │
                                   │ - Code review│    │          │
                                   │ - Scope check│    │ - Record │
                                   │ - Rework pred│    │ - Learn  │
                                   └──────────────┘    └──────────┘
                                   Review Agent        PM Agent
```

### Phase 1: Product Discovery (PM Agent)

The PM Agent handles everything before development starts:

| Capability | Source | Description |
|-----------|--------|-------------|
| **Issue Intake** | New in v2 | Natural language → structured issue with acceptance criteria |
| **Auto-Triage** | `conductor_triage_work_item`, `auto_label` | Classify type, area, priority, risk, size, spec readiness |
| **Decomposition** | `decompose_issue` | Break epics into dependency-ordered subtasks with critical path |
| **Dependency Mapping** | `add_dependency`, `analyze_dependency_graph` | Build and maintain the dependency DAG with cycle detection |
| **Similar Work Lookup** | `suggest_approach` | Find past decisions and lessons for similar work |
| **Rework Prediction** | `predict_rework` | Flag issues likely to need rework before they start |

### Phase 2: Sprint Planning (PM Agent)

| Capability | Source | Description |
|-----------|--------|-------------|
| **Sprint Planning** | `plan_sprint` | AI-optimized sprint plan: dependency-aware ordering, capacity-matched, confidence-scored |
| **Monte Carlo Sim** | `simulate_sprint` | Probabilistic throughput forecast (P10-P90) from 10K trials |
| **Backlog Forecast** | `forecast_backlog` | "When will these N items be done?" with confidence intervals |
| **Capacity Analysis** | `get_team_capacity` | Contributor profiles, throughput forecasting, area coverage gaps |
| **Dependency Impact** | `simulate_dependency_change` | "What if issue X slips by N days?" cascading delay analysis |
| **Session Optimization** | `optimize_session` | Recommend highest-impact work for available time |

### Phase 3: Development (Dev Agents — Existing v1 + Enhancements)

| Capability | Source | Description |
|-----------|--------|-------------|
| **Planning** | Planner Agent | Read issue + codebase context → implementation plan |
| **Plan Review** | Reviewer Agent | Critique plan, iterate up to 3 rounds |
| **Implementation** | Implementer Agent | Write code via Claude Code SDK / Codex SDK |
| **Test Execution** | Test Agent | Run tests, capture results as ground truth |
| **Scope Monitoring** | `detect_scope_creep` | Alert when changes drift from plan |
| **Context Recovery** | `recover_context` | Resume work across sessions with full history |

### Phase 4: Review & Learning (Review Agent + PM Agent)

| Capability | Source | Description |
|-----------|--------|-------------|
| **Code Review** | `review_pr` | Structured analysis with verdict |
| **Impact Analysis** | `analyze_pr_impact` | Blast radius, knowledge risk, coupling |
| **Readiness Check** | `check_readiness` | Pre-review validation score |
| **Outcome Recording** | `record_outcome` | Track what happened (merged, rework, reverted) |
| **Decision Recording** | `record_decision` | Persist architectural choices for future reference |
| **Review Calibration** | `get_review_calibration` | Track hit rates, reduce false positives over time |
| **Delay Analysis** | `explain_delay` | Root cause analysis when issues are stuck |

---

## AI-Optimized Project Management Data Model

### Why Local SQLite Beats GitHub Projects for AI

```
GitHub Projects:                    Conductor PM Engine:
─────────────────                   ─────────────────────
- GraphQL-only mutations            - Direct SQL queries (<1ms)
- No dependency tracking            - First-class dependency DAG
- No historical data                - Full event stream with timestamps
- No forecasting                    - Monte Carlo simulation
- No learning/memory                - JSONL decision + outcome memory
- Rate limited (5K pts/hr)          - Unlimited local operations
- Eventually consistent             - Immediately consistent (WAL mode)
- Field IDs are opaque UUIDs        - Simple integer primary keys
- No bulk operations                - Batch SQL operations
```

### Core Tables (extending v1 schema)

```sql
-- Issue/work item state (synced from GitHub, enriched locally)
CREATE TABLE issues (
  id              INTEGER PRIMARY KEY,
  github_node_id  TEXT UNIQUE NOT NULL,
  number          INTEGER NOT NULL,
  title           TEXT NOT NULL,
  body            TEXT,
  state           TEXT NOT NULL,           -- open/closed
  workflow_state  TEXT DEFAULT 'Backlog',  -- Backlog/Ready/Active/Review/Rework/Done
  priority        TEXT DEFAULT 'normal',   -- critical/high/normal/low
  area            TEXT,                    -- frontend/backend/contracts/infra
  issue_type      TEXT,                    -- epic/feature/bug/spike/chore
  risk            TEXT,                    -- low/med/high
  estimate        TEXT,                    -- S/M/L
  spec_readiness  REAL,                   -- 0.0-1.0 computed score
  assignee        TEXT,
  labels          TEXT,                    -- JSON array
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  closed_at       TEXT,
  synced_at       TEXT NOT NULL
);

-- First-class dependency graph
CREATE TABLE dependencies (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  blocker_issue   INTEGER NOT NULL REFERENCES issues(number),
  blocked_issue   INTEGER NOT NULL REFERENCES issues(number),
  dep_type        TEXT DEFAULT 'blocks',  -- blocks/prerequisite/related
  resolved        INTEGER DEFAULT 0,
  created_at      TEXT DEFAULT CURRENT_TIMESTAMP,
  resolved_at     TEXT,
  UNIQUE(blocker_issue, blocked_issue)
);

-- Immutable event stream (all state changes)
CREATE TABLE events (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type      TEXT NOT NULL,           -- workflow_change/priority_change/created/closed/sync/decision/outcome/dependency_added/dependency_resolved
  issue_number    INTEGER,
  from_value      TEXT,
  to_value        TEXT,
  metadata        TEXT,                    -- JSON
  created_at      TEXT DEFAULT CURRENT_TIMESTAMP
);

-- Persistent decision memory
CREATE TABLE decisions (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  decision        TEXT NOT NULL,
  type            TEXT,                    -- architectural/library/approach/workaround
  area            TEXT,
  rationale       TEXT,
  alternatives    TEXT,                    -- JSON array
  files           TEXT,                    -- JSON array
  issue_number    INTEGER,
  created_at      TEXT DEFAULT CURRENT_TIMESTAMP
);

-- Persistent outcome memory
CREATE TABLE outcomes (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  issue_number    INTEGER NOT NULL,
  result          TEXT NOT NULL,           -- merged/rework/reverted/abandoned
  summary         TEXT,
  area            TEXT,
  pr_number       INTEGER,
  review_rounds   INTEGER,
  rework_reasons  TEXT,                    -- JSON array
  lessons         TEXT,
  created_at      TEXT DEFAULT CURRENT_TIMESTAMP
);

-- Review finding calibration
CREATE TABLE review_findings (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  issue_number    INTEGER NOT NULL,
  pr_number       INTEGER,
  finding_type    TEXT NOT NULL,
  severity        TEXT NOT NULL,           -- blocking/non_blocking/suggestion
  disposition     TEXT NOT NULL,           -- accepted/dismissed/modified/deferred
  area            TEXT,
  files           TEXT,                    -- JSON array
  reason          TEXT,
  created_at      TEXT DEFAULT CURRENT_TIMESTAMP
);
```

### Data Flow: GitHub as Source, Conductor as Intelligence

```
GitHub (source of truth for artifacts)
  │
  │  Webhook / Polling / Manual Sync
  ▼
┌─────────────────────────────┐
│  Sync Layer                  │
│  - Incremental by default   │
│  - Force full refresh option │
│  - Respects rate limits     │
└─────────┬───────────────────┘
          │
          ▼
┌─────────────────────────────┐
│  Local SQLite                │
│  - Issues (enriched)        │    ← AI can query instantly
│  - Dependencies (first-class)│   ← No GraphQL roundtrips
│  - Events (immutable log)   │    ← Full history for analytics
│  - Decisions (persistent)   │    ← Cross-session memory
│  - Outcomes (persistent)    │    ← Learning from results
│  - Review findings          │    ← Self-calibrating reviews
└─────────┬───────────────────┘
          │
          ▼
┌─────────────────────────────┐
│  PM Intelligence Engine      │
│  - Cycle time analysis      │    ← From event timestamps
│  - Monte Carlo simulation   │    ← From historical cycle times
│  - Dependency graph analysis│    ← From dependencies table
│  - Rework prediction        │    ← From outcomes + patterns
│  - Capacity modeling        │    ← From git history
│  - Risk radar               │    ← Synthesizing all signals
└─────────────────────────────┘
```

---

## Inter-Agent Communication: A2A Protocol

### Why A2A

The industry has converged on a three-layer protocol stack under Linux Foundation governance:

| Layer | Protocol | Purpose | Conductor Use |
|-------|----------|---------|---------------|
| Agent-to-Agent | **A2A** (Google/LF) | Task delegation | Workers communicate via A2A Tasks over BullMQ |
| Agent-to-Tool | **MCP** (Anthropic/AAIF) | Tool/resource access | Each agent uses MCP for filesystem, GitHub, PM tools |
| Agent-to-User | **AG-UI** (CopilotKit) | Frontend streaming | Web UI receives agent events via AG-UI |

A2A's Task lifecycle maps naturally onto BullMQ jobs:

| A2A Task State | BullMQ Equivalent | Conductor Meaning |
|---------------|-------------------|-------------------|
| `submitted` | Job created | Work requested |
| `working` | Job active | Agent processing |
| `input-required` | Job paused | Human gate / clarification needed |
| `completed` | Job completed | Work done, artifacts available |
| `cancelled` | Job removed | Work cancelled |
| `failed` | Job failed | Error occurred |

### Agent Cards (Capability Discovery)

Each worker type declares capabilities via an A2A Agent Card:

```json
{
  "id": "pm-agent",
  "name": "PM Intelligence Agent",
  "description": "Product management intelligence: triage, decompose, forecast, plan sprints",
  "skills": [
    { "id": "triage", "name": "Issue Triage", "description": "Classify, score, and route new issues" },
    { "id": "decompose", "name": "Issue Decomposition", "description": "Break epics into dependency-ordered subtasks" },
    { "id": "plan-sprint", "name": "Sprint Planning", "description": "AI-optimized sprint plan with confidence scoring" },
    { "id": "forecast", "name": "Completion Forecasting", "description": "Monte Carlo simulation for delivery dates" },
    { "id": "risk-assess", "name": "Risk Assessment", "description": "Cross-cutting risk radar with mitigations" },
    { "id": "standup", "name": "Standup Generation", "description": "Auto-generated daily standup from activity" }
  ]
}
```

### Message Format (A2A over BullMQ)

```json
{
  "id": "msg-550e8400-e29b-41d4-a716-446655440000",
  "timestamp": "2026-02-19T10:30:00Z",
  "source": {
    "agentId": "pm-agent",
    "agentName": "PM Intelligence Agent"
  },
  "destination": {
    "agentId": "planner-agent",
    "queue": "agents.planner"
  },
  "taskId": "task-6ba7b810-9dad-11d1-80b4-00c04fd430c8",
  "contextId": "run-abc123",
  "type": "task_request",
  "status": {
    "state": "submitted"
  },
  "message": {
    "role": "user",
    "parts": [
      {
        "type": "text",
        "text": "Plan implementation for issue #42: Add health endpoint"
      },
      {
        "type": "data",
        "mimeType": "application/json",
        "data": {
          "issue": {
            "number": 42,
            "title": "Add /health endpoint",
            "body": "...",
            "acceptanceCriteria": ["..."]
          },
          "triage": {
            "type": "feature",
            "area": "backend",
            "priority": "high",
            "risk": "low",
            "estimate": "S",
            "specReadiness": 0.9
          },
          "dependencies": [],
          "pastDecisions": [
            {
              "decision": "Use Express router pattern for all endpoints",
              "rationale": "Consistency with existing codebase"
            }
          ],
          "similarOutcomes": [
            {
              "issue": 31,
              "result": "merged",
              "reviewRounds": 1,
              "lessons": "Keep health checks simple, no DB dependency"
            }
          ]
        }
      }
    ]
  },
  "metadata": {
    "priority": "high",
    "ttl": 600,
    "replyTo": "agents.pm.results",
    "runId": "run-abc123",
    "projectId": "proj-xyz"
  }
}
```

### Agent Response Format

```json
{
  "id": "msg-7c9e6679-7425-40de-944b-e07fc1f90ae7",
  "timestamp": "2026-02-19T10:32:15Z",
  "source": {
    "agentId": "planner-agent",
    "agentName": "Planner Agent"
  },
  "destination": {
    "agentId": "pm-agent",
    "queue": "agents.pm.results"
  },
  "taskId": "task-6ba7b810-9dad-11d1-80b4-00c04fd430c8",
  "contextId": "run-abc123",
  "type": "task_result",
  "status": {
    "state": "completed"
  },
  "message": {
    "role": "agent",
    "parts": [
      {
        "type": "text",
        "text": "Plan ready for review."
      },
      {
        "type": "data",
        "mimeType": "application/json",
        "data": {
          "artifact": "plan",
          "approach": "Add Express route handler at /health...",
          "files": ["src/routes/health.ts", "src/routes/index.ts"],
          "risks": [],
          "estimatedEffort": "S",
          "acceptanceCriteriaMapping": {
            "Returns 200 with JSON body": "src/routes/health.ts",
            "Includes uptime and version": "src/routes/health.ts"
          }
        }
      }
    ]
  }
}
```

### Communication Flow Example: Issue to PR

```
1. Human/AI selects issue #42 for work

2. Orchestrator → PM Agent (A2A Task: triage)
   PM Agent returns: type=feature, area=backend, priority=high, risk=low,
                     similar past work, relevant decisions, rework probability=0.12

3. Orchestrator → Planner Agent (A2A Task: plan)
   Planner receives: issue + triage context + past decisions
   Planner returns: implementation plan with file list and risks

4. Orchestrator → Reviewer Agent (A2A Task: review-plan)
   Reviewer receives: plan + issue requirements
   Reviewer returns: approved (or feedback for iteration)

5. Human gate: approve plan in UI (or MCP client approves programmatically)

6. Orchestrator → Implementer Agent (A2A Task: implement)
   Implementer receives: approved plan + codebase context
   Implementer returns: committed changes in worktree

7. Orchestrator → Test Agent (A2A Task: test)
   Test Agent receives: worktree path + test command
   Test Agent returns: pass/fail with output

8. Orchestrator → PM Agent (A2A Task: scope-check)
   PM Agent runs detect_scope_creep against plan
   PM Agent returns: scope OK (or drift warnings)

9. Orchestrator → Reviewer Agent (A2A Task: review-code)
   Reviewer receives: diff + plan + issue requirements
   Reviewer returns: approved (or feedback)

10. Orchestrator creates PR, posts to GitHub

11. Human merges → PM Agent records outcome + decisions
```

---

## MCP Server Interface (AI Autonomous Operation)

The same capabilities available in the web UI are exposed as MCP tools. An AI orchestrator (like Claude Code) can operate Conductor entirely through MCP.

### Tool Categories

**Project Management:**
```
conductor_get_board        — Board summary with health score
conductor_get_issue        — Issue details with enrichments
conductor_move_issue       — Transition workflow state
conductor_add_dependency   — Add issue dependency
conductor_conductor_triage_work_item     — Full triage analysis
conductor_decompose_issue  — Break into subtasks
conductor_plan_sprint      — Generate sprint plan
conductor_suggest_next     — Recommend next issue
```

**Run Operations:**
```
conductor_start_run        — Start a run for an issue
conductor_approve_plan     — Approve a pending plan
conductor_reject_plan      — Reject with feedback
conductor_cancel_run       — Cancel active run
conductor_retry_run        — Retry from failure
conductor_get_run_status   — Current run state + timeline
conductor_list_runs        — All active/recent runs
```

**Analytics & Prediction:**
```
conductor_get_velocity     — 7-day and 30-day velocity
conductor_get_cycle_times  — Historical cycle times
conductor_predict_completion — P50/P80/P95 dates
conductor_predict_rework   — Rework probability
conductor_simulate_sprint  — Monte Carlo forecast
conductor_get_risk_radar   — Executive risk dashboard
conductor_get_dashboard    — Full project health
```

**Memory & Learning:**
```
conductor_record_decision  — Persist architectural decision
conductor_record_outcome   — Record work outcome
conductor_suggest_approach — Get recommendations from past work
conductor_get_insights     — Analyze patterns across all memory
```

This means an AI coding agent with Conductor's MCP server configured can:

1. Check the board state
2. Pick the highest-priority unblocked issue
3. Start a run
4. Approve plans (if configured for autonomous mode)
5. Monitor progress
6. Record outcomes
7. Move to the next issue

No human in the loop required (if configured for that level of autonomy).

---

## SDK Strategy

### MVP: Claude Code SDK + Codex SDK

```
┌─────────────────────────────────────────┐
│  Agent Worker                            │
│  └── Conductor Agent Runtime             │
│       ├── Claude Agent SDK               │  ← Conversational agents
│       │   └── Anthropic API              │     (planner, reviewer, PM)
│       │                                  │
│       └── Codex SDK                      │  ← Autonomous implementation
│           └── OpenAI API                 │     (parallel code execution)
│                                          │
│  Tools provided via MCP:                 │
│  ├── Filesystem (scoped to worktree)     │
│  ├── Test runner                         │
│  ├── GitHub API (via outbox)             │
│  └── PM Intelligence (analytics, etc)    │
└─────────────────────────────────────────┘
```

**Why SDKs, not raw APIs:**
- SDKs handle conversation management, context compaction, tool use loops
- Claude Agent SDK manages the agentic conversation loop (retries, token limits)
- Codex SDK provides sandboxed autonomous execution with approval policies
- Both handle rate limiting, retries, and error recovery
- Switching models later means changing SDK config, not rewriting agent logic

**When we might roll our own:**
- When SDK abstractions limit our agent coordination patterns
- When we need tighter control over context assembly
- When we need custom tool orchestration that SDKs don't support
- Not for MVP. Prove the concept first.

---

## Self-Hosted Deployment Model (OpenClaw-Inspired)

### Installation

```bash
# Install globally
npm install -g @conductor/cli

# Initialize in a directory
conductor init

# Or run directly
npx conductor init
```

### What `conductor init` Does

1. Creates `~/.conductor/` (config, database, credentials)
2. Detects GitHub App setup (or guides through creation)
3. Starts the gateway process (web + worker + MCP server)
4. Opens the web UI at `http://localhost:3000`

### Runtime Architecture

```
~/.conductor/
├── conductor.db          # SQLite database (WAL mode)
├── config.json           # Gateway configuration
├── credentials/          # Encrypted API keys (0600 permissions)
├── memory/               # Decision + outcome JSONL files
├── repos/                # Cached repo clones
├── worktrees/            # Per-run worktrees
└── logs/                 # Structured logs
```

### Single Process, Multiple Interfaces

The gateway is a single Node.js process that serves:

| Interface | Port | Purpose |
|-----------|------|---------|
| Web UI | 3000 | Human control plane |
| MCP Server | stdio | AI agent tool access |
| A2A Endpoint | 3001 | External agent delegation |
| Webhook Receiver | 3000/api/webhooks | GitHub events |

Redis runs as a sidecar (Docker) or can be replaced with an in-process queue for single-user setups.

### Remote Access Options

Same patterns as OpenClaw:
- **Tailscale Serve** — Zero-config secure tunnel
- **SSH tunnel** — `ssh -L 3000:localhost:3000 server`
- **Docker** — `docker run -p 3000:3000 conductor`
- **VPS** — Direct deployment on any Linux host

---

## Implementation Phases

### Phase 1: Foundation Refactor (MVP extension)

**Goal:** Integrate PM Intelligence engine into Conductor, add MCP server interface.

| Task | Description |
|------|-------------|
| Port PM data model | Add issues, dependencies, events, decisions, outcomes tables to Conductor schema |
| Port PM Intelligence engine | Migrate analytics, prediction, simulation, and memory modules |
| Add MCP server | Expose Conductor capabilities as MCP tools alongside web UI |
| A2A message format | Replace ad-hoc context assembly with A2A Task/Message/Part model on BullMQ |
| PM Agent worker | New agent type that handles triage, decomposition, sprint planning |

### Phase 2: Product Development Layer

**Goal:** Full product lifecycle before development starts.

| Task | Description |
|------|-------------|
| Issue intake UI + MCP | Natural language → structured issue with AI-assisted fields |
| Kanban board with PM metrics | Board view showing dependency graph, cycle times, WIP limits |
| Sprint planning UI + MCP | Interactive sprint planning with Monte Carlo confidence |
| Dependency visualization | DAG rendering in web UI (Mermaid + interactive) |
| Risk dashboard | Executive view synthesizing all intelligence signals |
| Decision memory UI | Browse, search, and manage architectural decisions |

### Phase 3: Autonomous Mode

**Goal:** Full autonomous operation when configured.

| Task | Description |
|------|-------------|
| Autonomous loop | PM Agent triages → plans sprint → dispatches to dev agents → reviews → ships |
| MCP autonomous client | External AI agent operates Conductor entirely via MCP |
| A2A external endpoint | Other agents can delegate work to Conductor |
| Configurable autonomy levels | Human-in-the-loop at every gate → fully autonomous (per project policy) |
| Learning loop | Outcomes feed back into triage accuracy, sprint forecasting, rework prediction |

---

## Open Questions

1. **Queue technology** — BullMQ/Redis is proven but heavyweight for single-user. Consider in-process queue (e.g., `p-queue`) for local mode, BullMQ for multi-user?
2. **Agent model flexibility** — Should each agent type be configurable to use different LLM providers? (PM Agent uses Claude, Implementer uses Codex, etc.)
3. **MCP server transport** — stdio for Claude Code integration, but HTTP/SSE for remote MCP clients? Support both?
4. **GitHub vs GitLab** — v1 is GitHub-only. Should v2 abstract the forge layer early?
5. **Review finding memory** — How long to retain review calibration data? Per-project? Global?

---

## Relationship to claude-pm-toolkit

claude-pm-toolkit is the **R&D lab** where PM Intelligence was invented and validated. Conductor v2 is the **production platform** where it becomes a first-class citizen.

| claude-pm-toolkit | Conductor v2 |
|-------------------|--------------|
| MCP server consumed by Claude Code | MCP server + Web UI + A2A endpoint |
| Single repo, single user | Multi-project, multi-repo |
| CLI-driven workflow | UI-driven + programmatic |
| Agents are Claude Code itself | Dedicated agent workers with SDK integration |
| GitHub Projects optional | Own PM layer entirely |
| File-based memory (JSONL) | SQLite tables with indexed queries |
| Manual sync via tool call | Webhook-driven + auto-sync |

The 52 tools built in claude-pm-toolkit become the PM Agent's capabilities in Conductor v2. The data model, analytics engine, and prediction algorithms transfer directly.

---

## References

- [claude-pm-toolkit](https://github.com/cswenor/claude-pm-toolkit) — PM Intelligence MCP server with 52 tools
- [A2A Protocol Specification](https://a2a-protocol.org/latest/specification/) — Agent-to-Agent communication standard
- [MCP Specification](https://modelcontextprotocol.io/specification/2025-11-25) — Model Context Protocol
- [AG-UI Protocol](https://docs.ag-ui.com/) — Agent-User Interaction Protocol
- [OpenClaw Architecture](https://github.com/openclaw/openclaw) — Self-hosted AI agent platform (inspiration for deployment model)
- [Agentic AI Foundation](https://www.linuxfoundation.org/press/linux-foundation-announces-the-formation-of-the-agentic-ai-foundation) — Linux Foundation governance for MCP, A2A, AG-UI
