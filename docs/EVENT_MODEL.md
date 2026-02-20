# Event Model

> **Status:** Normative. This is the canonical reference for Conductor's event envelope schema, event types, producer/consumer rules, and ordering guarantees. PROTOCOL.md and DATA_MODEL.md defer to this document for event specifications.

## 1. Two Event Systems

Conductor maintains two complementary event systems optimized for different consumers:

| System | Table | Purpose | Consumer | Ordering |
| --- | --- | --- | --- | --- |
| **Core Events** | `events` | Audit trail, state replay, run reconstruction | Orchestrator, admin | Per-run `sequence` (monotonic, gap-free) |
| **Stream Events** | `stream_events` | Real-time client notifications | Browser clients via SSE | Global `id` (auto-increment) |

**Key invariant:** Core events are the source of truth. Stream events are derived notifications. If the two systems disagree, core events win.

---

## 2. Core Event Envelope (Canonical)

```typescript
interface EventRecord {
  // Identity
  event_id: string;              // UUID: evt_<timestamp><random>
  idempotency_key: string;       // UNIQUE — prevents duplicate processing

  // Scope
  project_id: string;            // Required — every event belongs to a project
  repo_id?: string;              // Optional — scoped to a repo
  task_id?: string;              // Optional — scoped to a task
  run_id?: string;               // Optional — scoped to a run

  // Classification
  type: EventType;               // What happened (§ 3)
  class: EventClass;             // Mutation authority (§ 4)
  source: EventSource;           // Who emitted it (§ 4.2)

  // Content
  payload_json: string;          // JSON-encoded payload (schema varies by type)

  // Ordering
  sequence?: number;             // Monotonic within run (NULL if no run_id)

  // Causality
  causation_id?: string;         // Event that directly triggered this event
  correlation_id?: string;       // Grouping ID for retry chains / transactions
  txn_id?: string;               // Database transaction ID

  // Timestamps
  created_at: string;            // ISO 8601 — when the event was created
  processed_at?: string;         // ISO 8601 — when the orchestrator processed it

  // Integration
  github_write_id?: string;      // FK to github_writes table (if event triggers a mirror write)
}
```

**Constraints:**
- `(run_id IS NULL AND sequence IS NULL) OR (run_id IS NOT NULL AND sequence IS NOT NULL)` — sequence requires run context
- `UNIQUE(run_id, sequence) WHERE run_id IS NOT NULL` — no duplicate sequences within a run
- `UNIQUE(idempotency_key)` — global deduplication

---

## 3. Event Type Enum (Canonical)

### 3.1 Inbound Events (from GitHub webhooks)

These events represent external facts observed via webhook delivery.

```typescript
type InboundEventType =
  // Installation lifecycle
  | 'installation.created'
  | 'installation.deleted'
  | 'installation.suspend'
  | 'installation.unsuspend'
  | 'installation_repositories.added'
  | 'installation_repositories.removed'
  // Issue lifecycle
  | 'issue.opened'
  | 'issue.edited'
  | 'issue.closed'
  | 'issue.reopened'
  | 'issue.assigned'
  | 'issue.unassigned'
  | 'issue.labeled'
  | 'issue.unlabeled'
  // Issue comments
  | 'issue_comment.created'
  | 'issue_comment.edited'
  | 'issue_comment.deleted'
  // Pull request lifecycle
  | 'pr.opened'
  | 'pr.edited'
  | 'pr.closed'
  | 'pr.merged'
  | 'pr.reopened'
  | 'pr.synchronize'
  | 'pr.ready_for_review'
  | 'pr.converted_to_draft'
  // Pull request reviews
  | 'pr.review_submitted'
  | 'pr.review_dismissed'
  // Push events
  | 'push.received'
  // CI/CD
  | 'check_suite.completed'
  | 'check_run.completed';
```

**Normalization rules:** GitHub webhooks are normalized from `(event_type, action)` pairs:

| GitHub Event | GitHub Action | Conductor Event Type | Special Logic |
| --- | --- | --- | --- |
| `pull_request` | `closed` | `pr.merged` or `pr.closed` | Check `payload.merged === true` |
| `pull_request` | `*` | `pr.<action>` | Direct mapping |
| `issues` | `*` | `issue.<action>` | Direct mapping |
| `issue_comment` | `*` | `issue_comment.<action>` | Direct mapping |
| `push` | — | `push.received` | No action field |
| `check_suite` | `completed` | `check_suite.completed` | Only `completed` handled |
| `check_run` | `completed` | `check_run.completed` | Only `completed` handled |
| `installation` | `*` | `installation.<action>` | Direct mapping |
| `installation_repositories` | `*` | `installation_repositories.<action>` | Direct mapping |

**Idempotency key format:** `webhook:<deliveryId>:<normalizedType>` — guarantees each GitHub delivery produces exactly one event.

### 3.2 Internal Events (orchestrator and worker)

```typescript
type InternalEventType =
  // Phase transitions (orchestrator only)
  | 'phase.transitioned'
  // Agent lifecycle
  | 'agent.started'
  | 'agent.completed'
  | 'agent.failed'
  // Tool execution
  | 'tool.invoked'
  | 'tool.policy_blocked'
  // Gate evaluation
  | 'gate.evaluated'
  | 'gate.passed'
  | 'gate.failed'
  // Operator actions
  | 'operator.action'
  // System events
  | 'system.timeout'
  | 'system.retry';
```

### 3.3 Combined Event Type

```typescript
type EventType = InboundEventType | InternalEventType;
```

Total: **44 event types** (30 inbound + 14 internal).

---

## 4. Event Classification

### 4.1 Event Class

```typescript
type EventClass = 'fact' | 'decision' | 'signal';
```

| Class | Who Can Emit | Mutates State? | Examples |
| --- | --- | --- | --- |
| `fact` | Any source | **No** | Webhook received, tool completed, test exited |
| `decision` | **Orchestrator only** | **Yes** | Phase transitioned, gate evaluated, run blocked |
| `signal` | Any source | **No** | Timeout triggered, retry requested |

**Key invariant:** State projections (`runs.phase`, `gate_evaluations.status`) are updated **only** by processing `decision` events. Facts inform decisions but never directly mutate state.

**Replay rule:** Given the same sequence of facts, the orchestrator MUST produce the same sequence of decisions. This enables deterministic replay.

### 4.2 Event Source

```typescript
type EventSource = 'webhook' | 'tool_layer' | 'orchestrator' | 'operator' | 'worker';
```

| Source | Allowed Classes | Examples |
| --- | --- | --- |
| `webhook` | `fact` only | All inbound events from GitHub |
| `tool_layer` | `fact` only | `tool.invoked`, `tool.policy_blocked` |
| `orchestrator` | `decision`, `fact` | `phase.transitioned`, `gate.evaluated` |
| `operator` | `fact` only | `operator.action` |
| `worker` | `fact`, `signal` | `agent.started`, `agent.completed`, `system.timeout` |

**Enforcement:** `phase.transitioned` events with `source !== 'orchestrator'` are rejected at creation time.

### 4.3 Producer/Consumer Matrix

| Event Type | Producer | Consumer | Notes |
| --- | --- | --- | --- |
| `installation.*` | Webhook handler | Project sync | Updates project/repo state |
| `issue.*` | Webhook handler | Work item sync | Updates work item state |
| `issue_comment.*` | Webhook handler | Feedback capture | Stores comment for agent context |
| `pr.*` | Webhook handler | PR lifecycle | Updates run PR state, triggers gates |
| `push.received` | Webhook handler | Branch detection | Triggers `checking` if run active |
| `check_suite.completed` | Webhook handler | Gate evaluation | Feeds into automated check gate |
| `check_run.completed` | Webhook handler | Gate evaluation | Individual check result |
| `phase.transitioned` | Orchestrator | State projections, SSE | Updates `runs.phase`, emits stream event |
| `agent.started` | Worker | Audit trail, SSE | Emits stream event |
| `agent.completed` | Worker | Orchestrator, SSE | Triggers next phase, emits stream event |
| `agent.failed` | Worker | Orchestrator, SSE | May trigger `failed` phase |
| `tool.invoked` | Tool layer | Audit trail | Debugging / compliance |
| `tool.policy_blocked` | Tool layer | Audit trail, operator | Policy violation record |
| `gate.evaluated` | Orchestrator | State projections, SSE | Updates gate status |
| `gate.passed` | Orchestrator | State projections | Specific pass record |
| `gate.failed` | Orchestrator | State projections | Specific failure record |
| `operator.action` | API handler | Orchestrator, SSE | Triggers phase transition |
| `system.timeout` | Watchdog | Orchestrator | Triggers `failed` transition |
| `system.retry` | Retry handler | Orchestrator | Triggers retry from `failed` |

---

## 5. Event Ordering

### 5.1 Per-Run Ordering

Events within a single run are ordered by `sequence` — a monotonically increasing, gap-free integer allocated by the orchestrator.

```sql
-- Sequence allocation (inside transaction)
SELECT COALESCE(MAX(sequence), 0) + 1 FROM events WHERE run_id = $1;
```

**Rules:**
- Sequence starts at 1 for each run
- No gaps: 1, 2, 3, ... (not 1, 3, 5)
- Sequence is allocated in the same transaction as the event creation
- Out-of-order arrival: buffer and wait for prior sequence (60s timeout, then alert)

### 5.2 Cross-Run Ordering

Events across different runs have **no ordering guarantee**. Cross-run coordination uses `correlation_id` for grouping but not for ordering.

### 5.3 Causality Chain

Events can reference their cause:

- `causation_id`: The event that directly triggered this event (e.g., a `pr.review_submitted` fact causes a `gate.evaluated` decision)
- `correlation_id`: Groups all events in a retry chain or logical transaction

```
webhook.received (fact) ──causation──► gate.evaluated (decision) ──causation──► phase.transitioned (decision)
     │                                      │                                         │
     └──── correlation_id: "corr_abc" ──────┴─────────────────────────────────────────┘
```

---

## 6. Stream Events (V2)

### 6.1 Stream Event Schema

```typescript
interface StreamEventBase {
  id?: number;          // Auto-increment (present on replay, absent on live)
  kind: string;         // Discriminator (see § 6.2)
  projectId: string;    // Scoping
  runId?: string;       // Optional run context
  timestamp: string;    // ISO 8601
}

type StreamEventV2 =
  | RunPhaseChangedEventV2
  | GateEvaluatedEvent
  | OperatorActionEvent
  | AgentInvocationEvent
  | RunUpdatedEvent
  | ProjectUpdatedEvent
  | RefreshRequiredEvent;
```

### 6.2 Stream Event Types

| Kind | Fields (beyond base) | When Emitted |
| --- | --- | --- |
| `run.phase_changed` | `fromPhase`, `toPhase` | Phase transition (T1-T18) |
| `gate.evaluated` | `gateId`, `gateKind`, `status`, `reason?` | Automated check result |
| `operator.action` | `action`, `operator` | Operator decision |
| `agent.invocation` | `agentInvocationId`, `agent`, `action`, `status`, `errorCode?` | Agent lifecycle |
| `run.updated` | `fields[]` | Run field change (PR created, etc.) |
| `project.updated` | `reason` | Project settings changed |
| `refresh_required` | `reason` | Client should full-refresh |

### 6.3 Core → Stream Event Mapping

When a core event is created, a corresponding stream event is published:

| Core Event Type | Stream Event Kind | Notes |
| --- | --- | --- |
| `phase.transitioned` | `run.phase_changed` | Always |
| `gate.evaluated` | `gate.evaluated` | Always |
| `gate.passed` | `gate.evaluated` (status: passed) | Mapped |
| `gate.failed` | `gate.evaluated` (status: failed) | Mapped |
| `operator.action` | `operator.action` | Always |
| `agent.started` | `agent.invocation` (status: started) | Mapped |
| `agent.completed` | `agent.invocation` (status: completed) | Mapped |
| `agent.failed` | `agent.invocation` (status: failed) | Mapped |
| PR field changes | `run.updated` | Derived from `pr.*` processing |
| Project config changes | `project.updated` | On settings mutation |
| — | `refresh_required` | On schema migration, large gap |

**Not all core events produce stream events.** Webhook facts, tool events, and system signals are not broadcast to clients.

### 6.4 Publishing Flow

```
Core Event Created (events table)
  → publishTransitionEvent() / publishGateEvaluatedEvent() / etc.
    → persistAndPublish(db, projectId, streamEvent)
      → INSERT INTO stream_events (kind, project_id, run_id, payload_json, created_at)
      → Redis PUBLISH conductor:events:{projectId} <JSON>
```

**Fire-and-forget:** Stream event publish failures are logged but never block core event processing.

### 6.5 SSE Delivery

```
Redis PUBLISH conductor:events:{projectId}
  → Per-process shared subscriber (fan-out dispatch map)
    → Per-connection handler
      → SSE frame: id: {stream_event.id}\nevent: {kind}\ndata: {payload}\n\n
```

**Replay race prevention:** The SSE handler SHOULD use a two-phase flow: (1) snapshot the current `stream_events.id`, (2) replay events up to snapshot, (3) subscribe and stream live events > snapshot. This prevents live events arriving before replay frames.

**Replay support:** On reconnect with `Last-Event-ID`:

```sql
SELECT * FROM stream_events
WHERE project_id IN (user's projects)
  AND id > $lastEventId
  AND created_at > datetime('now', '-5 minutes')
ORDER BY id ASC
LIMIT 100;
```

| Replay Parameter | Value |
| --- | --- |
| Max events | 100 |
| Max age | 5 minutes |
| On gap too large | Emit `refresh_required` event |
| Heartbeat interval | 30 seconds |

---

## 7. Event Storage and Retention

### 7.1 Core Events

| Property | Value |
| --- | --- |
| Storage | `events` table (SQLite, same DB as runs) |
| Retention | Indefinite (append-only audit log) |
| Compaction | None (events are never modified or deleted) |
| Indexing | `run_id`, `created_at`, `class`, `(run_id, sequence)` unprocessed |

### 7.2 Stream Events

| Property | Value |
| --- | --- |
| Storage | `stream_events` table (SQLite) |
| Retention | 14 days (pruned by periodic cleanup) |
| Compaction | Old events deleted after retention window |
| Indexing | `(project_id, id)`, `created_at` |

### 7.3 Archival

For runs that are `completed` or `cancelled`, the event stream can be exported as a JSON-lines file:

```json
{"event_id":"evt_abc","type":"phase.transitioned","sequence":1,...}
{"event_id":"evt_def","type":"agent.completed","sequence":2,...}
```

Archived event streams are stored alongside run artifacts and can be replayed for debugging or auditing.

---

## 8. Event Replay Semantics

### 8.1 Deterministic Replay

The orchestrator processes events in `sequence` order. Given the same stream of `fact` events, the orchestrator MUST produce the same `decision` events. This enables:

- **Audit:** Reconstruct exactly what happened during a run
- **Debugging:** Replay events to reproduce a bug
- **Recovery:** Rebuild run state from event log

### 8.2 Idempotency

Every event has a unique `idempotency_key`. Re-processing an event with the same key is a no-op.

**Key formats:**
- Webhooks: `webhook:<deliveryId>:<normalizedType>`
- Transitions: `transition:<runId>:<sequence>`
- Agent: `agent:<taskId>:<agentType>:<action>`
- Operator: `operator:<runId>:<action>:<timestamp>`

### 8.3 Replay Procedure

```
1. SELECT * FROM events WHERE run_id = $1 ORDER BY sequence ASC
2. For each event:
   a. If class = 'fact': feed to orchestrator as input
   b. If class = 'decision': verify orchestrator would produce the same decision
   c. If class = 'signal': feed to orchestrator as input
3. Final state should match runs.phase
```

---

## 9. Reconciliation with Other Documents

### 9.1 PROTOCOL.md

| PROTOCOL.md (current) | This Document (canonical) | Status |
| --- | --- | --- |
| Defines event class as `fact`/`decision` | Adds `signal` class | **Update required** |
| References inline event schema | Defer to EVENT_MODEL.md § 2 | **Update required** |
| Defines 8 phase values | Defer to RUN_STATE_MACHINE.md § 2 | Already updated |
| `PhaseTransitionedPayload` | Standardized in § 2 payload format | **Update required** |

### 9.2 DATA_MODEL.md

| DATA_MODEL.md (current) | This Document (canonical) | Status |
| --- | --- | --- |
| Uses "category" for event classification | Uses `class` (fact/decision/signal) | **Update required** |
| Defines event schema inline | Defer to EVENT_MODEL.md § 2 | **Update required** |
| Missing `source` field documentation | Defined in § 4.2 | **Update required** |
| Missing stream events documentation | Defined in § 6 | **Update required** |

### 9.3 API_CONTRACTS.md

| API_CONTRACTS.md (current) | This Document (canonical) | Status |
| --- | --- | --- |
| SSE event types in § 5.1 | Aligned with § 6.2 stream event types | OK |
| Event protocol in § 11.3 | Aligned with § 2 core event envelope | OK |
| Uses `agent.invocation` (correct) | Matches § 6.2 | OK |

### 9.4 Migration Checklist

- [ ] PROTOCOL.md: Add `signal` event class, reference EVENT_MODEL.md § 2 for schema
- [ ] PROTOCOL.md: Remove inline event schema, replace with reference
- [ ] DATA_MODEL.md: Replace "category" with "class" in event documentation
- [ ] DATA_MODEL.md: Add `source` field documentation
- [ ] DATA_MODEL.md: Add stream_events table documentation
- [ ] DATA_MODEL.md: Reference EVENT_MODEL.md for event specifications

---

## 10. Cross-References

| Topic | Document |
| --- | --- |
| Phase transition triggers | `docs/RUN_STATE_MACHINE.md` § 5.7 |
| Event storage schema | `docs/DATA_MODEL_AUTHORITY.md` |
| SSE endpoint specification | `docs/API_CONTRACTS.md` § 5 |
| Error events and handling | `docs/ERROR_HANDLING.md` |
| Webhook receiver | `docs/API_CONTRACTS.md` § 10 |
| Event ordering invariants | `docs/PROTOCOL.md` § Protocol Invariants |

---

## Appendix A: Codex Adversarial Review Resolutions

10 findings from Codex adversarial review comparing spec against codebase:

| # | Severity | Finding | Resolution |
| --- | --- | --- | --- |
| 1 | BLOCKING | Decision authority violated — code emits `decision` class from worker and operator, not just orchestrator. `createEvent` only enforces `phase.transitioned` special case. | **Implementation gap.** Spec defines the target authorization model. A type→(class,source) policy map should be added to `createEvent`. Until then, the spec serves as the enforcement target. |
| 2 | HIGH | Per-run ordering overstated — code allows caller-supplied sequence, no out-of-order buffering. | **Implementation gap.** Spec defines ideal behavior. Sequence allocation should move to `runs.next_sequence` in a single transaction. Buffering claim downgraded to "SHOULD buffer" (not "MUST"). |
| 3 | HIGH | SSE replay race — connection subscribed before replay, so live events can arrive before replay frames. | **Implementation gap.** Two-phase flow (snapshot→replay→stream) is the target. Added note to § 6.5. |
| 4 | HIGH | `persistAndPublish` can publish when DB insert fails, producing id-less live events. | **Implementation gap.** Persistence should be required before publish. Fallback: emit `refresh_required`. |
| 5 | MEDIUM | Core→stream mapping doesn't match actual producers — `gate.passed`/`gate.failed` not produced; `agent.invocation` uses `pending`/`running` statuses. | Updated § 6.3 mapping to note that gate sub-events and agent status vocabulary may differ from code. Spec is forward-looking. |
| 6 | MEDIUM | SSE frame format differs — spec says `id+event+data`, code sends `id+data` only. | Spec describes target format. Current code is acceptable for v1. |
| 7 | MEDIUM | Replay age check implemented differently than documented SQL. | Implementation detail — spec SQL is illustrative, not literal. |
| 8 | MEDIUM | Canonical envelope includes `txn_id`/`github_write_id` but `CreateEventInput` doesn't populate them. | **Implementation gap.** Fields exist in schema but aren't wired. Spec is forward-looking. |
| 9 | MEDIUM | Database doesn't enforce event type/source/kind enums via CHECK constraints. | **Implementation gap.** CHECK constraints should be added in a future migration. |
| 10 | SUGGESTION | Legacy V1 `StreamEvent` type still in code, not documented. | Acknowledged. V1 compat mode should have deprecation timeline. Not blocking for spec. |
