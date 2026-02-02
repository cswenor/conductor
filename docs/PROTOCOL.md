# Conductor Protocol

This document defines the protocols for state management, control actions, agent communication, events, and artifacts. These protocols make the system observable, auditable, and debuggable.

---

## Protocol Invariants

These invariants are the constitution of the protocol. They must never be violated.

**Authority:**
- Run phase may change only via orchestrator-emitted events
- Agents may propose, review, report, or escalate, but may never directly change run phase, gate state, or lifecycle
- Gates are evaluated only via GateEvaluation records; gate state is derived, not stored on runs
- All control actions originate from Conductor UI; GitHub is never a command interface

**Immutability:**
- Artifacts are append-only and versioned; previous versions are never edited or deleted
- Events are append-only; events are never modified after creation
- GitHub comments posted by Conductor are never edited or deleted

**GitHub boundary:**
- GitHub webhooks update snapshots only; no webhook directly triggers a run state transition
- Webhook handlers may only write `events` (class: 'fact') and update `tasks` snapshot cache
- Only orchestrator workers may write `runs.phase` and must do so with a corresponding 'decision' event
- All GitHub writes are idempotent and retry-safe
- GitHub is a mirror surface, never a source of truth for operational state

**Ordering:**
- Events may arrive out of order; processing MUST respect `sequence` over `created_at`
- Within a run, `sequence` provides total ordering; `created_at` is informational only
- Only the orchestrator may assign run event sequences; sequences are allocated atomically via DB counter

**State machine:**
- Run record is a projection of the event log
- Orchestrator MUST write (a) the event and (b) the resulting state mutation in the same transaction
- No state change without a corresponding event; no event without the state change

---

## Core Identifiers

### Task vs Run

| Identifier | Scope | Description |
|------------|-------|-------------|
| `task_id` | Issue-level | Conductor UUID (stable internal identifier) |
| `task_slug` | Issue-level | Display identifier: `{owner}/{repo}#{issue_number}` (for UI only) |
| `github_node_id` | Issue-level | GitHub GraphQL node ID (stable, used for deduplication) |
| `run_id` | Execution-level | Conductor-generated UUID for each execution attempt |

**Identity Model:**

| Field | Purpose | Stability |
|-------|---------|-----------|
| `task_id` | Internal DB primary key, foreign key relationships | Stable (Conductor UUID) |
| `github_node_id` | Cross-system joins, deduplication | Stable (GitHub-assigned) |
| `task_slug` | Human display, URLs, logs | **Unstable** (changes on repo rename/transfer) |

Example: `task_id = "task_a1b2c3d4"`, `github_node_id = "I_kwDOABC123"`, `task_slug = "acme/webapp#161"`

**Important:** Never use `task_slug` for joins, lookups, or idempotency keys. It changes when repos are renamed or transferred. Use `task_id` (internal) or `github_node_id` (cross-system).

One task can have multiple runs (retries, revisions, re-executions). Every comment, event, and artifact includes `run_id` for precise correlation.

### Run Lineage

| Field | Description |
|-------|-------------|
| `run_number` | Sequential attempt number per task (1, 2, 3...) |
| `parent_run_id` | For retries: the run this continues from |
| `supersedes_run_id` | For "start fresh": the run this replaces |

This enables UI to show "Attempt 3 of task #161" and audit to trace retry chains.

---

## Authoritative State (Database)

State is managed in **Conductor's database**. This is the source of truth.

### Run Phases

| Phase | Description |
|-------|-------------|
| `pending` | Run created, environment being set up |
| `planning` | Agents designing the approach |
| `awaiting_plan_approval` | Plan ready, waiting for human approval |
| `executing` | Implementation underway |
| `awaiting_review` | PR created, awaiting human review |
| `blocked` | Needs human intervention |
| `completed` | Merged and cleaned up |
| `cancelled` | Aborted by human |

### Run Record vs Run View

The protocol distinguishes **canonical** (stored) from **derived** (computed) fields.

```typescript
// Canonical: stored in DB
interface RunRecord {
  run_id: string;
  task_id: string;           // Conductor UUID (stable)
  phase: RunPhase;

  // Lineage
  run_number: number;        // 1, 2, 3... per task
  parent_run_id?: string;    // If retry
  supersedes_run_id?: string; // If replacing previous attempt

  // Pause state (separate from phase)
  paused_at?: string;        // null if not paused
  paused_by?: string;        // operator who paused
  pause_reason?: string;     // optional reason

  // Iteration tracking
  iterations: {
    plan_revisions: number;
    test_fix_attempts: number;
    review_rounds: number;
  };

  // Timing
  started_at: string;
  updated_at: string;
  completed_at?: string;

  // Git state
  branch: string;
  issue_number: number;
  pr_number?: number;
}

// Derived: computed for UI (not stored)
interface RunView extends RunRecord {
  status: RunStatus;                      // Derived from (phase, paused_at)
  gates: Record<string, GateStatus>;      // Derived from GateEvaluation records
  conductor_url: string;                  // Computed presentation URL
}

// Derived status logic
type RunStatus = 'active' | 'paused' | 'blocked' | 'finished';

function deriveStatus(phase: RunPhase, paused_at?: string): RunStatus {
  if (phase === 'completed' || phase === 'cancelled') return 'finished';
  if (paused_at) return 'paused';
  if (phase === 'blocked') return 'blocked';
  return 'active';
}
```

**Pause vs blocked:** Pause is operator-initiated suspension of a healthy run. Blocked is system-detected inability to proceed. A paused run can resume immediately; a blocked run requires intervention to fix the underlying issue.

**Gate state derivation:** Gate state is derived from the latest GateEvaluation per gate_id. "Latest" is determined by the causation event's sequence. Runs do not store embedded gate state.

**Gate evaluation ordering rule:**

```typescript
interface GateEvaluation {
  gate_evaluation_id: string;
  run_id: string;
  gate_id: string;
  status: 'pending' | 'passed' | 'failed';

  // Causation tracking (REQUIRED)
  causation_event_id: string;    // FK to events(event_id) that triggered this evaluation

  evaluated_at: string;          // Informational only
}
```

**Ordering derivation:**
- Primary: `causation_event.sequence` (from the referenced event)
- Tie-breaker: `gate_evaluation_id` lexicographically (deterministic UUID ordering)
- `evaluated_at` is informational only; do not use for ordering

**Latest gate evaluation query:**
```sql
SELECT ge.* FROM gate_evaluations ge
JOIN events e ON ge.causation_event_id = e.event_id
WHERE ge.run_id = ? AND ge.gate_id = ?
ORDER BY e.sequence DESC, ge.gate_evaluation_id DESC
LIMIT 1;
```

### State Transition Diagram

```
┌─────────┐
│ pending │
└────┬────┘
     │ environment ready
     ▼
┌──────────┐
│ planning │◄────────────────────────────┐
└────┬─────┘                             │
     │ plan ready                        │ revise requested
     ▼                                   │
┌─────────────────────────┐              │
│ awaiting_plan_approval  │──────────────┘
└────────────┬────────────┘
             │ approved
             ▼
┌───────────┐
│ executing │◄───────────────────────────┐
└─────┬─────┘                            │
      │ PR created                       │ changes requested
      ▼                                  │
┌─────────────────┐                      │
│ awaiting_review │──────────────────────┘
└────────┬────────┘
         │ merged
         ▼
┌───────────┐
│ completed │
└───────────┘

Any phase can transition to:
- blocked (on unrecoverable error)
- cancelled (on human cancel)
```

### Phase Transition Rules

**Invariant:** A run's `phase` may change only in response to a valid `phase.transitioned` event emitted by the orchestrator. Agents, webhooks, and external systems cannot directly mutate phase.

**Canonical event:** `phase.transitioned` is the single event type that drives state machine transitions. Other phase-related events (`phase.entered`, `phase.exited`) are observability events derived from `phase.transitioned` and MUST be emitted in the same transaction.

```typescript
interface PhaseTransitionedPayload {
  from: RunPhase;
  to: RunPhase;
  reason: string;              // Short human-readable explanation
  checkpoint?: Checkpoint;     // If transition is due to checkpoint completion
  trigger: {
    type: 'operator_action' | 'gate_result' | 'agent_output' | 'timeout' | 'error';
    ref?: string;              // operator_action_id, gate_evaluation_id, etc.
  };
}
```

**blocked vs awaiting_* distinction:**
- `awaiting_*` phases represent **expected waits** (plan approval, PR review). The run is healthy and progressing normally.
- `blocked` is entered **only** when forward progress is impossible without human intervention: failed gate, policy violation, exceeded retry limit, or unrecoverable error.
- `blocked` MUST NOT be used for normal wait states. `awaiting_*` MUST NOT be used for error states.

---

## Inbound GitHub Event Handling (Normative)

GitHub webhooks are processed in a two-stage model that preserves the "orchestrator-only phase transition" invariant.

### Stage 1: Webhook Ingestion

Webhook handlers have limited authority:

| Allowed | Not Allowed |
|---------|-------------|
| Write `events` table (class: 'fact') | Write `runs.phase` |
| Update `tasks` snapshot cache | Emit 'decision' events |
| Update `repos` snapshot cache | Directly transition run state |

```typescript
// Webhook handler (limited authority)
async function handleGitHubWebhook(payload: WebhookPayload): Promise<void> {
  // ✅ Allowed: Persist fact event
  await db.insert('events', {
    event_id: generateId(),
    type: `github_webhook:${payload.action}`,
    class: 'fact',  // Facts, not decisions
    source: 'github_webhook',
    payload: payload,
    idempotency_key: computeWebhookIdempotencyKey(payload),
    // ... other fields
  });

  // ✅ Allowed: Update task snapshot
  if (payload.issue) {
    await updateTaskSnapshot(payload.issue);
  }

  // ❌ NOT ALLOWED: Direct phase mutation
  // await db.update('runs', { run_id }, { phase: 'completed' });
}
```

### Stage 2: Orchestrator Processing

The orchestrator consumes fact events and emits decision events:

```typescript
// Orchestrator (full authority)
async function processFactEvent(event: Event): Promise<void> {
  if (event.class !== 'fact') return;

  // Determine if this fact triggers a state change
  if (event.type === 'github_webhook:pull_request.closed' && event.payload.merged) {
    // Emit decision event (which will update runs.phase)
    await emitDecisionEvent({
      type: 'phase.transitioned',
      class: 'decision',
      run_id: findRunForPR(event.payload.pull_request),
      causation_id: event.event_id,
      payload: {
        from: 'awaiting_review',
        to: 'completed',
        reason: 'PR merged',
        trigger: { type: 'github_webhook', ref: event.event_id },
      },
    });
  }
}
```

This separation ensures:
- Webhooks are pure "facts" that can be safely replayed
- All state changes are traceable to orchestrator decisions
- No "helpful" webhook code can bypass the state machine

---

## Mirrored Surfaces

GitHub surfaces **mirror** state from the database. They are views, not sources of truth.

### GitHub Projects (Optional)

If enabled, Conductor syncs run state to GitHub Projects v2 fields.

| Internal Phase | Project Field Value |
|----------------|---------------------|
| `pending` | Planning |
| `planning` | Planning |
| `awaiting_plan_approval` | Awaiting Approval |
| `executing` | In Progress |
| `awaiting_review` | In Review |
| `blocked` | Blocked |
| `completed` | Done |
| `cancelled` | Done |

Note: `pending` (environment setup) is displayed as "Planning" for simplicity. Detailed status (setup vs active planning) is visible in Conductor UI.

**Sync Rules:**
- Conductor → GitHub Projects: on every phase transition
- GitHub Projects → Conductor: **never** (Projects do not trigger actions)
- Conflict resolution: DB wins; Projects may lag or drift

Column/field mapping is configurable per project in Conductor settings.

### GitHub Issue/PR Comments

All significant events are mirrored to GitHub as comments for auditability. See "Verbosity Policy" below.

### GitHub Check Runs

Conductor creates check runs to show:
- Current phase
- Agent activity status
- Gate results

---

## Control Actions (UI)

**All control actions originate from Conductor UI.** GitHub is never used as a command interface.

### Available Actions

| Action | When Available | Effect |
|--------|----------------|--------|
| **Start Run** | Issue selected in Backlog | Creates run, begins planning (see options below) |
| **Approve Plan** | `awaiting_plan_approval` | Proceeds to execution |
| **Revise Plan** | `awaiting_plan_approval` | Returns to planning with feedback |
| **Reject & Cancel** | `awaiting_plan_approval` | Rejects plan and cancels the run |
| **Retry** | `blocked` | Resumes from last completed checkpoint |
| **Cancel** | Any phase | Aborts run, cleans up |
| **Pause** | Any active phase | Suspends after current step |
| **Resume** | Paused runs | Continues execution |

### Start Run Options

When starting a run, operators can configure:

| Option | Description | Default |
|--------|-------------|---------|
| `base_branch` | Branch to create worktree from | Repo default branch |
| `mode` | `standard` or `fast` (skip optional gates) | `standard` |
| `profile` | Agent/policy profile override | Project default |
| `priority` | Queue priority (1-10) | 5 |
| `auto_execute` | Start execution immediately after plan approval | `false` |
| `plan_only` | Stop after planning, don't execute | `false` |

These options are stored in the run record and visible in UI.

### Checkpoints and Retry Semantics

Retries resume from the most recent **completed checkpoint**, not from arbitrary steps.

```typescript
type Checkpoint =
  | 'environment_ready'      // Worktree created, dependencies installed
  | 'planning_complete'      // Plan artifact created
  | 'plan_approved'          // Human approved the plan
  | 'implementation_complete' // Code changes committed
  | 'tests_passed'           // Test suite passed
  | 'pr_created';            // Pull request opened
```

**Retry behavior:**
- On retry, orchestrator identifies the most recent completed checkpoint
- Execution resumes from that checkpoint, not from the failed step
- Partial work after the checkpoint may be discarded
- Checkpoint completion is recorded as an event with `type: checkpoint.completed`

**Checkpoint completion event:**

Only the orchestrator may emit `checkpoint.completed`. This event records evidence of checkpoint completion.

```typescript
interface CheckpointCompletedPayload {
  checkpoint: Checkpoint;
  evidence: {
    artifact_id?: string;      // For planning_complete: the PLAN artifact
    head_sha?: string;         // For implementation_complete, tests_passed: commit SHA
    pr_number?: number;        // For pr_created: the PR number
    gate_evaluation_id?: string; // For tests_passed: the passing gate eval
    operator_action_id?: string; // For plan_approved: the approval action
  };
}
```

Checkpoints are evidenced, not just declared. Retry logic uses evidence to validate that resumption is safe.

**Checkpoint Validity Anchors (Normative):**

Some checkpoints are **invalidated by subsequent changes**. The checkpoint evidence includes anchors that must still hold for the checkpoint to be valid:

| Checkpoint | Anchor | Invalidated By |
|------------|--------|----------------|
| `tests_passed` | `head_sha` | New commits after test run |
| `implementation_complete` | `head_sha` | New commits |
| `pr_created` | `pr_number` + `head_sha` | PR closed or new commits |

**Checkpoint validity check:**

```typescript
function isCheckpointValid(checkpoint: CheckpointCompletedPayload, run: Run): boolean {
  switch (checkpoint.checkpoint) {
    case 'tests_passed':
    case 'implementation_complete':
      // Checkpoint is valid only if head_sha hasn't changed
      return checkpoint.evidence.head_sha === run.head_sha;

    case 'pr_created':
      // PR must still exist and match current head
      return checkpoint.evidence.pr_number === run.pr_number
          && checkpoint.evidence.head_sha === run.head_sha;

    default:
      // Other checkpoints don't have anchors
      return true;
  }
}
```

**Retry semantics:** When determining "most recent completed checkpoint" for retry, the orchestrator MUST verify that the checkpoint is still valid under current anchors. An invalidated checkpoint is treated as not completed for retry purposes.

Example: If `tests_passed` was recorded at `head_sha: abc123` but the run now has `head_sha: def456` (new commit), retry resumes from `implementation_complete` (or earlier), not from `tests_passed`.

### Action with Feedback

Every action accepts an optional comment:

```typescript
interface ControlAction {
  action: 'start_run' | 'approve_plan' | 'revise_plan' | 'reject_and_cancel' |
          'retry' | 'cancel' | 'pause' | 'resume';
  run_id: string;
  operator: string;
  comment?: string;  // Optional feedback
  timestamp: string;
  options?: StartRunOptions;  // For start_run action
}
```

### Audit Trail (Mirrored to GitHub)

When an operator takes an action, Conductor:
1. Records the action in DB (authoritative)
2. Posts an audit comment to GitHub (mirror)

**Audit Comment Format (Rendering Convention — Non-Normative):**

The exact markdown format may evolve. The protocol requires only that audit comments include: run_id, action, operator, timestamp, and phase transition (if any).

```markdown
<!-- conductor:action {"run_id":"abc123","action":"approve_plan","operator":"alice"} -->

**[Conductor | Operator Action | run:abc123]**

✅ **Plan Approved** by @alice

> Looks good. Make sure to handle the edge case for expired refresh tokens.

---
<details>
<summary>Action details</summary>

- Action: approve_plan
- Run: abc123
- Phase: awaiting_plan_approval → executing
- Timestamp: 2024-01-15T10:30:00Z
</details>
```

---

## Verbosity Policy

Not everything goes to GitHub. This prevents comment spam while maintaining auditability.

### What Goes to GitHub (Comments)

| Event Type | Posts to GitHub |
|------------|-----------------|
| Phase transitions | ✅ Yes |
| Gate results (pass/fail) | ✅ Yes |
| Operator actions | ✅ Yes |
| Human escalations | ✅ Yes |
| Final artifacts (plan, test report) | ✅ Yes |
| Agent questions needing human input | ✅ Yes |
| Errors requiring attention | ✅ Yes |

### What Stays in Conductor UI Only

| Event Type | GitHub | Conductor UI |
|------------|--------|--------------|
| Incremental progress updates | ❌ | ✅ |
| Tool-by-tool execution traces | ❌ | ✅ |
| Streaming agent output | ❌ | ✅ |
| Internal agent negotiation details | ❌ | ✅ |
| Performance metrics | ❌ | ✅ |

### Comment Strategy

Conductor avoids progress chatter; GitHub comments are **checkpointed, not streamed**.

- **One comment per phase transition** (not edited later)
- **Artifacts posted as discrete comments** (plan, test report, review)
- **Escalations and errors always post** (regardless of rate limits)
- **No live-updating comments** — Conductor UI handles real-time progress

GitHub comments are **append-only**. Conductor never edits or deletes its own comments.

### Rate Limiting

Even for allowed GitHub writes:
- **Comment rate limit:** 1 comment / 30 seconds per run (burst 3)
- **Deduplication:** Repeated status updates collapsed

**Priority bypass:** The following GitHub writes are high-priority and MUST be delivered even under throttling (subject only to GitHub API hard limits):
- Phase transitions
- Operator actions
- Overrides
- Errors and escalations
- Human questions requiring input

Only "optional mirror writes" (progress summaries, incremental updates) are subject to throttling.

### GitHub Write Idempotency

GitHub writes must be exactly-once from Conductor's perspective, even when workers crash mid-write.

**GitHubWrite Status Model:**

```typescript
type GitHubWriteStatus =
  | 'queued'    // Not yet attempted
  | 'sent'      // Successfully sent, GitHub response received
  | 'failed'    // Failed with definitive error (4xx, validation error)
  | 'ambiguous'; // Network failure after request sent; outcome unknown
```

**Mechanism:**
1. Every GitHub write includes a cryptographically-bound marker in an HTML comment:
   ```html
   <!-- conductor:write {"github_write_id":"gw_abc123","payload_hash":"sha256:abc..."} -->
   ```
2. The marker includes both `github_write_id` AND `payload_hash` for verification
3. The `github_write_id` is assigned before the write attempt and stored in the GitHubWrite record
4. DB `github_writes.idempotency_key UNIQUE` prevents duplicate execution by workers

**Idempotency key rule:** `idempotency_key = sha256(kind + ":" + target_node_id + ":" + payload_hash)`. This enables deterministic retry detection.

**Status Transitions:**

```
queued → sent       (success)
queued → failed     (definitive error: 4xx, validation)
queued → ambiguous  (network error after request sent)
ambiguous → sent    (marker found on scan)
ambiguous → queued  (marker not found, safe to retry)
```

**Recovery on Ambiguous Failure (Normative):**

Comment scanning is expensive and should be scoped:

1. **Only scan when status is 'ambiguous'** (network failure after request send)
2. **Verify both `github_write_id` AND `payload_hash`** in the marker match the DB record
3. **Scan limit:** Last 100 comments or comments newer than the write attempt
4. **On marker found:** Transition to 'sent', extract `github_id` from GitHub API
5. **On marker not found:** Transition to 'queued', retry the write

```typescript
async function recoverAmbiguousWrite(write: GitHubWrite): Promise<void> {
  // Only scan for ambiguous status
  if (write.status !== 'ambiguous') return;

  const marker = await scanForMarker(write.target_node_id, write.github_write_id);

  if (marker && marker.payload_hash === write.payload_hash) {
    // Write succeeded; update status
    await db.update('github_writes', { github_write_id: write.github_write_id }, {
      status: 'sent',
      github_id: marker.github_comment_id,
      sent_at: new Date().toISOString(),
    });
  } else {
    // Write didn't happen; safe to retry
    await db.update('github_writes', { github_write_id: write.github_write_id }, {
      status: 'queued',
    });
  }
}
```

**Note:** Humans or attackers could paste fake markers, but verification of `payload_hash` ensures we only accept markers that match our actual payload.

---

## Agent Communication Protocol

Agents publish checkpointed outputs to GitHub via Conductor-proxied tools. This makes decisions and checkpoints visible and auditable.

**Security model:** Agents initiate GitHub writes through Conductor-proxied MCP tools. Conductor enforces target scoping (only current issue/PR), rate limiting, formatting requirements, and identity stamping. Agents never hold GitHub credentials directly.

**Authority boundary:** Agents may propose, review, report, and escalate. Agents may NOT directly change run phase, gate state, or lifecycle. Only the orchestrator may do so in response to events.

### Comment Structure (Rendering Convention — Non-Normative)

The exact markdown format may evolve. The protocol requires that agent comments include machine-readable metadata (run_id, agent, action) and human-readable content.

```markdown
<!-- conductor:agent {"run_id":"abc123","agent":"planner","action":"propose"} -->

**[Conductor | Planner | run:abc123]**

{Human-readable content}

---
<details>
<summary>Metadata</summary>

```json
{structured payload}
```
</details>
```

### Metadata Schema

```typescript
interface AgentCommentMetadata {
  run_id: string;           // Always required
  task_id: string;          // Issue-level identifier
  agent: 'planner' | 'implementer' | 'reviewer' | 'tester';
  action: 'propose' | 'review' | 'approve' | 'request_changes' |
          'implement' | 'report' | 'question' | 'escalate';
  artifact?: string;        // PLAN, REVIEW, TEST_REPORT
  version?: number;
  phase: string;
  timestamp: string;
  reply_to?: string;        // Logical parent comment ID (see note below)
}
```

**Note on `reply_to`:** This field provides logical threading for Conductor UI and replay tooling. It is NOT guaranteed to map to GitHub comment threading, as GitHub comment IDs are not stable across deletion/edit edge cases. Treat as a logical relationship, not a GitHub API contract.

**Note on agent actions:** Agent actions (propose, review, approve, etc.) describe what the agent is *communicating*, not what state change occurs. State changes happen only when the orchestrator processes the agent's output and emits a corresponding event.
```

### Agent Roles

| Role | Display | Responsibilities |
|------|---------|------------------|
| Planner | `[Conductor \| Planner]` | Designs approach, produces PLAN |
| Implementer | `[Conductor \| Implementer]` | Writes code, runs tests |
| Reviewer | `[Conductor \| Reviewer]` | Critiques plans and code |
| Tester | `[Conductor \| Tester]` | Runs test suites, reports results |
| Orchestrator | `[Conductor \| System]` | Phase transitions, errors, status |

### Action Types

#### `propose`
Agent puts forward a plan or solution.

#### `review`
Agent evaluates another agent's work.

#### `approve`
Agent signs off on work.

#### `request_changes`
Agent asks for modifications.

#### `implement`
Agent reports implementation progress (summary only—details in UI).

#### `report`
Agent shares results (test report, final status).

#### `question`
Agent needs human clarification.

#### `escalate`
Agent cannot proceed without human intervention.

---

## Event Schema

All significant events are recorded. Events go to DB (always) and GitHub comments (per verbosity policy).

### Event Categories

| Category | Examples | GitHub | DB |
|----------|----------|--------|-----|
| Lifecycle | run.started, run.completed | ✅ | ✅ |
| Phase | phase.transitioned (normative), phase.entered/exited (derived) | ✅ | ✅ |
| Checkpoint | checkpoint.completed | ❌ | ✅ |
| Gate | gate.evaluated, gate.passed, gate.failed | ✅ | ✅ |
| Operator | action.approve, action.cancel | ✅ | ✅ |
| Agent | agent.invoked, agent.completed | ❌ | ✅ |
| Error | error.agent, error.system | ✅ | ✅ |

### Event Structure

```typescript
// Event classification
type EventClass =
  | 'fact'      // Sourced externally (GitHub webhooks); never directly mutates run
  | 'decision'  // Emitted by orchestrator; IS allowed to mutate run state
  | 'signal';   // Internal telemetry (agent.started); never mutates run

// Base event (project-level, no run context)
interface BaseEvent {
  event_id: string;
  project_id: string;
  task_id?: string;
  type: string;
  class: EventClass;         // REQUIRED: determines mutation authority
  payload: Record<string, any>;
  created_at: string;        // Wall-clock timestamp (informational, not for ordering)
  source: 'github_webhook' | 'ui_action' | 'scheduler' | 'agent_runtime' | 'system';
  idempotency_key: string;
  causation_id?: string;     // Event that caused this one
  correlation_id?: string;   // Stable ID for event families (retry chains, test cycles)
  txn_id?: string;           // All events in same transaction share this
}

// Run-scoped event (sequence required)
interface RunEvent extends BaseEvent {
  run_id: string;
  task_id: string;
  sequence: number;          // Monotonic per run (1, 2, 3...) — REQUIRED for run events
  processed_at?: string;     // When orchestrator processed this event (null if pending)
}

type Event = BaseEvent | RunEvent;
```

**Event Class Rules (Normative):**

| Class | Authority | Can Mutate Run? | Examples |
|-------|-----------|-----------------|----------|
| `fact` | External system | No | `github_webhook:issue.edited`, `github_webhook:pr.merged` |
| `decision` | Orchestrator | Yes | `phase.transitioned`, `checkpoint.completed`, `gate.evaluated` |
| `signal` | Any component | No | `agent.started`, `agent.completed`, `tool.invoked` |

**Projection mutation rule:** Only events with `class: 'decision'` may drive changes to the run projection (`runs.phase`, `runs.step`, checkpoints, gate derivations). Processing a `fact` or `signal` event MUST NOT mutate the run record directly—it may only trigger orchestrator logic that subsequently emits a `decision` event.

**Timestamp naming:** Use `created_at` consistently for storage timestamp. UI may display as "timestamp" but canonical field name is `created_at`.

**Sequence requirement:** All events with a `run_id` MUST have a `sequence` number. Events without `run_id` (project-level events) have no sequence.

**Sequence Assignment (Normative):**

Only the orchestrator assigns run event sequences. Sequence assignment is atomic and monotonic:

```typescript
// Orchestrator allocates sequence in same transaction as event insert
function allocateSequence(run_id: string): number {
  // Atomically: SELECT next_sequence FROM runs WHERE run_id = ? FOR UPDATE
  //             UPDATE runs SET next_sequence = next_sequence + 1
  //             RETURN the selected value
  return db.transaction(() => {
    const run = db.selectForUpdate('runs', { run_id });
    const seq = run.next_sequence;
    db.update('runs', { run_id }, { next_sequence: seq + 1 });
    return seq;
  });
}
```

**Invariants:**
- `runs.next_sequence` starts at 1 when run is created
- Sequences are never reused within a run
- DB enforces uniqueness on `(run_id, sequence)`
- No two workers can allocate the same sequence (SELECT FOR UPDATE or equivalent)

**Causation tracking:** All phase transitions MUST reference the event that caused them via `causation_id`. Gate evaluations and checkpoint completions SHOULD include causation_id. This enables debugging and audit trail reconstruction.

### Idempotency

Every event has an `idempotency_key`. Processing the same event twice has no effect. This enables:
- Safe retries
- Event replay for debugging
- Crash recovery

### Replay Semantics

Event replay is **best-effort for audit and debugging**, not guaranteed deterministic:

| Deterministic | Non-deterministic |
|---------------|-------------------|
| Event ordering (via sequence) | Wall-clock time (timeouts, scheduling) |
| Fact → decision causation | External state (GitHub PR status at replay time) |
| Phase transition sequence | Agent model outputs (may vary) |

**Replay limitations:**
- Decisions that depended on time (timeouts) may not reproduce exactly
- Decisions that queried external systems (GitHub API) may see different state
- Agent outputs are not deterministic across model versions

**For strict replay:** All non-deterministic inputs would need to be captured as `fact` events (e.g., `scheduler.timeout_fired`, `github.pr_state_observed`). This is not implemented in v1.

### Out-of-Order Handling

Events may arrive out of order due to network delays, retries, or distributed processing.

**Processing rules:**
- Within a run, always process events in `sequence` order, not `timestamp` order
- `timestamp` is wall-clock time and is informational only; do not use for ordering
- Cross-run events (project-level) use `timestamp` as a hint but are generally independent

**Durable Processing State (Normative):**

Event ordering is enforced via `processed_at` tracking, not in-memory queues:

```typescript
// Orchestrator processing loop
function processNextEvent(run_id: string): boolean {
  return db.transaction(() => {
    // Find smallest unprocessed sequence where all prior sequences are processed
    const event = db.query(`
      SELECT * FROM events
      WHERE run_id = ?
        AND processed_at IS NULL
        AND sequence = (
          SELECT MIN(sequence) FROM events
          WHERE run_id = ? AND processed_at IS NULL
        )
        AND NOT EXISTS (
          SELECT 1 FROM events
          WHERE run_id = ?
            AND sequence < events.sequence
            AND processed_at IS NULL
        )
      FOR UPDATE
    `, [run_id, run_id, run_id]);

    if (!event) return false;  // No processable events

    // Process event and mark as processed
    processEvent(event);
    db.update('events', { event_id: event.event_id }, {
      processed_at: new Date().toISOString()
    });
    return true;
  });
}
```

**Invariants:**
- `processed_at IS NULL` means event is pending
- Events are processed in strict sequence order (no gaps)
- A crash leaves events with `processed_at IS NULL`; recovery resumes from there
- No in-memory queues needed; ordering is enforced by query logic

---

## Artifacts

Artifacts are structured documents that agents produce. They serve as checkpoints and audit records.

**Storage model:** Artifacts are stored in Conductor's database (canonical). GitHub comments contain a rendered view plus an integrity hash. This enables replay and verification.

**Immutability invariant:** Artifacts are immutable once created. Revisions produce new versions (incrementing `version`); previous versions are never edited or deleted. This is essential for audit and replay.

```typescript
interface Artifact {
  artifact_id: string;
  run_id: string;
  type: 'PLAN' | 'TEST_REPORT' | 'REVIEW';
  version: number;           // Increments on revision; v1 is first version
  content: string;           // Markdown content
  sha256: string;            // Integrity hash
  github_write_id?: string;  // FK to GitHubWrite if posted
  created_at: string;
}
```

### PLAN (Rendering Convention — Non-Normative)

**Producer:** Planner
**Consumer:** Reviewer, Implementer, Human

The protocol requires PLAN artifacts to include: goal, approach, files to modify/create, and risks. The exact markdown structure may evolve.

```markdown
# Plan: {Task Title}

## Goal
{One paragraph: what does success look like?}

## Approach
{Detailed description}

### Steps
1. {Step with expected outcome}
2. ...

## Files

### To Modify
| File | Changes |
|------|---------|
| `path/to/file.ts` | {what changes} |

### To Create
| File | Purpose |
|------|---------|
| `path/to/new.ts` | {purpose} |

## Risks
| Risk | Likelihood | Mitigation |
|------|------------|------------|
| {description} | Low/Medium/High | {mitigation} |

## Out of Scope
{What this plan explicitly does NOT cover}

## Open Questions
{Questions for human reviewer, or "None"}
```

### TEST_REPORT (Rendering Convention — Non-Normative)

**Producer:** Tester / Implementer
**Consumer:** Gate Engine, Human

The protocol requires TEST_REPORT artifacts to include: pass/fail counts, overall result, and failure details. The exact markdown structure may evolve.

```markdown
# Test Report

## Summary
| Status | Count |
|--------|-------|
| ✅ Passed | {n} |
| ❌ Failed | {n} |
| ⏭️ Skipped | {n} |

## Result: {PASS | FAIL}

## Failed Tests
{Details for each failure}

## Coverage
{If available}
```

### REVIEW (Rendering Convention — Non-Normative)

**Producer:** Reviewer
**Consumer:** Implementer, Human

The protocol requires REVIEW artifacts to include: summary, verdict (APPROVED/CHANGES_REQUESTED), and findings. The exact markdown structure may evolve.

```markdown
# Code Review

## Summary
{Overall assessment}

## Verdict: {APPROVED | CHANGES_REQUESTED}

## Findings

### Critical
{Must fix}

### Suggestions
{Nice to have}

### Positive
{What was done well}
```

---

## Conversation Threading

Agent conversations have implicit structure. The orchestrator tracks conversation state.

**Note:** GitHub doesn't support true comment threading. The `reply_to` field provides logical threading used by Conductor UI and replay tooling to reconstruct conversation flow.

### Conversation Model

```typescript
interface Conversation {
  run_id: string;
  topic: 'planning' | 'implementation' | 'review';
  participants: string[];
  status: 'active' | 'resolved' | 'escalated';
  outcome?: 'approved' | 'rejected' | 'needs_human';
}
```

### Iteration Limits

| Conversation | Max Iterations | On Limit |
|--------------|----------------|----------|
| Plan negotiation | 3 rounds | Escalate to human |
| Test-fix cycle | 3 attempts | Block for human |
| Code review fixes | 3 rounds | Block for human |

All limits are configurable in Conductor settings.

---

## Error Handling

### Error Categories

| Category | Examples | Handling |
|----------|----------|----------|
| Transient | Network timeout, rate limit | Auto-retry with backoff |
| Agent | Model error, invalid output | Retry once, then escalate |
| Gate | Failed check, missing artifact | Block, notify human |
| System | Database error, disk full | Block, alert operator |

### Error Comments

Errors are always posted to GitHub (overrides verbosity policy):

```markdown
<!-- conductor:error {"run_id":"abc123","code":"AGENT_TIMEOUT"} -->

**[Conductor | Error | run:abc123]**

## ❌ Agent Timeout

The Implementer agent did not respond within 15 minutes.

**Context:**
- Phase: executing
- Last activity: Writing `src/services/auth.ts`

**Next Steps:**
[View run in Conductor](https://conductor.example.com/runs/abc123) to retry or cancel.

*Run is now blocked.*
```

### Recovery Protocol

1. **Transient errors:** Auto-retry up to 3 times with exponential backoff
2. **Agent errors:** Retry once with fresh context, then block
3. **Persistent failures:** Block run, preserve state, notify operator
4. **On operator retry:** Resume from last stable checkpoint

---

## Configuration

Protocol behavior is configured in **Conductor settings** (stored in database), not repo files.

### Project-Level Settings

```yaml
# Stored in Conductor DB, configured via UI
project: acme-platform
protocol:
  limits:
    plan_revisions: 3
    test_fix_attempts: 3
    review_rounds: 3

  gates:
    require_plan_approval: true
    require_tests_pass: true

  timeouts:
    plan_approval_hours: 72
    reminder_after_hours: 24

  verbosity:
    post_phase_transitions: true
    post_progress_updates: false
```

### Per-Repo Overrides

Individual repos can override project defaults in Conductor settings.

---

## Further Reading

- [VISION.md](VISION.md) — Product vision and philosophy
- [ARCHITECTURE.md](ARCHITECTURE.md) — System components and data flow
- [CONTROL_PLANE_UX.md](CONTROL_PLANE_UX.md) — UI screens and operator workflows
- [INTEGRATION_MODEL.md](INTEGRATION_MODEL.md) — GitHub App integration
- [ISSUE_INTAKE.md](ISSUE_INTAKE.md) — PM agent and issue creation
- [DATA_MODEL.md](DATA_MODEL.md) — Database schema
- [ROUTING_AND_GATES.md](ROUTING_AND_GATES.md) — Routing and quality gates
- [POLICIES.md](POLICIES.md) — Policy engine, enforcement, and redaction
