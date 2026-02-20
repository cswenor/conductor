# Error Handling Matrix

> **Status:** Normative. This is the canonical reference for error classification, retry policies, escalation rules, and crash recovery across all Conductor layers.

## 1. Error Taxonomy

Every error in Conductor is classified into one of five classes. The class determines the handling strategy.

```typescript
type ErrorClass =
  | 'transient'    // Temporary failure; retry is likely to succeed
  | 'agent'        // AI agent failure (timeout, budget, context overflow)
  | 'gate'         // Automated check failure (tests, lint, security)
  | 'system'       // Infrastructure failure (DB, Redis, filesystem)
  | 'policy';      // Business rule violation (unauthorized, invalid transition)
```

### 1.1 Error Class Definitions

| Class | Retryable? | Examples | Default Action |
| --- | --- | --- | --- |
| `transient` | Yes (auto) | Rate limit, network timeout, temporary GitHub 5xx | Exponential backoff retry |
| `agent` | Conditional | Agent timeout, token budget exceeded, context length overflow | Depends on subtype (see § 1.2) |
| `gate` | Yes (with fix) | Test failure, lint error, security vulnerability found | Return to `executing` for fix attempt |
| `system` | No (manual) | Database corruption, Redis down, disk full | Mark run `failed`, alert operator |
| `policy` | No | Unauthorized transition, WIP limit exceeded, max retries exhausted | Reject with error code, no state change |

### 1.2 Agent Error Subtypes

```typescript
// From packages/shared/src/agents/provider.ts
class AgentError extends Error { code: string }
class AgentAuthError extends AgentError { }           // Provider auth failed
class AgentRateLimitError extends AgentError {         // Provider rate limit
  retryAfterMs?: number
}
class AgentContextLengthError extends AgentError { }   // Context window exceeded
class AgentBudgetExceededError extends AgentError {    // Token budget exhausted
  estimatedTokens: number; tokenBudget: number
}
class AgentTimeoutError extends AgentError {           // Agent execution timeout
  timeoutMs: number; agent: string; action: string
}
class AgentCancelledError extends AgentError {         // Operator cancelled mid-execution
  runId: string
}
```

| Agent Error | Retryable? | Action |
| --- | --- | --- |
| `AgentRateLimitError` | Yes (auto) | Exponential backoff with server hint (§ 2.1) |
| `AgentContextLengthError` | Yes (with truncation) | Truncate context, retry once |
| `AgentTimeoutError` | No | Mark run `failed` (reason: `agent_timeout`) |
| `AgentAuthError` | No | Mark run `failed` (reason: `auth_error`). Operator must fix credentials. |
| `AgentBudgetExceededError` | No | Mark run `failed` (reason: `budget_exceeded`) |
| `AgentCancelledError` | No | No action (run already transitioning to `cancelled`) |

---

## 2. Retry Policies

### 2.1 Rate Limit Retry (Transient)

Used for AI provider rate limits and GitHub API rate limits.

| Parameter | Value | Configurable? |
| --- | --- | --- |
| Max retries | 5 | Yes (`CONDUCTOR_RATE_LIMIT_MAX_RETRIES`) |
| Base delay | 30 seconds | No |
| Max delay | 600 seconds (10 min) | No |
| Backoff formula | `min(server_hint OR base * 2^attempt, max_delay)` | — |
| Jitter | ±10% random | No |
| On exhaustion | Mark run `failed` (reason: `rate_limit_exhausted`) | — |

**Server hint:** If the rate limit response includes `Retry-After` or `retryAfterMs`, use that value instead of the calculated backoff (but still cap at max delay).

### 2.2 Gate Retry (Check Failures)

Used when automated checks (tests, lint, security scan) fail.

| Parameter | Value | Configurable? |
| --- | --- | --- |
| Max attempts | 3 | Yes (`project_settings.max_check_attempts`) |
| Counter | `runs.check_fix_attempts` | — |
| On retry | Transition T8: `checking` → `executing` | — |
| On exhaustion | Transition T9: `checking` → `failed` | — |
| Reset | Counter resets on manual retry from `failed` | — |

**Flow:** Check fails → increment `check_fix_attempts` → if under limit, return to `executing` for AI to fix → re-enter `checking` → repeat until pass or limit.

### 2.3 Review Round Retry

Used when code review requests changes.

| Parameter | Value | Configurable? |
| --- | --- | --- |
| Max rounds | 5 | Yes (`project_settings.max_review_rounds`) |
| Counter | `runs.review_rounds` | — |
| On retry | Transition T11: `awaiting_review` → `executing` | — |
| On exhaustion | Transition T17: → `failed` (reason: `max_review_rounds`) | — |
| Reset | Counter resets on manual retry from `failed` | — |

### 2.4 Failed Run Retry

Used when operator manually retries a failed run.

| Parameter | Value | Configurable? |
| --- | --- | --- |
| Max retries | 3 | Yes (`project_settings.max_failed_retries`) |
| Counter | `runs.failed_retries` | — |
| Targets | T14: → `planning`, T15: → `executing` | — |
| On exhaustion | T16 forced: → `cancelled` (reason: `max_retries_exhausted`) | — |
| Counter reset | Plan revision and review round counters reset on retry | — |

### 2.5 Webhook Processing Retry

Used for GitHub webhook processing failures.

| Parameter | Value |
| --- | --- |
| Max retries | 3 (BullMQ default) |
| Backoff | Exponential (BullMQ built-in) |
| On exhaustion | Job moves to DLQ (§ 3) |
| Idempotency | Delivery ID deduplication prevents re-processing |

---

## 3. Dead Letter Queue (DLQ)

### 3.1 When Events Go to DLQ

| Queue | DLQ Trigger | Max Retries |
| --- | --- | --- |
| `webhooks` | Processing fails after max retries | 3 |
| `runs` | Job fails after max retries | 3 |
| `agents` | Agent fails with non-retryable error | 1 (no retry for agent errors) |
| `cleanup` | Cleanup fails after max retries | 5 |

### 3.2 DLQ Storage

Dead-lettered jobs are stored in Redis under the BullMQ `failed` set for each queue:

```
bull:webhooks:failed
bull:runs:failed
bull:agents:failed
bull:cleanup:failed
```

Each entry retains the original job data, error message, stack trace, and attempt count.

### 3.3 DLQ Replay Procedure

1. **Inspect:** `GET /api/admin/dlq?queue=webhooks` — list failed jobs with error details
2. **Diagnose:** Check error class. If transient (service was down), safe to replay. If policy, fix the root cause first.
3. **Replay:** `POST /api/admin/dlq/replay` with `{ queue, jobId }` — moves job back to active queue
4. **Purge:** `DELETE /api/admin/dlq` with `{ queue, olderThan }` — remove stale failed jobs

> **Note:** DLQ admin endpoints require `admin` role. See AUTH.md § 5.

### 3.4 DLQ Retention

- Failed jobs retained for 30 days
- Periodic cleanup removes jobs older than retention window
- No automatic replay — all DLQ replay is operator-initiated

---

## 4. Error Behavior Matrix

This table maps every error class × layer combination to its handling action.

### 4.1 Worker Layer

| Error Class | Agent Operation | Check Operation | GitHub Write | Action |
| --- | --- | --- | --- | --- |
| `transient` (rate limit) | Backoff retry (§ 2.1) | N/A | Backoff retry (§ 2.1) | Auto-retry with backoff |
| `transient` (network) | Retry once | Retry once | Retry once | Single retry, then escalate |
| `agent` (timeout) | Mark failed | N/A | N/A | `failed` (reason: `agent_timeout`) |
| `agent` (auth) | Mark failed | N/A | N/A | `failed` (reason: `auth_error`) |
| `agent` (budget) | Mark failed | N/A | N/A | `failed` (reason: `budget_exceeded`) |
| `agent` (context) | Truncate + retry once | N/A | N/A | One retry with truncation |
| `agent` (cancelled) | No-op | N/A | N/A | Already transitioning |
| `gate` (test fail) | N/A | Return to executing (§ 2.2) | N/A | Increment counter, retry |
| `gate` (lint fail) | N/A | Return to executing (§ 2.2) | N/A | Increment counter, retry |
| `gate` (security) | N/A | Return to executing (§ 2.2) | N/A | Increment counter, retry |
| `system` (DB) | Mark failed | Mark failed | Log + continue | `failed` (reason: `system_error`) |
| `system` (Redis) | Mark failed | Mark failed | Log + continue | `failed` (reason: `system_error`) |
| `policy` | Reject | Reject | Reject | Error response, no state change |

### 4.2 Orchestrator Layer

| Error Class | Transition | Event | Action |
| --- | --- | --- | --- |
| `transient` | Retry transition | Retry event creation | Auto-retry (max 3) |
| `system` (DB) | Rollback | Event lost | Alert operator, run may be inconsistent |
| `policy` (invalid transition) | Reject | Log `phase.transition_rejected` | 409 response |
| `policy` (unauthorized) | Reject | Log `phase.transition_denied` | 403 response |
| CAS conflict | Reject | No event | 409 with "state changed, please refresh" |

### 4.3 Control Plane (API) Layer

| Error Class | Status Code | Response Body | Action |
| --- | --- | --- | --- |
| `transient` | 503 | `{ error: { code: "SERVICE_UNAVAILABLE" } }` | Client should retry |
| `policy` (auth) | 401 | `{ error: { code: "UNAUTHORIZED" } }` | Redirect to login |
| `policy` (forbidden) | 403 | `{ error: { code: "FORBIDDEN" } }` | Show permission error |
| `policy` (not found) | 404 | `{ error: { code: "NOT_FOUND" } }` | Show not found page |
| `policy` (conflict) | 409 | `{ error: { code: "INVALID_TRANSITION" } }` | Refresh and retry |
| `policy` (validation) | 422 | `{ error: { code: "...", details: {...} } }` | Show validation errors |
| `policy` (rate limit) | 429 | `{ error: { code: "RATE_LIMITED", details: { retry_after } } }` | Wait and retry |
| `system` | 500 | `{ error: { code: "INTERNAL_ERROR" } }` | Show generic error, log details |

### 4.4 GitHub Integration Layer

| Error Class | GitHub Status | Action |
| --- | --- | --- |
| `transient` (rate limit) | 403 + `X-RateLimit-Remaining: 0` | Backoff retry (§ 2.1), respect `X-RateLimit-Reset` |
| `transient` (5xx) | 500/502/503 | Retry once after 5s |
| `transient` (network) | Connection refused | Retry once after 5s |
| `policy` (not found) | 404 | Log warning, mark GitHub write as `failed` |
| `policy` (forbidden) | 403 (no rate limit) | Mark write as `failed`, alert operator (permissions issue) |
| `system` (timeout) | Timeout | Retry once, then mark write as `failed` |

---

## 5. Circuit Breaker Configuration

Conductor uses implicit circuit breaker patterns rather than a formal circuit breaker library.

### 5.1 Rate Limit Circuit Breaker

When rate limit retries are exhausted (5 attempts), the run is marked `failed` with reason `rate_limit_exhausted`. This prevents infinite retry loops.

| Parameter | Value |
| --- | --- |
| Failure threshold | 5 consecutive rate limit errors |
| State after trip | Run `failed` |
| Reset | Operator manual retry |
| Half-open | N/A (no automatic probe) |

### 5.2 Revision Circuit Breaker

Plan revision loops are bounded:

| Parameter | Value |
| --- | --- |
| Max plan revisions | 3 (configurable) |
| State after trip | Run `failed` (reason: `max_plan_revisions`) |
| Reset | Operator manual retry (counter resets) |

### 5.3 Review Circuit Breaker

Review round loops are bounded:

| Parameter | Value |
| --- | --- |
| Max review rounds | 5 (configurable) |
| State after trip | Run `failed` (reason: `max_review_rounds`) |
| Reset | Operator manual retry (counter resets) |

### 5.4 GitHub Write Circuit Breaker

GitHub mirror writes use a rate limiter with deferred coalescing:

| Parameter | Value |
| --- | --- |
| Rate | 1 write / 30 seconds per run |
| Burst | 3 |
| Deferred event timeout | 60 seconds (stale cleanup) |
| On persistent failure | Mark write as `failed`, continue run |

---

## 6. Escalation Rules

### 6.1 What Surfaces to the Operator

| Event | Channel | Urgency |
| --- | --- | --- |
| Run enters `failed` | SSE event + UI "Needs Attention" panel | Immediate |
| Run stale (watchdog trigger) | Notification (email at 1d, 3d, 7d) | Progressive |
| Rate limit exhausted | SSE event + UI badge | Immediate |
| Auth error (credentials invalid) | SSE event + UI alert | Immediate |
| DLQ job count > 10 | Admin dashboard alert | Moderate |
| System error (DB/Redis) | Health endpoint degraded + log alert | Critical |
| Policy exception required | SSE event + UI "Needs Attention" panel | Immediate |

### 6.2 What Does NOT Surface

| Event | Reason |
| --- | --- |
| Transient retry (in progress) | Auto-handled, no operator action needed |
| Mirror write deferred | Normal rate limiting behavior |
| Agent message persistence failure | Non-critical, doesn't affect run |
| Tool event emission failure | Non-critical, logged only |
| SSE heartbeat miss | Client reconnects automatically |

---

## 7. Timeout Specifications

| Operation | Timeout | On Timeout |
| --- | --- | --- |
| **Worktree setup** (`pending`) | 10 minutes | → `failed` (reason: `setup_timeout`) |
| **AI planning** (`planning`) | 30 minutes | → `failed` (reason: `planning_timeout`) |
| **AI implementation** (`executing`) | 2 hours | → `failed` (reason: `execution_timeout`) |
| **Automated checks** (`checking`) | 15 minutes | → `failed` (reason: `check_timeout`) |
| **Single agent invocation** | 30 minutes (configurable) | `AgentTimeoutError` |
| **GitHub API call** | 30 seconds | Retry once, then fail |
| **Redis operation** | 5 seconds | Log error, degrade gracefully |
| **Database operation** | 10 seconds | Abort transaction, return error |
| **Webhook processing** | 60 seconds | BullMQ job timeout, retry |
| **SSE heartbeat** | 30 seconds | Client-side reconnect |
| **Human gate** (`awaiting_*`) | 7 days notification only | Notification only (never auto-fail) |

> **Note:** Human gate phases are never auto-failed by timeouts. See RUN_STATE_MACHINE.md § 5.6.

---

## 8. Crash Recovery

### 8.1 Mid-Worktree-Setup Crash

**Scenario:** Worker crashes during `pending` phase while creating git worktree.

**Detection:** Watchdog detects `pending` > 10 minutes.

**Recovery:**
1. Watchdog transitions run to `failed` (reason: `setup_timeout`)
2. Cleanup job enqueued to remove partial worktree
3. Operator retries → fresh worktree setup

**Data loss:** None (no work started yet).

### 8.2 Mid-Commit Crash

**Scenario:** Worker crashes during `executing` phase after creating commits but before pushing.

**Detection:** Watchdog detects `executing` > 2 hours, or worker heartbeat stops.

**Recovery:**
1. Watchdog transitions run to `failed` (reason: `execution_timeout`)
2. Worktree and branch preserved (not cleaned up on failure)
3. Operator retries → AI resumes from existing branch/commits
4. If worktree corrupted, operator can cancel and start fresh

**Data loss:** Possible loss of in-memory agent state. Committed changes preserved in git.

### 8.3 Mid-GitHub-Write Crash

**Scenario:** Worker crashes after creating event but before GitHub API call completes.

**Detection:** Outbox processor finds unprocessed GitHub writes.

**Recovery:**
1. Outbox processor retries the write (idempotent via GitHub API)
2. If write target changed (comment already exists), skip gracefully
3. After max retries, mark write as `failed` (non-blocking)

**Data loss:** None (event persisted, GitHub write is mirror-only).

### 8.4 Mid-Phase-Transition Crash

**Scenario:** Worker crashes between creating `phase.transitioned` event and updating `runs.phase`.

**Detection:** Event exists but run phase doesn't match.

**Recovery:**
1. Orchestrator uses transactional writes: event + state mutation in same SQL transaction
2. If crash happens mid-transaction: transaction rolls back, both event and state are consistent
3. If crash happens after commit: state is already updated

**Data loss:** None (atomic transaction guarantees).

### 8.5 Redis Down

**Scenario:** Redis becomes unavailable (queue manager and pub/sub affected).

**Detection:** Health endpoint (`GET /api/health/redis`) returns error.

**Recovery:**
1. Job queues: BullMQ jobs persist in Redis. On Redis recovery, jobs resume automatically.
2. SSE: Clients lose real-time updates. On reconnect with `Last-Event-ID`, missed events replayed from `stream_events` table (SQLite, not Redis).
3. Pub/sub: Stream events published after Redis recovery. Gap covered by SSE replay.

**Data loss:** No data loss (SQLite is primary store). Real-time updates delayed.

---

## 9. Non-Fatal Error Handling

Some errors are intentionally non-fatal — they don't block the run or require operator attention.

| Error | Layer | Behavior | Why Non-Fatal |
| --- | --- | --- | --- |
| Agent message persistence failure | Worker | Log warning, continue | Messages are debugging aid, not critical |
| Tool event emission failure | Worker | Log warning, continue | Events are audit trail, not state |
| Mirror operation failure | Worker | Log warning, continue | GitHub is mirror, not source of truth |
| SSE publish failure | Pub/Sub | Log warning, continue | Client reconnects automatically |
| Deferred event stale cleanup | Mirror | Log info, remove | Coalescing optimization |

**Rule:** Non-fatal errors MUST be logged at `warn` level minimum. Silent swallowing (`catch {}`) is prohibited.

---

## 10. Cross-References

| Topic | Document |
| --- | --- |
| Phase transitions and retry counters | `docs/RUN_STATE_MACHINE.md` § 5.4 |
| Stale run detection and timeouts | `docs/RUN_STATE_MACHINE.md` § 5.6 |
| API error response format | `docs/API_CONTRACTS.md` § 1.3 |
| Worker credentials and auth errors | `docs/WORKER_CREDENTIALS.md` |
| Rate limiting details | `docs/RATE_LIMITING.md` (see issue #169) |
| Event ordering and replay | `docs/EVENT_MODEL.md` § 5 |

---

## Appendix A: Codex Adversarial Review Resolutions

9 findings from Codex adversarial review comparing spec against codebase:

| # | Severity | Finding | Resolution |
| --- | --- | --- | --- |
| 1 | BLOCKING | Code uses `blocked` phase, not `failed`. `markRunFailed` transitions to `blocked`. | **Design-forward spec.** RUN_STATE_MACHINE.md renames `blocked` to `failed` as canonical. Code must be updated to match. |
| 2 | BLOCKING | Watchdog timeout behavior not implemented. Timeout transitions to `cancelled`, not `failed`. | **Implementation gap.** Watchdog scanning and reason-specific transitions are the target. |
| 3 | BLOCKING | DLQ admin endpoints don't exist. BullMQ prefix is `conductor:`, not `bull:`. | **Implementation gap.** DLQ admin endpoints are planned features. |
| 4 | HIGH | `AgentContextLengthError`/`AgentBudgetExceededError` fall through generic handler. `AgentUnsupportedProviderError` missing. | Added `AgentUnsupportedProviderError` to § 1.2. Other subtypes are implementation targets. |
| 5 | HIGH | Review rounds hardcoded to 3 (not 5). Counter names differ. No `failed_retries` counter. | Spec values are canonical targets per RUN_STATE_MACHINE.md § 5.4. |
| 6 | HIGH | Rate limit retry has no jitter. Exhaustion goes to `blocked` not `failed`. | Implementation targets. |
| 7 | HIGH | API errors use flat `{ error: "..." }` not structured envelope. | Centralized error middleware is an implementation target. |
| 8 | MEDIUM | Catch blocks swallow errors or return fake-success fallbacks. | Implementation bugs. § 9 rule prohibits this. |
| 9 | SUGGESTION | Missing `github_writes` queue in DLQ table. | Noted for implementation. |
