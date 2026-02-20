# Rate Limiting and AI Cost Protection

> **Status:** Normative. This defines the rate limiting strategy, AI token budgets, runaway prevention, cost attribution, and emergency controls for Conductor.

## 1. Rate Limiting Architecture

Conductor implements **three active rate limiting layers** with a fourth planned:

```
                    ┌─────────────────────────────────┐
                    │   GitHub Write Rate Limiting      │  Layer 1: Comment flood prevention
                    └──────────────┬──────────────────┘
                                   │
                    ┌──────────────▼──────────────────┐
                    │   AI Provider Rate Limiting       │  Layer 2: Provider 429/529 handling
                    └──────────────┬──────────────────┘
                                   │
                    ┌──────────────▼──────────────────┐
                    │   Token Budget Enforcement        │  Layer 3: Cost control
                    └─────────────────────────────────┘
```

> **Planned (v0.2+):** HTTP API request throttling middleware. Currently only a `tooManyRequests` response helper exists in `packages/web/src/lib/api-utils.ts` but no request-counting middleware is wired.

---

## 2. GitHub Write Rate Limiting

### 2.1 GitHub Mirror Rate Limiter

**Source:** `packages/shared/src/mirroring/rate-limiter.ts`

GitHub comments are rate-limited to prevent flooding issues/PRs:

| Parameter | Value | Configurable? |
|-----------|-------|---------------|
| Rate limit window | 30 seconds between comments per run | Code constant (`RATE_LIMIT_SECONDS = 30`) |
| Enforcement point | Before enqueueing GitHub write | — |
| Deferral storage | `mirror_deferred_events` table | — |
| Stale event flush | 60 seconds (default parameter) | Code parameter |

**Deferral and coalescing flow:**

```
Event triggers GitHub comment
  → Check: last comment for this run < 30s ago?
    → No  → Enqueue write immediately
    → Yes → Defer event to mirror_deferred_events table
              → On next allowed post, coalesce all deferred events
              → Post single combined comment
```

### 2.2 GitHub API Retry Handling

GitHub API errors are handled through two mechanisms:

1. **Outbox processor** (`packages/shared/src/outbox/processor.ts`): `isRetryableError()` classifies errors by message string matching:
   - Retryable: `rate limit`, `too many requests`, `500`, `502`, `503`, `network`, `timeout`, `econnreset`
   - Non-retryable: `404`, `403`, `401`

2. **BullMQ queue retry** (`packages/shared/src/queue/index.ts`): The `github_writes` queue retries up to 5 times with exponential backoff (base 2,000ms).

> **Note:** GitHub's per-installation rate limit is 5,000 requests/hour (external platform fact, not enforced by Conductor). The codebase exposes `getRateLimitStatus` as a passthrough in `packages/shared/src/github/index.ts` but does not currently parse `Retry-After` or track `X-RateLimit-Remaining` headers.

### 2.3 Database Schema

```sql
-- Migration 014: mirror_deferred_events
CREATE TABLE IF NOT EXISTS mirror_deferred_events (
  deferred_event_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(run_id),
  event_type TEXT NOT NULL,
  formatted_body TEXT NOT NULL,
  idempotency_suffix TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_mirror_deferred_run_time
  ON mirror_deferred_events(run_id, created_at ASC);

-- Migration 015: add summary column
ALTER TABLE mirror_deferred_events
  ADD COLUMN summary TEXT NOT NULL DEFAULT '';
```

---

## 3. AI Provider Rate Limiting

### 3.1 Rate Limit Retry Handler

**Source:** `packages/worker/src/rate-limit-retry.ts`

| Parameter | Value | Env Override |
|-----------|-------|-------------|
| Max retries | 5 | `CONDUCTOR_RATE_LIMIT_MAX_RETRIES` |
| Base delay | 30,000 ms (30s) | — |
| Max delay | 600,000 ms (10 min) | — |
| Backoff formula | `min(server_hint OR 30000 * 2^attempt, 600000)` | — |
| Jitter | None (deterministic delay) | — |
| Set to 0 | Disables retries entirely | — |

The handler returns `RateLimitRetryResult: { retried: boolean, delayMs?: number }`. When retrying, it enqueues the agent job with a delay via `enqueueAgent()`.

> **Note:** The executor's inner retry loop (`packages/shared/src/agent-runtime/executor.ts`) has a separate jitter mechanism: `RETRY_BASE_DELAY_MS = 1_000` with `RETRY_JITTER_MS = 500`. This applies to in-executor rate limit retries, not the worker-level handler.

### 3.2 Provider Support and Error Classification

**Source:** `packages/shared/src/agent-runtime/provider.ts`

Currently only **Anthropic** is fully supported. Other providers throw `AgentUnsupportedProviderError`:

| Provider | Status | Default Model | Timeout |
|----------|--------|---------------|---------|
| Anthropic | Supported | `claude-sonnet-4-20250514` | 300,000ms (5 min) |
| OpenAI | Throws `AgentUnsupportedProviderError` | — | — |
| Google | Throws `AgentUnsupportedProviderError` | — | — |
| Mistral | Throws `AgentUnsupportedProviderError` | — | — |

Per-agent timeouts: planner 300s, reviewer 180s, implementer 600s.

The Anthropic SDK wrapper maps HTTP errors generically (401/403 → auth error, 429 → rate limited, 400 → bad request). Provider-specific error codes (`rate_limit_error`, `overloaded_error`) are surfaced through the SDK's error objects.

### 3.3 Retry-After Header Extraction

**Source:** `packages/shared/src/agent-runtime/retry-after.ts`

- Parses `Retry-After` from both `Headers` API (`.get()` method) and plain `Record<string, unknown>` (case-insensitive key lookup)
- Validates: `0 < seconds < 3600`
- Converts to milliseconds via `Math.ceil(seconds * 1000)` (no minimum enforcement — sub-second values can produce <1000ms)
- Returns `undefined` if header is missing, non-numeric, or out of range
- **Fallback to exponential backoff happens in callers** (worker handler and executor), not in this module

### 3.4 Exhaustion Handling

When all retries are consumed:

1. Run transitions to `blocked` phase
2. `BlockedReasonCode` set to `rate_limit_exhausted`
3. Error logged via `markRunFailed()` with context: reason string and reason code
4. Operator can manually retry via UI after rate limit resets

---

## 4. Token Budget Enforcement

### 4.1 Budget Hierarchy

```
Agent Invocation Budget (per-call)  ← Currently implemented
└── Input Token Cap (per-request)

Run Budget (per-run)                ← Future
Project Budget (per-period)         ← Future
```

> **v0.1 scope:** Only per-invocation input token caps are implemented. Run-level and project-level budgets are planned but not yet present in the runtime.

### 4.2 Input Token Budget

**Source:** `packages/shared/src/agent-runtime/executor.ts`

The executor enforces a per-request input token cap:

| Parameter | Default | Env Override | Range |
|-----------|---------|-------------|-------|
| Context window | 200,000 | `CONDUCTOR_CONTEXT_WINDOW` | — |
| Budget fraction | 0.65 (65% of context) | — | — |
| Effective cap | 130,000 tokens | `CONDUCTOR_MAX_INPUT_TOKENS` | — |
| Safety factor | 1.15 (15% margin) | — | — |

**Precedence for max input tokens:**
1. Explicit `maxInputTokens` from caller
2. `CONDUCTOR_MAX_INPUT_TOKENS` env var
3. `CONDUCTOR_CONTEXT_WINDOW * 0.65`

### 4.3 Dynamic Budget Adjustment

The executor dynamically adjusts the token budget based on provider responses:

| Event | Action | Parameter | Default |
|-------|--------|-----------|---------|
| Rate limit hit | Reduce budget by factor | `CONDUCTOR_BUDGET_BACKOFF` | 0.8 (20% reduction) |
| Successful call | Increase budget by factor | `CONDUCTOR_BUDGET_RECOVERY` | 1.05 (5% increase) |
| Budget floor | Never drop below | `CONDUCTOR_BUDGET_FLOOR` | 10,000 tokens |

**Range validation:**
- Backoff: 0.1 – 0.99
- Recovery: 1.0 – 2.0

> **Note:** The floor is additionally clamped to the context cap: `min(rawFloor, contextCap)`. Recovery multiplies toward the context cap, not unbounded.

### 4.4 Pre-Request Budget Check

Before sending any AI API request:

```
estimated_input = tokenize(messages + tools + system_prompt) * ESTIMATION_SAFETY_FACTOR

if (estimated_input > effectiveBudget):
    → Attempt context compaction (trim older messages)
    → Re-estimate after compaction
    → If still over budget: raise AgentBudgetExceededError (non-retryable)
```

The check compares estimated input tokens against the effective budget. There is no cumulative `budget_used` tracking or output token estimation in the preflight check.

### 4.5 Context Section Budgets

**Source:** `packages/shared/src/agent-runtime/context.ts`

Individual sections of agent context have independent budgets:

| Section | Default | Env Override | Floor |
|---------|---------|-------------|-------|
| Issue body | 5,000 | `CONDUCTOR_CTX_BUDGET_ISSUE` | 500 |
| Plan | 10,000 | `CONDUCTOR_CTX_BUDGET_PLAN` | 1,000 |
| Review | 10,000 | `CONDUCTOR_CTX_BUDGET_REVIEW` | 1,000 |
| File tree | 10,000 | `CONDUCTOR_CTX_BUDGET_FILE_TREE` | 1,000 |
| File tree entries | 500 | `CONDUCTOR_CTX_BUDGET_FILE_TREE_ENTRIES` | 50 |

---

## 5. Runaway Detection and Prevention

### 5.1 Tool Iteration Limit

**Source:** `packages/shared/src/agent-runtime/executor.ts`

```typescript
export const MAX_TOOL_ITERATIONS = 50;  // Hard cap per agent invocation
```

If an agent runs 50 tool-loop iterations without completing, the invocation is terminated. A single iteration can include multiple tool calls (e.g., parallel tool use), so this caps iterations, not individual tool calls.

### 5.2 Wall-Clock Timeout

The executor supports a `totalTimeoutMs` parameter:
- Checked at iteration boundaries (between tool-loop iterations)
- Remaining time clamped onto per-call timeout
- A long in-flight provider call may slightly exceed this budget
- On timeout: `AgentTimeoutError` (non-retryable)

### 5.3 Phase-Based Cancellation

**Source:** `packages/shared/src/cancellation/index.ts`

**In-process cancellation:**
- `registerCancellable(runId)` — creates `AbortController` per run (with refCount)
- `signalCancellation(runId)` — calls `controller.abort()`
- `isCancelled(runId)` — checks `signal.aborted`
- `getAbortSignal(runId)` — executor passes signal to provider calls
- `unregisterCancellable(runId)` — decrements refCount

**Cross-process fallback:**
- Executor checks run phase in database at each iteration boundary
- If phase has changed to `cancelled` or `completed`, execution stops
- Abort signal is re-checked before each tool call
- Limitation: Single-shot agent calls only abort via local signal

### 5.4 Retry Escalation

| Limit Exceeded | Consequence | Recovery |
|---------------|-------------|----------|
| Tool iterations (50) | Agent invocation terminates | Operator retry |
| Rate limit retries (5) | Run → `blocked` (`rate_limit_exhausted`) | Operator retry after reset |
| Agent budget exceeded | Run → `blocked` (via `markRunFailed` with error message) | Increase budget, retry |
| Wall-clock timeout | Run → `blocked` | Operator retry |

> **Note:** `BlockedReasonCode` includes `max_plan_revisions`, `max_review_rounds`, and `rate_limit_exhausted`. Budget exhaustion is handled through `markRunFailed()` with an error message string rather than a dedicated reason code.

---

## 6. Cost Attribution

### 6.1 Token Usage Tracking

**Source:** `packages/shared/src/db/migrations/001_initial_schema.ts`

Every AI API call records token usage in the `agent_invocations` table:

| Column | Type | Description |
|--------|------|-------------|
| `tokens_input` | INTEGER (default 0) | Input tokens consumed |
| `tokens_output` | INTEGER (default 0) | Output tokens consumed |

Usage is tracked at the **per-invocation** level only. Run-level and project-level aggregation can be computed via SQL queries over `agent_invocations` joined through `runs`, but no dedicated aggregation service exists yet.

> **Future:** Extended tracking fields (cache tokens, thinking tokens) and a `ModelPricing` cost model are planned but not implemented. See Non-Goals § 10.

### 6.2 Cost Estimation (Future)

The following cost model is **planned but not yet implemented** in runtime code:

```typescript
// Planned interface — not yet in codebase
interface ModelPricing {
  provider_id: string;
  model_id: string;
  input_per_million: number;          // USD per 1M tokens
  output_per_million: number;         // USD per 1M tokens
  cache_read_per_million?: number;
  cache_write_per_million?: number;
  thinking_per_million?: number;
  batch_discount?: number;            // e.g., 0.5 = 50% off
}
```

### 6.3 Reference Pricing

For planning and estimation purposes, current AI provider pricing:

| Provider | Model | Input $/1M | Output $/1M |
|----------|-------|-----------|-----------|
| Anthropic | claude-opus-4-6 | $15.00 | $75.00 |
| Anthropic | claude-sonnet-4-6 | $3.00 | $15.00 |
| Anthropic | claude-haiku-4-5 | $0.80 | $4.00 |

> **Note:** Only Anthropic is supported in v0.1. These prices are reference values, not built-in constants. No runtime pricing table or cost computation exists yet.

---

## 7. Emergency Controls

### 7.1 Operator Cancel

**Source:** `packages/web/src/app/api/runs/[id]/actions/route.ts`

The operator can cancel any run via the UI or API:
- `POST /api/runs/:runId/actions` with `{ action: "cancel" }` — enqueues a `run-cancel` job (stable job ID `run-cancel-${runId}` for idempotency)
- In-process agent aborted via `AbortController`
- Cross-process agent stopped via phase check at next iteration boundary

### 7.2 Operator Pause

The operator can pause any run:
- `POST /api/runs/:runId/actions` with `{ action: "pause" }` — calls `pauseRunCommand()` (validates phase constraints: non-terminal, non-blocked phases only)
- Resume via `{ action: "resume" }` — enqueues `run-resume` job with `workflowEpoch` for stale job detection
- Pause prevents new work from being scheduled; **in-flight provider calls may continue until the next iteration boundary**

### 7.3 System-Level Kill (v0.1 Limitation)

v0.1 does not have a dedicated "kill all AI spending" button. The equivalent workflow:

1. **Cancel all active runs** — stops all AI invocations at next iteration boundary
2. **Stop worker process** — `docker compose stop worker` — halts all job processing
3. **Remove provider credentials** — delete or disable user API keys in the `user_api_keys` table (runtime credential resolution uses per-user keys, not a global env var)

**Future enhancement:** A single `/api/emergency-halt` endpoint that atomically cancels all active runs and pauses the worker.

### 7.4 Other Run Actions

The actions endpoint also supports:

| Action | Description |
|--------|-------------|
| `approve_plan` | Approve agent's plan, enqueue implementer |
| `revise_plan` | Request plan revision (can block after max revisions) |
| `reject_run` | Reject and cancel the run |
| `retry` | Retry a blocked run |
| `grant_policy_exception` | Grant an override for a policy violation |
| `deny_policy_exception` | Deny override, cancel the run |

---

## 8. Quota Error Contracts

### 8.1 Standard Error Response

API error responses use the following shape (from `packages/web/src/lib/api-utils.ts`):

```json
{
  "error": "Rate limit exceeded",
  "code": "RATE_LIMITED",
  "details": { "retry_after_ms": 30000 }
}
```

Helper functions: `errors.tooManyRequests()` (429), `errors.badRequest()` (400), `errors.unauthorized()` (401), `errors.forbidden()` (403), `errors.notFound()` (404), `errors.conflict()` (409), `errors.internal()` (500).

### 8.2 Error Codes

| Code | HTTP Status | Description |
|------|-------------|-------------|
| `RATE_LIMITED` | 429 | Rate limit exceeded (via `tooManyRequests` helper) |
| `BUDGET_EXCEEDED` | 402 | Token budget exhausted (planned, not standardized yet) |
| `PROVIDER_OVERLOADED` | 503 | AI provider temporarily unavailable (planned, not standardized yet) |

> **Note:** The `tooManyRequests` helper exists but quota-specific error codes (`BUDGET_EXCEEDED`, `PROVIDER_OVERLOADED`) are not yet standardized across all API routes.

---

## 9. Environment Variable Summary

| Variable | Default | Description |
|----------|---------|-------------|
| `CONDUCTOR_RATE_LIMIT_MAX_RETRIES` | 5 | Max AI provider rate limit retries (0 to disable) |
| `CONDUCTOR_MAX_INPUT_TOKENS` | (derived) | Hard cap on input tokens per request |
| `CONDUCTOR_CONTEXT_WINDOW` | 200,000 | Model context window size |
| `CONDUCTOR_BUDGET_BACKOFF` | 0.8 | Budget reduction factor on rate limit (0.1–0.99) |
| `CONDUCTOR_BUDGET_RECOVERY` | 1.05 | Budget recovery factor on success (1.0–2.0) |
| `CONDUCTOR_BUDGET_FLOOR` | 10,000 | Minimum token budget floor (clamped to context cap) |
| `CONDUCTOR_BUDGET_MAX_RETRIES` | 3 | Executor inner rate limit retries |
| `CONDUCTOR_CTX_BUDGET_ISSUE` | 5,000 | Issue body context budget |
| `CONDUCTOR_CTX_BUDGET_PLAN` | 10,000 | Plan context budget |
| `CONDUCTOR_CTX_BUDGET_REVIEW` | 10,000 | Review context budget |
| `CONDUCTOR_CTX_BUDGET_FILE_TREE` | 10,000 | File tree context budget |
| `CONDUCTOR_CTX_BUDGET_FILE_TREE_ENTRIES` | 500 | File tree entries limit |

---

## 10. Non-Goals (v0.1)

| Non-Goal | Rationale |
|----------|-----------|
| HTTP API request throttling middleware | `tooManyRequests` helper exists; middleware not wired yet |
| Per-project token budgets | Single-operator; global limits sufficient |
| Run-level cumulative token budgets | Per-invocation caps sufficient for v0.1 |
| Built-in pricing / cost computation | Self-hosted; operator pays provider directly |
| Per-user cost allocation | Single-operator in v0.1 |
| Multi-provider support (OpenAI, Google) | Only Anthropic supported; others throw `AgentUnsupportedProviderError` |
| GitHub `Retry-After` header parsing | Retries handled via message-string matching and BullMQ exponential backoff |
| Dynamic pricing updates | No runtime pricing model; reference values only |

---

## 11. Cross-References

| Topic | Document |
|-------|----------|
| Error classification and retry policies | `docs/ERROR_HANDLING.md` |
| AI provider integration details | `docs/workers/AI_PROVIDERS.md` |
| Rate limit metrics and alerts | `docs/OBSERVABILITY.md` § 3, § 6 |
| Policy enforcement rules | `docs/POLICIES.md` |
| Run phase transitions on limit exhaustion | `docs/RUN_STATE_MACHINE.md` |
| BlockedReasonCode enum values | `docs/ENUMS.md` § 1.4 |

---

## Appendix A: Codex Adversarial Review Resolution

**Review date:** 2026-02-20
**Reviewer:** Codex (read-only sandbox)
**Findings:** 27 total — 21 BLOCKING, 2 HIGH, 4 MEDIUM

| # | Severity | Section | Finding | Resolution |
|---|----------|---------|---------|------------|
| 1 | BLOCKING | §1 Architecture | "API Rate Limiting" layer not implemented as middleware | Restructured to 3 active layers; API throttling moved to Non-Goals with note about existing helper |
| 2 | BLOCKING | §2.2 GitHub 429 | No `Retry-After` parsing or `X-RateLimit-Remaining` tracking | Rewrote §2.2 to document actual mechanism: string-based `isRetryableError()` + BullMQ queue retries |
| 3 | BLOCKING | §2.2 Metric | `conductor_github_rate_limit_remaining` metric doesn't exist | Removed; noted `getRateLimitStatus` passthrough exists |
| 4 | HIGH | §2.2 Rate limit | 5,000/hour is external fact, not Conductor-enforced | Clarified as external platform fact |
| 5 | BLOCKING | §2.3 Schema | Index name wrong (`idx_deferred_events_run`), missing `summary` column | Fixed to `idx_mirror_deferred_run_time`; added migration 015 `summary` column |
| 6 | BLOCKING | §3.1 Jitter | No jitter in `rate-limit-retry.ts` | Removed jitter row; added note about executor's separate `RETRY_JITTER_MS` |
| 7 | BLOCKING | §3.2 Providers | OpenAI/Google not implemented (throw `AgentUnsupportedProviderError`) | Replaced with provider support matrix showing only Anthropic supported |
| 8 | BLOCKING | §3.3 Retry-After | No 1-second minimum; `Math.ceil(seconds * 1000)` | Corrected conversion description; noted sub-second values possible |
| 9 | BLOCKING | §3.3 Fallback | Fallback is caller-side, not in `retry-after.ts` | Clarified that module returns `undefined`; callers handle fallback |
| 10 | BLOCKING | §4.1 Hierarchy | Run/project budgets not implemented | Restructured to show only per-invocation as implemented; run/project as future |
| 11 | BLOCKING | §4.4 Budget check | No `budget_used` or `estimated_output` in preflight | Rewrote pseudocode to match actual logic: `estimated_input > effectiveBudget` with compaction attempt |
| 12 | MEDIUM | §4.3 Floor | Floor additionally clamped to context cap | Added note about `min(rawFloor, contextCap)` clamping |
| 13 | BLOCKING | §5.1 Iterations | 50 iterations ≠ 50 tool calls (single iteration can have parallel calls) | Corrected wording to "50 tool-loop iterations" |
| 14 | MEDIUM | §5.3 Cancellation | Cross-process also stops on `completed` | Added `completed` to stop conditions |
| 15 | BLOCKING | §5.4 Escalation | `budget_exceeded` not in `BlockedReasonCode` | Corrected to show `markRunFailed()` with error message string; documented actual enum values |
| 16 | BLOCKING | §5.4 Policy | "Policy warnings (10/run)" mechanism doesn't exist | Removed row |
| 17 | BLOCKING | §6.1 TokenUsage | Only `tokens_input` and `tokens_output` stored | Replaced interface with actual table columns |
| 18 | BLOCKING | §6.1 Levels | No per-project aggregation service | Noted per-invocation only; aggregation possible via SQL |
| 19 | BLOCKING | §6.2 Cost model | `ModelPricing` interface doesn't exist in code | Marked as planned/future with clear label |
| 20 | BLOCKING | §6.3 Pricing | No built-in pricing table in code | Changed to "Reference Pricing"; removed OpenAI/Google rows |
| 21 | BLOCKING | §6.4 Cost formula | No runtime cost computation | Removed section; covered by future note in §6.2 |
| 22 | BLOCKING | §7.1 Cancel | Endpoint is `/api/runs/[id]/actions` with `{ action: "cancel" }` | Fixed endpoint and described job enqueue mechanism |
| 23 | BLOCKING | §7.2 Pause | Same actions endpoint; phase validation constraints | Fixed endpoint; added phase constraint note |
| 24 | BLOCKING | §7.2 Pause | In-flight work can continue briefly | Added caveat about in-flight provider calls |
| 25 | BLOCKING | §7.3 Kill | `AI_API_KEY` not used; user keys via `user_api_keys` table | Corrected to describe user key management |
| 26 | BLOCKING | §8.1 Response | Error shape is `{ error, code, details }` not nested | Fixed to match `ApiError` interface from `api-utils.ts` |
| 27 | BLOCKING | §8.2 Codes | Quota error codes not standardized in routes | Added note that `tooManyRequests` exists but other codes are planned |
