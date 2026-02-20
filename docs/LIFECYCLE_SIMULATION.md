# Feature Lifecycle Simulation

Status: Informative reference
Audience: Engineering, platform evaluators
Updated: 2026-02-19

This document simulates a complete feature lifecycle through Conductor, showing every worker invocation, every state transition, and every dynamic adaptation point. Use it to understand how the system works end-to-end.

---

## The Scenario

**Work item:** "Add JWT authentication to API endpoints"

- Type: feature
- Area: backend
- Estimated scope: medium
- Acceptance criteria:
  1. All /api/* routes require valid JWT
  2. Token refresh endpoint at /api/auth/refresh
  3. Rate limiting on auth endpoints (10 req/min)
- Non-goals: OAuth/SSO integration, frontend auth UI
- Priority: high (blocking other backend work)
- Autonomy level: L2 (AI plans and executes, human approves gates)

**Team configuration:**
- Provider budget: $200/month
- Primary provider: Anthropic (Claude)
- Failover: OpenAI (GPT-4.1)
- Local: Ollama (Llama 3.3) for privacy fallback
- CI: GitHub Actions

---

## Phase 0: Issue Created (GitHub webhook)

```
EVENT: github.issues.opened { number: 42, title: "Add JWT authentication to API endpoints" }
```

### Workers Invoked:

| # | Worker | Role | Operation | Mode | Duration |
|---|--------|------|-----------|------|----------|
| 0.1 | pm-engine-v1 | pm_engine | `conductor_sync_from_source` | sync | 2s |
| 0.2 | triage-haiku | pm.triage.classifier | `pm.triage` | sync | 3s |
| 0.3 | pm-engine-v1 | pm_engine | `conductor_predict_rework` | async | 1s |
| 0.4 | pm-engine-v1 | pm_engine | `conductor_get_issue_dependencies` | async | 0.5s |
| 0.5 | slack-notifier | notifier | `script.notify` | async (fire-and-forget) | 0.2s |

**What happens:**

1. GitHub webhook arrives → orchestrator receives `issues.opened` event
2. PM Engine syncs the new issue into its local database (0.1)
3. Auto-triage is enabled (`auto_triage: 'suggest'`), so the classifier runs (0.2):
   - Input: issue title, body, labels
   - Output: `{ type: "feature", area: "backend", priority: "high", size: "medium", risk: "medium", confidence: 0.85 }`
   - Confidence is 0.85 (> 0.8 threshold) → labels are applied automatically
4. In parallel, rework prediction and dependency analysis run (0.3, 0.4)
5. Slack notification fires (0.5): "New issue #42: Add JWT authentication to API endpoints [high priority, backend]"

**Dynamic adaptation point:** The triage classifier chose `triage-haiku` (cheapest LLM variant) because triage is high-volume and doesn't need deep reasoning. If confidence had been < 0.6, it would have escalated to `triage-claude-sonnet` for a second opinion.

**State after Phase 0:**
```
Issue #42: open
Project state: Backlog
Labels: type:feature, area:backend, priority:high, size:medium
```

---

## Phase 1: Run Started (human or auto)

```
EVENT: run.created { run_id: "run-abc", work_item_id: 42, template: "feature" }
```

At L2 autonomy, the orchestrator auto-creates the run because confidence was high and priority is high. At L0-L1, a human would click "Start" in the Web UI.

### Workers Invoked:

| # | Worker | Role | Operation | Mode | Duration |
|---|--------|------|-----------|------|----------|
| 1.1 | pm-engine-v1 | pm_engine | `conductor_suggest_approach` | sync | 1s |
| 1.2 | pm-engine-v1 | pm_engine | `conductor_predict_completion` | sync | 0.5s |
| 1.3 | pm-engine-v1 | pm_engine | `conductor_get_history_insights` | sync | 0.5s |

**What happens:**

1. Orchestrator selects the `feature` workflow template (medium scope, no special labels)
2. PM intelligence gathered for the planner's context packet:
   - `suggest_approach`: "Previous auth work (issue #28) used middleware pattern. Decision D-14 chose jose library for JWT. Lesson: test token expiry edge cases — missed in first attempt."
   - `predict_completion`: P50 = 6 hours, P80 = 12 hours, P95 = 24 hours
   - `history_insights`: `src/middleware/` is a hotspot (12 changes in 30 days), `src/routes/api/` has bus factor = 1 (only @alice touches it)
3. Run enters `planning` phase

**State after Phase 1:**
```
Run run-abc: phase=planning, status=active
Issue #42: Active (moved from Backlog)
```

---

## Phase 2: Planning

```
EVENT: run.phase_changed { run_id: "run-abc", phase: "planning" }
```

### Workers Invoked:

| # | Worker | Role | Operation | Mode | Duration |
|---|--------|------|-----------|------|----------|
| 2.1 | planner-claude-opus | planner | `planning.create` | sync | 90s |
| 2.2 | slack-notifier | notifier | `script.notify` | async | 0.2s |

**Why claude-opus?** The orchestrator selected `planner-claude-opus` over `planner-claude-sonnet` because:
- Priority is `high` → quality boost for highest-capability model
- Area is `backend` with security implications (auth) → extra caution
- Rework prediction was 0.35 (moderate) → doesn't require Opus alone, but combined with high priority, Opus wins

**Dynamic adaptation point:** If the Anthropic API were down:
```
planner-claude-opus → CIRCUIT BREAKER OPEN
planner-claude-sonnet → CIRCUIT BREAKER OPEN (same provider)
→ Failover: planner-gpt4 (OpenAI)
→ Event: provider_failover { from: anthropic, to: openai }
```

**What happens:**

1. Planner receives the context packet:
   - Work item (title, body, ACs, non-goals)
   - Intelligence (approach suggestion, history insights, rework prediction)
   - Codebase access (read-only — reads file tree, existing middleware, route structure)
2. Planner produces:
   - `PLAN` artifact: Markdown plan with approach, file changes, AC traceability table
   - `PLAN_METADATA` artifact: `{ files: ["src/middleware/auth.ts", "src/routes/api/auth.ts", ...], complexity: "medium", risks: ["rate limiting library choice", "token rotation edge cases"] }`
3. Slack notification: "Plan ready for #42: Add JWT auth (3 files, medium complexity)"

**Plan output (abbreviated):**
```markdown
## Approach
Add JWT verification middleware using jose library (per decision D-14).
New auth routes at /api/auth/refresh. Rate limiting via express-rate-limit.

## AC Traceability
| # | Criterion | Files | Tests |
|---|-----------|-------|-------|
| 1 | All /api/* require JWT | src/middleware/auth.ts | tests/middleware/auth.test.ts |
| 2 | Token refresh endpoint | src/routes/api/auth.ts | tests/routes/auth.test.ts |
| 3 | Rate limiting (10/min) | src/middleware/rate-limit.ts | tests/middleware/rate-limit.test.ts |
```

**State after Phase 2:**
```
Run run-abc: phase=awaiting_plan_approval, status=active
Artifacts: PLAN (plan-abc-1), PLAN_METADATA (meta-abc-1)
```

---

## Phase 3: Plan Approval (Gate)

```
EVENT: run.phase_changed { run_id: "run-abc", phase: "awaiting_plan_approval" }
```

### Workers Invoked:

| # | Worker | Role | Operation | Mode | Duration |
|---|--------|------|-----------|------|----------|
| 3.1 | @bob | plan_approver | `gate.plan_approval` | sync | 45 min |

**At L2 autonomy:** Plan approval requires a human. The orchestrator routes the approval request to @bob (designated plan approver) via the Web UI and Slack notification.

**At L3 autonomy:** The AI would auto-approve because risk is medium (not high) and rework prediction is 0.35 (below 0.55 threshold). No human needed.

**Dynamic adaptation point:** If @bob doesn't respond within 4 hours (the timeout), the orchestrator:
1. Sends escalation notification to team channel
2. If escalation policy is set, routes to backup approver @alice
3. If no backup, run enters `blocked` state

**What happens:**

1. @bob reviews the plan in the Conductor Web UI
2. @bob approves with comment: "Looks good. Use jose v6 not v5 — we had issues with v5 key rotation."
3. Orchestrator records the approval and the comment as feedback for the implementer

**State after Phase 3:**
```
Run run-abc: phase=executing, status=active
Gate: plan_approval = PASSED (approved_by: @bob)
```

---

## Phase 4: Implementation

```
EVENT: run.phase_changed { run_id: "run-abc", phase: "executing" }
```

### Workers Invoked:

| # | Worker | Role | Operation | Mode | Duration |
|---|--------|------|-----------|------|----------|
| 4.1 | impl-claude-sonnet | implementer | `implementation.execute` | sync | 8 min |
| 4.2 | slack-notifier | notifier | `script.notify` | async | 0.2s |

**Why claude-sonnet (not opus)?** Implementation is execution, not reasoning. Sonnet is the sweet spot: fast enough for code generation, capable enough for complex changes, cheaper than Opus. The plan was already approved by Opus — Sonnet just follows it.

**Dynamic adaptation point:** If implementation were for a `critical` priority item with `risk=high`, the orchestrator would select `impl-claude-opus` instead.

**What happens:**

1. Implementer receives:
   - Approved plan artifact
   - Approval feedback ("Use jose v6 not v5")
   - Workspace: worktree created at `/worktrees/conductor-42/`
   - Sandbox: `workspace-write` (can read/write within worktree only)
2. Implementer creates/modifies files:
   - `src/middleware/auth.ts` — JWT verification middleware
   - `src/middleware/rate-limit.ts` — Rate limiting middleware
   - `src/routes/api/auth.ts` — Token refresh endpoint
   - `tests/middleware/auth.test.ts` — Auth middleware tests
   - `tests/middleware/rate-limit.test.ts` — Rate limit tests
   - `tests/routes/auth.test.ts` — Auth route tests
3. Implementer runs tests within worktree: `vitest run`
4. Produces artifacts:
   - `CODE` artifact: 6 files changed
   - `PATCHSET` artifact: Git diff
   - `TEST_REPORT` artifact: 14 tests passed, 0 failed

**Checkpoint behavior:** The implementer checkpoints after each file. If the AI context window runs out at file 4 of 6, a new task is created with the checkpoint, and implementation resumes from file 5.

**State after Phase 4:**
```
Run run-abc: phase=executing (quality checks next), status=active
Artifacts: +CODE (code-abc-1), +PATCHSET (patch-abc-1), +TEST_REPORT (test-abc-1)
Commits: 1 commit on branch feature/42-jwt-auth
```

---

## Phase 5: Quality Checks (Parallel)

```
EVENT: run.parallel_group_started { run_id: "run-abc", group: "quality_checks" }
```

### Workers Invoked (ALL IN PARALLEL):

| # | Worker | Role | Operation | Mode | Duration |
|---|--------|------|-----------|------|----------|
| 5.1 | vitest-worker | tester | `script.test` | parallel | 25s |
| 5.2 | eslint-worker | linter | `script.lint` | parallel | 8s |
| 5.3 | tsc-worker | typechecker | `script.typecheck` | parallel | 12s |
| 5.4 | semgrep-worker | security_scanner | `script.security_scan` | parallel | 15s |
| 5.5 | prettier-worker | formatter | `script.format` | parallel | 3s |

**Join rule:** `all` — every check must pass before proceeding to review.

**What happens:**

1. All 5 script workers start simultaneously on the worktree
2. Results arrive as each completes:
   - Formatter (5.5, 3s): 2 files reformatted → auto-committed
   - Linter (5.2, 8s): Clean ✓
   - Type checker (5.3, 12s): Clean ✓
   - Security scanner (5.4, 15s): 1 finding — "Missing input validation on refresh token parameter" (medium severity)
   - Tests (5.1, 25s): 14/14 pass ✓
3. **Security finding triggers rework** — the parallel group FAILS because security_scan found a medium+ severity issue

**Dynamic adaptation point:** The security scanner finding is medium severity. Project policy says: `security_scan_block_threshold: medium`. If the threshold were `high`, the medium finding would be logged but wouldn't block.

```
EVENT: run.parallel_group_failed { run_id: "run-abc", group: "quality_checks", failed: ["security_scan"] }
EVENT: run.phase_changed { run_id: "run-abc", phase: "executing" }  ← retry loop
```

### Fix Cycle:

| # | Worker | Role | Operation | Mode | Duration |
|---|--------|------|-----------|------|----------|
| 5.6 | impl-claude-sonnet | implementer | `implementation.fix` | sync | 2 min |
| 5.7-5.11 | (same 5 workers) | (same) | (same) | parallel | 25s |

1. Orchestrator creates a fix task with the security finding as input
2. Implementer adds input validation to the refresh endpoint (2 minutes)
3. Quality checks re-run (all parallel again)
4. This time all pass ✓

**Retry tracking:** Attempt 1 of 3 (max_test_fix_attempts=3). If all 3 fail, the run enters `blocked` state and escalates to human.

**State after Phase 5:**
```
Run run-abc: phase=awaiting_review, status=active
Gate: tests_pass = PASSED (attempt 2 of 3)
Commits: 2 commits on branch feature/42-jwt-auth
```

---

## Phase 6: PR Creation (async, background)

```
EVENT: run.pr_created { run_id: "run-abc", pr_number: 87 }
```

### Workers Invoked:

| # | Worker | Role | Operation | Mode | Duration |
|---|--------|------|-----------|------|----------|
| 6.1 | impl-claude-sonnet | implementer | `implementation.prepare_pr` | sync | 15s |
| 6.2 | github-ci-adapter | ci_service | `script.ci_trigger` | async | 2s |
| 6.3 | slack-notifier | notifier | `script.notify` | async | 0.2s |

**What happens:**

1. Implementer creates PR #87 with:
   - Title: "feat: Add JWT authentication to API endpoints (#42)"
   - Body: Generated from plan, AC traceability table, and test summary
   - Labels: auto-applied from work item
2. CI triggered on the PR branch (GitHub Actions)
3. Slack notification: "PR #87 created for #42, ready for review"

---

## Phase 7: Code Review

```
EVENT: run.phase_changed { run_id: "run-abc", phase: "awaiting_review" }
```

### Workers Invoked:

| # | Worker | Role | Operation | Mode | Duration |
|---|--------|------|-----------|------|----------|
| 7.1 | reviewer-claude-opus | reviewer | `review.code` | sync | 45s |
| 7.2 | reviewer-claude-opus | reviewer | `review.scope` | sync | 10s |
| 7.3 | pm-engine-v1 | pm_engine | `conductor_detect_scope_creep` | sync | 1s |
| 7.4 | @alice | human_reviewer | `review.code` | sync | 2 hours |

**Why is there both AI and human review?** At L2 autonomy:
- AI review runs first (fast, immediate feedback)
- Human review is required by gate policy (`code_review: enforced`)
- Both must pass — AI review blocks on its own, then human review blocks

**Dynamic adaptation point:** At L3, if AI review finds 0 blocking issues AND rework probability is low, human review becomes advisory (auto-approved). The human still receives the PR notification but doesn't block.

**What happens (AI review):**

1. AI reviewer examines:
   - PR diff against acceptance criteria
   - Scope alignment against planned files
   - Code quality, security, correctness
2. AI review output:
   - Verdict: `APPROVED` (no blocking findings)
   - 2 suggestions (non-blocking):
     - "Consider adding token rotation support for future extensibility" (suggestion)
     - "Line 45 auth.ts: error message could be more specific" (low)
   - Scope check: `CLEAN` — all changes within planned scope
3. Scope creep detection (7.3): `{ scope_creep_ratio: 0.0, verdict: "CLEAN" }`

**What happens (human review):**

4. @alice receives PR review request on GitHub
5. @alice reviews the PR, sees the AI findings
6. @alice approves: "LGTM. Good test coverage on the edge cases."
7. Gate passes

**State after Phase 7:**
```
Run run-abc: phase=awaiting_review → completed (after merge)
Gate: code_review = PASSED (ai: approved, human: approved)
PR #87: approved
```

---

## Phase 8: Merge and Completion

```
EVENT: run.phase_changed { run_id: "run-abc", phase: "completed" }
```

### Workers Invoked:

| # | Worker | Role | Operation | Mode | Duration |
|---|--------|------|-----------|------|----------|
| 8.1 | @carol | merge_approver | `gate.merge_approval` | sync | 10 min |
| 8.2 | github-ci-adapter | ci_service | `script.ci_status` | sync | 1s |
| 8.3 | pm-engine-v1 | pm_engine | `conductor_record_outcome` | async | 0.5s |
| 8.4 | pm-engine-v1 | pm_engine | `conductor_move_issue` | async | 0.2s |
| 8.5 | slack-notifier | notifier | `script.notify` | async | 0.2s |
| 8.6 | docs-claude-sonnet | documenter | `docs.update` | async (monitored) | 30s |
| 8.7 | metrics-collector | metrics | `script.metrics` | async | 1s |

**At L2:** Human merge approval required. @carol clicks "Merge" in Conductor UI (or GitHub).
**At L3:** If CI is green AND risk is medium or lower, auto-merge is enabled.

**What happens:**

1. @carol approves merge (8.1)
2. CI status verified: all checks green (8.2)
3. PR #87 merged via squash merge
4. **Post-merge async fan-out** (all fire in parallel, none blocking):
   - Outcome recorded (8.3): `{ result: "delivered", cycle_hours: 8.5, review_rounds: 1, rework_cycles: 1 }`
   - Issue moved to Done (8.4)
   - Slack notification (8.5): "Issue #42 delivered. PR #87 merged."
   - Documentation updated (8.6): README API section updated with JWT auth docs
   - Metrics collected (8.7): cycle time, token usage, cost breakdown

**Dynamic adaptation point (documentation):** The documenter is async-monitored. If it fails:
- Warning event emitted
- Run is already completed — docs failure doesn't reopen the run
- Human can manually trigger `docs.update` later
- If docs are critical (project policy `docs_required: true`), it becomes a sync stage instead

**State after Phase 8:**
```
Run run-abc: status=completed
Issue #42: Done
PR #87: merged
Branch: feature/42-jwt-auth (deleted after merge)
```

---

## Complete Worker Invocation Timeline

```
Time    Worker                    Operation                    Mode      Phase
──────  ────────────────────────  ──────────────────────────  ────────  ──────────────
0:00    pm-engine-v1              conductor_sync_from_source   sync      (pre-run)
0:02    triage-haiku              pm.triage                    sync      (pre-run)
0:05    pm-engine-v1              conductor_predict_rework     async     (pre-run)
0:05    pm-engine-v1              conductor_get_issue_deps     async     (pre-run)
0:06    slack-notifier            script.notify                async     (pre-run)
        ─── Run created ───
0:10    pm-engine-v1              conductor_suggest_approach   sync      pending
0:11    pm-engine-v1              conductor_predict_completion sync      pending
0:12    pm-engine-v1              conductor_history_insights   sync      pending
        ─── Phase: planning ───
0:15    planner-claude-opus       planning.create              sync      planning
1:45    slack-notifier            script.notify                async     planning
        ─── Phase: awaiting_plan_approval ───
2:00    @bob                      gate.plan_approval           sync      plan_approval
47:00   (approved)
        ─── Phase: executing ───
47:05   impl-claude-sonnet        implementation.execute       sync      implementing
55:05   slack-notifier            script.notify                async     implementing
        ─── Phase: quality checks (parallel) ───
55:10   vitest-worker             script.test                  parallel  testing
55:10   eslint-worker             script.lint                  parallel  testing
55:10   tsc-worker                script.typecheck             parallel  testing
55:10   semgrep-worker            script.security_scan         parallel  testing
55:10   prettier-worker           script.format                parallel  testing
55:35   (group failed — security finding)
        ─── Fix cycle ───
55:40   impl-claude-sonnet        implementation.fix           sync      implementing
57:40   (re-run quality checks — all pass)
        ─── Phase: review ───
58:00   reviewer-claude-opus      review.code                  sync      reviewing
58:45   reviewer-claude-opus      review.scope                 sync      reviewing
58:55   pm-engine-v1              conductor_detect_scope_creep sync      reviewing
59:00   @alice                    review.code                  sync      reviewing
179:00  (approved)
        ─── Phase: merge ───
179:05  impl-claude-sonnet        implementation.prepare_pr    sync      (pre-merge)
179:20  github-ci-adapter         script.ci_trigger            async     (pre-merge)
179:25  @carol                    gate.merge_approval          sync      (merge gate)
189:25  (merged)
        ─── Post-completion (async fan-out) ───
189:26  pm-engine-v1              conductor_record_outcome     async     (post)
189:26  pm-engine-v1              conductor_move_issue         async     (post)
189:26  slack-notifier            script.notify                async     (post)
189:26  docs-claude-sonnet        docs.update                  async     (post)
189:26  metrics-collector         script.metrics               async     (post)
```

### Summary Statistics

| Metric | Value |
| --- | --- |
| **Total worker invocations** | 33 |
| **Unique workers** | 14 |
| **AI worker invocations** | 6 (planner x1, implementer x3, reviewer x2, documenter x1) |
| **Script worker invocations** | 13 (5 quality checks x2 runs + notifier x4 + CI + metrics) |
| **Human worker invocations** | 3 (plan approval, code review, merge approval) |
| **Service worker invocations** | 10 (PM engine x8, CI service x1) |
| **PM worker invocations** | 8 (triage, 3x intelligence, scope creep, outcome, move, 1x implicit) |
| **Sync invocations** | 18 (blocking the workflow) |
| **Async invocations** | 15 (non-blocking) |
| **Parallel groups** | 2 (quality checks x2) |
| **Total AI tokens (est)** | ~450K (planner: 100K, implementer: 200K + 50K fix, reviewer: 50K + 10K, documenter: 40K) |
| **Total cost (est)** | ~$12 (Opus planning + Sonnet implementation + Opus review) |
| **Wall clock time** | ~3.2 hours (dominated by human wait times) |
| **AI compute time** | ~12 minutes (total of all AI stages) |
| **Script compute time** | ~1.5 minutes (total of all script stages) |

---

## Dynamic Adaptation Points (Summary)

Every lifecycle run encounters dynamic conditions. Here's every adaptation point from this simulation:

| # | Phase | Condition | Adaptation |
|---|-------|-----------|------------|
| 1 | Triage | Low confidence (<0.6) | Escalate to higher-quality triage model |
| 2 | Triage | `auto_triage: 'off'` | Skip auto-triage, wait for human |
| 3 | Planning | Provider outage | Failover from Anthropic to OpenAI |
| 4 | Planning | Low risk work item | Downgrade planner from Opus to Sonnet (save cost) |
| 5 | Planning | High rework prediction (>0.5) | Add extra review steps to plan |
| 6 | Plan approval | Approver timeout (4h) | Escalate to backup approver |
| 7 | Plan approval | L3 autonomy | Auto-approve (skip human) |
| 8 | Implementation | Critical priority | Upgrade to Opus implementer |
| 9 | Implementation | Checkpoint overflow | Split into continuation task |
| 10 | Quality checks | Security finding | Block and trigger fix cycle |
| 11 | Quality checks | 3 fix attempts fail | Block run, escalate to human |
| 12 | Quality checks | `security_scan_block_threshold: high` | Medium findings don't block |
| 13 | Review | L3 + low risk + 0 blocking findings | Auto-approve (skip human review) |
| 14 | Review | Scope creep detected | Block PR, require scope cleanup |
| 15 | Merge | Budget depleted | Downgrade models for remaining work |
| 16 | Merge | L3 + green CI + low risk | Auto-merge (skip human) |
| 17 | Post-merge | Docs failure | Warning only (async stage) |
| 18 | Any phase | New model canary active | Route 10% of tasks to new variant |
| 19 | Any phase | Area-specific quality regression | Boost rank of better-performing variant |
| 20 | Any phase | Privacy policy active | Filter to local-only providers |

---

## Variant Configurations at Each Phase

For the same feature, different team configurations would use different workers:

### Solo Developer (Budget: $50/month)

```
Phase           Worker Variant              Provider    Model               Cost
────────        ────────────────────────    ────────    ─────────────────   ────
Triage          triage-script               —           heuristic           free
Planning        planner-claude-sonnet       anthropic   claude-sonnet-4-6   $$
Plan approval   (auto — L3)                —           —                   free
Implementation  impl-claude-sonnet          anthropic   claude-sonnet-4-6   $$
Quality checks  (all script workers)        —           —                   free
Review          reviewer-sonnet             anthropic   claude-sonnet-4-6   $$
Merge           (auto — L3)                —           —                   free
Documentation   (skipped)                   —           —                   free
```
**Total: ~$5 per feature | All AI from single provider**

### Enterprise Team (Budget: $2000/month)

```
Phase           Worker Variant              Provider    Model               Cost
────────        ────────────────────────    ────────    ─────────────────   ────
Triage          triage-haiku                anthropic   claude-haiku-4-5    $
Planning        planner-claude-opus         anthropic   claude-opus-4-6     $$$
Plan approval   @bob (human)                —           —                   human
Implementation  impl-claude-sonnet          anthropic   claude-sonnet-4-6   $$
Quality checks  (all script workers)        —           —                   free
Review (AI)     sec-reviewer-claude-opus    anthropic   claude-opus-4-6     $$$
Review (Human)  @alice + @dave (security)   —           —                   human
Merge           @carol (human)              —           —                   human
Documentation   docs-claude-sonnet          anthropic   claude-sonnet-4-6   $$
```
**Total: ~$25 per feature | Maximum quality, dual review**

### Air-Gapped / Privacy-Sensitive

```
Phase           Worker Variant              Provider    Model               Cost
────────        ────────────────────────    ────────    ─────────────────   ────
Triage          triage-script               —           heuristic           free
Planning        planner-local-llama         ollama      llama-3.3-70b       $ (compute)
Plan approval   @bob (human)                —           —                   human
Implementation  impl-local-deepseek         ollama      deepseek-coder-v3   $ (compute)
Quality checks  (all script workers)        —           —                   free
Review          reviewer-local-llama        ollama      llama-3.3-70b       $ (compute)
Review (Human)  @alice (human)              —           —                   human
Merge           @carol (human)              —           —                   human
Documentation   (manual)                    —           —                   human
```
**Total: ~$2 per feature (compute only) | No data leaves network**

---

## Cross-Workflow Triggers

This feature lifecycle also triggers PM workflows in the background:

| Event | PM Workflow Triggered | When |
|-------|----------------------|------|
| Issue created | **Triage Workflow** | Phase 0 (immediate) |
| Run completed | **Outcome Recording Workflow** | Phase 8 (async) |
| Sprint boundary | **Sprint Planning Workflow** | External trigger (weekly) |
| 3+ issues completed | **Retrospective Workflow** | External trigger (sprint end) |
| PR merged | **Release Notes Workflow** | External trigger (release boundary) |
| Daily cadence | **Anomaly Monitoring Workflow** | External trigger (cron) |

Each PM workflow is its own run with its own workers, independent of the dev workflow. They share data through the PM Engine's SQLite database but don't block each other.

---

## What Could Go Wrong (Failure Modes)

| Failure | Detection | Recovery | Workers Involved |
|---------|-----------|----------|------------------|
| Planner produces bad plan | Human rejects at gate | Retry planning (max 3 revisions) | planner (again), plan_approver |
| Implementer produces wrong code | Tests fail | Fix cycle (max 3 attempts) | implementer (fix), all quality checks |
| All fix attempts fail | Retry counter exhausted | Run blocked, human escalation | slack-notifier (alert), human (manual fix) |
| Provider outage mid-task | HTTP 503 / timeout | Circuit breaker → failover to next provider | (switches to different variant) |
| Budget exhausted | Cost tracker threshold | Downgrade to cheaper models or pause | (all AI variants affected) |
| Human approver unavailable | Timeout (4-24h) | Escalate to backup, or auto-approve at L3 | notifier (escalation), backup approver |
| Scope creep detected | scope_creep_ratio > 0 | Block PR, require cleanup | pm_engine (detect), implementer (split) |
| CI fails | ci_status returns failure | Retry or block | ci_service, implementer (fix) |
| Security vulnerability in code | security_scanner finding | Block at quality gate, require fix | security_scanner, implementer (fix) |
| Context window overflow | Token count exceeds limit | Checkpoint and continue in new task | implementer (continued), pm_engine (checkpoint) |
