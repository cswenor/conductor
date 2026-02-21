# Orchestrator Interfaces

Status: Vision — Not implemented in v0.1. Describes planned architecture for a future release. Do not use as implementation reference for the current codebase.
Audience: Engineering, UX, platform integrators
Updated: 2026-02-19

This document specifies how humans, AI tools, and external systems interact with the orchestrator. The orchestrator is interface-agnostic — all interfaces translate between their presentation format and the orchestrator's unified task/event protocol.

---

## 1. Interface Overview

```
                    ┌──────────────────────────────┐
                    │       Orchestrator API        │
                    │    (Single entry point)       │
                    └──────┬───────┬───────┬───────┘
                           │       │       │
              ┌────────────┤       │       ├────────────┐
              │            │       │       │            │
              ▼            ▼       ▼       ▼            ▼
         ┌─────────┐ ┌─────────┐ ┌───┐ ┌─────────┐ ┌─────────┐
         │ Web UI  │ │OpenClaw │ │API│ │  MCP    │ │Webhooks │
         │(primary)│ │(optional│ │   │ │(AI tool)│ │(inbound)│
         │         │ │  CLI)   │ │   │ │         │ │         │
         └─────────┘ └─────────┘ └───┘ └─────────┘ └─────────┘
          Humans      Humans     Bots   AI agents   GitHub/etc
```

Every interface talks to the same orchestrator API. There is no interface-specific logic in the orchestrator core.

| Interface | Primary Users | Transport | Direction |
| --- | --- | --- | --- |
| **Web UI** | All human users | HTTP + WebSocket | Bidirectional |
| **OpenClaw** | CLI-preferring users, self-hosted teams | HTTP + Server-Sent Events | Bidirectional |
| **REST API** | Programmatic integrations, custom tools | HTTP | Bidirectional |
| **MCP** | AI coding tools (Claude Code, Cursor, etc.) | stdio / SSE | Bidirectional |
| **Webhooks (inbound)** | GitHub, GitLab, Linear, Jira | HTTP POST | Inbound only |
| **Notifications (outbound)** | Humans via external channels | Various | Outbound only |

---

## 2. Web UI (Primary Interface)

The Web UI is the primary human interface. Most users will interact with Conductor through it.

### 2.1 Core Views

| View | Purpose | Key Data |
| --- | --- | --- |
| **Dashboard** | Project health at a glance | Active runs, blocked items, velocity, DORA metrics |
| **Board** | Kanban view of work items | Work items by workflow state, WIP limits visible |
| **Run Detail** | Single run lifecycle | Phase graph with current position, task history, artifacts, events |
| **Worker Registry** | Connected workers and health | Worker list, status, circuit breaker state, utilization |
| **Queue Monitor** | Task queue depth and throughput | Per-queue depth, processing rate, dead letter count |
| **Settings** | Project configuration | Autonomy level, templates, notification channels, worker config |
| **Event Log** | Audit trail | Filterable event stream with correlation ID search |

### 2.2 Real-Time Updates

The Web UI connects via WebSocket for live updates:

```
Client ──── WebSocket ────► Orchestrator
                            │
                            ├── run.phase_changed → Update board + run detail
                            ├── task.completed → Update run detail
                            ├── worker.dead → Flash alert on worker registry
                            ├── decision.escalated → Show approval request
                            └── worker.circuit_open → Flash alert on dashboard
```

Reconnection: exponential backoff with jitter, starting at 1 second. On reconnect, the client requests a state snapshot to catch up on missed events.

### 2.3 Human Action Points

The Web UI surfaces actions when the orchestrator needs human input:

| Situation | UI Element | Urgency |
| --- | --- | --- |
| Plan needs approval | Approval card with plan artifact | Normal |
| Code review requested | Review card with PR link + diff | Normal |
| Run blocked | Blocked banner with reason + options | High |
| Circuit breaker open | Alert banner with affected runs | High |
| Merge ready | Merge button (final human gate) | Normal |
| Budget exhausted | Budget dialog with increase option | Medium |

**Notification flow for human actions:**

```
Orchestrator determines: human input needed
    │
    ▼
Create human task (task.worker_type = 'human')
    │
    ▼
Route to assigned human (or project default queue)
    │
    ▼
Push via:
    1. WebSocket (real-time in Web UI if connected)
    2. Notification channel (email, Slack, etc. per project config)
    │
    ▼
Human responds via Web UI (or OpenClaw, or API)
    │
    ▼
Response routed to orchestrator as task_result
```

### 2.4 Autonomy Level Controls

The Web UI exposes autonomy level per project and per run:

```
Project Settings > Autonomy
    │
    ├── L0: Full oversight ──── Every step requires approval
    ├── L1: Plan approval ──── Default for new projects
    ├── L2: Result review ──── Recommended for mature teams
    └── L3: Exception-based ── For high-trust, high-velocity teams
```

When starting a run, users can override the project default:

```
Start Run for #42
    │
    ├── Priority: [1-10 slider]
    ├── Autonomy: [L0 / L1 / L2 / L3]  (default from project)
    └── Template: [auto-select / override]
```

---

## 3. OpenClaw (Optional CLI Interface)

OpenClaw is an optional self-hosted CLI interface for teams that prefer terminal-first workflows. It provides:

1. **CLI access** to all orchestrator operations
2. **Safety enforcement** for AI interactions
3. **Self-hosted deployment** for airgapped or privacy-sensitive environments

### 3.1 When to Use OpenClaw

| Use Case | Why OpenClaw |
| --- | --- |
| CLI-first developers | Prefer terminal over browser |
| Airgapped environments | No external web access needed |
| Safety-critical projects | Additional safety layer for AI interactions |
| CI/CD integration | Script orchestrator operations from pipelines |
| Mobile/lightweight access | SSH into a server and use the CLI |

### 3.2 OpenClaw ↔ Orchestrator Communication

OpenClaw is a client of the orchestrator API. It does NOT have special access:

```
Human ──── OpenClaw CLI ──── HTTP ──── Orchestrator API
```

OpenClaw translates between terminal interaction patterns and the orchestrator's task protocol:

```bash
# Start a run
openclaw run start --issue 42 --autonomy L2

# Check run status
openclaw run status 42

# Approve a plan
openclaw approve plan --run <run_id>

# View blocked runs
openclaw runs --blocked

# View worker status
openclaw workers

# Tail event stream
openclaw events --follow --project my-project
```

### 3.3 Safety Layer

OpenClaw adds a safety layer that other interfaces don't have by default:

| Safety Feature | Description |
| --- | --- |
| **Secret filtering** | Scans orchestrator responses for potential secrets before displaying |
| **Command confirmation** | Prompts before destructive operations (cancel run, disable worker) |
| **Audit logging** | Logs all CLI interactions to local file |
| **Token display** | Shows cumulative AI token usage per session |
| **Rate limiting** | Client-side rate limiting to prevent accidental API flooding |

These safety features are OpenClaw-specific. The orchestrator API itself enforces its own authorization and policy checks regardless of which interface is used.

### 3.4 Server-Sent Events

OpenClaw uses SSE (not WebSocket) for real-time updates because SSE is simpler for CLI tools:

```
openclaw events --follow
    │
    └── HTTP GET /api/events/stream
        ├── data: {"type": "run.phase_changed", ...}
        ├── data: {"type": "task.completed", ...}
        └── data: {"type": "decision.escalated", ...}
```

### 3.5 Deployment

OpenClaw can be deployed as:
- **Local binary** — installed alongside the user's dev tools
- **Container** — runs in Docker, connects to orchestrator over network
- **Server-side** — installed on a shared server, accessed via SSH

OpenClaw is NOT required for Conductor to function. The Web UI and REST API provide the same capabilities.

---

## 4. REST API

The programmatic interface. All other interfaces are built on top of this API.

### 4.1 Endpoints

**Runs:**

| Method | Path | Description |
| --- | --- | --- |
| `POST` | `/api/runs` | Create and start a run |
| `GET` | `/api/runs` | List runs (filterable by project, state, template) |
| `GET` | `/api/runs/:id` | Get run detail |
| `PATCH` | `/api/runs/:id` | Update run (priority, autonomy level) |
| `POST` | `/api/runs/:id/cancel` | Cancel a run |
| `POST` | `/api/runs/:id/retry` | Retry a blocked/failed run |
| `POST` | `/api/runs/:id/unblock` | Manually unblock a run |
| `GET` | `/api/runs/:id/phases` | Get phase history |
| `GET` | `/api/runs/:id/events` | Get run events |
| `GET` | `/api/runs/:id/artifacts` | Get run artifacts |

**Tasks:**

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/api/tasks` | List tasks (filterable) |
| `GET` | `/api/tasks/:id` | Get task detail |
| `POST` | `/api/tasks/:id/respond` | Submit human response to a task |

**Workers:**

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/api/workers` | List registered workers |
| `GET` | `/api/workers/:id` | Get worker detail |
| `POST` | `/api/workers/:id/disable` | Disable a worker |
| `POST` | `/api/workers/:id/enable` | Re-enable a worker |
| `DELETE` | `/api/workers/:id` | Deregister a worker |

**Projects:**

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/api/projects` | List projects |
| `GET` | `/api/projects/:id` | Get project detail |
| `PATCH` | `/api/projects/:id` | Update project settings |
| `GET` | `/api/projects/:id/templates` | List workflow templates |
| `POST` | `/api/projects/:id/templates` | Create custom template |
| `PATCH` | `/api/projects/:id/templates/:tid` | Update template |

**Queues:**

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/api/queues` | List queue depths |
| `GET` | `/api/queues/:name/dead` | List dead letter items |
| `POST` | `/api/queues/:name/dead/:id/retry` | Retry dead letter item |

**Events:**

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/api/events` | Query event stream (filterable) |
| `GET` | `/api/events/stream` | SSE stream of real-time events |

**Health:**

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/health/live` | Liveness check |
| `GET` | `/health/ready` | Readiness check |
| `GET` | `/health/deep` | Deep health check |

### 4.2 Authentication

| Interface | Auth Method |
| --- | --- |
| Web UI | Session cookie (from OAuth login) |
| OpenClaw | API key (stored in local config) |
| REST API | API key or OAuth token |
| MCP | Inherited from host tool's auth |
| Webhooks | Webhook secret (HMAC verification) |

All API requests carry a user identity. The orchestrator logs the identity with every action for audit.

### 4.3 Error Format

```json
{
  "error": {
    "code": "RUN_BLOCKED",
    "message": "Run is blocked: unresolved dependency on issue #41",
    "details": {
      "run_id": "uuid",
      "block_reason": "unresolved_dependency",
      "blocking_issue": 41
    }
  }
}
```

Error codes follow the pattern `<RESOURCE>_<CONDITION>`:
- `RUN_NOT_FOUND`, `RUN_BLOCKED`, `RUN_COMPLETED` (cannot modify)
- `WORKER_DEAD`, `WORKER_DISABLED`
- `QUEUE_FULL`, `BUDGET_EXHAUSTED`
- `TEMPLATE_INVALID`, `TRANSITION_INVALID`
- `AUTH_REQUIRED`, `AUTH_FORBIDDEN`

---

## 5. MCP Interface

AI coding tools (Claude Code, Cursor, etc.) interact with the orchestrator via MCP (Model Context Protocol).

### 5.1 Tool Catalog

The orchestrator exposes its operations as MCP tools:

| Tool | Description | Parameters |
| --- | --- | --- |
| `conductor_start_run` | Create and enqueue run for a work item | `work_item_id`, `priority?`, `autonomy_level?`, `template_id?` |
| `conductor_get_run_status` | Read full run status view (phase, gates, timeline, artifacts) | `run_id` |
| `conductor_list_runs` | List runs by project/phase/status/result filters | `project_id`, `state?`, `limit?` |
| `conductor_approve_run_plan` | Approve plan when run is awaiting plan approval gate | `run_id`, `comment?` |
| `conductor_reject_run_plan` | Reject plan and return to planning or cancel | `run_id`, `reason`, `action` |
| `conductor_cancel_run` | Cancel active/awaiting/blocked run and trigger cleanup | `run_id`, `reason` |
| `conductor_retry_run` | Retry blocked/failed path with optional rewind checkpoint | `run_id`, `rewind_to?` |
| `conductor_get_queue_status` | Get task queue depths | `project_id?` |
| `conductor_get_workers` | List registered workers | `worker_type?`, `status?` |
| `conductor_submit_result` | Submit work result (for AI tools acting as workers) | `task_id`, `state`, `output`, `artifacts?` |
| `conductor_get_task` | Get task details and input | `task_id` |
| `conductor_list_blocked` | List blocked runs with reasons | `project_id?` |

These tools let an AI coding agent participate in Conductor as both a controller (starting runs) and a worker (receiving and completing tasks).

### 5.2 AI Tool as Worker

When an AI coding tool (like Claude Code) is registered as a worker:

```
Orchestrator ──── MCP task_request ────► Claude Code
                                         │
                                         │ (implements code, runs tests)
                                         │
Claude Code ──── MCP task_result ────► Orchestrator
```

The AI tool receives tasks through MCP, executes them using its local capabilities (file editing, terminal, etc.), and reports results back through MCP.

### 5.3 AI Tool as Controller

When a human uses an AI coding tool to interact with Conductor:

```
Human: "Start working on issue #42"
    │
    ▼
Claude Code calls: conductor_start_run(work_item_id=42)
    │
    ▼
Orchestrator creates run, selects template, assigns first task
    │
    ▼
Claude Code calls: conductor_get_run_status(run_id) to check progress
```

The AI tool acts as a proxy between the human and the orchestrator.

---

## 6. Inbound Webhooks

External systems push events to the orchestrator via webhooks.

### 6.1 Supported Sources

| Source | Events | Webhook Path |
| --- | --- | --- |
| **GitHub** | Issue/PR opened/closed/labeled, push, review, comment | `/api/webhooks/github` |
| **GitLab** | Merge request, issue, pipeline, push | `/api/webhooks/gitlab` |
| **Linear** | Issue created/updated, cycle changes | `/api/webhooks/linear` |
| **Jira** | Issue created/updated/transitioned | `/api/webhooks/jira` |
| **Custom** | Any event matching the schema | `/api/webhooks/custom` |

### 6.2 Webhook Processing

```
Webhook received
    │
    ▼
Verify signature (HMAC for GitHub/GitLab, token for others)
    │
    ▼
Normalize to internal event format:
    {
      source: "github",
      event_type: "issue.opened",
      payload: { ... normalized fields ... },
      raw: { ... original payload ... }
    }
    │
    ▼
Enqueue to conductor:webhooks queue (BullMQ)
    │
    ▼
Orchestrator processes:
    ├── Issue opened → Should we create a run? (check auto-triage settings)
    ├── PR opened → Link to existing run if branch matches
    ├── Review submitted → Forward review result to reviewing phase
    ├── Push event → Trigger retest if run is in testing phase
    └── Issue labeled → Update run metadata, check for trigger labels
```

### 6.3 Auto-Triage

When an issue is opened, the orchestrator can optionally auto-triage it:

1. Query PM Engine: `conductor_triage_work_item(project_id, work_item_id)` for type, area, priority, and size estimate.
2. If auto-triage is enabled and confidence is high, create a run automatically.
3. If confidence is low, surface in the Web UI for human triage.

Auto-triage is controlled by project settings:
- `auto_triage: 'off'` — never auto-triage (default for new projects)
- `auto_triage: 'suggest'` — triage and suggest but don't create runs
- `auto_triage: 'auto'` — triage and create runs automatically

---

## 7. Outbound Notifications

The orchestrator sends notifications through configured channels when events require human attention.

### 7.1 Notification Channels

| Channel | Transport | Use Case |
| --- | --- | --- |
| **Web UI** | WebSocket push | Real-time if user is connected |
| **Email** | SMTP | Asynchronous, formal notifications |
| **Slack** | Slack API | Team channels, quick alerts |
| **OpenClaw** | SSE / push | CLI users, self-hosted environments |
| **Custom webhook** | HTTP POST | Integration with other systems |

### 7.2 Notification Events

Not all orchestrator events generate notifications. Only events that require human attention or represent significant state changes:

| Event | Default Channel | Urgency |
| --- | --- | --- |
| Run blocked | Web UI + Slack | High |
| Plan approval needed | Web UI + Email | Normal |
| Review requested | Web UI + Slack | Normal |
| Merge ready | Web UI | Normal |
| Circuit breaker opened | Web UI + Slack + Email | High |
| Budget exhausted | Web UI + Email | Medium |
| Run completed | Web UI | Low |
| Daily digest | Email | Low |

### 7.3 Notification Preferences

Users can configure per-channel preferences:

```json
{
  "user_id": "user-123",
  "channels": {
    "web_ui": { "enabled": true, "min_urgency": "low" },
    "email": { "enabled": true, "min_urgency": "normal" },
    "slack": { "enabled": true, "min_urgency": "high" },
    "openclaw": { "enabled": false }
  }
}
```

---

## 8. Worker Communication Protocol

This section specifies how workers communicate with the orchestrator, regardless of transport (in-process, HTTP, MCP).

### 8.1 Task Request

Orchestrator → Worker:

```json
{
  "task_id": "uuid",
  "run_id": "uuid",
  "correlation_id": "uuid",
  "operation": "implementation.execute",
  "input": {
    "work_item": {
      "id": 42,
      "title": "Add user authentication",
      "type": "feature",
      "acceptance_criteria": ["..."],
      "non_goals": ["..."]
    },
    "artifacts": [
      {"type": "PLAN", "content": "..."}
    ],
    "context": {
      "area": "backend",
      "approach_suggestion": "...",
      "history_insights": "..."
    }
  },
  "constraints": {
    "timeout_ms": 1800000,
    "token_budget": 100000,
    "sandbox_mode": "workspace-write",
    "autonomy_level": 2
  }
}
```

### 8.2 Task Progress (Optional)

Worker → Orchestrator (streaming):

```json
{
  "task_id": "uuid",
  "progress": {
    "percent": 45,
    "phase": "writing_tests",
    "message": "Implementing test cases for auth middleware"
  }
}
```

Progress updates are optional. Script workers typically don't send them. AI workers send them to keep the UI responsive.

### 8.3 Task Result

Worker → Orchestrator:

```json
{
  "task_id": "uuid",
  "state": "completed",
  "output": {
    "summary": "Implemented JWT authentication with middleware",
    "details": "...",
    "files_changed": ["src/auth.ts", "src/middleware.ts", "tests/auth.test.ts"]
  },
  "artifacts": [
    {"type": "CODE", "path": "src/auth.ts", "hash": "sha256:..."},
    {"type": "TEST_REPORT", "path": ".conductor/test-report.json", "hash": "sha256:..."}
  ],
  "metrics": {
    "duration_ms": 45000,
    "tokens_used": 12500
  }
}
```

**Task states in results (aligned with A2A `A2ATaskState`):**

| State | Meaning | Orchestrator Action |
| --- | --- | --- |
| `completed` | Task succeeded | Evaluate transitions from current phase |
| `failed` | Task failed | Check `recoverable` flag: if true, retry; if false, block run and escalate |
| `input-required` | Worker needs human input | Route to human via interface, run enters `blocked` |

The A2A `A2ATaskState` enum also includes `submitted` (task queued) and `working` (task in progress), but these are only used in progress updates, not in final results.

**Note on `cancelled`:** Tasks can be cancelled by the orchestrator (e.g., run cancelled). This is an orchestrator-initiated state change, not a worker result. The DB `tasks.state` column allows `cancelled` for this purpose.

### 8.4 Worker Registration

Worker → Orchestrator (on startup):

```json
{
  "worker_id": "script-eslint-1",
  "worker_type": "script",
  "display_name": "ESLint Checker",
  "capabilities": [
    {"operation": "script.lint", "priority_boost": 0}
  ],
  "max_parallel": 8,
  "config": {
    "script_path": "/usr/local/bin/eslint-worker",
    "runtime": "node",
    "sandbox_mode": "read-only"
  }
}
```

### 8.5 Heartbeat

Worker → Orchestrator (every 30 seconds):

```json
{
  "worker_id": "script-eslint-1",
  "status": "active",
  "current_task_count": 2,
  "current_task_ids": ["task-uuid-1", "task-uuid-2"],
  "resource_usage": {
    "cpu_percent": 15,
    "memory_mb": 128
  }
}
```

### 8.6 Transport Abstraction

The worker protocol is transport-agnostic. The same messages flow over different transports:

| Transport | When Used | How |
| --- | --- | --- |
| **In-process** | Local mode (workers in same process) | Direct function calls via BullMQ |
| **HTTP** | Remote workers (separate services) | REST endpoints on worker |
| **MCP** | AI coding tools (Claude Code, etc.) | MCP tool calls |
| **Subprocess** | Script workers spawned by orchestrator | stdin/stdout JSON |

The orchestrator uses a transport adapter per worker. The adapter translates between the orchestrator's internal protocol and the worker's transport.

---

## 9. Cross-Reference with Existing Specs

Where this document relates to existing Conductor v1 specifications:

| This Document | Existing Spec | Relationship |
| --- | --- | --- |
| § 2 Web UI | `CONTROL_PLANE_UX.md` | Supersedes — this is the v2 interface model |
| § 4 REST API | `ARCHITECTURE.md` API layer | Extends — adds run/task/worker endpoints |
| § 6 Webhooks | `PROTOCOL.md` webhook handling | Replaces — new normalization model |
| § 8 Worker Protocol | `PROTOCOL.md` agent communication | Replaces — unified protocol for all worker types |
| § 3 OpenClaw | (new) | New interface, not in v1 |
| § 5 MCP | `INTERFACES.md` MCP tools | Extends — adds orchestrator-specific tools alongside PM Engine tools |

The v1 specs remain valid for concepts not covered here (state machine fundamentals in PROTOCOL.md, policy enforcement in POLICIES.md). This document adds the interface layer that was missing from v1.
