# Idempotency Key Reconciliation

> **Status:** Normative. This defines the canonical idempotency key algorithms, collision guarantees, storage requirements, deduplication windows, and per-operation idempotency requirements for Conductor.

## 1. Idempotency Architecture

Conductor enforces idempotency at **six independent layers**, each with its own key format and deduplication mechanism:

```
┌─────────────────────────────────────────────────────┐
│  Webhook Delivery                                     │  Layer 1: GitHub delivery_id
├─────────────────────────────────────────────────────┤
│  Event Persistence                                    │  Layer 2: Per-event-type idempotency_key
├─────────────────────────────────────────────────────┤
│  GitHub Write Outbox                                  │  Layer 3: Composite or custom idempotency_key
├─────────────────────────────────────────────────────┤
│  Mirror Rate Limiter                                  │  Layer 4: Deferred event coalescing
├─────────────────────────────────────────────────────┤
│  Job Queue (BullMQ)                                   │  Layer 5: Caller-provided jobId
├─────────────────────────────────────────────────────┤
│  Run Lineage                                          │  Layer 6: Active run enforcement
└─────────────────────────────────────────────────────┘
```

**Design principle:** Database-layer deduplication (Layers 1–4) is permanent via UNIQUE constraints. BullMQ deduplication (Layer 5) persists only while the job record exists — jobs are auto-removed by `removeOnComplete`/`removeOnFail` count-based retention. Status lifecycle rules are application-level conventions (no DB CHECK constraints enforce allowed transitions).

---

## 2. Webhook Deduplication (Layer 1)

**Source:** `packages/shared/src/webhooks/index.ts`

### 2.1 Key Format

```
delivery_id   (from X-GitHub-Delivery header)
```

GitHub assigns a unique `delivery_id` to each webhook delivery. On retry, GitHub resends the same `delivery_id`. This is an **external GitHub guarantee**, not enforced by Conductor code.

### 2.2 Storage

| Parameter | Value |
|-----------|-------|
| Table | `webhook_deliveries` |
| Column | `delivery_id TEXT PRIMARY KEY` |
| Dedup method | `INSERT OR IGNORE` on duplicate |
| Dedup window | Permanent (no TTL) |

### 2.3 Status Lifecycle

```
received → processing → processed   (success)
received → ignored                   (ping events, unsupported action)
received → failed                    (signature validation failure, enqueue failure — set in receiver)
```

> **Note:** `failed` is set in the webhook receiver (`packages/web/src/app/api/webhooks/github/route.ts`) for invalid signatures or enqueue failures. Worker processing paths set `processed` or `ignored`, not `failed`.

### 2.4 Duplicate Detection Flow

```
Webhook arrives with X-GitHub-Delivery header
  → persistWebhookDelivery(delivery_id, ...)
    → INSERT OR IGNORE INTO webhook_deliveries
    → If inserted: isNew = true  → process normally
    → If ignored:  isNew = false → log "Duplicate webhook delivery", skip
```

### 2.5 Payload Integrity

A payload hash is computed via `computePayloadHash(rawBody)` and stored in `webhook_deliveries.payload_hash` as a hex hash value. The hash scheme (`sha256:cjson:v1`) is tracked separately in the redact module but is not stored per-delivery in the `webhook_deliveries` table. The `delivery_id` — not the hash — is the authoritative dedup key.

---

## 3. Event Deduplication (Layer 2)

**Source:** `packages/shared/src/events/index.ts`

### 3.1 Key Formats

Events use per-event-type key patterns:

**Webhook-sourced events (class: `fact`):**

| Event Type | Key Pattern |
|-----------|-------------|
| Issue events | `${deliveryId}:issue:${action}` |
| Comment events | `${deliveryId}:comment:${commentId}` |
| Pull request events | `${deliveryId}:pr:${action}` |
| Review events | `${deliveryId}:review:${reviewId}` |

**Orchestrator-emitted events (class: `decision`):**

| Event Type | Key Pattern |
|-----------|-------------|
| Phase transitions | `phase:${runId}:${sequence}` |
| Gate decisions | `gate:${runId}:${gateId}:${Date.now()}` |

### 3.2 Storage

| Parameter | Value |
|-----------|-------|
| Table | `events` |
| Column | `idempotency_key TEXT NOT NULL UNIQUE` |
| Index | Implicit from UNIQUE constraint |
| Dedup window | Permanent |

### 3.3 Event Classes

| Class | Source | Mutation Authority |
|-------|--------|-------------------|
| `fact` | Webhooks | None — informational only |
| `decision` | Orchestrator | Can mutate run state |
| `signal` | Agents/system | None — informational only |

### 3.4 Sequence Assignment

Orchestrator-emitted events use monotonic per-run sequences:

- Sequences are computed via `SELECT MAX(sequence) + 1` within the events table
- Monotonic per run: 1, 2, 3...
- UNIQUE constraint: `(run_id, sequence)`

> **Caveat:** The current implementation uses `MAX(sequence)+1` without an explicit lock or compare-and-set. For single-worker deployments (v0.1), this is safe. Multi-worker setups would need atomic sequence allocation.

### 3.5 Event Ordering

Events are stored with sequence numbers and can be listed in sequence order. A `processed_at` column marks when each event was handled. The events module provides listing by sequence and processed-at marking, but no automated gap-detection or hold-until-prior-sequence processor exists — ordering is ensured by the single-worker execution model.

### 3.6 Causation Tracking

Decision events can optionally include `causation_id` (FK to the triggering fact event). This field is optional in `createEvent()` input and is not uniformly populated by all orchestrator paths. When present, it enables replay and audit trail reconstruction.

---

## 4. GitHub Write Deduplication (Layer 3)

**Source:** `packages/shared/src/outbox/index.ts`

### 4.1 Default Key Format

```
${runId}:${kind}:${targetNodeId}:${payloadHash}
```

**Components:**

| Component | Source | Purpose |
|-----------|--------|---------|
| `runId` | Run identifier | Isolates writes per run |
| `kind` | Write type (see § 4.2) | Differentiates operation types |
| `targetNodeId` | Stable target identifier — GitHub GraphQL node ID or commit SHA (for check runs) | Survives repo renames |
| `payloadHash` | SHA-256 of redacted canonical JSON | Content-based dedup |

> **Custom override:** `enqueueWrite()` and `enqueueWriteAsync()` accept a caller-supplied `idempotencyKey` parameter. When provided, it replaces the default composite key. The mirroring system uses custom keys via this mechanism.

### 4.2 Write Kinds

**Source:** `packages/shared/src/types/index.ts`

| Kind | Description |
|------|-------------|
| `comment` | Issue/PR comment |
| `pull_request` | Pull request creation/update |
| `check_run` | Check run (target is commit SHA) |
| `branch` | Branch creation/deletion |
| `label` | Label application |
| `review` | PR review submission |
| `project_field_update` | Project field mutation |

### 4.3 Write Lifecycle

```
queued → processing → completed   (success, GitHub returns ID)
queued → processing → failed      (definitive error: 4xx, validation)
queued → cancelled                 (run cancelled before processing)
```

> **Note:** PROTOCOL.md describes an `ambiguous` status for network errors after request submission, with marker-scan recovery. This machinery is **not yet implemented** in the outbox code. Currently, ambiguous failures fall through to the retry/failed path.

### 4.4 Duplicate Detection

When `enqueueWrite()` or `enqueueWriteAsync()` is called:

1. Compute or accept `idempotencyKey`
2. `SELECT` existing write by `idempotencyKey`
3. If found: return existing `github_write_id` without creating new record
4. If not found: `INSERT` new record with status `queued`, enqueue processing job

> **Race condition note:** The current implementation uses SELECT-then-INSERT without an explicit transaction wrapper. For single-worker deployments, this is safe. Multi-worker setups should use INSERT-OR-IGNORE/upsert to prevent races.

### 4.5 Retry Configuration

GitHub write jobs retry up to 5 times with exponential backoff (base 2,000ms) via the `github_writes` BullMQ queue.

---

## 5. Mirror Deferred Event Deduplication (Layer 4)

**Source:** `packages/shared/src/mirroring/rate-limiter.ts`

### 5.1 Key Format

```
${runId}:mirror:${eventType}:${sequence}
```

**Examples:**

| Event | Idempotency Suffix |
|-------|--------------------|
| Phase transition at sequence 42 | `runId:mirror:phase:42` |
| Plan artifact version 3 | `runId:mirror:plan:3` |
| Approval decision | `runId:mirror:approval:operatorActionId` |
| Failure at sequence 42 | `runId:mirror:failure:42` |

### 5.2 Storage

| Parameter | Value |
|-----------|-------|
| Table | `mirror_deferred_events` |
| Columns | `idempotency_suffix TEXT NOT NULL UNIQUE`, `summary TEXT NOT NULL DEFAULT ''` (migration 015) |
| Dedup window | Rate-limit window (30 seconds), then flushed |

### 5.3 Deferred Event Flow

```
Event triggers mirror comment
  → Check: last comment for this run < 30s ago?
    → No  → Enqueue write immediately (passes idempotencySuffix to outbox)
    → Yes → Defer event to mirror_deferred_events table
              → UNIQUE constraint prevents duplicate deferral
              → On next allowed post: coalesce all deferred events
              → Use current event's idempotencySuffix for coalesced write
              → Delete deferred events only after write confirmed (result.isNew)
```

### 5.4 Stale Event Flush

Events deferred longer than 60 seconds (default parameter to `flushStaleDeferredEvents()`) are flushed. The stale query uses `datetime('now', '-' || ? || ' seconds')` comparison against the `created_at` column.

---

## 6. Job Queue Deduplication (Layer 5)

**Source:** `packages/shared/src/queue/index.ts`

### 6.1 Job ID Patterns

Job IDs are caller-provided. Patterns vary by call site:

| Queue | Call Site | Pattern | Stable? |
|-------|----------|---------|---------|
| `runs` | Start run | `run:start:${runId}` | Yes |
| `runs` | Cancel | `run-cancel-${runId}` | Yes (idempotent cancel) |
| `runs` | Retry | `run-retry-${runId}-${Date.now()}` | No (allows multiple retries) |
| `runs` | PR retry | `run-pr-retry-...` | No |
| `runs` | Restart | `run-restart-...` | No |
| `agents` | Worker enqueue | `agent-${runId}-${agent}-${action}-${Date.now()}` | No (timestamp-scoped) |
| `agents` | Implementer | `agent-...-seq${sequence}` | Semi-stable (sequence-scoped) |
| `github_writes` | Outbox | `${githubWriteId}` (raw ID) | Yes |
| `cleanup` | Worker | `cleanup:${type}:${targetId}` | Yes |
| `webhooks` | Receiver | `${deliveryId}` | Yes (matches webhook dedup) |

**Idempotency implications:** Only stable-ID jobs provide true dedup. Timestamp-scoped IDs intentionally allow duplicate enqueuing (e.g., a new retry creates a new job).

### 6.2 Dedup Mechanism

BullMQ enforces `jobId` uniqueness per queue via Redis keys. If a job with the same ID already exists, the add call returns the existing job (BullMQ library behavior — not verified by Conductor test suite).

**Retention:** Jobs are auto-removed by count-based retention:

| Queue | `removeOnComplete` | `removeOnFail` | Retry Config |
|-------|--------------------|----------------|-------------|
| `webhooks` | 1,000 | 5,000 | 3 attempts, exponential 1,000ms |
| `runs` | 100 | 1,000 | 1 attempt |
| `agents` | 100 | 1,000 | 1 attempt |
| `github_writes` | 1,000 | 5,000 | 5 attempts, exponential 2,000ms |
| `cleanup` | 100 | 100 | 3 attempts, fixed 60,000ms |

### 6.3 Stale Episode Guards

Run and agent jobs include epoch/phase guards to prevent stale retries:

| Field | Purpose |
|-------|---------|
| `fromPhase` | Expected current phase; worker skips if run has moved beyond |
| `fromSequence` | Expected event sequence; detects stale episodes |
| `workflowEpoch` | Monotonic counter; incremented on workflow mutations (edit/rewind), not normal phase transitions; worker rejects mismatched epochs |

---

## 7. Run Lineage Deduplication (Layer 6)

**Source:** `packages/shared/src/runs/index.ts`

### 7.1 Identity Model

| Field | Format | Purpose |
|-------|--------|---------|
| `run_id` | `run_${base36Timestamp}${random}` | Unique per run (primary key) |
| `run_number` | Sequential integer (1, 2, 3...) | Attempt count |
| `parent_run_id` | FK to previous run | Retry lineage |
| `supersedes_run_id` | FK to replaced run | "Start fresh" lineage |

### 7.2 Active Run Enforcement

| Parameter | Value |
|-----------|-------|
| Enforcement | `tasks.active_run_id` column |
| Constraint | Single active run per task |
| Set by | Run-creation workflows (callers of `createRun()`, not `createRun()` itself) |
| Cleared on | Terminal phase (`completed`, `cancelled`) |

> **Implementation note:** The start-actions path uses a guarded compare-and-set (`UPDATE ... WHERE active_run_id IS NULL`). However, the API run-creation path uses a read-check then unconditional set, which has a theoretical race window. For single-worker v0.1 this is safe; multi-worker deployments should unify on the guarded path.

---

## 8. Collision Analysis

### 8.1 Collision Risk Assessment

| Layer | Key Space | Risk | Notes |
|-------|-----------|------|-------|
| Webhook | GitHub `delivery_id` | Negligible | External GitHub guarantee (assumed unique) |
| Events | Per-event-type composite | Negligible | Unique delivery IDs + monotonic sequences |
| GitHub Writes | 4-component composite with SHA-256 | Negligible | All 4 components must collide simultaneously |
| Deferred Mirror | Run-scoped with event type + sequence | Negligible | Sequence is monotonic per run |
| BullMQ Jobs | Caller-provided composite strings | Varies | Stable IDs provide dedup; timestamped IDs intentionally allow duplicates |
| Run Lineage | `run_${base36}${random}` | Negligible | Not UUID — collision probability depends on random component entropy |

### 8.2 Risk Matrix

| Scenario | Risk | Mitigation |
|----------|------|-----------|
| Duplicate webhook delivery (GitHub retry) | Negligible | `delivery_id` PRIMARY KEY + INSERT OR IGNORE |
| GitHub write race (concurrent workers) | Low (v0.1: None) | `idempotency_key` UNIQUE; SELECT-then-INSERT safe for single worker |
| Event out-of-order arrival | Low (v0.1: None) | Sequence ordering + single-worker execution model |
| Repo rename/transfer | None | Uses `github_node_id` (immutable), not `github_full_name` |
| Mirror comment coalesce timing | Low | Rate limiter checks `MAX(created_at)` on all non-cancelled writes |
| Stale job retry (run moved on) | None | `fromPhase`, `fromSequence`, `workflowEpoch` guards |
| SHA-256 payload hash collision | Negligible (2⁻²⁵⁶) | All 4 key components must also match |

---

## 9. Per-Operation Idempotency Requirements

### 9.1 Operations That MUST Be Idempotent

| Operation | Idempotency Mechanism | What Happens on Duplicate |
|-----------|----------------------|--------------------------|
| Webhook processing | `delivery_id` PRIMARY KEY | Duplicate silently skipped |
| Event persistence | `idempotency_key` UNIQUE | Duplicate silently skipped |
| GitHub write creation | `idempotency_key` UNIQUE | Returns existing write ID |
| Run cancel request | Stable job ID `run-cancel-${runId}` | Duplicate cancel is no-op |
| Run start | Stable job ID `run:start:${runId}` | Duplicate start is no-op |

### 9.2 Operations That Are NOT Idempotent

| Operation | Why Not | Safety Mechanism |
|-----------|---------|-----------------|
| Run creation | Each run is a new attempt | `active_run_id` prevents concurrent runs per task (guarded path) |
| Agent invocation | Each invocation is unique work | Generally non-deduped; most agent jobs use timestamp-scoped IDs. Select paths (e.g., implementer enqueue) use sequence-scoped IDs for semi-stable dedup. |
| Run retry | Each retry is intentional | Timestamp in job ID allows multiple retries |
| Phase transitions | Side effects (agent enqueue, cleanup) | Epoch guard rejects stale transitions |

---

## 10. Reconciliation: PROTOCOL.md vs INTEGRATION_MODEL.md

### 10.1 Differences Found

| Aspect | PROTOCOL.md | INTEGRATION_MODEL.md | Actual Code (Authoritative) |
|--------|-------------|---------------------|---------------------------|
| GitHub write key | `sha256(kind + ":" + target_node_id + ":" + payload_hash)` | `sha256(run_id + target_node_id + write_kind + logical_key)` | String concat: `${runId}:${kind}:${targetNodeId}:${payloadHash}` (or custom override) |
| Event key (issue) | Generic idempotency_key | `{event_type}:{delivery_id}` | `${deliveryId}:issue:${action}` |
| Event key (comment) | Generic idempotency_key | Not specified | `${deliveryId}:comment:${commentId}` |
| Event key (PR) | Generic idempotency_key | Not specified | `${deliveryId}:pr:${action}` |
| Event key (review) | Generic idempotency_key | Not specified | `${deliveryId}:review:${reviewId}` |
| Decision key (phase) | Not specified | Not specified | `phase:${runId}:${sequence}` |
| Decision key (gate) | Not specified | Not specified | `gate:${runId}:${gateId}:${Date.now()}` |
| Write status values | `queued → sent → failed → ambiguous` | Not specified | `queued → processing → completed / failed / cancelled` (no `ambiguous`) |
| Event source enum | Not specified | Uses `source: 'system'` | `EventSource` type has no `system` value |

### 10.2 Canonical Authority

**This document and the source code are authoritative.** Where PROTOCOL.md or INTEGRATION_MODEL.md conflict with the actual implementation, update those documents to match.

Key corrections needed:
1. PROTOCOL.md uses `sent` status — actual code uses `completed`
2. PROTOCOL.md hashes the key components — actual code concatenates them with `:` separators
3. PROTOCOL.md describes `ambiguous` status and marker-scan recovery — not yet implemented
4. INTEGRATION_MODEL.md uses `logical_key` terminology — actual code uses `payloadHash`
5. INTEGRATION_MODEL.md references `source: 'system'` — no `system` value in `EventSource` enum
6. Both documents should reference this spec for canonical key formats

---

## 11. Cross-References

| Topic | Document |
|-------|----------|
| GitHub write outbox processing | `docs/PROTOCOL.md` § GitHub Writes |
| Event model and processing | `docs/EVENT_MODEL.md` |
| Integration patterns | `docs/INTEGRATION_MODEL.md` § Inbound Events |
| Rate limiting and deferral | `docs/RATE_LIMITING.md` § 2 |
| Database schema definitions | `docs/DATA_MODEL_AUTHORITY.md` |
| Error handling and retry policies | `docs/ERROR_HANDLING.md` |

---

## Appendix A: Codex Adversarial Review Resolution

**Review date:** 2026-02-20
**Reviewer:** Codex (read-only sandbox)
**Findings:** 32 total — 23 BLOCKING, 3 HIGH, 6 MEDIUM

| # | Severity | Section | Finding | Resolution |
|---|----------|---------|---------|------------|
| 1 | BLOCKING | §1 Design principle | BullMQ dedup is not permanent | Corrected: DB-layer permanent, BullMQ persists while job record exists |
| 2 | HIGH | §2.1 Key format | GitHub `delivery_id` uniqueness is external | Added "external GitHub guarantee" qualifier |
| 3 | BLOCKING | §2.3 Status lifecycle | `failed` set in receiver, not worker processing | Corrected lifecycle and added note about where `failed` is set |
| 4 | BLOCKING | §2.5 Payload hash | Hash is hex value, scheme is separate metadata | Corrected to describe hex hash; scheme not stored per-delivery |
| 5 | BLOCKING | §3.1 Key formats | Webhook event keys are per-event-type specific | Replaced generic pattern with per-event-type table |
| 6 | BLOCKING | §3.1 Decision keys | Gate decisions use `gate:` prefix, not `phase:` | Added `gate:${runId}:${gateId}:${Date.now()}` pattern |
| 7 | BLOCKING | §3.4 Sequence assignment | Uses `SELECT MAX+1`, not `SELECT FOR UPDATE` | Corrected and added single-worker caveat |
| 8 | BLOCKING | §3.5 Out-of-order handling | No gap-detection processor exists | Rewrote to describe actual behavior: sequence listing + processed_at marking |
| 9 | BLOCKING | §3.6 Causation tracking | `causation_id` is optional, not universal | Changed to "optionally include" with note about inconsistent population |
| 10 | BLOCKING | §4.1 Write kinds | `pr` should be `pull_request`; missing `review`, `project_field_update` | Updated to actual enum values from types/index.ts |
| 11 | BLOCKING | §4.1 targetNodeId | Check runs use commit SHA, not node ID | Changed to "stable target identifier (node ID or commit SHA)" |
| 12 | BLOCKING | §4.1 Key format | Callers can supply custom idempotencyKey | Added custom override note |
| 13 | BLOCKING | §4.3 Write lifecycle | No `ambiguous` status; has `cancelled` | Replaced with actual statuses; noted PROTOCOL.md ambiguous as unimplemented |
| 14 | BLOCKING | §4.4 Duplicate detection | SELECT-then-INSERT, not INSERT-on-conflict | Corrected algorithm and added race condition note |
| 15 | BLOCKING | §4.5 Ambiguous recovery | Marker scan not implemented | Removed section; noted as unimplemented in §4.3 |
| 16 | BLOCKING | §5.4 Stale flush | Datetime comparison format concern | Documented actual query mechanism |
| 17 | BLOCKING | §6.1 Job ID patterns | Patterns differ from documented | Replaced with actual per-call-site patterns with stability column |
| 18 | HIGH | §6.2 Dedup mechanism | BullMQ duplicate-add is library behavior | Added "BullMQ library behavior" qualifier |
| 19 | BLOCKING | §6.3 workflowEpoch | Incremented on edit/rewind, not phase transitions | Corrected description |
| 20 | BLOCKING | §7.1 Run ID format | Not UUID; uses `run_${base36}${random}` | Corrected format |
| 21 | BLOCKING | §7.2 active_run_id | Set by callers, not `createRun()` | Corrected to "set by run-creation workflows" |
| 22 | BLOCKING | §7.2 Enforcement | Guarded path not universal | Added implementation note about race in API path |
| 23 | HIGH | §8.1 Collision probability | "None" claims are theoretical | Changed to "Negligible" with assumption notes |
| 24 | BLOCKING | §8.1 Run lineage | Not UUID v4 | Corrected probability description |
| 25 | BLOCKING | §8.3 Risk matrix | No DB transaction wrapper | Corrected to "SELECT-then-INSERT safe for single worker" |
| 26 | BLOCKING | §8.3 Event ordering | No gap detection implementation | Changed to "sequence ordering + single-worker model" |
| 27 | BLOCKING | §9.2 Agent invocation | Most agent jobs use timestamp IDs | Corrected to describe actual dedup behavior per path |
| 28 | BLOCKING | §10.1 Event keys | Generic patterns didn't match per-event actuals | Replaced with per-event-type actual patterns |
| 29 | BLOCKING | §10.1 Write statuses | No `ambiguous`; has `cancelled` | Corrected to actual statuses |
| 30 | MEDIUM | §2.3/§4.3 Status lifecycle | No DB CHECK constraints on status | Added note about application-level convention |
| 31 | MEDIUM | §5.2 Storage | Missing `summary` column | Added `summary TEXT NOT NULL DEFAULT ''` from migration 015 |
| 32 | MEDIUM | §10.1 Reconciliation | EventSource has no `system` value | Added to reconciliation table |
