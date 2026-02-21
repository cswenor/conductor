# Data Model Authority

> **Status:** Normative (v0.1 implementation). This document describes the schema that is actually implemented in code today.

## 1. Architecture (Actual v0.1)

Conductor v0.1 uses **one** SQLite database file, opened through `better-sqlite3`.

- There is no runtime PostgreSQL database.
- There is no separate runtime "orchestrator DB".
- There is no separate runtime "PM-engine DB".
- Redis is used for BullMQ queues/pubsub, not primary persistence.

Runtime initialization and safety settings:

- Shared DB init: `packages/shared/src/db/index.ts`
- Engine: `new Database(config.path, ...)` from `better-sqlite3`
- Pragmas at startup:
  - `journal_mode = WAL`
  - `foreign_keys = ON`
- Migrations run at startup before returning the DB handle.

## 2. Database Path Resolution

`DATABASE_PATH` is the single source of DB location for both web and worker.

- Web config default: `./conductor.db` in `packages/web/src/lib/config.ts`
- Web bootstrap path resolution: relative paths are resolved against monorepo root in `packages/web/src/lib/bootstrap.ts`
- Worker config default: `./conductor.db` in `packages/worker/src/index.ts`
- Worker path resolution: relative paths are resolved against monorepo root in `packages/worker/src/index.ts`

Result: web + worker point at the same SQLite file by default.

## 3. Migration System (Actual)

Migration implementation is in TypeScript, forward-only, and `up`-only.

- Migration registry: `packages/shared/src/db/migrations/index.ts`
- Current ordered list: `001` through `024`
- Migration interface:
  - `version: number`
  - `name: string`
  - `up: (db) => void`
- Version tracking table: `schema_versions` (created by `runMigrations` in `packages/shared/src/db/index.ts`)
- Apply logic: run each migration with `version > MAX(schema_versions.version)`
- Transaction model: each migration runs inside one SQLite transaction, then records `(version, name)`

Important constraints of the current system:

- No down-migrations
- No migration checksums
- No SQL-file migration runner
- No multi-database migration orchestration

### 3.1 Migration Registry (001-024)

| Version | Name | Change |
| --- | --- | --- |
| 001 | `initial_schema` | Creates base schema (core tables/indexes) |
| 002 | `add_violation_fk` | Rebuilds `tool_invocations` to add FK `violation_id -> policy_violations.violation_id` |
| 003 | `github_writes_payload` | Adds `github_writes.payload_json` |
| 004 | `events_source` | Adds `events.source` |
| 005 | `pending_github_installations` | Creates `pending_github_installations` |
| 006 | `users_and_sessions` | Creates `users`, `sessions` |
| 007 | `projects_user_id` | Adds `projects.user_id` |
| 008 | `pending_installations_user_id` | Adds `pending_github_installations.user_id` |
| 009 | `token_encryption_nonces` | Adds token nonce/encryption columns to `users` |
| 010 | `strict_ownership` | Enforces ownership constraints; rebuilds `projects` and `pending_github_installations` |
| 011 | `user_api_keys` | Creates `user_api_keys` |
| 012 | `repo_clone_tracking` | Adds clone tracking columns to `repos` |
| 013 | `worktree_metadata` | Adds `worktrees.branch_name`, `worktrees.base_commit` |
| 014 | `mirroring_rate_limits` | Creates `mirror_deferred_events` |
| 015 | `mirror_deferred_summary` | Adds `mirror_deferred_events.summary` |
| 016 | `github_writes_number` | Adds `github_writes.github_number` |
| 017 | `operator_actions_actor_columns` | Adds `operator_actions.actor_type`, `actor_display_name` |
| 018 | `stream_events` | Creates `stream_events` |
| 019 | `agent_messages` | Creates `agent_messages` |
| 020 | `gate_decisions` | Creates `gate_decisions`; adds `runs.approval_cycle` |
| 021 | `implementer_backend` | Adds `runs.implementer_backend` |
| 022 | `workflow_config` | Adds workflow config columns to `projects` and `runs` |
| 023 | `workflow_epoch` | Adds `runs.workflow_epoch` |
| 024 | `rewind_context` | Adds `runs.rewind_context_mode`, `runs.rewind_context_summary` |

## 4. ID Format (Actual)

Primary Conductor entity IDs are **TEXT with stable prefixes**, not UUID v7.

Examples from generators in `packages/shared/src/...`:

- `proj_...` (`projects.project_id`)
- `repo_...` (`repos.repo_id`)
- `task_...` (`tasks.task_id`)
- `run_...` (`runs.run_id`)
- `ps_...` (`policy_sets.policy_set_id`)
- `wt_...` (`worktrees.worktree_id`)
- `pl_...` (`port_leases.port_lease_id`)
- `ghw_...` (`github_writes.github_write_id`)
- `ai_...` (`agent_invocations.agent_invocation_id`)
- `ti_...` (`tool_invocations.tool_invocation_id`)
- `art_...` (`artifacts.artifact_id`)
- `evt_...` (`events.event_id`)
- `ge_...` (`gate_evaluations.gate_evaluation_id`)
- `gd_...` (`gate_decisions.gate_decision_id`)
- `oa_...` (`operator_actions.operator_action_id`)
- `ov_...` (`overrides.override_id`)
- `am_...` (`agent_messages.agent_message_id`)
- `def_...` (`mirror_deferred_events.deferred_event_id`)
- `user_...` (`users.user_id`)
- `sess_...` (`sessions.session_id`)

Current exceptions:

- `jobs.job_id` is UUID v4 from `crypto.randomUUID()` (`packages/shared/src/jobs/index.ts`)
- `webhook_deliveries.delivery_id` is GitHub-provided (`X-GitHub-Delivery`), not Conductor-generated
- `stream_events.id` is `INTEGER PRIMARY KEY AUTOINCREMENT`

## 5. Authoritative Table Inventory (Current v0.1)

All tables below exist in the live schema after migrations `001`-`024` (plus runtime `schema_versions`).

| Table | Primary Key | Key Columns (non-exhaustive) |
| --- | --- | --- |
| `agent_invocations` | `agent_invocation_id` | `run_id`, `agent`, `action`, `status`, `tokens_input`, `tokens_output`, `started_at`, `completed_at` |
| `agent_messages` | `agent_message_id` | `agent_invocation_id`, `run_id`, `turn_index`, `role`, `content_json`, `content_size_bytes`, `created_at` |
| `artifacts` | `artifact_id` | `run_id`, `type`, `version`, `content_markdown`, `blob_ref`, `checksum_sha256`, `validation_status`, `source_tool_invocation_id`, `github_write_id` |
| `events` | `event_id` | `project_id`, `repo_id`, `task_id`, `run_id`, `type`, `class`, `source`, `payload_json`, `sequence`, `idempotency_key`, `processed_at`, `causation_id`, `correlation_id`, `github_write_id` |
| `evidences` | `evidence_id` | `run_id`, `kind`, location fields, `redacted_text`, `redacted_hash`, `raw_blob_ref`, `created_at` |
| `gate_decisions` | `gate_decision_id` | `run_id`, `gate_id`, `cycle`, `decision`, `actor_id`, `comment`, `created_at` |
| `gate_definitions` | `gate_id` | `kind`, `description`, `default_config_json` |
| `gate_evaluations` | `gate_evaluation_id` | `run_id`, `gate_id`, `kind`, `status`, `reason`, `details_json`, `causation_event_id`, `evaluated_at` |
| `github_writes` | `github_write_id` | `run_id`, `kind`, `target_node_id`, `target_type`, `idempotency_key`, `payload_hash`, `payload_json`, `status`, `error`, `github_id`, `github_number`, `github_url`, `retry_count`, `sent_at` |
| `jobs` | `job_id` | `queue`, `job_type`, `payload_json`, `idempotency_key`, `status`, `priority`, claim/lease fields, retry fields, `run_id`, `project_id` |
| `mirror_deferred_events` | `deferred_event_id` | `run_id`, `event_type`, `formatted_body`, `summary`, `idempotency_suffix`, `created_at` |
| `operator_actions` | `operator_action_id` | `run_id`, `action`, `operator`, `actor_type`, `actor_display_name`, `comment`, `from_phase`, `to_phase`, `github_write_id`, `created_at` |
| `overrides` | `override_id` | `run_id`, `kind`, `target_id`, `scope`, constraint fields, `policy_set_id`, `operator`, `justification`, `expires_at`, `github_write_id` |
| `pending_github_installations` | `(installation_id, user_id)` | `setup_action`, `state`, `created_at` |
| `policy_audit_entries` | `audit_id` | `run_id`, `policy_id`, `policy_set_id`, `enforcement_point`, `target`, `decision`, `violation_id`, `evaluated_at` |
| `policy_definitions` | `policy_id` | `severity`, `description`, `check_points_json`, `default_config_json` |
| `policy_set_entries` | `(policy_set_id, policy_id)` | `enabled`, `severity_override`, `config_json` |
| `policy_sets` | `policy_set_id` | `project_id`, `config_hash`, `replaces_policy_set_id`, `created_by`, `created_at` |
| `policy_violations` | `violation_id` | `run_id`, `policy_id`, `policy_set_id`, `severity`, `description`, `evidence_id`, `tool_invocation_id`, `resolved_by_override_id`, `detected_at` |
| `port_leases` | `port_lease_id` | `project_id`, `worktree_id`, `port`, `purpose`, `is_active`, `leased_at`, `expires_at`, `released_at` |
| `projects` | `project_id` | `user_id`, `name`, GitHub org/install fields, defaults, port range, `workflow_config_json`, `created_at`, `updated_at` |
| `repos` | `repo_id` | `project_id`, GitHub identity fields, `profile_id`, `status`, `last_indexed_at`, `clone_path`, `cloned_at`, `last_fetched_at` |
| `routing_decisions` | `routing_decision_id` | `run_id`, `inputs_json`, `agent_graph_json`, `required_gates_json`, `optional_gates_json`, `reasoning`, `decided_at` |
| `runs` | `run_id` | lineage (`run_number`, parents), lifecycle (`phase`, `step`), policy/event counters, pause/blocked fields, git/PR fields, revision counters, `approval_cycle`, `implementer_backend`, workflow fields, rewind context fields, result/timestamps |
| `schema_versions` | `version` | `name`, `applied_at` |
| `sessions` | `session_id` | `user_id`, `token_hash`, `user_agent`, `ip_address`, `expires_at`, `created_at`, `last_active_at` |
| `stream_events` | `id` (autoincrement) | `kind`, `project_id`, `run_id`, `payload_json`, `created_at` |
| `tasks` | `task_id` | `project_id`, `repo_id`, GitHub issue identity/content fields, `active_run_id`, sync/activity timestamps |
| `tool_invocations` | `tool_invocation_id` | `agent_invocation_id`, `run_id`, `tool`, redacted args/result hash fields, policy fields, `violation_id`, `status`, `duration_ms`, `created_at` |
| `user_api_keys` | `(user_id, provider)` | `api_key`, `api_key_nonce`, `key_encrypted`, `created_at`, `updated_at` |
| `users` | `user_id` | `github_id`, `github_node_id`, `github_login`, profile fields, OAuth token fields + nonce/encryption fields, `status`, `created_at`, `updated_at`, `last_login_at` |
| `webhook_deliveries` | `delivery_id` | `event_type`, `action`, `repository_node_id`, `sender_id`, `payload_summary_json`, `payload_hash`, `signature_valid`, `status`, `job_id`, `error`, `ignore_reason`, `received_at`, `processed_at` |
| `worktrees` | `worktree_id` | `run_id`, `project_id`, `repo_id`, `path`, `status`, `branch_name`, `base_commit`, `last_heartbeat_at`, `created_at`, `destroyed_at` |

## 6. Canonical Constraints to Rely On

Selected constraints/index guarantees that are active in this schema:

- `projects.github_installation_id` is unique (`idx_projects_installation_unique`)
- `repos.github_node_id` is unique
- `tasks.github_node_id` is unique
- `events.idempotency_key` is unique
- `events` enforces run/sequence coupling and unique `(run_id, sequence)` when `run_id IS NOT NULL`
- `github_writes.idempotency_key` is unique
- `port_leases` has one active lease per `(project_id, port)`
- `pending_github_installations` primary key is `(installation_id, user_id)`
- `worktrees` allows only one active worktree per run (`idx_worktrees_active_run` where `destroyed_at IS NULL`)
- `gate_decisions` enforces one decision per `(run_id, gate_id, cycle)`

## 7. What Is Not in the v0.1 Runtime Schema

The following are not part of the actual running data model today:

- Any PostgreSQL schema (`conductor.*`, `orchestrator.*`)
- Any separate PM-engine SQLite schema (`pm_*` tables)
- Any runtime cross-database foreign keys or synchronization contracts between multiple primary databases

## 8. Cross-References

Additional docs that align with this implementation:

- `docs/PORTS_AND_HEALTH.md` (runtime topology, web/worker + shared SQLite)
- `docs/IDEMPOTENCY.md` (deduplication keys over `webhook_deliveries`, `events`, `github_writes`)
- `docs/RATE_LIMITING.md` (`mirror_deferred_events` behavior)
- `docs/DEPLOYMENT.md` (`DATABASE_PATH` examples for web + worker)

Primary code anchors for this authority doc:

- `packages/shared/src/db/index.ts`
- `packages/shared/src/db/migrations/index.ts`
- `packages/shared/src/db/migrations/001_initial_schema.ts`
- `packages/shared/src/db/migrations/002_add_violation_fk.ts` through `packages/shared/src/db/migrations/024_rewind_context.ts`
- `packages/shared/src/types/index.ts`
- `packages/web/src/lib/config.ts`
- `packages/web/src/lib/bootstrap.ts`
- `packages/worker/src/index.ts`

## Appendix A: Codex Adversarial Review Resolution

This appendix resolves the previously reported findings.

| Finding | Resolution in This Doc | Evidence |
| --- | --- | --- |
| PostgreSQL-vs-SQLite mismatch | Replaced with single-DB SQLite architecture via `better-sqlite3`; removed 3-DB runtime claims | `packages/shared/src/db/index.ts`, `packages/web/src/lib/bootstrap.ts`, `packages/worker/src/index.ts` |
| Wrong ID format (UUID claims) | Corrected to prefixed TEXT IDs for Conductor-generated entities; documented current exceptions explicitly | ID generators in `packages/shared/src/*` (e.g., `runs`, `projects`, `events`, `outbox`, `auth`, `gates`) |
| Wrong table names (e.g., `api_keys`) | Corrected to actual table names from migrations (including `user_api_keys`) | `packages/shared/src/db/migrations/011_user_api_keys.ts` and full migration inventory |
| Missing down-migration accuracy | Corrected migration model: forward-only, `up`-only, no `down` path in interface/registry | `packages/shared/src/db/migrations/index.ts`, `packages/shared/src/db/index.ts` |
| Non-existent orchestrator/PM-engine tables documented as real | Removed from authoritative schema and explicitly listed as not in runtime v0.1 | Full migration set `001`-`024` and current table inventory in Section 5 |
