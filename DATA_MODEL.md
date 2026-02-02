# Data Model

This document defines **Conductor's authoritative data model**: what Conductor stores, what GitHub stores, how they connect, and how we preserve a clean audit trail without turning repos into "Conductor repos."

---

## 0) First Principles

### Conductor is the system of record for operations

Conductor's database is authoritative for:

* Run lifecycle (phases, retries, pause/resume/cancel)
* Gates and overrides
* Agent/tool execution metadata
* Worktrees and port leases
* Policies and violations
* Routing decisions
* Metrics and analytics

### GitHub is the system of record for collaboration + audit

GitHub is authoritative for:

* Issue/PR human-authored content (title/body/comments/labels)
* PR merge/close events
* Source code and history

Conductor mirrors key operational checkpoints to GitHub **as comments/check runs** for auditability.

### GitHub Projects is optional and *purely a mirror*

* Conductor may write field values / column mapping for visibility
* Project edits do **not** drive Conductor behavior (no "move card to start")
* Drift is allowed; DB wins if enforcement mode is enabled

---

## 0.1) Sync Model

### Data Flow

```
GitHub ─────────────────────────────────────────────────────▶ DB
         facts only: issue edits, labels, merge/close, comments

DB ─────────────────────────────────────────────────────────▶ GitHub
         mirrors only: comments, check runs, project fields
```

### Conflict Resolution (Strict)

| Data Category | Authority | Other System |
|---------------|-----------|--------------|
| Human-authored content (title/body/labels) | GitHub wins | DB is cache |
| Operational state (run/phase/gates) | DB wins | GitHub is mirror |
| Project fields | DB wins (if `enforce_projects: true`) | Otherwise best-effort mirror, no snapback |

Run state is **never "conflicted"** because GitHub doesn't own it. Conflict resolution applies only to human-authored fields synced into DB snapshots.

---

## 1) Identifiers and Scopes

### Task vs Run

* `task_id` = stable per work item (usually a GitHub Issue)
* `run_id` = unique per execution attempt of a task

A task can have many runs. Every artifact, event, gate evaluation, and operator action references `run_id`.

**Terminology note:** The data model uses "Task" as the canonical term for a work item. The UI may display "Issue" or "Work Item" contextually, but all internal references use `task_id`.

---

## 2) Phases vs Steps (Macro vs Micro)

Conductor has **two levels of lifecycle state**:

### Macro phase (operator-facing)

```ts
type RunPhase =
  | 'pending'
  | 'planning'
  | 'awaiting_plan_approval'
  | 'executing'
  | 'awaiting_review'
  | 'blocked'
  | 'completed'
  | 'cancelled';
```

### Micro step (internal execution)

```ts
type RunStep =
  | 'setup_worktree'
  | 'route'
  | 'planner_create_plan'
  | 'reviewer_review_plan'
  | 'wait_plan_approval'
  | 'implementer_apply_changes'
  | 'tester_run_tests'
  | 'reviewer_review_code'
  | 'create_pr'
  | 'wait_pr_merge'
  | 'cleanup';
```

### Derived Status

Run status is **derived from phase and pause state**, not stored separately:

```ts
type RunStatus = 'active' | 'paused' | 'blocked' | 'finished';

function deriveStatus(phase: RunPhase, paused_at?: string): RunStatus {
  if (phase === 'completed' || phase === 'cancelled') return 'finished';
  if (paused_at) return 'paused';
  if (phase === 'blocked') return 'blocked';
  return 'active';
}
```

**Status semantics:**

| Status | Meaning |
|--------|---------|
| `active` | Run is progressing normally |
| `paused` | Operator intentionally paused a healthy run |
| `blocked` | Run cannot proceed; needs decision/intervention |
| `finished` | Run completed or was cancelled |

**Invariant:** `awaiting_*` phases are normal waits (expected); `blocked` is used only for failures, exceeded retries, or policy blocks requiring human action.

**Rule:** Conductor UI and audit comments speak in macro phases. Internal logs track steps.

---

## 3) Entity Graph (Conceptual)

```
Project ──< Repo ──< Task ──< Run ──< AgentInvocation ──< ToolInvocation
    │                     │            │
    │                     │            ├─< Artifact
    │                     │            ├─< GateEvaluation
    │                     │            ├─< OperatorAction
    │                     │            ├─< Override
    │                     │            ├─< Evidence ──< PolicyViolation
    │                     │            ├─< PolicyAuditEntry
    │                     │            ├─< RoutingDecision
    │                     │            ├─< GitHubWrite
    │                     │            └─< Event
    │                     │
    │                     └─(GitHub Issue/PR is the external identity)
    │
    └──< PolicySet ──< PolicySetEntry
```

Worktrees and port leases are attached to runs:

```
Run ──1:1── Worktree ──< PortLease
Run ──>── PolicySet (FK: policy_set_id locked at run start)
```

Definition tables (not per-run):

```
GateDefinition
PolicyDefinition
```

---

## 4) Core Entities

### 4.1 Project

A workspace containing repos, policies, and shared defaults.

```ts
interface Project {
  project_id: string;            // stable slug or UUID
  name: string;

  github: {
    org_id: number;
    org_node_id: string;         // GraphQL node ID (stable)
    org_name: string;
    installation_id: number;     // GitHub App installation
    projects_v2_id?: string;     // optional mirror surface
  };

  defaults: {
    profile_id: string;          // default repo profile
    base_branch: string;         // default base branch
  };

  settings: {
    enforce_projects: boolean;   // if true, DB snaps back project field drift
  };

  port_range: { start: number; end: number };

  created_at: string;
  updated_at: string;
}
```

**Stored in:** DB
**Mirrored to GitHub:** optional Projects v2 linkage only

---

### 4.2 Repo

A GitHub repository registered inside a project.

```ts
interface Repo {
  repo_id: string;
  project_id: string;

  github: {
    node_id: string;             // GraphQL node ID (stable, primary key for GitHub)
    numeric_id: number;          // Numeric ID (for REST API)
    owner: string;
    name: string;
    full_name: string;           // owner/name
    default_branch: string;
  };

  profile_id: string;            // e.g., node-pnpm, python-pytest, docs-only
  status: 'active' | 'disabled' | 'error';
  last_indexed_at?: string;

  created_at: string;
  updated_at: string;
}
```

**Stored in:** DB
**Note:** No `.conductor/` directory, no repo-local Conductor config.

**GitHub Identity:** `github.node_id` is the stable identifier for deduplication and GraphQL queries. `github.numeric_id` is kept for REST API compatibility (named to avoid collision with internal `repo_id`).

---

### 4.3 Task (Work Item)

A GitHub Issue (or PR) that can be acted on.

```ts
type TaskType = 'issue' | 'pull_request';

interface Task {
  task_id: string;
  project_id: string;
  repo_id: string;

  github: {
    node_id: string;             // GraphQL node ID (stable)
    issue_number: number;
    type: TaskType;

    // cached snapshot for search & display
    title: string;
    body: string;
    state: 'open' | 'closed';
    labels: string[];
    last_etag?: string;          // for conditional requests
    synced_at: string;
  };

  active_run_id?: string;        // if a run is active
  created_at: string;
  updated_at: string;
  last_activity_at: string;
}
```

**Stored in:** DB (snapshot)
**Authoritative for content:** GitHub (the DB copy is a cache)

**Snapshot freshness rules:**
- Refreshed on webhook delivery (issue/PR events)
- Refreshed on access if `synced_at` older than 5 minutes OR conditional GET returns 200 (changed)
- UI always displays snapshot freshness timestamp to operators

---

### 4.4 Run

A single execution attempt against a task.

```ts
interface Run {
  run_id: string;
  task_id: string;
  project_id: string;
  repo_id: string;

  // Lineage tracking
  run_number: number;            // Sequential per task (1, 2, 3...)
  parent_run_id?: string;        // If this is a retry of a previous run
  supersedes_run_id?: string;    // If this replaces a previous attempt

  phase: RunPhase;               // macro (status derived from this + paused_at)
  step: RunStep;                 // micro
  // INVARIANT: `status` is ALWAYS derived from (phase, paused_at) - never stored

  // Policy versioning
  policy_set_id: string;         // FK to PolicySet (locked at run start)

  // Operator pause (separate from phase)
  paused_at?: string;            // null if not paused
  paused_by?: string;            // operator who paused

  // Blocked state context (populated when phase='blocked')
  blocked_reason?: string;       // e.g., 'policy_exception_required', 'retry_limit_exceeded', 'gate_failed'
  blocked_context?: {
    prior_phase: RunPhase;       // Phase before blocking (for resume)
    violation_id?: string;       // If blocked by policy violation
    gate_id?: string;            // If blocked by gate failure
  };

  git: {
    base_branch: string;
    branch: string;
    head_sha?: string;
    pr?: {                       // populated when PR exists
      number: number;
      node_id: string;
      url: string;
      state: 'open' | 'closed' | 'merged';
      synced_at: string;
    };
  };

  iterations: {
    plan_revisions: number;
    test_fix_attempts: number;
    review_rounds: number;
  };

  timing: {
    started_at: string;
    updated_at: string;
    completed_at?: string;
  };

  result?: 'success' | 'failure' | 'cancelled';
  result_reason?: string;
}
```

**Stored in:** DB
**Mirrored to GitHub:** phase transitions (optional), operator actions, final artifacts, errors, check runs

**Note:** `status` is not stored; it is derived from `(phase, paused_at)` (see Section 2).

**Phase Transition Invariant:**

> Run phase changes happen **only** when the orchestrator processes an Event or OperatorAction and emits a `phase.transitioned` event. The DB write to `runs.phase` must be derived from the Event stream, not an ad-hoc UPDATE.

This invariant ensures:
- All phase changes are auditable via the Event stream
- Event replay produces the same phase sequence
- No worker can bypass the state machine with direct `UPDATE runs SET phase=...`

**Enforcement:** The application layer maintains `runs.last_event_sequence` (see schema). Phase updates must:
1. Write to `events` table first
2. Update `runs.phase` and `runs.last_event_sequence` atomically
3. Verify `last_event_sequence` increases monotonically

---

### 4.5 Worktree

An isolated checkout for the run.

```ts
interface Worktree {
  worktree_id: string;
  run_id: string;
  project_id: string;
  repo_id: string;

  path: string;
  status: 'creating' | 'ready' | 'busy' | 'cleanup' | 'destroyed';

  created_at: string;
  destroyed_at?: string;

  last_heartbeat_at: string;
}
```

**Stored in:** DB
**GitHub equivalent:** none

---

### 4.6 PortLease

A port reservation associated with a worktree.

```ts
interface PortLease {
  port_lease_id: string;
  project_id: string;
  worktree_id: string;

  port: number;
  purpose: 'dev_server' | 'api' | 'db' | 'other';

  is_active: boolean;            // materialized derived column (see enforcement below)

  leased_at: string;
  expires_at: string;
  released_at?: string;
}
```

**Stored in:** DB
**Constraint:** Only one active lease per `(project_id, port)`.

**Enforcement:**

`is_active` is a **materialized derived column** maintained by a DB trigger; application code must never write it directly.

**Recommended enforcement order (dialect-dependent):**

1. **Generated column** (if supported): cleanest, DB-enforced
2. **Trigger-maintained column**: works on Postgres, MySQL, etc.
3. **App-layer invariant + periodic reconciler**: fallback for limited DBs (e.g., SQLite without generated columns)

```sql
-- is_active = TRUE when released_at IS NULL (maintained by trigger)
CREATE UNIQUE INDEX uniq_active_port_per_project
  ON port_leases(project_id, port)
  WHERE is_active = TRUE;

-- Trigger (Postgres example):
CREATE OR REPLACE FUNCTION maintain_port_lease_is_active()
RETURNS TRIGGER AS $$
BEGIN
  NEW.is_active := (NEW.released_at IS NULL);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_port_lease_is_active
  BEFORE INSERT OR UPDATE ON port_leases
  FOR EACH ROW EXECUTE FUNCTION maintain_port_lease_is_active();

-- SQLite alternative (no generated columns): enforce in app layer
-- and run periodic reconciliation:
-- UPDATE port_leases SET is_active = (released_at IS NULL) WHERE is_active != (released_at IS NULL);
```

---

## 5) Definition Entities

These define the available gates and policies. They are **not per-run**—they're system/project configuration.

### 5.1 GateDefinition

```ts
interface GateDefinition {
  gate_id: string;               // e.g., tests_pass, plan_approval, code_review
  kind: 'automatic' | 'human' | 'policy';
  description: string;

  default_config: {
    required: boolean;
    timeout_minutes?: number;
    max_retries?: number;
  };
}
```

**Stored in:** DB (seed data + admin-editable)
**Purpose:** Makes `gate_evaluations.gate_id` a queryable, documented reference.

### 5.2 PolicyDefinition

```ts
interface PolicyDefinition {
  policy_id: string;             // e.g., no_secrets_in_code, max_file_changes
  severity: 'warning' | 'blocking';
  description: string;
  check_points: Array<'tool_invocation' | 'pre_push' | 'artifact_validation'>;

  default_config: Record<string, any>;  // policy-specific defaults
}
```

**Stored in:** DB (seed data + admin-editable)
**Purpose:** Makes `policy_violations.policy_id` a queryable, documented reference. Drives policy configuration UI.

### 5.3 PolicySet (Immutable Snapshots)

Policy configurations are versioned to ensure audit trails reflect the exact rules in effect at evaluation time.

```ts
interface PolicySet {
  policy_set_id: string;         // e.g., "ps_abc123"
  project_id: string;

  // Immutable snapshot of all active policies at creation time
  config_hash: string;           // SHA256 of canonical JSON config
  created_at: string;
  created_by: string;            // Operator who saved changes

  // Version chain
  replaces_policy_set_id?: string;
}

interface PolicySetEntry {
  policy_set_id: string;
  policy_id: string;             // FK to PolicyDefinition

  enabled: boolean;
  severity_override?: 'warning' | 'blocking';
  config_json: string;           // Policy-specific config snapshot
}
```

**Stored in:** DB (immutable once created)
**Purpose:**
- Every policy evaluation references `policy_set_id` to know which rules were in effect
- Enables audit replay: "why was this blocked?" can be answered definitively
- PolicySet entries are never modified; new PolicySet created on any config change

**Invariant:** When policies are modified in the UI, a new `PolicySet` is created. Runs, violations, and audit entries reference the `policy_set_id` that was active at the time.

---

## 6) Execution, Audit, and Policy Entities

### 6.1 RoutingDecision

Immutable record of how Conductor built the agent graph and gates for this run.

```ts
interface RoutingDecision {
  routing_decision_id: string;
  run_id: string;

  inputs: {
    issue_type: 'bug' | 'feature' | 'refactor' | 'docs' | 'chore';
    estimated_scope: 'small' | 'medium' | 'large';
    repo_profile_id: string;
    sensitive_paths_predicted: boolean;
    prior_failures_summary?: string;
  };

  agent_graph: Array<{
    node_id: string;
    agent: 'planner' | 'implementer' | 'reviewer' | 'tester';
    action: string;
    depends_on: string[];
    context_sources: string[];
  }>;

  required_gates: string[];      // gate_id references
  optional_gates: string[];      // gate_id references

  reasoning: string;
  decided_at: string;
}
```

**Stored in:** DB
**Mirrored to GitHub:** not necessary (visible in UI); can be summarized in plan comment if desired.

---

### 6.2 AgentInvocation

One agent call.

```ts
interface AgentInvocation {
  agent_invocation_id: string;
  run_id: string;

  agent: 'planner' | 'implementer' | 'reviewer' | 'tester';
  action: string;                        // e.g. create_plan, review_code, run_tests

  status: 'running' | 'completed' | 'failed' | 'timeout';

  tokens: { input: number; output: number };
  duration_ms?: number;

  context_summary?: string;              // what was included (human-readable)
  error?: { code: string; message: string };

  started_at: string;
  completed_at?: string;
}
```

**Stored in:** DB
**Mirrored to GitHub:** no (too chatty). Summarize only when necessary.

---

### 6.3 ToolInvocation

Every agent action that touches the outside world (files, shell, GitHub API) is logged here.

```ts
interface ToolInvocation {
  tool_invocation_id: string;
  agent_invocation_id: string;
  run_id: string;

  tool: string;                          // e.g. fs.write, shell.exec, github.comment
  target?: string;                       // file path, URL, repo, etc.

  // Redacted storage (raw args/results NEVER stored)
  args_redacted: {
    json: string;                        // redacted version
    fields_removed: string[];            // which fields were stripped
    secrets_detected: boolean;           // did redaction find secrets?
    payload_hash: string;                // SHA256 of original for verification
    payload_hash_scheme: string;         // e.g., "sha256:cjson:v1"
  };

  result_meta: {
    json: string;                        // redacted result metadata
    payload_hash: string;
    payload_hash_scheme: string;         // e.g., "sha256:cjson:v1"
  };

  policy: {
    decision: 'allowed' | 'blocked';
    policy_id?: string;                  // FK to PolicyDefinition
    policy_set_id?: string;              // FK to PolicySet (version at evaluation)
    violation_id?: string;               // FK to PolicyViolation (if blocked)
  };

  status: 'success' | 'error';
  duration_ms: number;
  created_at: string;
}
```

**Stored in:** DB
**Why:** observability, debugging, policy enforcement audit

**Redaction Strategy:**

| Rule | Implementation |
|------|----------------|
| Raw args/results never stored | Only redacted JSON persisted |
| Deny by default | All fields stripped unless explicitly allowlisted |
| Secrets detected | Flag set if redaction engine found patterns |
| Verification | SHA256 hash of original enables integrity check |
| Optional encrypted storage | `full_payload_ref` points to encrypted blob (short retention, admin-only access) |

**Payload Hash Canonicalization:**

`payload_hash` is SHA256 of **canonical JSON (sorted keys, UTF-8) before redaction**. This ensures:
- Two codepaths generating the same logical payload produce the same hash
- Integrity verification is deterministic regardless of JSON serialization order
- Hash is computed on original data, enabling verification even when only redacted version is stored

**Hash scheme versioning:** Each hash is tagged with `payload_hash_scheme` (e.g., `sha256:cjson:v1`) to enable future canonicalization changes while preserving ability to validate older rows.

---

### 6.4 Artifact

Structured documents that act as checkpoints (PLAN/REVIEW/TEST_REPORT).

```ts
type ArtifactType = 'plan' | 'review' | 'test_report' | 'other';

interface Artifact {
  artifact_id: string;
  run_id: string;

  type: ArtifactType;
  version: number;

  // content strategy:
  // - small content inline (dev)
  // - large content in blob storage with pointer
  content_markdown?: string;
  blob_ref?: string;
  size_bytes: number;

  checksum_sha256: string;

  // Source tracking (required for test_report, optional for others)
  source_tool_invocation_id?: string;    // FK to ToolInvocation

  github_write_id?: string;              // FK to GitHubWrite (replaces inline mirror fields)

  created_by: string;                    // agent role or system
  created_at: string;
}
```

**Stored in:** DB (authoritative)
**Mirrored to GitHub:** yes (final artifacts per verbosity policy)

**Source Tracking Rule:**

For `test_report` artifacts, `source_tool_invocation_id` is **required**. This enables artifact validation to verify:
- The test_report corresponds to a real test command execution
- The reported pass/fail matches the tool invocation exit status
- No hallucinated test results (agent can't claim tests passed without running them)

---

### 6.5 GateEvaluation

Record of a gate evaluation attempt.

```ts
type GateStatus = 'pending' | 'passed' | 'failed';

interface GateEvaluation {
  gate_evaluation_id: string;
  run_id: string;

  gate_id: string;                       // FK to GateDefinition
  kind: 'automatic' | 'human' | 'policy';

  status: GateStatus;                    // ternary only
  reason?: string;
  details_json?: string;                 // gate-specific details

  evaluated_at: string;
  duration_ms?: number;
}
```

**Stored in:** DB
**Mirrored to GitHub:** pass/fail/pending only when it matters (per verbosity)

---

### 6.6 OperatorAction

Every control action taken in the Conductor UI.

```ts
type OperatorActionType =
  | 'start_run'
  | 'approve_plan'
  | 'revise_plan'
  | 'reject_run'
  | 'retry'
  | 'pause'
  | 'resume'
  | 'cancel'
  // Policy exception actions
  | 'grant_policy_exception'
  | 'deny_policy_exception';
  // Post-MVP:
  // | 'approve_sensitive_changes'

// INVARIANT: All operator action types MUST be enumerated above.
// New action types must be added to this enum before use in any document.

interface OperatorAction {
  operator_action_id: string;
  run_id: string;

  action: OperatorActionType;
  operator: string;                      // human identity (GitHub username or internal user)
  comment?: string;

  from_phase?: RunPhase;
  to_phase?: RunPhase;

  created_at: string;

  github_write_id?: string;              // FK to GitHubWrite
}
```

**Stored in:** DB (authoritative)
**Mirrored to GitHub:** always (audit surface)

---

### 6.7 Override

Explicit, logged bypass/exception decisions. Overrides are **not blanket exceptions**—they include constraints that limit what they permit.

```ts
type OverrideScope = 'this_run' | 'this_task' | 'this_repo' | 'project_wide';
type ConstraintKind = 'host' | 'command' | 'path' | 'diff' | 'artifact' | 'location';

interface Override {
  override_id: string;
  run_id: string;

  kind:
    | 'skip_tests'
    | 'accept_with_issues'
    | 'policy_exception'
    | 'bypass_planning_review'
    | 'force_retry';

  target_id?: string;                    // gate_id or policy_id depending on kind
  scope: OverrideScope;

  // Constraints limit what this override permits (required for policy_exception)
  constraint_kind?: ConstraintKind;      // What type of constraint
  constraint_value?: string;             // The specific value (host, command, path pattern, etc.)
  constraint_hash?: string;              // Content hash for matching (e.g., diff hash, location content hash)

  // Policy version at grant time
  policy_set_id?: string;                // FK to PolicySet (for policy_exception kind)

  operator: string;
  justification: string;

  created_at: string;
  expires_at?: string;                   // Optional expiration

  github_write_id?: string;              // FK to GitHubWrite
}
```

**Stored in:** DB
**Mirrored to GitHub:** yes (high audit value)

**Constraint Examples:**

| Override Kind | Constraint Kind | Constraint Value | Meaning |
|---------------|-----------------|------------------|---------|
| `policy_exception` (no_network_access) | `host` | `api.example.com` | Allow only this host |
| `policy_exception` (allowed_commands) | `command` | `curl` | Allow only curl |
| `policy_exception` (no_secrets_in_code) | `location` | `src/config.ts:42` | Allow only this location |
| `policy_exception` (no_secrets_in_code) | `diff` | `sha256:abc123...` | Allow only this exact diff |

**Policy evaluation rule:** For `policy_exception` overrides, both `target_id` (policy_id) AND constraint must match. A blanket "allow_all" override requires explicit `constraint_kind: null` with elevated permissions.

---

### 6.8 Evidence

Structured storage for violation evidence that separates safe metadata from sensitive content.

```ts
type EvidenceKind = 'diff_snippet' | 'file_location' | 'command' | 'artifact_ref';

interface Evidence {
  evidence_id: string;
  run_id: string;

  kind: EvidenceKind;

  // Safe metadata (stored in main DB, queryable)
  location?: {
    file: string;
    line_start: number;
    line_end: number;
  };
  command_name?: string;                 // Just the command, not args
  pattern_matched?: string;              // Name of pattern, not the match

  // Redacted content for display
  redacted_text: string;
  redacted_hash: string;                 // SHA256 of redacted_text

  // Sensitive content (encrypted, short retention)
  raw_blob_ref?: string;                 // Reference to encrypted storage
  raw_blob_expires_at?: string;

  created_at: string;
}
```

**Stored in:** DB (metadata) + encrypted blob storage (sensitive content)
**Purpose:**
- Evidence metadata is queryable without exposing secrets
- Raw content is encrypted with short retention (default 7 days)
- GitHub mirrors reference `violation_id` and show only redacted summaries

**Access Rules:**

| Role | Can See |
|------|---------|
| Agent | Nothing (violations block actions) |
| Operator | Metadata + redacted_text |
| Admin | Full evidence via raw_blob_ref (audit logged) |
| GitHub Mirror | Metadata only (file, line, pattern name) |

---

### 6.9 PolicyViolation

Blocking or warning violations discovered by the policy engine.

```ts
type PolicySeverity = 'warning' | 'blocking';

interface PolicyViolation {
  violation_id: string;
  run_id: string;

  policy_id: string;                     // FK to PolicyDefinition
  policy_set_id: string;                 // FK to PolicySet (version at detection time)
  severity: PolicySeverity;
  description: string;                   // Never contains secret values

  evidence_id: string;                   // FK to Evidence
  tool_invocation_id?: string;           // FK to ToolInvocation (if triggered by tool)

  detected_at: string;

  resolved_by_override_id?: string;      // FK to Override
}
```

**Stored in:** DB
**Mirrored to GitHub:** blocking violations yes (metadata only); warnings optional/UI-only.

---

### 6.10 PolicyAuditEntry

Record of every policy evaluation (not just violations).

```ts
interface PolicyAuditEntry {
  audit_id: string;
  run_id: string;

  policy_id: string;                     // FK to PolicyDefinition
  policy_set_id: string;                 // FK to PolicySet (version at evaluation time)

  enforcement_point: 'tool_invocation' | 'pre_push' | 'artifact_validation';
  target: string;                        // File path, command name, artifact type (never sensitive content)

  decision: 'allowed' | 'blocked';

  // If blocked
  violation_id?: string;                 // FK to PolicyViolation

  evaluated_at: string;
}
```

**Stored in:** DB
**Purpose:**
- Complete audit trail of all policy evaluations (not just violations)
- Enables "why was this allowed?" queries, not just "why was this blocked?"
- `policy_set_id` ensures audit is reproducible even after policy changes

---

### 6.12 GitHubWrite

Record of every write to GitHub (comments, check runs, project field updates).

```ts
type GitHubWriteKind = 'comment' | 'check_run' | 'project_field_update';
type GitHubTargetType = 'issue' | 'pr' | 'project_item' | 'repo';
type GitHubWriteStatus = 'queued' | 'sent' | 'failed' | 'ambiguous';

interface GitHubWrite {
  github_write_id: string;
  run_id: string;

  kind: GitHubWriteKind;
  target_node_id: string;                // GitHub node ID of issue/PR/project item
  target_type: GitHubTargetType;         // Clarifies what target_node_id refers to

  idempotency_key: string;               // unique; makes retries safe
  payload_hash: string;                  // SHA256 of payload for dedup/verification
  payload_hash_scheme: string;           // e.g., "sha256:cjson:v1"

  status: GitHubWriteStatus;             // includes 'ambiguous' for network failures
  error?: string;

  // GitHub response (populated on success)
  github_id?: number;                    // comment_id, check_run_id, etc.
  github_url?: string;

  created_at: string;
  sent_at?: string;

  retry_count: number;
}
```

**Stored in:** DB
**Purpose:**
- Centralized tracking of all GitHub writes
- Enables retry/rate-limit handling (idempotency_key prevents double-comments on worker crash)
- Replaces scattered `github_comment_id` fields on other entities
- Audit trail for GitHub interactions

**Idempotency key composition:**

```
idempotency_key = sha256(kind + ":" + target_node_id + ":" + payload_hash)
```

This provides deterministic idempotency and allows key recreation without storing the raw payload.

**Payload hash scheme:** Each hash is tagged with `payload_hash_scheme` (e.g., `sha256:cjson:v1`) to enable future canonicalization changes while preserving ability to validate older rows. The `target_type` field disambiguates the node_id since the same write kind may target different entity types.

---

### 6.10 Event

Append-only event stream for replay/debugging.

```ts
interface Event {
  event_id: string;
  run_id?: string;
  task_id?: string;
  repo_id?: string;
  project_id: string;

  type: string;                          // e.g. run.started, phase.entered, gate.failed
  payload_json: string;

  // Ordering (required when run_id is set)
  sequence?: number;                     // monotonic per run (1, 2, 3...)

  idempotency_key: string;
  created_at: string;

  github_write_id?: string;              // FK to GitHubWrite (if mirrored)
}
```

**Stored in:** DB (always)
**Mirrored to GitHub:** selected event types only (verbosity policy)

**Append-only guarantees:**
- `idempotency_key UNIQUE` prevents duplicate processing
- `sequence` enables deterministic replay within a run (required when `run_id` is set; null for project-level events)
- `created_at` provides wall-clock time (not reliable for ordering across distributed nodes)
- Uniqueness constraint on `(run_id, sequence)` when `run_id` is not null; enforce in app logic if DB doesn't support partial unique indexes

---

## 7) GitHub ↔ DB Sync Model

### 7.1 GitHub → DB (ingest facts)

Triggered by webhooks + periodic reconciliation:

* issues: created/edited/labeled/closed
* issue_comment: created
* pull_request: opened/synchronized/closed/merged
* pull_request_review: submitted
* check_run/check_suite: completed (optional)
* projects_v2_item: updated (optional mirror drift detection only)

**Key rule:** GitHub facts can update Task snapshots and can close/merge PR state, but **do not directly "control" runs**.

### 7.2 DB → GitHub (mirror checkpoints)

Conductor writes (via GitHubWrite records):

* Audit comments for **OperatorAction** and **Override**
* Artifacts (PLAN/REVIEW/TEST_REPORT) per verbosity policy
* Errors/escalations
* Check runs (status indicators)
* Optional GitHub Projects fields/columns

### 7.3 Conflict rules

| Data | Authority | Sync Behavior |
|------|-----------|---------------|
| Task content (title/body/labels) | GitHub | DB stores snapshot; refresh on access |
| Run state/phase/gates | DB | GitHub never overrides |
| GitHub Projects fields | DB (if `enforce_projects: true`) | Snapback on sync; otherwise best-effort |

---

## 8) Database Schema (Conceptual SQL)

Below is a conceptual schema (dialect-agnostic). Some constraints (like partial indexes) vary by DB.

```sql
-- Gate definitions (seed data)
CREATE TABLE gate_definitions (
  gate_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  description TEXT NOT NULL,
  default_config_json TEXT NOT NULL
);

-- Policy definitions (seed data)
CREATE TABLE policy_definitions (
  policy_id TEXT PRIMARY KEY,
  severity TEXT NOT NULL,
  description TEXT NOT NULL,
  check_points_json TEXT NOT NULL,
  default_config_json TEXT NOT NULL
);

-- Policy sets (immutable snapshots for versioning)
CREATE TABLE policy_sets (
  policy_set_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(project_id),

  config_hash TEXT NOT NULL,             -- SHA256 of canonical JSON config
  replaces_policy_set_id TEXT REFERENCES policy_sets(policy_set_id),

  created_by TEXT NOT NULL,
  created_at TIMESTAMP NOT NULL
);

-- Policy set entries (immutable)
CREATE TABLE policy_set_entries (
  policy_set_id TEXT NOT NULL REFERENCES policy_sets(policy_set_id),
  policy_id TEXT NOT NULL REFERENCES policy_definitions(policy_id),

  enabled BOOLEAN NOT NULL,
  severity_override TEXT,
  config_json TEXT NOT NULL,

  PRIMARY KEY (policy_set_id, policy_id)
);

-- Projects
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
  enforce_projects BOOLEAN NOT NULL DEFAULT FALSE,

  port_range_start INTEGER NOT NULL,
  port_range_end INTEGER NOT NULL,

  created_at TIMESTAMP NOT NULL,
  updated_at TIMESTAMP NOT NULL
);

-- Repos
CREATE TABLE repos (
  repo_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(project_id),

  github_node_id TEXT NOT NULL,
  github_numeric_id INTEGER NOT NULL,    -- named to avoid collision with internal repo_id
  github_owner TEXT NOT NULL,
  github_name TEXT NOT NULL,
  github_full_name TEXT NOT NULL,
  github_default_branch TEXT NOT NULL,

  profile_id TEXT NOT NULL,
  status TEXT NOT NULL,

  last_indexed_at TIMESTAMP,
  created_at TIMESTAMP NOT NULL,
  updated_at TIMESTAMP NOT NULL,

  UNIQUE(github_node_id)
);

-- Tasks (Work Items)
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
  github_synced_at TIMESTAMP NOT NULL,

  active_run_id TEXT,

  created_at TIMESTAMP NOT NULL,
  updated_at TIMESTAMP NOT NULL,
  last_activity_at TIMESTAMP NOT NULL,

  UNIQUE(github_node_id)
);

-- Runs
CREATE TABLE runs (
  run_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(task_id),
  project_id TEXT NOT NULL REFERENCES projects(project_id),
  repo_id TEXT NOT NULL REFERENCES repos(repo_id),

  -- Lineage tracking
  run_number INTEGER NOT NULL DEFAULT 1,     -- Sequential per task (1, 2, 3...)
  parent_run_id TEXT REFERENCES runs(run_id), -- If retry
  supersedes_run_id TEXT REFERENCES runs(run_id), -- If replacing previous attempt

  phase TEXT NOT NULL,
  step TEXT NOT NULL,
  -- status is DERIVED from (phase, paused_at), not stored

  -- Policy versioning (locked at run start)
  policy_set_id TEXT NOT NULL REFERENCES policy_sets(policy_set_id),

  -- Event stream tracking (for phase transition invariant)
  last_event_sequence INTEGER NOT NULL DEFAULT 0,
  next_sequence INTEGER NOT NULL DEFAULT 1,  -- Monotonic counter for sequence allocation

  -- Operator pause (separate from phase)
  paused_at TIMESTAMP,
  paused_by TEXT,

  -- Blocked state context (populated when phase='blocked')
  blocked_reason TEXT,                       -- e.g., 'policy_exception_required', 'retry_limit_exceeded'
  blocked_context_json TEXT,                 -- JSON: { prior_phase, violation_id?, gate_id? }

  -- Git state
  base_branch TEXT NOT NULL,
  branch TEXT NOT NULL,
  head_sha TEXT,

  -- PR identity (populated when PR exists; all-or-nothing bundle)
  pr_number INTEGER,
  pr_node_id TEXT,
  pr_url TEXT,
  pr_state TEXT,                         -- 'open' | 'closed' | 'merged'
  pr_synced_at TIMESTAMP,

  -- Prevent half-populated PR state
  CONSTRAINT chk_runs_pr_bundle CHECK (
    (pr_number IS NULL AND pr_node_id IS NULL AND pr_url IS NULL AND pr_state IS NULL AND pr_synced_at IS NULL)
    OR
    (pr_number IS NOT NULL AND pr_node_id IS NOT NULL AND pr_url IS NOT NULL AND pr_state IS NOT NULL AND pr_synced_at IS NOT NULL)
  ),

  plan_revisions INTEGER NOT NULL DEFAULT 0,
  test_fix_attempts INTEGER NOT NULL DEFAULT 0,
  review_rounds INTEGER NOT NULL DEFAULT 0,

  started_at TIMESTAMP NOT NULL,
  updated_at TIMESTAMP NOT NULL,
  completed_at TIMESTAMP,

  result TEXT,
  result_reason TEXT
);

-- Worktrees
CREATE TABLE worktrees (
  worktree_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(run_id),
  project_id TEXT NOT NULL REFERENCES projects(project_id),
  repo_id TEXT NOT NULL REFERENCES repos(repo_id),

  path TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL,

  last_heartbeat_at TIMESTAMP NOT NULL,
  created_at TIMESTAMP NOT NULL,
  destroyed_at TIMESTAMP
);

-- Port leases
CREATE TABLE port_leases (
  port_lease_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(project_id),
  worktree_id TEXT NOT NULL REFERENCES worktrees(worktree_id),

  port INTEGER NOT NULL,
  purpose TEXT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,

  leased_at TIMESTAMP NOT NULL,
  expires_at TIMESTAMP NOT NULL,
  released_at TIMESTAMP
);

-- Enforce single active lease per port per project
-- For Postgres/SQLite with partial indexes:
CREATE UNIQUE INDEX uniq_active_port_per_project
  ON port_leases(project_id, port)
  WHERE is_active = TRUE;

-- GitHub writes (centralized tracking)
CREATE TABLE github_writes (
  github_write_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(run_id),

  kind TEXT NOT NULL,
  target_node_id TEXT NOT NULL,
  target_type TEXT NOT NULL,             -- 'issue'|'pr'|'project_item'|'repo'

  idempotency_key TEXT NOT NULL UNIQUE,  -- prevents double-writes on retry
  payload_hash TEXT NOT NULL,
  payload_hash_scheme TEXT NOT NULL DEFAULT 'sha256:cjson:v1',

  status TEXT NOT NULL,
  error TEXT,

  github_id INTEGER,
  github_url TEXT,

  created_at TIMESTAMP NOT NULL,
  sent_at TIMESTAMP,
  retry_count INTEGER NOT NULL DEFAULT 0
);

-- Agent invocations
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

  started_at TIMESTAMP NOT NULL,
  completed_at TIMESTAMP
);

-- Tool invocations
CREATE TABLE tool_invocations (
  tool_invocation_id TEXT PRIMARY KEY,
  agent_invocation_id TEXT NOT NULL REFERENCES agent_invocations(agent_invocation_id),
  run_id TEXT NOT NULL REFERENCES runs(run_id),

  tool TEXT NOT NULL,
  target TEXT,

  -- Redacted storage
  args_redacted_json TEXT NOT NULL,
  args_fields_removed_json TEXT NOT NULL,
  args_secrets_detected BOOLEAN NOT NULL DEFAULT FALSE,
  args_payload_hash TEXT NOT NULL,
  args_payload_hash_scheme TEXT NOT NULL DEFAULT 'sha256:cjson:v1',

  result_meta_json TEXT NOT NULL,
  result_payload_hash TEXT NOT NULL,
  result_payload_hash_scheme TEXT NOT NULL DEFAULT 'sha256:cjson:v1',

  policy_decision TEXT NOT NULL,
  policy_id TEXT REFERENCES policy_definitions(policy_id),
  policy_set_id TEXT REFERENCES policy_sets(policy_set_id),
  violation_id TEXT REFERENCES policy_violations(violation_id),

  status TEXT NOT NULL,
  duration_ms INTEGER NOT NULL,
  created_at TIMESTAMP NOT NULL
);

-- Artifacts
CREATE TABLE artifacts (
  artifact_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(run_id),

  type TEXT NOT NULL,
  version INTEGER NOT NULL,

  content_markdown TEXT,
  blob_ref TEXT,
  size_bytes INTEGER NOT NULL,
  checksum_sha256 TEXT NOT NULL,

  -- Validation status (gates only read 'valid' artifacts)
  validation_status TEXT NOT NULL DEFAULT 'pending',  -- 'pending'|'valid'|'invalid'
  validation_errors_json TEXT,                         -- Array of error strings if invalid
  validated_at TIMESTAMP,

  -- Source tracking (required for test_report, optional for others)
  source_tool_invocation_id TEXT REFERENCES tool_invocations(tool_invocation_id),

  github_write_id TEXT REFERENCES github_writes(github_write_id),

  created_by TEXT NOT NULL,
  created_at TIMESTAMP NOT NULL,

  CONSTRAINT chk_artifacts_validation_status CHECK (
    validation_status IN ('pending', 'valid', 'invalid')
  )
);

-- Gate evaluations
CREATE TABLE gate_evaluations (
  gate_evaluation_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(run_id),

  gate_id TEXT NOT NULL REFERENCES gate_definitions(gate_id),
  kind TEXT NOT NULL,

  status TEXT NOT NULL,
  reason TEXT,
  details_json TEXT,

  -- Causation tracking (REQUIRED for ordering)
  causation_event_id TEXT NOT NULL REFERENCES events(event_id),

  evaluated_at TIMESTAMP NOT NULL,
  duration_ms INTEGER
);

-- Operator actions
CREATE TABLE operator_actions (
  operator_action_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(run_id),

  action TEXT NOT NULL,
  operator TEXT NOT NULL,
  comment TEXT,

  from_phase TEXT,
  to_phase TEXT,

  github_write_id TEXT REFERENCES github_writes(github_write_id),

  created_at TIMESTAMP NOT NULL
);

-- Overrides
CREATE TABLE overrides (
  override_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(run_id),

  kind TEXT NOT NULL,
  target_id TEXT,
  scope TEXT NOT NULL,

  -- Constraints (required for policy_exception kind)
  constraint_kind TEXT,                  -- 'host'|'command'|'path'|'diff'|'artifact'|'location'
  constraint_value TEXT,
  constraint_hash TEXT,                  -- Content hash for matching

  -- Policy version at grant time
  policy_set_id TEXT REFERENCES policy_sets(policy_set_id),

  operator TEXT NOT NULL,
  justification TEXT NOT NULL,

  expires_at TIMESTAMP,

  github_write_id TEXT REFERENCES github_writes(github_write_id),

  created_at TIMESTAMP NOT NULL
);

-- Evidence (structured storage for violation evidence)
CREATE TABLE evidences (
  evidence_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(run_id),

  kind TEXT NOT NULL,                    -- 'diff_snippet'|'file_location'|'command'|'artifact_ref'

  -- Safe metadata (queryable)
  location_file TEXT,
  location_line_start INTEGER,
  location_line_end INTEGER,
  command_name TEXT,
  pattern_matched TEXT,

  -- Redacted content for display
  redacted_text TEXT NOT NULL,
  redacted_hash TEXT NOT NULL,           -- SHA256 of redacted_text

  -- Sensitive content (encrypted, short retention)
  raw_blob_ref TEXT,
  raw_blob_expires_at TIMESTAMP,

  created_at TIMESTAMP NOT NULL
);

-- Policy violations
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
  detected_at TIMESTAMP NOT NULL
);

-- Policy audit entries (every evaluation, not just violations)
CREATE TABLE policy_audit_entries (
  audit_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(run_id),

  policy_id TEXT NOT NULL REFERENCES policy_definitions(policy_id),
  policy_set_id TEXT NOT NULL REFERENCES policy_sets(policy_set_id),

  enforcement_point TEXT NOT NULL,       -- 'tool_invocation'|'pre_push'|'artifact_validation'
  target TEXT NOT NULL,                  -- file path, command name, artifact type

  decision TEXT NOT NULL,                -- 'allowed'|'blocked'
  violation_id TEXT REFERENCES policy_violations(violation_id),

  evaluated_at TIMESTAMP NOT NULL
);

-- Routing decisions
CREATE TABLE routing_decisions (
  routing_decision_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(run_id),

  inputs_json TEXT NOT NULL,
  agent_graph_json TEXT NOT NULL,
  required_gates_json TEXT NOT NULL,
  optional_gates_json TEXT NOT NULL,
  reasoning TEXT NOT NULL,

  decided_at TIMESTAMP NOT NULL
);

-- Events (append-only)
CREATE TABLE events (
  event_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(project_id),

  repo_id TEXT,
  task_id TEXT,
  run_id TEXT,

  type TEXT NOT NULL,
  class TEXT NOT NULL,                   -- 'fact'|'decision'|'signal' (determines mutation authority)
  payload_json TEXT NOT NULL,

  sequence INTEGER,                      -- monotonic per run; required when run_id is set
  idempotency_key TEXT NOT NULL UNIQUE,
  created_at TIMESTAMP NOT NULL,
  processed_at TIMESTAMP,                -- null if pending; set when orchestrator processes

  -- Causation and correlation tracking
  causation_id TEXT REFERENCES events(event_id),
  correlation_id TEXT,                   -- stable ID for event families
  txn_id TEXT,                           -- all events in same transaction share this

  github_write_id TEXT REFERENCES github_writes(github_write_id),

  -- Enforce sequence/run_id coupling: both null or both not null
  CONSTRAINT chk_events_sequence_requires_run CHECK (
    (run_id IS NULL AND sequence IS NULL)
    OR
    (run_id IS NOT NULL AND sequence IS NOT NULL)
  ),

  -- Enforce class is valid
  CONSTRAINT chk_events_class CHECK (class IN ('fact', 'decision', 'signal'))
);

-- Enforce sequence uniqueness within a run (preferred; use app-level if partial unique not supported)
CREATE UNIQUE INDEX uniq_events_run_sequence
  ON events(run_id, sequence)
  WHERE run_id IS NOT NULL;

-- Indexes
CREATE INDEX idx_tasks_repo ON tasks(repo_id);
CREATE INDEX idx_tasks_project ON tasks(project_id);
CREATE INDEX idx_runs_task ON runs(task_id);
CREATE INDEX idx_runs_phase ON runs(phase);
CREATE INDEX idx_runs_paused ON runs(paused_at) WHERE paused_at IS NOT NULL;
CREATE INDEX idx_agent_invocations_run ON agent_invocations(run_id);
CREATE INDEX idx_tool_invocations_run ON tool_invocations(run_id);
CREATE INDEX idx_gate_evaluations_run ON gate_evaluations(run_id);
CREATE INDEX idx_github_writes_run ON github_writes(run_id);
CREATE INDEX idx_github_writes_status ON github_writes(status);
CREATE INDEX idx_github_writes_idempotency ON github_writes(idempotency_key);
-- Retry worker index (partial if supported, otherwise use full index)
CREATE INDEX idx_github_writes_retry
  ON github_writes(status, created_at)
  WHERE status IN ('queued', 'failed');
CREATE INDEX idx_events_run ON events(run_id);
CREATE INDEX idx_events_run_sequence ON events(run_id, sequence);
CREATE INDEX idx_events_created_at ON events(created_at);
CREATE INDEX idx_events_class ON events(class);
CREATE INDEX idx_events_unprocessed ON events(run_id, sequence) WHERE processed_at IS NULL;
CREATE INDEX idx_gate_evaluations_causation ON gate_evaluations(causation_event_id);

-- Policy versioning indexes
CREATE INDEX idx_policy_sets_project ON policy_sets(project_id);
CREATE INDEX idx_policy_set_entries_policy ON policy_set_entries(policy_id);
CREATE INDEX idx_runs_policy_set ON runs(policy_set_id);

-- Evidence and violation indexes
CREATE INDEX idx_evidences_run ON evidences(run_id);
CREATE INDEX idx_policy_violations_run ON policy_violations(run_id);
CREATE INDEX idx_policy_violations_policy_set ON policy_violations(policy_set_id);
CREATE INDEX idx_policy_audit_entries_run ON policy_audit_entries(run_id);
CREATE INDEX idx_policy_audit_entries_policy_set ON policy_audit_entries(policy_set_id);

-- Artifact validation indexes (gates only read valid artifacts)
CREATE INDEX idx_artifacts_run_type_valid ON artifacts(run_id, type)
  WHERE validation_status = 'valid';
CREATE INDEX idx_artifacts_validation_pending ON artifacts(run_id, validation_status)
  WHERE validation_status = 'pending';
```

---

## 9) Queries (Examples)

### 9.1 Active runs (in progress)

```sql
SELECT
  p.name AS project,
  r.github_full_name AS repo,
  t.github_issue_number,
  t.github_title,
  ru.phase,
  ru.step,
  ru.started_at
FROM runs ru
JOIN tasks t ON ru.task_id = t.task_id
JOIN repos r ON ru.repo_id = r.repo_id
JOIN projects p ON ru.project_id = p.project_id
WHERE ru.phase NOT IN ('completed', 'cancelled')
  AND ru.phase != 'blocked'
  AND ru.paused_at IS NULL
ORDER BY ru.started_at DESC;
```

### 9.2 Runs awaiting operator action

```sql
SELECT
  r.github_full_name AS repo,
  t.github_issue_number,
  t.github_title,
  ru.phase,
  ru.updated_at
FROM runs ru
JOIN tasks t ON ru.task_id = t.task_id
JOIN repos r ON ru.repo_id = r.repo_id
WHERE ru.phase IN ('awaiting_plan_approval', 'blocked', 'awaiting_review')
ORDER BY ru.updated_at ASC;
```

### 9.3 Audit trail for a run (operator actions + overrides)

```sql
SELECT 'action' AS kind, created_at AS ts, action AS name, operator, comment
FROM operator_actions
WHERE run_id = :run_id
UNION ALL
SELECT 'override' AS kind, created_at AS ts, kind AS name, operator, justification
FROM overrides
WHERE run_id = :run_id
ORDER BY ts ASC;
```

### 9.4 Pending GitHub writes (for retry queue)

```sql
SELECT *
FROM github_writes
WHERE status IN ('queued', 'failed')
  AND retry_count < 3
ORDER BY created_at ASC;
```

### 9.5 Event replay for a run

```sql
SELECT *
FROM events
WHERE run_id = :run_id
ORDER BY sequence ASC;
```

---

## 10) Retention and Storage Notes

* **DB should not be a blob store.** Artifacts and large logs should support `blob_ref`.
* Store:

  * SHA256 checksums for tamper detection
  * sizes for budget control
  * redacted tool args/results (raw never stored)
* Keep an explicit retention policy:

  * e.g., full tool logs retained 14 days, artifacts retained 1 year, events retained indefinitely (or compacted)

---

## 11) Identity Model: Internal IDs vs GitHub Node IDs

Conductor uses a dual-identity model:

| Identity Type | Purpose | Example |
|---------------|---------|---------|
| Internal IDs | DB primary keys, foreign key relationships | `repo_id`, `task_id`, `run_id` |
| GitHub node_id | Cross-system joins, deduplication, GraphQL queries | `github_node_id` (UNIQUE constraint) |

**Key Rules:**

1. **Internal IDs are DB primary keys** — All foreign key relationships use internal IDs (`repo_id`, not `github_node_id`)
2. **GitHub node_id is globally unique** — `UNIQUE` constraints prevent duplicate entity registration
3. **Cross-system joins use node_id** — When correlating Conductor data with GitHub API responses, use `node_id`
4. **Never use mutable identifiers for joins** — Issue numbers, repo names, etc. can change; `node_id` is stable

This design allows:
- Efficient DB operations via internal IDs
- Safe correlation with GitHub via immutable node_ids
- Future migration to a normalized `github_entities` table

---

## 12) Future Normalization: GitHub Entities Table

Currently, GitHub identity fields are repeated across entities (`github_node_id`, `github_org_id`, etc.).

At scale, consider a normalized `github_entities` table:

```sql
CREATE TABLE github_entities (
  node_id TEXT PRIMARY KEY,              -- GraphQL node ID (stable)
  type TEXT NOT NULL,                    -- 'org', 'repo', 'issue', 'pr', 'user'
  numeric_id INTEGER,                    -- REST API ID
  url TEXT,

  cached_data_json TEXT,                 -- denormalized fields
  synced_at TIMESTAMP
);
```

This enables:
- Single source of truth for GitHub identity
- Deduplication across entities
- Easier GraphQL query batching
- Cleaner foreign key relationships

Not required for v1, but the schema is designed to allow this migration.

---

## 13) Non-Goals

* No repo-local Conductor configuration files.
* No "GitHub Projects drives the state machine."
* No "GitHub is authoritative for run phases."
* No implicit overrides (everything bypass-y is explicit and logged).
* No raw tool args/results in DB (redaction required).

---

## Further Reading

- [PROTOCOL.md](PROTOCOL.md) — Event types and state machine
- [ROUTING_AND_GATES.md](ROUTING_AND_GATES.md) — Routing and gate definitions
- [ARCHITECTURE.md](ARCHITECTURE.md) — System components
- [POLICIES.md](POLICIES.md) — Policy engine, redaction, enforcement points
