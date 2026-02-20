# Data Model Authority

> **Status:** Normative. This is the master index for all database schemas in Conductor. Individual component DATA_MODEL.md files contain the detailed table definitions; this document provides the unified architecture, cross-database relationships, naming conventions, and migration strategy.

## 1. Database Architecture

Conductor uses three databases, each owned by a specific component:

```
┌─────────────────────────────────────────────────────────────────────────┐
│                          Conductor System                               │
│                                                                         │
│  ┌─────────────────────┐  ┌──────────────────────┐  ┌────────────────┐ │
│  │  CORE DATABASE       │  │  ORCHESTRATOR DB      │  │  PM ENGINE DB  │ │
│  │  PostgreSQL          │  │  PostgreSQL            │  │  SQLite        │ │
│  │                      │  │                        │  │                │ │
│  │  Runs, Gates,        │  │  Workflow Templates,   │  │  Work Items,   │ │
│  │  Policies, Audit,    │  │  Workers, Tasks,       │  │  Dependencies, │ │
│  │  GitHub Integration, │  │  Phase History,        │  │  Iterations,   │ │
│  │  Auth (users/sessions)│  │  Notifications         │  │  Memory,       │ │
│  │                      │  │                        │  │  AI Projections│ │
│  └──────────┬───────────┘  └──────────┬─────────────┘  └───────┬────────┘ │
│             │                         │                        │          │
│             └─────────────────────────┼────────────────────────┘          │
│                                       │                                   │
│  ┌────────────────────────────────────┴──────────────────────────────┐   │
│  │  REDIS (Ephemeral)                                                │   │
│  │  BullMQ job queues, worker heartbeats, distributed locks          │   │
│  │  Reconstructable from database state — NOT a persistence layer    │   │
│  └───────────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────┘
```

| Database | Engine | Owner | Purpose | Schema Doc |
| --- | --- | --- | --- | --- |
| **Core** | PostgreSQL 16+ | Conductor API server | Operational state, policy, audit, auth, GitHub integration | `docs/DATA_MODEL.md` |
| **Orchestrator** | PostgreSQL 16+ (same instance, separate schema) | Orchestrator service | Workflow execution, workers, phase transitions, notifications | `docs/orchestrator/DATA_MODEL.md` |
| **PM Engine** | SQLite (via `better-sqlite3`) | PM Intelligence service | Work item planning, dependency graphs, AI projections, memory | `docs/pm-engine/DATA_MODEL.md` |
| **Redis** | Redis 7+ | BullMQ | Job queues, worker heartbeats, distributed locks | `docs/orchestrator/DATA_MODEL.md` § Redis |

### 1.1 Why Three Databases?

| Decision | Rationale |
| --- | --- |
| **Core + Orchestrator in PostgreSQL** | Shared ACID transactions for run lifecycle; separate schemas for ownership clarity |
| **PM Engine in SQLite** | Local-first design; PM intelligence runs without network dependency; portable |
| **Redis as ephemeral queue** | BullMQ requires Redis; all queue state is reconstructable from PostgreSQL |

### 1.2 PostgreSQL Schema Separation

Core and Orchestrator share a PostgreSQL instance but use separate schemas:

```sql
CREATE SCHEMA IF NOT EXISTS conductor;   -- Core tables
CREATE SCHEMA IF NOT EXISTS orchestrator; -- Orchestrator tables
```

Cross-schema references use fully qualified names: `orchestrator.workers`, `conductor.runs`.

---

## 2. Table Inventory

### 2.1 Core Database (45 tables)

| Category | Tables | Primary Keys |
| --- | --- | --- |
| **Auth** | `users`, `sessions`, `api_keys`, `user_api_keys` | `user_id`, `session_id`, `key_id`, `(user_id, provider)` |
| **Projects** | `projects`, `repos` | `project_id`, `repo_id` |
| **Work Items** | `tasks` | `task_id` |
| **Runs** | `runs`, `worktrees`, `port_leases` | `run_id`, `worktree_id`, `port_lease_id` |
| **Gates** | `gate_definitions`, `gate_evaluations` | `gate_id`, `gate_evaluation_id` |
| **Policies** | `policy_definitions`, `policy_sets`, `policy_set_entries`, `policy_violations`, `policy_audit_entries` | `policy_id`, `policy_set_id`, etc. |
| **Execution** | `agent_invocations`, `tool_invocations`, `artifacts`, `routing_decisions` | respective `*_id` PKs |
| **Operator** | `operator_actions`, `overrides`, `evidences` | respective `*_id` PKs |
| **GitHub** | `github_writes`, `webhook_deliveries` | `github_write_id`, `delivery_id` |
| **Events** | `events` | `event_id` |
| **Jobs** | `jobs` | `job_id` |

### 2.2 Orchestrator Database (20 tables)

| Category | Tables | Primary Keys |
| --- | --- | --- |
| **Execution** | `runs`, `run_phases`, `tasks`, `task_dependencies` | `run_id`, `phase_id`, `task_id`, `dependency_id` |
| **Workers** | `workers`, `worker_capabilities`, `circuit_breakers` | `worker_id`, `(worker_id, operation)`, `worker_type` |
| **Templates** | `workflow_templates`, `workflow_overrides` | `template_id`, `override_id` |
| **Events** | `orchestrator_events` | `event_id` |
| **Artifacts** | `artifacts` | `artifact_id` |
| **Config** | `projects`, `project_workers`, `notification_channels`, `user_notification_preferences` | `project_id`, etc. |

### 2.3 PM Engine Database (40+ tables)

| Category | Tables | Primary Keys |
| --- | --- | --- |
| **Work Items** | `pm_work_items`, `pm_work_item_labels`, `pm_work_item_repo_links`, `pm_external_items` | `work_item_id`, etc. |
| **AI** | `pm_work_item_ai_current`, `pm_work_item_ai_history` | `work_item_id`, `ai_snapshot_id` |
| **Value** | `pm_value_profiles`, `pm_value_profile_history` | `work_item_id`, `value_snapshot_id` |
| **Dependencies** | `pm_dependencies`, `pm_dependency_closure`, `pm_dependency_metrics` | `dependency_id`, etc. |
| **Iterations** | `pm_iterations`, `pm_iteration_items` | `iteration_id`, etc. |
| **Stakeholders** | `pm_stakeholders`, `pm_work_item_stakeholders`, `pm_urgency_signals` | `stakeholder_id`, etc. |
| **Memory** | `pm_decisions`, `pm_outcomes`, `pm_decision_tags`, `pm_outcome_tags`, FTS tables, view | `decision_id`, `outcome_id` |
| **Review** | `pm_review_findings` | `finding_id` |
| **Initiatives** | `pm_initiatives`, `pm_initiative_items` | `initiative_id` |
| **Events** | `pm_event_types`, `pm_event_project_sequences`, `pm_events` | `event_type`, `project_id`, `event_id` |
| **Sync** | `pm_sync_cursors`, `pm_sync_inbox`, `pm_sync_conflicts` | `sync_cursor_id`, `inbox_id`, `conflict_id` |
| **Subscriptions** | `pm_event_subscriptions`, `pm_event_delivery_log` | `subscription_id`, `delivery_id` |
| **Config** | `pm_project_settings` | `project_id` |

---

## 3. Cross-Database Relationships

These three databases are linked by shared identifiers, not foreign keys (cross-database FKs are not possible):

```
┌──────────────────┐      ┌──────────────────────┐      ┌──────────────────┐
│    CORE DB        │      │   ORCHESTRATOR DB     │      │   PM ENGINE DB   │
│                   │      │                       │      │                  │
│  projects         │◄────►│  projects             │◄────►│  (project_id     │
│  .project_id      │      │  .project_id          │      │   in all tables) │
│                   │      │                       │      │                  │
│  tasks            │──────│  runs                 │──────│  pm_work_items   │
│  .task_id         │      │  .work_item_id        │      │  .work_item_id   │
│  .github_node_id  │      │  .work_item_type      │      │  .work_item_uid  │
│                   │      │                       │      │                  │
│  runs             │◄────►│  runs                 │      │  pm_external_    │
│  .run_id          │      │  .run_id              │      │  items           │
│                   │      │  .correlation_id      │      │  .external_      │
│                   │      │                       │      │   node_id        │
│  users            │      │  workers              │      │                  │
│  .user_id         │      │  .worker_id           │      │                  │
│  (github node_id) │      │                       │      │                  │
└──────────────────┘      └──────────────────────┘      └──────────────────┘
```

### 3.1 Shared Identifiers

| Identifier | Format | Where Used | Invariant |
| --- | --- | --- | --- |
| `project_id` | UUID v7 | All three DBs | Created in Core, referenced by ID in Orchestrator and PM Engine |
| `run_id` | UUID v7 | Core + Orchestrator | Created in Orchestrator, mirrored to Core |
| `work_item_id` | Integer (PM) / TEXT (Core `task_id`) | PM Engine + Orchestrator | PM Engine is source of truth; Orchestrator references by `work_item_id` |
| `github_node_id` | GitHub opaque ID | Core (`tasks`, `repos`) + PM Engine (`pm_external_items`) | GitHub is source of truth; used for dedup on sync |
| `user_id` | GitHub `node_id` | Core (auth) + PM Engine (actor fields) | Core is source of truth for user identity |
| `correlation_id` | UUID v7 | Core + Orchestrator events | Links events across databases for the same logical operation |

### 3.2 Cross-Database Consistency

Since foreign keys cannot span databases, consistency is maintained by:

1. **Sync on write:** When Core creates a project, Orchestrator and PM Engine are notified via event bus
2. **Idempotent upsert:** All cross-database writes use `ON CONFLICT ... DO UPDATE`
3. **Correlation IDs:** Events in different databases share `correlation_id` for tracing
4. **Eventual consistency:** PM Engine may lag behind Core/Orchestrator; this is acceptable since PM intelligence is advisory, not authoritative for operational state

---

## 4. Naming Conflicts Resolution

Several table names appear in multiple databases. This is intentional — they represent different facets of the same concept:

### 4.1 `runs`

| Database | Full Name | Purpose | Phase Storage |
| --- | --- | --- | --- |
| Core | `conductor.runs` | Operational record: policy set, PR, git state | `phase` (canonical enum from PROTOCOL.md) |
| Orchestrator | `orchestrator.runs` | Execution record: workflow template, counters, priority | `current_phase` (maps to template phase name) |

**Resolution:** Same `run_id` in both tables. Core holds the authoritative phase (per PROTOCOL.md invariant: "Run phase may change only via orchestrator-emitted events"). Orchestrator holds execution details. Queries that need both join on `run_id`.

### 4.2 `tasks`

| Database | Full Name | Purpose | Identity |
| --- | --- | --- | --- |
| Core | `conductor.tasks` | GitHub issue/PR registration | `task_id` (TEXT), `github_node_id` |
| Orchestrator | `orchestrator.tasks` | Worker execution assignment | `task_id` (UUID), maps to `operation` enum |

**Resolution:** Different concepts with the same name. Core `tasks` are work items (issues/PRs). Orchestrator `tasks` are execution units (a single worker assignment within a run). Cross-reference: `orchestrator.runs.work_item_id` → `conductor.tasks.task_id`.

### 4.3 `artifacts`

| Database | Full Name | Type Enum |
| --- | --- | --- |
| Core | `conductor.artifacts` | `plan`, `review`, `test_report`, `other` |
| Orchestrator | `orchestrator.artifacts` | `PLAN`, `CODE`, `TEST_REPORT`, `REVIEW`, `PATCHSET`, `REVIEW_FINDINGS`, `RELEASE_NOTES`, `DEPLOY_LOG`, `METRICS`, `CUSTOM` |

**Resolution:** Orchestrator has the richer enum (12 types vs 4). Core's `other` maps to Orchestrator-specific types. Same `artifact_id` used in both.

### 4.4 `projects`

| Database | Full Name | Purpose |
| --- | --- | --- |
| Core | `conductor.projects` | Project ownership, GitHub org binding, port ranges |
| Orchestrator | `orchestrator.projects` | Workflow defaults, autonomy level, PM engine URL |

**Resolution:** Same `project_id`. Core holds auth/ownership; Orchestrator holds execution configuration.

### 4.5 `events` / `orchestrator_events` / `pm_events`

Three separate event streams:

| Stream | Database | Scope | Ordering |
| --- | --- | --- | --- |
| `conductor.events` | Core | Run lifecycle, gates, policies | Per-run sequence |
| `orchestrator.orchestrator_events` | Orchestrator | Workflow execution, worker activity | Per-run via `run_id` |
| `pm_events` | PM Engine | Planning, dependencies, memory | Per-project monotonic sequence |

All three use `correlation_id` for cross-stream tracing.

---

## 5. Identity Model

### 5.1 Primary Keys

| Entity | PK Format | Generated By | Rationale |
| --- | --- | --- | --- |
| Users | GitHub `node_id` (TEXT) | GitHub | Immutable across username changes |
| Projects | UUID v7 | Conductor | Sortable by creation time |
| Repos | UUID v7 | Conductor | — |
| Runs | UUID v7 | Orchestrator | Sortable, unique across instances |
| Tasks (Core) | UUID v7 | Conductor | — |
| Tasks (Orchestrator) | UUID v7 | Orchestrator | — |
| Work Items (PM) | INTEGER AUTOINCREMENT | PM Engine | SQLite-native, fast |
| Events | UUID v7 (Core/Orch) / INTEGER (PM) | Each database | Engine-appropriate |

### 5.2 GitHub Identity Mapping

GitHub entities use `node_id` as the stable identifier:

```
GitHub Entity     → Conductor column          → Never use as key
─────────────────────────────────────────────────────────────────
Repository        → repos.github_node_id      → repos.github_name (mutable)
Issue/PR          → tasks.github_node_id      → tasks.github_issue_number (mutable on transfer)
User              → users.user_id             → users.login (mutable)
```

---

## 6. Migration Strategy

### 6.1 Migration Tool

| Database | Migration Tool | File Location |
| --- | --- | --- |
| Core + Orchestrator (PostgreSQL) | Raw SQL files with version numbers | `migrations/postgres/` |
| PM Engine (SQLite) | Raw SQL files with version numbers | `migrations/sqlite/` |

### 6.2 Version Tracking

Each database tracks its schema version:

```sql
-- PostgreSQL (shared by Core + Orchestrator)
CREATE TABLE conductor._schema_version (
  version     INTEGER PRIMARY KEY,
  description TEXT NOT NULL,
  applied_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  checksum    TEXT NOT NULL  -- SHA-256 of migration file
);

-- SQLite (PM Engine)
CREATE TABLE _schema_version (
  version     INTEGER PRIMARY KEY,
  description TEXT NOT NULL,
  applied_at  TEXT NOT NULL DEFAULT (datetime('now')),
  checksum    TEXT NOT NULL
);
```

### 6.3 Migration File Naming

```
migrations/
  postgres/
    0001_initial_core_schema.sql
    0002_initial_orchestrator_schema.sql
    0003_add_policy_sets.sql
    0004_add_auth_tables.sql
    ...
  sqlite/
    0001_initial_pm_schema.sql
    0002_add_ai_projections.sql
    0003_add_dependency_closure.sql
    ...
```

### 6.4 Migration Rules

1. **Forward-only.** Migrations are never modified after deployment. Fix-ups are new migrations.
2. **Idempotent guards.** Each migration checks state before modifying: `CREATE TABLE IF NOT EXISTS`, `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`.
3. **Rollback script.** Each migration has a corresponding `down` file: `0003_add_policy_sets.down.sql`. Rollbacks are manual (operator runs explicitly), never automatic.
4. **Data migrations separate.** Schema changes and data transforms are in separate migration files. Schema first, data second.
5. **Version gates.** Application startup checks `_schema_version` and refuses to start if migrations are pending:
   ```
   Error: Database schema version 3, application requires version 5.
   Run: conductor migrate up
   ```

### 6.5 Breaking Change Policy

| Change Type | Breaking? | Requires |
| --- | --- | --- |
| Add table | No | Migration only |
| Add nullable column | No | Migration only |
| Add NOT NULL column with default | No | Migration only |
| Add NOT NULL column without default | **Yes** | Data migration + schema migration |
| Remove column | **Yes** | Deprecation period (1 minor version) |
| Rename column | **Yes** | Add new + copy + deprecate old |
| Change column type | **Yes** | Add new column + data migration |
| Drop table | **Yes** | Deprecation period (1 minor version) |

---

## 7. Index Strategy

### 7.1 Required Indexes (All Databases)

Every table with a `run_id` or `project_id` FK MUST have an index on that column. This is non-negotiable for query performance.

### 7.2 Critical Indexes

| Table | Index | Type | Purpose |
| --- | --- | --- | --- |
| `conductor.runs` | `idx_runs_phase` | B-tree | Filter by current phase |
| `conductor.runs` | `idx_runs_paused` (partial: `WHERE paused_at IS NOT NULL`) | B-tree | Find paused runs |
| `conductor.events` | `idx_events_unprocessed` (partial: `WHERE processed_at IS NULL`) | B-tree | Event processing loop |
| `conductor.events` | `idx_events_run_sequence` on `(run_id, sequence)` | B-tree (unique) | Event ordering per run |
| `conductor.github_writes` | `idx_github_writes_retry` (partial: `WHERE status IN ('queued','failed')`) | B-tree | Retry processing |
| `conductor.jobs` | `idx_jobs_claimable` (partial: `WHERE status IN ('queued','processing')`) | B-tree | Job claiming |
| `orchestrator.tasks` | `idx_tasks_state` on `(state, priority)` | B-tree | Worker task claiming |
| `orchestrator.workers` | `idx_workers_status` | B-tree | Active worker lookup |
| `pm_events` | `idx_pm_events_project_seq` on `(project_id, sequence)` | B-tree (unique) | Event ordering |
| `pm_dependencies` | `idx_deps_successor` on `(successor_work_item_id)` | B-tree | Reverse dependency lookup |
| `pm_work_items` | `idx_work_items_state_priority` on `(state, priority_band)` | B-tree | Backlog queries |

### 7.3 Unique Constraints (Data Integrity)

| Table | Constraint | Purpose |
| --- | --- | --- |
| `conductor.github_writes` | `UNIQUE(idempotency_key)` | Prevent duplicate GitHub API calls |
| `conductor.events` | `UNIQUE(idempotency_key)` | Event deduplication |
| `conductor.port_leases` | `UNIQUE(project_id, port) WHERE is_active = TRUE` | One active lease per port |
| `orchestrator.run_phases` | `UNIQUE(run_id, sequence_num)` | Phase ordering integrity |
| `pm_events` | `UNIQUE(project_id, sequence)` | Event ordering |
| `pm_events` | `UNIQUE(idempotency_key)` | Event deduplication |
| `pm_dependencies` | `UNIQUE(predecessor, successor, relation_type) WHERE status = 'active'` | No duplicate active deps |

---

## 8. Data Flow Between Databases

```
GitHub Webhook → Core DB (webhook_deliveries)
                    │
                    ├──► Orchestrator DB (runs, tasks, phases)
                    │         │
                    │         ├──► PM Engine DB (work item sync)
                    │         │
                    │         └──► Redis (job queues)
                    │
                    └──► Core DB (events, github_writes)

Operator Action → Core DB (operator_actions)
                    │
                    └──► Orchestrator DB (workflow_overrides)

PM Intelligence Query → PM Engine DB (read)
                           │
                           └──► Orchestrator DB (advisory: routing, estimation)
```

**Write ownership:** Each database is written to by exactly one service. Cross-database writes go through the event bus, never direct SQL.

| Database | Write Owner | Other Services |
| --- | --- | --- |
| Core DB | Conductor API server | Read-only for others |
| Orchestrator DB | Orchestrator service | Read-only for API, PM Engine |
| PM Engine DB | PM Intelligence service | Read-only for Orchestrator |
| Redis | BullMQ (any service can enqueue) | All services read/write queues |

---

## 9. Cross-References

| Topic | Document |
| --- | --- |
| Core table definitions | `docs/DATA_MODEL.md` |
| Orchestrator table definitions | `docs/orchestrator/DATA_MODEL.md` |
| PM Engine table definitions | `docs/pm-engine/DATA_MODEL.md` |
| Auth tables (users, sessions, api_keys) | `docs/AUTH.md` § 2.3, § 3.3 |
| Worker credential tables | `docs/WORKER_CREDENTIALS.md` § Database Schema |
| Event schema and ordering | `docs/PROTOCOL.md` § Event Schema |
| Run phase transitions | `docs/PROTOCOL.md` § Run Phases |
| Canonical enums | Issue #168 (central enum registry) |
