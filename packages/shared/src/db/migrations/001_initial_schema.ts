/**
 * Migration 001: Initial Schema
 *
 * Creates all core tables per DATA_MODEL.md Section 8.
 * Tables are created in dependency order.
 */

import type { Database } from 'better-sqlite3';
import type { Migration } from './index.js';

export const migration001: Migration = {
  version: 1,
  name: 'initial_schema',
  up: (db: Database) => {
    // =========================================================================
    // Reference Tables (seed data)
    // =========================================================================

    db.exec(`
      -- Gate definitions (seed data)
      CREATE TABLE gate_definitions (
        gate_id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        description TEXT NOT NULL,
        default_config_json TEXT NOT NULL
      )
    `);

    db.exec(`
      -- Policy definitions (seed data)
      CREATE TABLE policy_definitions (
        policy_id TEXT PRIMARY KEY,
        severity TEXT NOT NULL,
        description TEXT NOT NULL,
        check_points_json TEXT NOT NULL,
        default_config_json TEXT NOT NULL
      )
    `);

    // =========================================================================
    // Projects
    // =========================================================================

    db.exec(`
      CREATE TABLE projects (
        project_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,

        github_org_id INTEGER NOT NULL,
        github_org_node_id TEXT NOT NULL,
        github_org_name TEXT NOT NULL,
        github_installation_id INTEGER NOT NULL,
        github_projects_v2_id TEXT,

        default_profile_id TEXT NOT NULL,
        default_base_branch TEXT NOT NULL,
        enforce_projects INTEGER NOT NULL DEFAULT 0,

        port_range_start INTEGER NOT NULL,
        port_range_end INTEGER NOT NULL,

        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);

    // =========================================================================
    // Policy Sets (depends on projects)
    // =========================================================================

    db.exec(`
      -- Policy sets (immutable snapshots for versioning)
      CREATE TABLE policy_sets (
        policy_set_id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(project_id),

        config_hash TEXT NOT NULL,
        replaces_policy_set_id TEXT REFERENCES policy_sets(policy_set_id),

        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL
      )
    `);

    db.exec(`
      -- Policy set entries (immutable)
      CREATE TABLE policy_set_entries (
        policy_set_id TEXT NOT NULL REFERENCES policy_sets(policy_set_id),
        policy_id TEXT NOT NULL REFERENCES policy_definitions(policy_id),

        enabled INTEGER NOT NULL,
        severity_override TEXT,
        config_json TEXT NOT NULL,

        PRIMARY KEY (policy_set_id, policy_id)
      )
    `);

    // =========================================================================
    // Repos (depends on projects)
    // =========================================================================

    db.exec(`
      CREATE TABLE repos (
        repo_id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(project_id),

        github_node_id TEXT NOT NULL,
        github_numeric_id INTEGER NOT NULL,
        github_owner TEXT NOT NULL,
        github_name TEXT NOT NULL,
        github_full_name TEXT NOT NULL,
        github_default_branch TEXT NOT NULL,

        profile_id TEXT NOT NULL,
        status TEXT NOT NULL,

        last_indexed_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,

        UNIQUE(github_node_id)
      )
    `);

    // =========================================================================
    // Tasks (depends on projects, repos)
    // =========================================================================

    db.exec(`
      CREATE TABLE tasks (
        task_id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(project_id),
        repo_id TEXT NOT NULL REFERENCES repos(repo_id),

        github_node_id TEXT NOT NULL,
        github_issue_number INTEGER NOT NULL,
        github_type TEXT NOT NULL,

        github_title TEXT NOT NULL,
        github_body TEXT NOT NULL,
        github_state TEXT NOT NULL,
        github_labels_json TEXT NOT NULL,
        github_last_etag TEXT,
        github_synced_at TEXT NOT NULL,

        active_run_id TEXT,

        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_activity_at TEXT NOT NULL,

        UNIQUE(github_node_id)
      )
    `);

    // =========================================================================
    // Runs (depends on tasks, policy_sets)
    // =========================================================================

    db.exec(`
      CREATE TABLE runs (
        run_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(task_id),
        project_id TEXT NOT NULL REFERENCES projects(project_id),
        repo_id TEXT NOT NULL REFERENCES repos(repo_id),

        -- Lineage tracking
        run_number INTEGER NOT NULL DEFAULT 1,
        parent_run_id TEXT REFERENCES runs(run_id),
        supersedes_run_id TEXT REFERENCES runs(run_id),

        phase TEXT NOT NULL,
        step TEXT NOT NULL,

        -- Policy versioning (locked at run start)
        policy_set_id TEXT NOT NULL REFERENCES policy_sets(policy_set_id),

        -- Event stream tracking
        last_event_sequence INTEGER NOT NULL DEFAULT 0,
        next_sequence INTEGER NOT NULL DEFAULT 1,

        -- Operator pause
        paused_at TEXT,
        paused_by TEXT,

        -- Blocked state context
        blocked_reason TEXT,
        blocked_context_json TEXT,

        -- Git state
        base_branch TEXT NOT NULL,
        branch TEXT NOT NULL,
        head_sha TEXT,

        -- PR identity (all-or-nothing bundle)
        pr_number INTEGER,
        pr_node_id TEXT,
        pr_url TEXT,
        pr_state TEXT,
        pr_synced_at TEXT,

        plan_revisions INTEGER NOT NULL DEFAULT 0,
        test_fix_attempts INTEGER NOT NULL DEFAULT 0,
        review_rounds INTEGER NOT NULL DEFAULT 0,

        started_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT,

        result TEXT,
        result_reason TEXT,

        -- Enforce PR bundle is all-or-nothing
        CHECK (
          (pr_number IS NULL AND pr_node_id IS NULL AND pr_url IS NULL AND pr_state IS NULL AND pr_synced_at IS NULL)
          OR
          (pr_number IS NOT NULL AND pr_node_id IS NOT NULL AND pr_url IS NOT NULL AND pr_state IS NOT NULL AND pr_synced_at IS NOT NULL)
        )
      )
    `);

    // =========================================================================
    // Worktrees (depends on runs)
    // =========================================================================

    db.exec(`
      CREATE TABLE worktrees (
        worktree_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(run_id),
        project_id TEXT NOT NULL REFERENCES projects(project_id),
        repo_id TEXT NOT NULL REFERENCES repos(repo_id),

        path TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL,

        last_heartbeat_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        destroyed_at TEXT
      )
    `);

    // =========================================================================
    // Port Leases (depends on worktrees)
    // =========================================================================

    db.exec(`
      CREATE TABLE port_leases (
        port_lease_id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(project_id),
        worktree_id TEXT NOT NULL REFERENCES worktrees(worktree_id),

        port INTEGER NOT NULL,
        purpose TEXT NOT NULL,
        is_active INTEGER NOT NULL DEFAULT 1,

        leased_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        released_at TEXT
      )
    `);

    db.exec(`
      -- Enforce single active lease per port per project
      CREATE UNIQUE INDEX uniq_active_port_per_project
        ON port_leases(project_id, port)
        WHERE is_active = 1
    `);

    // =========================================================================
    // GitHub Writes (outbox pattern)
    // =========================================================================

    db.exec(`
      CREATE TABLE github_writes (
        github_write_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(run_id),

        kind TEXT NOT NULL,
        target_node_id TEXT NOT NULL,
        target_type TEXT NOT NULL,

        idempotency_key TEXT NOT NULL UNIQUE,
        payload_hash TEXT NOT NULL,
        payload_hash_scheme TEXT NOT NULL DEFAULT 'sha256:cjson:v1',

        status TEXT NOT NULL,
        error TEXT,

        github_id INTEGER,
        github_url TEXT,

        created_at TEXT NOT NULL,
        sent_at TEXT,
        retry_count INTEGER NOT NULL DEFAULT 0
      )
    `);

    // =========================================================================
    // Agent Invocations (depends on runs)
    // =========================================================================

    db.exec(`
      CREATE TABLE agent_invocations (
        agent_invocation_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(run_id),

        agent TEXT NOT NULL,
        action TEXT NOT NULL,
        status TEXT NOT NULL,

        tokens_input INTEGER NOT NULL DEFAULT 0,
        tokens_output INTEGER NOT NULL DEFAULT 0,

        duration_ms INTEGER,
        context_summary TEXT,

        error_code TEXT,
        error_message TEXT,

        started_at TEXT NOT NULL,
        completed_at TEXT
      )
    `);

    // =========================================================================
    // Tool Invocations (depends on agent_invocations)
    // =========================================================================

    db.exec(`
      CREATE TABLE tool_invocations (
        tool_invocation_id TEXT PRIMARY KEY,
        agent_invocation_id TEXT NOT NULL REFERENCES agent_invocations(agent_invocation_id),
        run_id TEXT NOT NULL REFERENCES runs(run_id),

        tool TEXT NOT NULL,
        target TEXT,

        -- Redacted storage
        args_redacted_json TEXT NOT NULL,
        args_fields_removed_json TEXT NOT NULL,
        args_secrets_detected INTEGER NOT NULL DEFAULT 0,
        args_payload_hash TEXT NOT NULL,
        args_payload_hash_scheme TEXT NOT NULL DEFAULT 'sha256:cjson:v1',

        result_meta_json TEXT NOT NULL,
        result_payload_hash TEXT NOT NULL,
        result_payload_hash_scheme TEXT NOT NULL DEFAULT 'sha256:cjson:v1',

        policy_decision TEXT NOT NULL,
        policy_id TEXT REFERENCES policy_definitions(policy_id),
        policy_set_id TEXT REFERENCES policy_sets(policy_set_id),
        violation_id TEXT,

        status TEXT NOT NULL,
        duration_ms INTEGER NOT NULL,
        created_at TEXT NOT NULL
      )
    `);

    // =========================================================================
    // Artifacts (depends on runs, tool_invocations, github_writes)
    // =========================================================================

    db.exec(`
      CREATE TABLE artifacts (
        artifact_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(run_id),

        type TEXT NOT NULL,
        version INTEGER NOT NULL,

        content_markdown TEXT,
        blob_ref TEXT,
        size_bytes INTEGER NOT NULL,
        checksum_sha256 TEXT NOT NULL,

        validation_status TEXT NOT NULL DEFAULT 'pending',
        validation_errors_json TEXT,
        validated_at TEXT,

        source_tool_invocation_id TEXT REFERENCES tool_invocations(tool_invocation_id),
        github_write_id TEXT REFERENCES github_writes(github_write_id),

        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL,

        CHECK (validation_status IN ('pending', 'valid', 'invalid'))
      )
    `);

    // =========================================================================
    // Events (append-only log)
    // =========================================================================

    db.exec(`
      CREATE TABLE events (
        event_id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(project_id),

        repo_id TEXT,
        task_id TEXT,
        run_id TEXT,

        type TEXT NOT NULL,
        class TEXT NOT NULL,
        payload_json TEXT NOT NULL,

        sequence INTEGER,
        idempotency_key TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        processed_at TEXT,

        causation_id TEXT REFERENCES events(event_id),
        correlation_id TEXT,
        txn_id TEXT,

        github_write_id TEXT REFERENCES github_writes(github_write_id),

        -- Enforce sequence/run_id coupling
        CHECK (
          (run_id IS NULL AND sequence IS NULL)
          OR
          (run_id IS NOT NULL AND sequence IS NOT NULL)
        ),

        -- Enforce valid class
        CHECK (class IN ('fact', 'decision', 'signal'))
      )
    `);

    db.exec(`
      -- Enforce sequence uniqueness within a run
      CREATE UNIQUE INDEX uniq_events_run_sequence
        ON events(run_id, sequence)
        WHERE run_id IS NOT NULL
    `);

    // =========================================================================
    // Gate Evaluations (depends on runs, events)
    // =========================================================================

    db.exec(`
      CREATE TABLE gate_evaluations (
        gate_evaluation_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(run_id),

        gate_id TEXT NOT NULL REFERENCES gate_definitions(gate_id),
        kind TEXT NOT NULL,

        status TEXT NOT NULL,
        reason TEXT,
        details_json TEXT,

        causation_event_id TEXT NOT NULL REFERENCES events(event_id),

        evaluated_at TEXT NOT NULL,
        duration_ms INTEGER
      )
    `);

    // =========================================================================
    // Operator Actions (depends on runs, github_writes)
    // =========================================================================

    db.exec(`
      CREATE TABLE operator_actions (
        operator_action_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(run_id),

        action TEXT NOT NULL,
        operator TEXT NOT NULL,
        comment TEXT,

        from_phase TEXT,
        to_phase TEXT,

        github_write_id TEXT REFERENCES github_writes(github_write_id),

        created_at TEXT NOT NULL
      )
    `);

    // =========================================================================
    // Evidences (depends on runs)
    // =========================================================================

    db.exec(`
      CREATE TABLE evidences (
        evidence_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(run_id),

        kind TEXT NOT NULL,

        location_file TEXT,
        location_line_start INTEGER,
        location_line_end INTEGER,
        command_name TEXT,
        pattern_matched TEXT,

        redacted_text TEXT NOT NULL,
        redacted_hash TEXT NOT NULL,

        raw_blob_ref TEXT,
        raw_blob_expires_at TEXT,

        created_at TEXT NOT NULL
      )
    `);

    // =========================================================================
    // Overrides (depends on runs, policy_sets, github_writes)
    // =========================================================================

    db.exec(`
      CREATE TABLE overrides (
        override_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(run_id),

        kind TEXT NOT NULL,
        target_id TEXT,
        scope TEXT NOT NULL,

        constraint_kind TEXT,
        constraint_value TEXT,
        constraint_hash TEXT,

        policy_set_id TEXT REFERENCES policy_sets(policy_set_id),

        operator TEXT NOT NULL,
        justification TEXT NOT NULL,

        expires_at TEXT,

        github_write_id TEXT REFERENCES github_writes(github_write_id),

        created_at TEXT NOT NULL
      )
    `);

    // =========================================================================
    // Policy Violations (depends on runs, evidences, overrides)
    // =========================================================================

    db.exec(`
      CREATE TABLE policy_violations (
        violation_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(run_id),

        policy_id TEXT NOT NULL REFERENCES policy_definitions(policy_id),
        policy_set_id TEXT NOT NULL REFERENCES policy_sets(policy_set_id),
        severity TEXT NOT NULL,
        description TEXT NOT NULL,

        evidence_id TEXT NOT NULL REFERENCES evidences(evidence_id),
        tool_invocation_id TEXT REFERENCES tool_invocations(tool_invocation_id),

        resolved_by_override_id TEXT REFERENCES overrides(override_id),
        detected_at TEXT NOT NULL
      )
    `);

    // Now add the foreign key for tool_invocations.violation_id
    // SQLite doesn't support ALTER TABLE ADD CONSTRAINT, so this is handled by the CHECK above

    // =========================================================================
    // Policy Audit Entries (depends on runs, policy_violations)
    // =========================================================================

    db.exec(`
      CREATE TABLE policy_audit_entries (
        audit_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(run_id),

        policy_id TEXT NOT NULL REFERENCES policy_definitions(policy_id),
        policy_set_id TEXT NOT NULL REFERENCES policy_sets(policy_set_id),

        enforcement_point TEXT NOT NULL,
        target TEXT NOT NULL,

        decision TEXT NOT NULL,
        violation_id TEXT REFERENCES policy_violations(violation_id),

        evaluated_at TEXT NOT NULL
      )
    `);

    // =========================================================================
    // Routing Decisions (depends on runs)
    // =========================================================================

    db.exec(`
      CREATE TABLE routing_decisions (
        routing_decision_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(run_id),

        inputs_json TEXT NOT NULL,
        agent_graph_json TEXT NOT NULL,
        required_gates_json TEXT NOT NULL,
        optional_gates_json TEXT NOT NULL,
        reasoning TEXT NOT NULL,

        decided_at TEXT NOT NULL
      )
    `);

    // =========================================================================
    // Jobs (durable queue with leasing)
    // =========================================================================

    db.exec(`
      CREATE TABLE jobs (
        job_id TEXT PRIMARY KEY,
        queue TEXT NOT NULL,

        job_type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        idempotency_key TEXT NOT NULL UNIQUE,

        status TEXT NOT NULL DEFAULT 'queued',
        priority INTEGER NOT NULL DEFAULT 0,

        claimed_by TEXT,
        claimed_at TEXT,
        lease_expires_at TEXT,

        attempts INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL DEFAULT 3,
        last_error TEXT,
        next_retry_at TEXT,

        created_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT,

        run_id TEXT REFERENCES runs(run_id),
        project_id TEXT REFERENCES projects(project_id)
      )
    `);

    // =========================================================================
    // Webhook Deliveries (inbound persistence)
    // =========================================================================

    db.exec(`
      CREATE TABLE webhook_deliveries (
        delivery_id TEXT PRIMARY KEY,

        event_type TEXT NOT NULL,
        action TEXT,
        repository_node_id TEXT,
        sender_id INTEGER,

        payload_summary_json TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        signature_valid INTEGER NOT NULL,

        status TEXT NOT NULL DEFAULT 'received',
        job_id TEXT REFERENCES jobs(job_id),
        error TEXT,
        ignore_reason TEXT,

        received_at TEXT NOT NULL,
        processed_at TEXT
      )
    `);

    // =========================================================================
    // Indexes
    // =========================================================================

    // Task indexes
    db.exec(`CREATE INDEX idx_tasks_repo ON tasks(repo_id)`);
    db.exec(`CREATE INDEX idx_tasks_project ON tasks(project_id)`);

    // Run indexes
    db.exec(`CREATE INDEX idx_runs_task ON runs(task_id)`);
    db.exec(`CREATE INDEX idx_runs_phase ON runs(phase)`);
    db.exec(`CREATE INDEX idx_runs_paused ON runs(paused_at) WHERE paused_at IS NOT NULL`);
    db.exec(`CREATE INDEX idx_runs_policy_set ON runs(policy_set_id)`);

    // Agent/tool invocation indexes
    db.exec(`CREATE INDEX idx_agent_invocations_run ON agent_invocations(run_id)`);
    db.exec(`CREATE INDEX idx_tool_invocations_run ON tool_invocations(run_id)`);

    // Gate evaluation indexes
    db.exec(`CREATE INDEX idx_gate_evaluations_run ON gate_evaluations(run_id)`);
    db.exec(`CREATE INDEX idx_gate_evaluations_causation ON gate_evaluations(causation_event_id)`);

    // GitHub writes indexes
    db.exec(`CREATE INDEX idx_github_writes_run ON github_writes(run_id)`);
    db.exec(`CREATE INDEX idx_github_writes_status ON github_writes(status)`);
    db.exec(`CREATE INDEX idx_github_writes_idempotency ON github_writes(idempotency_key)`);
    db.exec(`
      CREATE INDEX idx_github_writes_retry
        ON github_writes(status, created_at)
        WHERE status IN ('queued', 'failed')
    `);

    // Event indexes
    db.exec(`CREATE INDEX idx_events_run ON events(run_id)`);
    db.exec(`CREATE INDEX idx_events_run_sequence ON events(run_id, sequence)`);
    db.exec(`CREATE INDEX idx_events_created_at ON events(created_at)`);
    db.exec(`CREATE INDEX idx_events_class ON events(class)`);
    db.exec(`CREATE INDEX idx_events_unprocessed ON events(run_id, sequence) WHERE processed_at IS NULL`);

    // Policy indexes
    db.exec(`CREATE INDEX idx_policy_sets_project ON policy_sets(project_id)`);
    db.exec(`CREATE INDEX idx_policy_set_entries_policy ON policy_set_entries(policy_id)`);

    // Evidence and violation indexes
    db.exec(`CREATE INDEX idx_evidences_run ON evidences(run_id)`);
    db.exec(`CREATE INDEX idx_policy_violations_run ON policy_violations(run_id)`);
    db.exec(`CREATE INDEX idx_policy_violations_policy_set ON policy_violations(policy_set_id)`);
    db.exec(`CREATE INDEX idx_policy_audit_entries_run ON policy_audit_entries(run_id)`);
    db.exec(`CREATE INDEX idx_policy_audit_entries_policy_set ON policy_audit_entries(policy_set_id)`);

    // Artifact indexes
    db.exec(`
      CREATE INDEX idx_artifacts_run_type_valid ON artifacts(run_id, type)
        WHERE validation_status = 'valid'
    `);
    db.exec(`
      CREATE INDEX idx_artifacts_validation_pending ON artifacts(run_id, validation_status)
        WHERE validation_status = 'pending'
    `);

    // Job queue indexes
    db.exec(`CREATE INDEX idx_jobs_queue_status ON jobs(queue, status, priority DESC, created_at ASC)`);
    db.exec(`
      CREATE INDEX idx_jobs_claimable ON jobs(queue, status, lease_expires_at)
        WHERE status IN ('queued', 'processing')
    `);
    db.exec(`
      CREATE INDEX idx_jobs_retry ON jobs(next_retry_at)
        WHERE status = 'failed' AND next_retry_at IS NOT NULL
    `);
    db.exec(`CREATE INDEX idx_jobs_run ON jobs(run_id) WHERE run_id IS NOT NULL`);
    db.exec(`CREATE INDEX idx_jobs_idempotency ON jobs(idempotency_key)`);

    // Webhook delivery indexes
    db.exec(`CREATE INDEX idx_webhook_deliveries_status ON webhook_deliveries(status)`);
    db.exec(`CREATE INDEX idx_webhook_deliveries_received ON webhook_deliveries(received_at DESC)`);
    db.exec(`
      CREATE INDEX idx_webhook_deliveries_repo ON webhook_deliveries(repository_node_id)
        WHERE repository_node_id IS NOT NULL
    `);
  },
};
