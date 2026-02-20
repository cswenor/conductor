# Orchestrator Data Model

Status: Normative specification
Audience: Engineering
Updated: 2026-02-19

This document defines the orchestrator's storage schema. The orchestrator uses PostgreSQL for durable state and Redis for ephemeral state (queues, worker heartbeats, locks).

The PM Engine has its own SQLite database (see `../pm-engine/DATA_MODEL.md`). The two databases are independent — the orchestrator queries the PM Engine via its tool interface, never by direct database access.

---

## 1. Core Tables

### 1.1 Runs

A run is a single execution of a workflow for a work item.

```sql
CREATE TABLE runs (
  run_id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id      UUID NOT NULL REFERENCES projects(project_id),
  work_item_id    INTEGER NOT NULL,              -- Issue/PR number from source system
  work_item_type  TEXT NOT NULL,                  -- 'epic', 'feature', 'bug', 'chore', 'spike', 'incident', 'task'
  source_system   TEXT NOT NULL DEFAULT 'github', -- 'github', 'gitlab', 'linear', 'jira'
  source_ref      TEXT NOT NULL,                  -- e.g., 'github:owner/repo#42'

  -- Workflow
  template_id     TEXT NOT NULL,                  -- Which workflow template governs this run
  current_phase   TEXT NOT NULL DEFAULT 'pending',-- RunPhase: position in workflow graph
  state           TEXT NOT NULL DEFAULT 'active', -- RunStatus: 'active', 'paused', 'blocked', 'finished'
  block_reason    TEXT,                           -- Why run is blocked (null if not blocked)

  -- Parent/child (for epics)
  parent_run_id   UUID REFERENCES runs(run_id),

  -- Lifecycle
  priority        INTEGER NOT NULL DEFAULT 5,     -- 1 (highest) to 10 (lowest)
  autonomy_level  INTEGER NOT NULL DEFAULT 1,     -- 0-3, override from project default
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at      TIMESTAMPTZ,
  completed_at    TIMESTAMPTZ,
  cancelled_at    TIMESTAMPTZ,

  -- Metadata
  correlation_id  UUID NOT NULL DEFAULT gen_random_uuid(), -- For end-to-end tracing
  created_by      TEXT NOT NULL,                  -- 'human:<user_id>', 'webhook:<source>', 'orchestrator:<reason>'
  summary         TEXT,                           -- Human-readable summary (populated on completion)

  -- Counters (tracked by orchestrator, consumed by PM Engine for predictions)
  phase_transitions  INTEGER NOT NULL DEFAULT 0,
  total_tasks        INTEGER NOT NULL DEFAULT 0,
  failed_tasks       INTEGER NOT NULL DEFAULT 0,
  plan_revisions     INTEGER NOT NULL DEFAULT 0,  -- Times plan was rejected and re-planned
  test_fix_attempts  INTEGER NOT NULL DEFAULT 0,  -- Times test failure triggered rework
  review_rounds      INTEGER NOT NULL DEFAULT 0,  -- Times code review was requested

  CONSTRAINT valid_state CHECK (state IN ('active', 'paused', 'blocked', 'finished')),
  CONSTRAINT valid_priority CHECK (priority BETWEEN 1 AND 10),
  CONSTRAINT valid_autonomy CHECK (autonomy_level BETWEEN 0 AND 3)
);

CREATE INDEX idx_runs_project ON runs(project_id, state);
CREATE INDEX idx_runs_work_item ON runs(source_ref);
CREATE INDEX idx_runs_parent ON runs(parent_run_id) WHERE parent_run_id IS NOT NULL;
CREATE INDEX idx_runs_state ON runs(state) WHERE state IN ('active', 'blocked');
```

### 1.2 Run Phases

Tracks the history of phase transitions for a run. This is the run's audit trail.

```sql
CREATE TABLE run_phases (
  phase_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id          UUID NOT NULL REFERENCES runs(run_id),
  phase_name      TEXT NOT NULL,                  -- e.g., 'planning', 'implementing', 'reviewing'
  sequence_num    INTEGER NOT NULL,               -- Order within this run (0-indexed)

  -- Lifecycle
  entered_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  exited_at       TIMESTAMPTZ,
  duration_ms     INTEGER GENERATED ALWAYS AS (
    EXTRACT(EPOCH FROM (exited_at - entered_at)) * 1000
  ) STORED,

  -- Result
  exit_reason     TEXT,                           -- 'success', 'failure', 'timeout', 'skipped', 'cancelled'
  exit_detail     TEXT,                           -- Human-readable detail

  -- Worker assignment
  task_id         UUID REFERENCES tasks(task_id), -- The task that executed this phase
  worker_id       TEXT,                           -- Which worker handled it

  CONSTRAINT unique_phase_sequence UNIQUE (run_id, sequence_num)
);

CREATE INDEX idx_run_phases_run ON run_phases(run_id);
```

### 1.3 Tasks

A task is a unit of work assigned to a worker. One run phase typically produces one task, but a retry creates a new task for the same phase.

```sql
CREATE TABLE tasks (
  task_id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id          UUID NOT NULL REFERENCES runs(run_id),
  phase_name      TEXT NOT NULL,                  -- Which phase this task fulfills

  -- Assignment
  operation       TEXT NOT NULL,                  -- e.g., 'planning.create', 'implementation.execute', 'script.lint', 'review.code'
  worker_id       TEXT,                           -- Assigned worker (null if unassigned)
  worker_type     TEXT NOT NULL,                  -- 'ai', 'script', 'human', 'service'

  -- State
  state           TEXT NOT NULL DEFAULT 'queued', -- 'queued', 'assigned', 'running', 'completed', 'failed', 'cancelled'
  queued_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  assigned_at     TIMESTAMPTZ,
  started_at      TIMESTAMPTZ,
  completed_at    TIMESTAMPTZ,

  -- Input/Output
  input_payload   JSONB NOT NULL,                 -- Task request (operation-specific)
  output_payload  JSONB,                          -- Task result (populated on completion)
  artifacts       JSONB DEFAULT '[]'::jsonb,      -- Produced artifacts [{type, path, hash}]

  -- Retry tracking
  attempt_number  INTEGER NOT NULL DEFAULT 1,
  max_attempts    INTEGER NOT NULL DEFAULT 3,
  previous_task_id UUID REFERENCES tasks(task_id),-- Points to the failed task this retries

  -- Constraints
  timeout_ms      INTEGER NOT NULL DEFAULT 300000,-- 5 minutes default
  priority        INTEGER NOT NULL DEFAULT 5,     -- Inherited from run

  CONSTRAINT valid_task_state CHECK (state IN ('queued', 'assigned', 'running', 'completed', 'failed', 'cancelled')),
  CONSTRAINT valid_worker_type CHECK (worker_type IN ('ai', 'script', 'human', 'service'))
);

CREATE INDEX idx_tasks_run ON tasks(run_id);
CREATE INDEX idx_tasks_worker ON tasks(worker_id) WHERE state = 'running';
CREATE INDEX idx_tasks_state ON tasks(state) WHERE state IN ('queued', 'assigned', 'running');
CREATE INDEX idx_tasks_queue ON tasks(operation, state, priority) WHERE state = 'queued';
```

### 1.4 Task Dependencies

Tasks within a run (or across runs) can depend on each other.

```sql
CREATE TABLE task_dependencies (
  dependency_id   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id         UUID NOT NULL REFERENCES tasks(task_id),      -- The task that is blocked
  depends_on      UUID NOT NULL REFERENCES tasks(task_id),      -- The task that must complete first
  dep_type        TEXT NOT NULL DEFAULT 'blocks',               -- 'blocks', 'data_flow'
  satisfied       BOOLEAN NOT NULL DEFAULT FALSE,
  satisfied_at    TIMESTAMPTZ,

  CONSTRAINT unique_dependency UNIQUE (task_id, depends_on),
  CONSTRAINT no_self_dependency CHECK (task_id != depends_on)
);

CREATE INDEX idx_task_deps_task ON task_dependencies(task_id) WHERE NOT satisfied;
CREATE INDEX idx_task_deps_blocker ON task_dependencies(depends_on) WHERE NOT satisfied;
```

---

## 2. Worker Tables

### 2.1 Worker Registry

Tracks all registered workers and their current status.

```sql
CREATE TABLE workers (
  worker_id       TEXT PRIMARY KEY,               -- Unique identifier (e.g., 'script-eslint-1', 'ai-claude-planner-1')
  worker_type     TEXT NOT NULL,                  -- 'ai', 'script', 'human', 'service'
  display_name    TEXT NOT NULL,

  -- Capabilities (from Agent Card)
  capabilities    JSONB NOT NULL,                 -- Operations this worker accepts
  max_parallel    INTEGER NOT NULL DEFAULT 1,     -- Max concurrent tasks

  -- AI-specific (null for non-AI workers)
  model_id        TEXT,                           -- e.g., 'claude-opus-4-6'
  token_budget    INTEGER,                        -- Per-task token limit

  -- Script-specific (null for non-script workers)
  script_path     TEXT,                           -- Path to the executable
  runtime         TEXT,                           -- 'bash', 'node', 'python', 'binary'
  sandbox_mode    TEXT DEFAULT 'read-only',       -- 'read-only', 'workspace-write', 'full-access'

  -- Status
  status          TEXT NOT NULL DEFAULT 'idle',   -- 'idle', 'active', 'draining', 'dead', 'disabled'
  current_tasks   INTEGER NOT NULL DEFAULT 0,

  -- Health
  registered_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_heartbeat  TIMESTAMPTZ NOT NULL DEFAULT now(),
  heartbeat_interval_ms INTEGER NOT NULL DEFAULT 30000,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,

  -- Lifetime stats
  tasks_completed INTEGER NOT NULL DEFAULT 0,
  tasks_failed    INTEGER NOT NULL DEFAULT 0,
  avg_duration_ms REAL NOT NULL DEFAULT 0,        -- Running average

  CONSTRAINT valid_worker_type CHECK (worker_type IN ('ai', 'script', 'human', 'service')),
  CONSTRAINT valid_status CHECK (status IN ('idle', 'active', 'draining', 'dead', 'disabled'))
);

CREATE INDEX idx_workers_type_status ON workers(worker_type, status);
CREATE INDEX idx_workers_available ON workers(status, current_tasks)
  WHERE status IN ('idle', 'active');
```

### 2.2 Worker Capabilities

Normalized table for efficient capability-based lookup.

```sql
CREATE TABLE worker_capabilities (
  worker_id       TEXT NOT NULL REFERENCES workers(worker_id) ON DELETE CASCADE,
  operation       TEXT NOT NULL,                  -- e.g., 'planning.create', 'script.lint', 'review.code'
  priority_boost  INTEGER NOT NULL DEFAULT 0,     -- Bonus priority for this operation (expertise)

  CONSTRAINT unique_capability UNIQUE (worker_id, operation)
);

CREATE INDEX idx_worker_caps_operation ON worker_capabilities(operation);
```

### 2.3 Circuit Breakers

Tracks circuit breaker state per worker type to prevent cascading failures.

```sql
CREATE TABLE circuit_breakers (
  worker_type     TEXT PRIMARY KEY,
  state           TEXT NOT NULL DEFAULT 'closed', -- 'closed', 'open', 'half_open'
  failure_count   INTEGER NOT NULL DEFAULT 0,
  failure_threshold INTEGER NOT NULL DEFAULT 3,
  opened_at       TIMESTAMPTZ,
  half_open_at    TIMESTAMPTZ,
  cooldown_ms     INTEGER NOT NULL DEFAULT 60000, -- Time before half-open attempt
  last_failure_at TIMESTAMPTZ,
  last_success_at TIMESTAMPTZ,

  CONSTRAINT valid_cb_state CHECK (state IN ('closed', 'open', 'half_open'))
);
```

---

## 3. Workflow Tables

### 3.1 Workflow Templates

Defines the shape of how work flows through the system.

```sql
CREATE TABLE workflow_templates (
  template_id     TEXT PRIMARY KEY,               -- e.g., 'feature', 'bug_fix', 'spike', 'epic', 'incident'
  project_id      UUID REFERENCES projects(project_id), -- NULL = global/built-in template
  display_name    TEXT NOT NULL,
  description     TEXT,

  -- Matching rules (when this template applies)
  match_rules     JSONB NOT NULL,                 -- {work_item_types, estimated_scope, labels}

  -- Limits
  max_plan_revisions    INTEGER NOT NULL DEFAULT 3,
  max_test_attempts     INTEGER NOT NULL DEFAULT 3,
  max_review_rounds     INTEGER NOT NULL DEFAULT 3,
  max_duration_hours    INTEGER NOT NULL DEFAULT 72,

  -- Graph definition
  phases          JSONB NOT NULL,                 -- Array of phase definitions
  edges           JSONB NOT NULL,                 -- Array of transition edges

  -- Metadata
  is_builtin      BOOLEAN NOT NULL DEFAULT FALSE,
  version         INTEGER NOT NULL DEFAULT 1,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_templates_project ON workflow_templates(project_id);
```

**Phase definition (JSONB element):**

```json
{
  "phase_id": "implementing",
  "display_name": "Implementation",
  "required_capability": "implementation.execute",
  "worker_type_preference": "ai",
  "gate_ids": ["tests_pass"],
  "artifacts_produced": ["CODE", "TEST_REPORT"],
  "artifacts_required": ["PLAN"],
  "timeout_ms": 1800000,
  "skippable": false
}
```

**Edge definition (JSONB element):**

```json
{
  "from": "implementing",
  "to": "reviewing",
  "priority": 1,
  "condition": {
    "type": "step_result",
    "result": "success"
  }
}
```

### 3.2 Workflow Overrides

Per-run overrides that modify the template dynamically.

```sql
CREATE TABLE workflow_overrides (
  override_id     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id          UUID NOT NULL REFERENCES runs(run_id),
  override_type   TEXT NOT NULL,                  -- 'insert_phase', 'skip_phase', 'modify_limit', 'add_gate'
  target_phase    TEXT,                           -- Phase being modified
  override_data   JSONB NOT NULL,                 -- Type-specific override payload
  reason          TEXT NOT NULL,                  -- Why this override was applied
  source          TEXT NOT NULL,                  -- 'intelligence', 'policy', 'human', 'orchestrator'
  applied_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT valid_override_type CHECK (override_type IN (
    'insert_phase', 'skip_phase', 'modify_limit', 'add_gate', 'modify_timeout'
  ))
);

CREATE INDEX idx_overrides_run ON workflow_overrides(run_id);
```

---

## 4. Event Tables

### 4.1 Orchestrator Events

The orchestrator's append-only event stream. Every state change, decision, and failure is recorded.

```sql
CREATE TABLE orchestrator_events (
  event_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  correlation_id  UUID NOT NULL,                  -- Links to run.correlation_id
  run_id          UUID REFERENCES runs(run_id),   -- NULL for system events
  task_id         UUID REFERENCES tasks(task_id), -- NULL for run-level events

  -- Event classification
  event_type      TEXT NOT NULL,
  category        TEXT NOT NULL,                  -- 'fact', 'decision', 'signal'
  severity        TEXT NOT NULL DEFAULT 'info',   -- 'info', 'warning', 'error', 'critical'

  -- Payload
  message         TEXT NOT NULL,                  -- Human-readable description
  metadata        JSONB DEFAULT '{}'::jsonb,      -- Structured data specific to event type

  -- Context
  source          TEXT NOT NULL,                  -- 'orchestrator', 'worker:<id>', 'human:<id>', 'webhook', 'pm_engine'
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT valid_category CHECK (category IN ('fact', 'decision', 'signal')),
  CONSTRAINT valid_severity CHECK (severity IN ('info', 'warning', 'error', 'critical'))
);

CREATE INDEX idx_events_run ON orchestrator_events(run_id, created_at);
CREATE INDEX idx_events_correlation ON orchestrator_events(correlation_id, created_at);
CREATE INDEX idx_events_type ON orchestrator_events(event_type, created_at);
```

**Event types:**

| Event Type | Category | When |
| --- | --- | --- |
| `run.created` | fact | Run created |
| `run.started` | fact | Run moved from pending to active |
| `run.phase_changed` | fact | Run transitioned to a new phase |
| `run.blocked` | fact | Run entered blocked state |
| `run.completed` | fact | Run completed successfully |
| `run.cancelled` | fact | Run was cancelled |
| `task.queued` | fact | Task placed in queue |
| `task.assigned` | fact | Task assigned to a worker |
| `task.started` | fact | Worker began executing task |
| `task.completed` | fact | Task completed (success or failure) |
| `task.reassigned` | fact | Task moved to a different worker |
| `worker.registered` | fact | Worker joined the registry |
| `worker.heartbeat_missed` | signal | Worker missed expected heartbeat |
| `worker.dead` | fact | Worker marked as dead |
| `worker.circuit_open` | signal | Circuit breaker opened for a worker type |
| `decision.template_selected` | decision | Orchestrator chose a workflow template |
| `decision.worker_selected` | decision | Orchestrator chose a worker for a task |
| `decision.override_applied` | decision | Workflow was dynamically modified |
| `decision.gate_evaluated` | decision | Gate passed or failed |
| `decision.auto_approved` | decision | Action approved automatically (autonomy level) |
| `decision.escalated` | decision | Action escalated to human |
| `intelligence.queried` | signal | PM Engine was consulted |
| `intelligence.degraded` | signal | PM Engine unavailable, using defaults |

### 4.2 Artifacts

Outputs produced by workers during runs.

```sql
CREATE TABLE artifacts (
  artifact_id     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id          UUID NOT NULL REFERENCES runs(run_id),
  task_id         UUID REFERENCES tasks(task_id),
  phase_name      TEXT NOT NULL,

  artifact_type   TEXT NOT NULL,                  -- 'PLAN', 'CODE', 'TEST_REPORT', 'REVIEW', 'RESEARCH', 'DEPLOY_LOG'
  content_hash    TEXT NOT NULL,                  -- SHA-256 of content
  storage_path    TEXT NOT NULL,                  -- Path in artifact storage
  size_bytes      INTEGER NOT NULL,

  -- Metadata
  metadata        JSONB DEFAULT '{}'::jsonb,      -- Type-specific metadata
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT valid_artifact_type CHECK (artifact_type IN (
    'PLAN', 'PLAN_METADATA', 'CODE', 'PATCHSET', 'TEST_REPORT',
    'REVIEW', 'REVIEW_FINDINGS', 'REVIEW_VERDICT', 'RESEARCH',
    'STANDUP', 'RETRO', 'RELEASE_NOTES', 'DEPLOY_LOG', 'METRICS', 'CUSTOM'
  ))
);

CREATE INDEX idx_artifacts_run ON artifacts(run_id);
CREATE INDEX idx_artifacts_type ON artifacts(artifact_type, run_id);
```

---

## 5. Project Configuration

### 5.1 Projects

Top-level project configuration.

```sql
CREATE TABLE projects (
  project_id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  display_name    TEXT NOT NULL,
  slug            TEXT NOT NULL UNIQUE,           -- URL-friendly identifier

  -- Source system connection
  source_system   TEXT NOT NULL DEFAULT 'github',
  source_config   JSONB NOT NULL,                 -- {owner, repo, app_installation_id, ...}

  -- Defaults
  default_autonomy_level INTEGER NOT NULL DEFAULT 1,
  default_template_id    TEXT NOT NULL DEFAULT 'feature',
  auto_triage            TEXT NOT NULL DEFAULT 'off', -- 'off', 'suggest', 'auto'

  -- PM Engine connection
  pm_engine_url   TEXT,                           -- URL to PM Engine MCP server (null = embedded)

  -- Status
  status          TEXT NOT NULL DEFAULT 'active', -- 'active', 'paused', 'archived'
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT valid_project_status CHECK (status IN ('active', 'paused', 'archived')),
  CONSTRAINT valid_auto_triage CHECK (auto_triage IN ('off', 'suggest', 'auto'))
);
```

### 5.2 Project Workers

Maps which workers are available for which projects.

```sql
CREATE TABLE project_workers (
  project_id      UUID NOT NULL REFERENCES projects(project_id),
  worker_id       TEXT NOT NULL REFERENCES workers(worker_id),
  enabled         BOOLEAN NOT NULL DEFAULT TRUE,
  config_overrides JSONB DEFAULT '{}'::jsonb,     -- Project-specific worker config

  CONSTRAINT unique_project_worker UNIQUE (project_id, worker_id)
);

CREATE INDEX idx_project_workers_project ON project_workers(project_id) WHERE enabled;
```

### 5.3 Notification Channels

How humans get notified about orchestrator events.

```sql
CREATE TABLE notification_channels (
  channel_id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id      UUID NOT NULL REFERENCES projects(project_id),
  channel_type    TEXT NOT NULL,                  -- 'web_ui', 'email', 'slack', 'openclaw', 'webhook'
  config          JSONB NOT NULL,                 -- Type-specific configuration

  -- Filtering
  event_filter    JSONB DEFAULT '{"severity": ["warning", "error", "critical"]}'::jsonb,
  enabled         BOOLEAN NOT NULL DEFAULT TRUE,

  CONSTRAINT valid_channel_type CHECK (channel_type IN (
    'web_ui', 'email', 'slack', 'openclaw', 'webhook'
  ))
);

CREATE INDEX idx_channels_project ON notification_channels(project_id) WHERE enabled;
```

### 5.4 User Notification Preferences

Per-user overrides for notification routing.

```sql
CREATE TABLE user_notification_preferences (
  user_id         TEXT NOT NULL,
  project_id      UUID NOT NULL REFERENCES projects(project_id),
  channel_type    TEXT NOT NULL,                  -- 'web_ui', 'email', 'slack', 'openclaw', 'webhook'
  enabled         BOOLEAN NOT NULL DEFAULT TRUE,
  min_urgency     TEXT NOT NULL DEFAULT 'low',    -- 'low', 'normal', 'medium', 'high'

  CONSTRAINT unique_user_channel UNIQUE (user_id, project_id, channel_type),
  CONSTRAINT valid_urgency CHECK (min_urgency IN ('low', 'normal', 'medium', 'high'))
);

CREATE INDEX idx_user_prefs_user ON user_notification_preferences(user_id, project_id);
```

---

## 6. Queue State (Redis)

These structures live in Redis, not PostgreSQL. They are ephemeral and reconstructable from the database.

### 6.1 Task Queues (BullMQ)

| Queue Name | Producer | Consumer | Priority |
| --- | --- | --- | --- |
| `conductor:webhooks` | API gateway | Orchestrator | FIFO |
| `conductor:runs` | API / Orchestrator | Orchestrator | Priority-ordered |
| `conductor:task:plan` | Orchestrator | Planner workers | Priority-ordered |
| `conductor:task:implement` | Orchestrator | Implementer workers | Priority-ordered |
| `conductor:task:review` | Orchestrator | Reviewer workers | Priority-ordered |
| `conductor:task:script:<operation>` | Orchestrator | Script workers | FIFO |
| `conductor:task:human` | Orchestrator | Human notification | Priority-ordered |
| `conductor:events` | All workers | Orchestrator | FIFO |
| `conductor:cleanup` | Orchestrator | Janitor worker | Low priority |
| `conductor:dead:<queue>` | Queue processor | Manual / UI | None (inspect only) |

Script workers get per-operation queues (e.g., `conductor:task:script:lint`, `conductor:task:script:test`) because they are deterministic routed — the operation maps directly to the worker.

### 6.2 Worker Heartbeats (Redis)

```
Key:    conductor:heartbeat:<worker_id>
Value:  { status, current_task_count, current_task_ids, resource_usage, timestamp }
TTL:    60 seconds (2x heartbeat interval — matches dead detection threshold)
```

When a heartbeat key expires, the orchestrator's heartbeat monitor picks it up and marks the worker as dead.

### 6.3 Distributed Locks (Redis)

```
Key:    conductor:lock:run:<run_id>
TTL:    30 seconds (auto-renewed while held)
```

The orchestrator acquires a lock on a run before evaluating transitions. This prevents race conditions when multiple events arrive for the same run concurrently.

---

## 7. Schema Migrations

The orchestrator uses a migration framework (e.g., `postgres-migrations` or `dbmate`). Migrations are stored in `migrations/orchestrator/` and versioned.

```sql
CREATE TABLE orchestrator_migrations (
  version         INTEGER PRIMARY KEY,
  name            TEXT NOT NULL,
  applied_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

The PM Engine manages its own migrations independently (SQLite in `.pm/state.db`).

---

## 8. Data Retention

| Table | Retention | Rationale |
| --- | --- | --- |
| `runs` | Indefinite | Audit trail, intelligence input |
| `run_phases` | Indefinite | Phase timing data feeds PM Engine |
| `tasks` | 90 days (soft delete) | Detailed task data only needed for recent analysis |
| `orchestrator_events` | 180 days | Event volume is high; older events archived to cold storage |
| `artifacts` | 30 days (content), indefinite (metadata) | Artifact content is large; metadata retained for traceability |
| `workers` | Indefinite (pruned on deregistration) | Active registry only |
| `circuit_breakers` | Indefinite | Small table, always needed |
| `workflow_templates` | Indefinite | Templates are versioned, never deleted |

Retention is enforced by a scheduled cleanup job, not by cascade deletes.
