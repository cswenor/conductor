# GitHub Integration Edge Cases

> **Status:** Normative. This is the single source of truth for how Conductor handles GitHub integration edge cases — repo lifecycle changes, permission revocations, API outages, webhook failures, and mid-run disruptions. All other documentation MUST reference this document for edge case behavior.

## 1. Edge Case Severity Classification

| Severity | Meaning | Example |
|----------|---------|---------|
| **Critical** | Run corruption or data loss possible | Repo deletion mid-run |
| **High** | Run failure with manual recovery needed | Permission revocation mid-run |
| **Medium** | Degraded functionality, auto-recovery possible | Rate limit exhaustion during mirror |
| **Low** | Cosmetic or informational impact | Repo rename after task creation |

---

## 2. Repository Lifecycle Edge Cases

### 2.1 Repo Rename

**Severity:** Low

**Detection:** GitHub sends no webhook for repo renames within the same owner. Cross-owner transfers (§ 2.3) do generate webhooks.

**Impact:**
- `repos.github_full_name` and `repos.github_name` become stale
- `repos.github_node_id` remains stable (GitHub node_id survives renames)
- API calls using owner/name paths may return 301 redirects or 404
- Git clone URLs using old name may continue to work (GitHub provides redirects temporarily)

**Current behavior:**
- Conductor does **not** auto-detect renames
- The `github_node_id` UNIQUE constraint ensures repo identity survives renames
- API calls via Octokit use owner/name, so stale names cause 404 on next API call
- Worktrees created before rename continue to work (local paths unaffected)

**Recovery:** Manual sync — update `repos.github_owner`, `repos.github_name`, `repos.github_full_name` via a re-sync from the GitHub API using the installation's repository list.

### 2.2 Repo Archive Mid-Run

**Severity:** High

**Detection:** GitHub sends `repository` webhook with `action: archived`. If webhook processing is configured, Conductor receives this event.

**Impact:**
- Archived repos are **read-only** on GitHub
- `git push` to remote fails with 403
- PR creation fails with 403
- Comment creation fails with 403
- Local worktree operations (commit, branch) still work
- Agent invocation completes locally but outbox writes fail

**Current behavior:**
- Conductor does **not** check repo archive status before operations
- Outbox processor classifies 403 as **non-retryable** via `isRetryableError()`
- Write marked as `failed` with error message
- Mirror/outbox write failures are non-fatal — they do not automatically transition the run to `blocked`
- Critical-path writes (e.g., PR creation via `pr-creation.ts`) do transition the run to `blocked` on failure
- No automatic notification to operator

**Recovery:** Operator must unarchive the repo on GitHub, then retry the run.

### 2.3 Repo Transfer (Ownership Change)

**Severity:** High

**Detection:** GitHub sends `repository` webhook with `action: transferred`. The `new_owner` field contains the new owner details.

**Impact:**
- `repos.github_owner` and `repos.github_full_name` become stale
- `repos.github_node_id` remains stable
- Installation-level permissions may change (new owner may not have the GitHub App installed)
- In-flight installation tokens become invalid if the App is not installed by the new owner
- Git remote URLs break (old owner/name combination no longer exists)

**Current behavior:**
- Conductor does **not** handle the `repository.transferred` webhook event
- Next API call using stale owner/name returns 404
- Outbox writes fail as non-retryable
- Run transitions to `blocked`

**Recovery:** Manual intervention required:
1. Ensure the GitHub App is installed on the new owner's account
2. Update repo record with new owner/name
3. Re-clone the repo (git remote URL changed)
4. Retry failed run

### 2.4 Repo Deletion

**Severity:** Critical

**Detection:** GitHub sends `repository` webhook with `action: deleted`.

**Impact:**
- All GitHub API calls for this repo return 404
- Git fetch/push operations fail
- In-progress runs cannot create PRs, push branches, or post comments
- Existing worktrees become orphaned (local files remain, remote gone)

**Current behavior:**
- Conductor does **not** handle the `repository.deleted` webhook event
- Next API call returns 404 (non-retryable)
- Run transitions to `blocked` with error
- Repo record remains in database with stale data
- Worktree files remain on disk

**Recovery:**
1. Delete repo record: `deleteRepo(db, repoId)`
2. Clean up worktree files manually
3. Cancel any in-progress runs referencing this repo

### 2.5 Private → Public Transition

**Severity:** Medium

**Detection:** GitHub sends `repository` webhook with `action: publicized`.

**Impact:**
- Previously private issue content, comments, and code become publicly visible
- Conductor-posted comments (mirror output) become public — these may contain plan summaries, agent logs, or file paths
- No data is exposed that wasn't already in the GitHub issue/PR

**Current behavior:**
- Conductor does **not** handle visibility change webhooks
- No automatic content review or redaction
- Mirror comments remain as-posted

**Recovery:** Operator should review Conductor-posted comments on the repo for any sensitive content before or after making the repo public.

---

## 3. Issue Lifecycle Edge Cases

### 3.1 Issue Transfer Between Repos

**Severity:** High

**Detection:** GitHub sends `issues` webhook with `action: transferred`. The event includes `changes.new_issue` and `changes.new_repository`. However, Conductor's `normalizeWebhook()` does not map the `transferred` action, so this event is persisted but marked as `ignored`.

**Impact:**
- `tasks.github_issue_number` may change (GitHub assigns new number in target repo)
- `tasks.github_node_id` changes (new node_id in target repo)
- Mirror writes targeting the old issue/repo fail with 404
- In-progress runs referencing the old issue lose their target

**Current behavior:**
- Conductor does **not** handle the `issues.transferred` event
- Mirror writes to old issue return 404 (non-retryable)
- Run continues but mirror comments are lost
- Task record becomes stale

**Recovery:** Manual update of task record with new issue number, node_id, and repo reference.

### 3.2 Issue Deletion

**Severity:** Medium

**Detection:** GitHub sends `issues` webhook with `action: deleted` (only available to GitHub Apps with `issues` permission).

**Impact:**
- Mirror writes to deleted issue return 404
- Task record references non-existent issue
- Run can still continue (mirroring is non-fatal)

**Current behavior:**
- Mirror functions use `resolveIssueTarget()` which returns `null` if the issue cannot be resolved — but this checks DB state, not GitHub state
- If DB still references the issue, mirror enqueue succeeds (write stored in `github_writes`), but outbox execution later fails with 404 (non-retryable)
- Run continues unaffected — mirror functions return `MirrorResult` with `enqueued`/`deferred` flags and never throw
- The 404 failure surfaces at outbox processing time, not at mirror enqueue time

**Recovery:** No action required for run completion. Task record can be cleaned up manually.

---

## 4. Permission and Authentication Edge Cases

### 4.1 GitHub App Uninstalled Mid-Run

**Severity:** Critical

**Detection:** GitHub sends `installation` webhook with `action: deleted`.

**Impact:**
- All installation tokens become immediately invalid
- In-flight API calls fail with 401
- Git push/fetch operations using installation tokens fail
- No new tokens can be obtained for this installation
- All runs for repos under this installation are affected

**Current behavior:**
- Conductor persists the `installation.deleted` webhook to `webhook_deliveries`
- The event is persisted but **not actionably processed** — `normalizeWebhook()` does not map `installation.deleted` to run/task operations, so it is persisted in the database but ignored by the worker (no downstream effect)
- No automatic run cancellation or notification
- Next API call returns 401 (non-retryable)
- Outbox writes fail permanently

**Recovery:**
1. User re-installs the GitHub App
2. New installation ID is assigned (old one is permanently invalid)
3. Project must be re-linked to new installation
4. In-progress runs must be cancelled and re-created

### 4.2 GitHub App Permissions Downgraded

**Severity:** High

**Detection:** GitHub sends `installation` webhook with various actions for permission changes, but Conductor's event normalization only maps `created`, `deleted`, `suspend`, and `unsuspend` actions. Permission change actions are persisted but marked as `ignored`. The practical detection mechanism is 403 responses on API calls that previously succeeded.

**Impact (by permission):**

| Permission Lost | Operations Affected | Detection |
|----------------|-------------------|-----------|
| `issues: write` | Comment creation, issue updates | 403 on POST /issues/comments |
| `pull_requests: write` | PR creation, PR updates | 403 on POST /pulls |
| `checks: write` | Check run creation/updates | 403 on POST /check-runs |
| `contents: write` | Branch creation, push | 403 on POST /git/refs |
| `metadata: read` | Repo discovery, issue listing | 403 on GET /repos |

**Current behavior:**
- Conductor does **not** verify permissions before operations
- 403 responses are classified as non-retryable by `isRetryableError()`
- Write marked as `failed`
- No specific error classification for "permission denied" vs "other 403"

**Recovery:** Operator must re-grant permissions via GitHub App settings, then retry failed operations.

### 4.3 Installation Token Expiration

**Severity:** Medium

**Detection:** 401 response on API call. Installation tokens expire after 1 hour (GitHub platform behavior).

**Impact:**
- Single API call fails
- Git operations using the token fail

**Current behavior:**
- Conductor obtains fresh tokens via `getInstallationToken()` per operation batch
- Clone/fetch operations are bounded by timeouts and limited retries (2 attempts), so in practice they do not run for the full token lifetime
- 401 is classified as non-retryable by `isRetryableError()`
- Next operation batch obtains a fresh token

**Recovery:** Automatic — next operation obtains a fresh token. Long-running git operations may need manual retry.

### 4.4 OAuth Token Revocation

**Severity:** Medium

**Detection:** 401 on user-scoped API calls (installation discovery). Also 403 if token lacks `read:org` scope.

**Impact:**
- `GET /user/installations` fails
- User cannot discover new installations
- Existing project-installation links remain functional (installation tokens are independent of user OAuth tokens)

**Current behavior:**
- Installation discovery endpoint catches 403 and falls back to pending-only list
- Logged at `warn` level: `'GitHub returned 403 for /user/installations — the OAuth token may lack read:org scope'`
- Graceful degradation: user sees only pending installations, not all accessible ones

**Recovery:** User re-authenticates via OAuth flow to obtain fresh token.

---

## 5. GitHub API Failure Modes

### 5.1 Rate Limit Exhaustion

**Severity:** Medium

**Detection:** Error message substring matching in `isRetryableError()` — checks for `'rate limit'` and `'too many requests'` in the lowercased error message. Does not parse HTTP status codes or `Retry-After` / `X-RateLimit-Remaining` headers directly.

**Impact:**
- Outbox writes delayed (retryable)
- Mirror comments deferred
- Agent API calls (AI provider) handled separately (see `docs/RATE_LIMITING.md`)

**Current behavior:**

| Layer | Rate Limit | Window | Handling |
|-------|-----------|--------|----------|
| GitHub write rate limiter | 1 comment per 30s per run | Per-run | Deferral + coalescing |
| GitHub API rate limit | 5,000 req/hr per installation | Per-installation | BullMQ retry with exponential backoff |

- `isRetryableError()` returns `true` for rate limit messages
- BullMQ retries up to 5 times with exponential backoff (base 2s)
- If retries exhausted: write marked `failed`, run may be blocked

**Recovery:** Automatic via retry. If retries exhausted, wait for rate limit window reset and retry manually.

### 5.2 GitHub Partial Outage

**Severity:** High

**Detection:** 500, 502, or 503 responses. Also ECONNRESET, timeout, or network errors.

**Impact:**
- Webhook deliveries may be delayed or lost by GitHub
- API calls fail intermittently
- Git operations (clone, fetch, push) may time out

**Current behavior:**
- 500/502/503 classified as retryable by `isRetryableError()`
- Network errors (ECONNRESET, timeout) classified as retryable
- BullMQ retries with exponential backoff
- Git operations retry 2x with backoff (clone: 2s base, fetch: 1s base)
- Webhook deliveries: GitHub retries on its end (up to ~3 days per GitHub docs)

**Recovery:** Automatic via retry for API calls. Git operations may need manual retry after outage resolution.

### 5.3 GitHub Full Outage

**Severity:** Critical

**Detection:** All API calls fail. Git operations fail. No webhooks received.

**Impact:**
- No new webhooks received (events buffered by GitHub, delivered after recovery)
- All outbox writes fail and queue up
- Git clone/fetch/push all fail
- Runs that require GitHub interaction are blocked
- Local-only operations (agent invocations, worktree file operations) continue

**Current behavior:**
- Writes accumulate in `github_writes` table with `queued` or `failed` status
- BullMQ retries exhaust, writes marked as permanently `failed`
- No automatic health monitoring of GitHub API availability
- No circuit breaker to suspend operations during detected outage

**Recovery:**
1. Wait for GitHub to recover
2. Re-process failed writes via outbox processor
3. Check for missed webhooks (GitHub delivers buffered events)
4. Verify run state consistency

### 5.4 Webhook Delivery Failures

**Severity:** Medium

**Detection:** Missed events inferred from state inconsistencies (e.g., issue closed on GitHub but task still open in Conductor).

**Impact:**
- Conductor may not learn about external changes (issue edits, PR merges, label changes)
- State drift between GitHub and Conductor's local database
- Mirror comments may reference stale state

**Current behavior:**
- Conductor relies on GitHub's webhook retry mechanism (GitHub retries failed deliveries)
- Webhook deliveries table provides audit trail
- No periodic polling to detect missed events
- No reconciliation mechanism to sync state after missed webhooks

**Recovery:** Manual sync — re-fetch issue/PR state from GitHub API and reconcile with local database.

---

## 6. Mid-Run Disruption Scenarios

### 6.1 Branch Protection Changes Mid-Run

**Severity:** High

**Detection:** `git push` fails with 403 or specific GitHub error message indicating branch protection.

**Impact:**
- Agent cannot push commits to the run's branch
- PR cannot be created if branch doesn't exist on remote
- Run transitions to `blocked` at the push/PR creation step

**Current behavior:**
- Conductor does **not** check branch protection rules before operations
- Conductor does **not** disable branch protection for agent branches
- Push is performed in the PR creation worker (`pr-creation.ts`), not by the agent directly
- Push failure transitions the run to `blocked` phase via `markRunFailed()` (there is no `failed` phase in `RunPhase`)
- Error is recorded as a generic `Git push failed` message

**Recovery:** Operator adjusts branch protection rules (e.g., exclude pattern for agent branches), then retries the run.

### 6.2 Default Branch Change Mid-Run

**Severity:** Medium

**Detection:** No direct detection. Manifests as merge conflicts or missing base branch.

**Impact:**
- Run's `baseBranch` field references the old default branch
- New worktrees created after the change use the new default
- Existing worktrees remain on old base (may cause merge conflicts)

**Current behavior:**
- `resolveBaseBranch()` uses a 3-tier resolution: (1) explicitly configured default, (2) GitHub default branch from DB, (3) check if `main` or `master` exists in the clone
- If an explicit branch is configured, it is returned immediately **without verifying existence** — the missing branch is detected later by `resolveBaseCommit()` which throws `Error("Base branch '{name}' not found in repo")`
- If no explicit branch is configured, the function falls back to DB → `main` → `master` → defaults to `'main'`
- Run-level `baseBranch` is set at creation time and not updated

**Recovery:** Automatic for common renames (e.g., `master` → `main` with fallback). Otherwise, cancel and re-create the run with correct base branch.

### 6.3 Force Push to Base Branch Mid-Run

**Severity:** High

**Detection:** No direct detection. `git fetch` succeeds but base commit no longer exists in remote history. Subsequent merge/rebase operations fail.

**Impact:**
- Worktree's base commit may be orphaned (no longer reachable from remote)
- PR shows unexpected diff (includes force-pushed changes)
- Agent-created branch may have diverged history relative to new base

**Current behavior:**
- No detection of base branch force pushes
- `git clone` and `git fetch` operations succeed (they fetch new state)
- `git push` in `pr-creation.ts` may fail if the branch was based on now-orphaned commits
- Git errors surface as generic failures, not force-push-specific messages
- Run transitions to `blocked` if push or PR creation fails

**Recovery:** Cancel run, re-create with new base commit.

### 6.4 Concurrent Runs on Same Repo

**Severity:** Medium

**Detection:** Multiple runs with different worktrees on the same repo.

**Impact:**
- Each run has its own worktree and branch (isolated)
- Git clone/fetch operations are serialized via file locks (`acquireFileLock('clone-${repoId}')`)
- No branch naming conflicts (branch names include run ID: `conductor/run-{runId}`)
- Mirror comments may interleave on the same issue

**Current behavior:**
- File-based locking prevents concurrent clone/fetch operations
- Each worktree is independent (different path, different branch)
- Outbox writes are per-run (different idempotency keys)
- Mirror rate limiter is per-run (30s window per run, not per issue)

**Recovery:** No recovery needed — concurrent runs are supported by design.

---

## 7. Webhook Edge Cases

### 7.1 Duplicate Webhook Delivery

**Severity:** Low

**Detection:** `X-GitHub-Delivery` header matches an existing `delivery_id` in `webhook_deliveries` table.

**Handling:**
```
INSERT OR IGNORE INTO webhook_deliveries (delivery_id, ...) VALUES (?, ...)
→ result.changes === 0 → duplicate detected
→ Return 200 with { received: true, duplicate: true }
```

No side effects on duplicate — fully idempotent.

### 7.2 Out-of-Order Webhook Delivery

**Severity:** Medium

**Detection:** Events arrive in unexpected order (e.g., `issue_comment` before `issues.opened`).

**Impact:**
- Comment event may reference an issue not yet tracked by Conductor
- No issue → no task → event is processed but may not link to a run

**Current behavior:**
- Webhooks are persisted regardless of processing order
- Event processing may fail gracefully (no matching task/run)
- Failed processing logged but does not block future events

**Recovery:** Automatic — delayed events are processed when they arrive. GitHub eventually delivers all events.

### 7.3 Webhook Arrives Before Bootstrap Complete

**Severity:** Medium

**Detection:** `ensureBootstrap()` throws during webhook handling.

**Handling:**
```typescript
try {
  await ensureBootstrap();  // Blocks until DB + queue ready
} catch (err) {
  return NextResponse.json({ error: 'Service unavailable' }, { status: 503 });
}
```

GitHub receives 503 and retries the delivery. No data loss.

### 7.4 Webhook Signature Mismatch

**Severity:** High

**Detection:** `verifyWebhookSignature()` returns `false` or throws.

**Handling:**
- Webhook is persisted to database with `signature_valid: 0`
- Returns 401 response
- Logged for security audit

**Development mode exception:** If GitHub credentials are not configured, all webhooks are accepted without signature verification (allows local testing).

### 7.5 Oversized Webhook Payload

**Severity:** Low

**Detection:** JSON parsing failure or payload exceeds Next.js body parser defaults.

**Current behavior:**
- No explicit payload size limit configured in the webhook route
- Next.js body parser applies its own default limits (no custom `bodyParser` config in the route)
- `extractPayloadSummary()` extracts only needed fields, discarding bulk payload
- Only `payload_summary_json` is stored, not the full payload

---

## 8. Error Classification Reference

### 8.1 Retryable vs Non-Retryable Errors

**Source:** `isRetryableError()` in `packages/shared/src/outbox/processor.ts`

| Error Pattern | Retryable | Rationale |
|--------------|-----------|-----------|
| `rate limit` / `too many requests` | Yes | Temporary, resolves after window reset |
| `500` / `502` / `503` | Yes | Server-side transient error |
| `network` / `timeout` / `econnreset` | Yes | Network transient error |
| `404` | No | Resource permanently missing |
| `403` | No | Permission denied (structural, not transient) |
| `401` | No | Authentication invalid (token expired/revoked) |
| `409` / `422` | No | Default fallthrough — `isRetryableError()` does not explicitly match these; they fall through to the non-retryable default |
| Unknown errors | No | Default fallthrough — any unmatched error message is treated as non-retryable |

### 8.2 Error Response Handling by Layer

| Layer | Retryable Behavior | Non-Retryable Behavior |
|-------|-------------------|----------------------|
| Outbox processor | BullMQ retry (5 attempts, exponential backoff from 2s) | Write marked `failed`, logged |
| Git operations | 2 retries with backoff (clone: 2s, fetch: 1s) | Operation fails, error propagated |
| Webhook handler | N/A (reception only) | 400/401/500 returned to GitHub; 503 if bootstrap fails |
| Mirror system | Deferred event flushed later (60s stale threshold) | `MirrorResult.error` set, non-fatal |
| Agent provider | Budget backoff + retry (see `docs/RATE_LIMITING.md`) | Agent invocation fails |

---

## 9. Detection and Notification

### 9.1 Current Detection Mechanisms

| Edge Case | Detection Method | Notification |
|-----------|-----------------|--------------|
| Repo rename | Next API call returns 404 (stale name) | Write failure logged |
| Repo archive | Write returns 403 | Write failure logged |
| Repo transfer | Next API call returns 404 | Write failure logged |
| Repo deletion | Next API call returns 404 | Write failure logged |
| Visibility change | `repository` webhook (if handled) | None |
| Issue transfer | `issues.transferred` webhook (not handled) | None |
| App uninstalled | `installation.deleted` webhook | Webhook persisted |
| Permissions downgraded | Next write returns 403 | Write failure logged |
| Token expiration | 401 on API call | Next call obtains fresh token |
| Rate limit | 429 on API call | BullMQ retry mechanism |
| GitHub outage | 5xx / network errors | Retry mechanism |
| Branch protection | Push fails with 403 | Agent invocation error |
| Webhook failure | State drift (indirect) | None |

### 9.2 Notification Gaps

The following edge cases produce **no operator notification**:

- Repo visibility change (private → public)
- Issue transfer between repos
- Missed webhooks (no reconciliation)
- GitHub App permission downgrade (detected only on next use)
- Orphaned PRs from failed runs
- Stale repo metadata after rename

### 9.3 Recommended Monitoring

| Signal | Method | Threshold |
|--------|--------|-----------|
| Outbox write failure rate | Count `status='failed'` in `github_writes` | > 5 failures per hour |
| Webhook processing delay | `processed_at - received_at` from `webhook_deliveries` | > 60 seconds |
| Git operation failures | Agent invocation errors with git error codes | Any failure |
| Token refresh failures | 401 errors in logs | Any occurrence |
| Stale deferred events | Count in `mirror_deferred_events` older than threshold | > 10 events older than 5 minutes |

---

## 10. Graceful Degradation Patterns

### 10.1 Non-Fatal Mirroring

All mirror functions follow the **non-fatal pattern** — they never throw, always return `MirrorResult`:

```typescript
export function mirrorPhaseTransition(ctx, input, result): MirrorResult {
  try {
    if (!result.success) return { enqueued: false, deferred: false };
    const target = resolveIssueTarget(ctx.db, input.runId);
    if (target === null) return { enqueued: false, deferred: false };
    // ... mirror logic ...
  } catch (err) {
    log.error({ error: err.message }, 'Mirror failed');
    return { enqueued: false, deferred: false, error: err.message };
  }
}
```

**Implication:** Run progression is never blocked by mirror failures. Comments may be lost silently.

### 10.2 Development Mode Webhook Acceptance

When GitHub credentials are not configured (local development):
- Webhook signature verification is skipped
- All webhooks are accepted as valid
- `signature_valid` is set to `true` regardless

### 10.3 Idempotent Operations

Key operations are designed to be safely retried:

| Operation | Idempotency Mechanism |
|-----------|----------------------|
| Webhook persistence | `delivery_id` PRIMARY KEY + INSERT OR IGNORE |
| Outbox write enqueue | `idempotency_key` UNIQUE + SELECT-then-INSERT (checks for existing key before insert; UNIQUE constraint is the safety net) |
| Worktree creation | Double-check locking + UNIQUE constraint |
| Repo creation | `github_node_id` UNIQUE constraint |
| Mirror deferred event | `idempotency_suffix` UNIQUE constraint |

### 10.4 Compensating Transactions

When worktree creation partially fails:

```
1. Git worktree created on disk ✓
2. Database insert fails (UNIQUE constraint) ✗
3. Compensating action:
   - git worktree remove --force <path>
   - rm -rf <path> (if worktree remove fails)
   - git branch -D <branch>
4. Check if another process won the race
5. If yes: return race winner's worktree
6. If no: re-throw original error
```

---

## 11. Cross-References

| Topic | Document |
|-------|----------|
| Rate limiting details | `docs/RATE_LIMITING.md` |
| Idempotency system | `docs/IDEMPOTENCY.md` |
| Webhook handling | `docs/INTEGRATION_MODEL.md` |
| Data model (webhook/write tables) | `docs/DATA_MODEL_AUTHORITY.md` |
| API contracts (webhook endpoints) | `docs/API_CONTRACTS.md` |
| Agent prompt injection defenses | `docs/AGENT_PROMPTS.md` § 8 |

---

## Appendix A: Codex Adversarial Review Resolution

**Review date:** 2026-02-20
**Reviewer:** Codex (read-only sandbox)
**Findings:** 19 total — 3 BLOCKING, 11 HIGH, 5 MEDIUM

| # | Severity | Section | Finding | Resolution |
|---|----------|---------|---------|------------|
| 1 | BLOCKING | §2.2, §2.3, §2.4, §6.1 | Referenced `failed` RunPhase — no such phase exists; use `blocked` | Replaced all `failed` phase references with `blocked`; noted `markRunFailed()` transitions to `blocked` |
| 2 | HIGH | §2.2 | Claimed write failures always transition run to `failed` | Clarified: mirror/outbox writes are non-fatal; only critical-path writes (PR creation) transition to `blocked` |
| 3 | HIGH | §2.2 | Didn't distinguish mirror non-fatality from critical-path writes | Added distinction between non-fatal mirror writes and fatal PR creation writes |
| 4 | HIGH | §3.1 | Didn't note that `normalizeWebhook()` doesn't map `transferred` action | Added: event persisted but marked `ignored` since action is unmapped |
| 5 | HIGH | §3.2 | MirrorResult timing — described enqueue-time failure detection | Clarified: enqueue succeeds (DB state OK), 404 failure surfaces at outbox execution time |
| 6 | BLOCKING | §4.1 | `installation.deleted` described as "processed via BullMQ job" | Fixed: persisted but not actionably processed — ignored by worker |
| 7 | HIGH | §4.2 | Permission change actions described as handled | Fixed: only `created`/`deleted`/`suspend`/`unsuspend` mapped; permission changes persisted but ignored |
| 8 | MEDIUM | §4.3 | Token expiration described as "long-running operations" running full hour | Fixed: clone/fetch bounded by timeouts and limited retries (2 attempts) |
| 9 | HIGH | §5.1 | Rate limit detection described as HTTP status/header parsing | Fixed: uses error message substring matching (.includes()), not HTTP status codes |
| 10 | HIGH | §6.1 | Branch protection push failure attributed to agent | Fixed: push is in `pr-creation.ts` worker, not agent directly |
| 11 | HIGH | §6.2 | `resolveBaseBranch()` showed wrong error message | Fixed: 3-tier resolution; missing branch error from `resolveBaseCommit()`: "Base branch '{name}' not found in repo" |
| 12 | HIGH | §6.3 | Force push described in terms of merge/rebase failures | Reframed: actual failure points are clone/fetch/push operations; git errors surface as generic failures |
| 13 | MEDIUM | §6.4 | Branch names described as including issue number | Fixed: branch names include run ID only (`conductor/run-{runId}`) |
| 14 | HIGH | §7.3-7.4 | Webhook processing described generically | Clarified: project-level normalization via `normalizeWebhook()` |
| 15 | MEDIUM | §7.5 | Implied explicit parser-limit configuration | Fixed: no custom `bodyParser` config; relies on Next.js defaults |
| 16 | MEDIUM | §8.1 | 409/422 shown as explicit checks in `isRetryableError()` | Fixed: these are default fallthrough (not explicitly matched), treated as non-retryable |
| 17 | HIGH | §8.2 | Webhook handler only listed 400/401 responses | Fixed: also returns 503 (bootstrap failure) and 500 (enqueue failure) |
| 18 | BLOCKING | §9.1 | Installation detection described as actioned | Fixed: persisted but ignored in worker — consistent with §4.1 |
| 19 | HIGH | §10.3 | Outbox enqueue described as INSERT OR IGNORE | Fixed: uses SELECT-then-INSERT pattern; UNIQUE constraint is safety net |
