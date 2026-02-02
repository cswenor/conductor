# MVP Scope (v0.1)

> **Implementation Specification.** This document defines what gets built for v0.1. Use this to create issues and track progress.

---

## The MVP Promise

**Select an issue in the UI. Click Start Run. A PR appears.**

Between those two moments: agents plan, review, implement, test, and propose. You approve the plan in the UI, merge the PR in GitHub.

v0.1 proves this works end-to-end. Everything else is optimization.

**Conversational boundary:** Issue Intake (PM agent) is deferred to v0.2, so v0.1 has no conversational surfaces—purely command-and-observe.

---

## Success Criteria

v0.1 is complete when all of these work:

| # | Criterion | Validation |
|---|-----------|------------|
| 1 | **Happy path completes** | Issue → Start Run → Plan → Approve → Implement → PR → Merge |
| 2 | **UI controls everything** | All operator actions happen in UI (no CLI required for operation) |
| 3 | **Plan approval gate works** | Run blocks until operator approves in UI |
| 4 | **Plan revision works** | Operator rejects with feedback, Planner revises |
| 5 | **Test retry works** | Failing tests trigger fix attempts (up to limit) |
| 6 | **Blocking works** | Failures surface in UI with explanation |
| 7 | **Cancellation works** | Cancel button stops run cleanly |
| 8 | **Two parallel runs work** | No collision between concurrent runs (max 2 per host) |
| 9 | **GitHub mirrors state** | Comments show phase transitions and decisions |

---

## Architecture Overview (v0.1)

```
┌─────────────────────────────────────────────────────────────┐
│                     Conductor Host                           │
├─────────────────────────────────────────────────────────────┤
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────┐  │
│  │   Next.js   │  │    Redis    │  │       Worker        │  │
│  │  (UI + API  │─▶│  + BullMQ   │─▶│   (Orchestrator)    │  │
│  │  + Webhooks)│  │             │  │   + Agent Runtime   │  │
│  └─────────────┘  └─────────────┘  └─────────────────────┘  │
│         │                                    │               │
│         └──────────────┬─────────────────────┘               │
│                        ▼                                     │
│  ┌───────────────────────────────────────────────────────┐  │
│  │                    SQLite Database                     │  │
│  │  projects │ repos │ runs │ events │ artifacts │ gates │  │
│  └───────────────────────────────────────────────────────┘  │
│                          │                                   │
│  ┌───────────────────────┴───────────────────────────────┐  │
│  │              Worktree & Environment Manager            │  │
│  │         worktrees │ ports │ sandboxed processes        │  │
│  └───────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│                    GitHub Integration                        │
│        webhooks │ comments │ PRs │ checks │ Projects        │
└─────────────────────────────────────────────────────────────┘
```

### Tech Stack

| Component | Technology | Notes |
|-----------|------------|-------|
| Runtime | Node.js 20+ | Three processes: Next.js, Redis, Worker |
| Language | TypeScript | Strict mode |
| Database | SQLite | Single file, WAL mode |
| Job Queue | Redis + BullMQ | Durable job processing, retries |
| UI + API | Next.js 14+ | App Router, Server Actions, API routes |
| UI Components | shadcn/ui | Tailwind, Radix primitives |
| GitHub | Octokit | GitHub App auth |
| Agents | Claude API | Anthropic SDK |

---

## Work Packages

Each work package maps to a set of issues. Dependencies are explicit.

### WP1: Project Foundation

**Goal:** Runnable system with database, job queue, foundational patterns, and basic UI shell.

| Task | Description | Output |
|------|-------------|--------|
| WP1.1 | Project scaffolding | TypeScript, ESLint, build system, monorepo structure |
| WP1.2 | Database schema | SQLite with migrations, schema versioning from day 1 |
| WP1.3 | Next.js application | App Router, API routes, health endpoint |
| WP1.4 | Redis + BullMQ setup | Job queue infrastructure, Docker Compose for local Redis |
| WP1.5 | Worker process | Standalone Node.js process consuming from queues |
| WP1.6 | Job table with leasing | Exactly-once semantics, lease expiration, idempotency keys |
| WP1.7 | Central redact() utility | Apply at all boundaries; secret pattern detection |
| WP1.8 | UI shell | shadcn/ui, routing, layout, global nav |
| WP1.9 | Dev environment | `pnpm dev` starts Next.js + Redis + Worker |

**Foundational patterns (non-negotiable for v0.1):**
- All external writes go through outbox (github_writes table)
- Jobs have leases with expiration; claim is atomic
- Events classified as facts vs decisions
- All GitHub entities keyed by node_id
- actor_id on all OperatorActions (even if "local_operator")
- redact() applied at tool logging, GitHub mirroring, webhook persistence

**Exit criteria:** `pnpm dev` starts all three processes; database initializes; job enqueue/dequeue works; redaction utility exists.

---

### WP2: GitHub Integration

**Goal:** GitHub App receives webhooks and can read/write via API with proper durability.

**Depends on:** WP1

| Task | Description | Output |
|------|-------------|--------|
| WP2.1 | GitHub App manifest | App configuration, permissions |
| WP2.2 | App installation flow | UI to install app on org |
| WP2.3 | Webhook receiver | Next.js API route, signature verification |
| WP2.4 | Webhook persistence | Store to webhook_deliveries before processing (no lost webhooks) |
| WP2.5 | Webhook event normalization | Raw webhook → job enqueue → internal event |
| WP2.6 | GitHub API client | Octokit wrapper, rate limiting |
| WP2.7 | GitHub write outbox | All writes via github_writes table, idempotency keys |
| WP2.8 | Comment posting | Post comments via outbox pattern |
| WP2.9 | PR creation | Create PR via outbox pattern |

**Key invariants:**
- Webhooks persisted before any processing (crash-safe)
- All GitHub writes go through outbox (idempotent, auditable)
- All entities keyed by node_id (not issue_number)

**Exit criteria:** Webhooks received and persisted; comments post via outbox; PR can be created via outbox.

---

### WP3: Projects & Repos (UI)

**Goal:** Operator can create projects and register repos via UI.

**Depends on:** WP1, WP2

| Task | Description | Output |
|------|-------------|--------|
| WP3.1 | Projects list screen | List projects, create project button |
| WP3.2 | Create project flow | Name, description → DB |
| WP3.3 | Project detail / tabs | Overview, Backlog, Repos, Runs, Policies tabs |
| WP3.4 | GitHub connection UI | Connect GitHub, show connected orgs |
| WP3.5 | Add repo flow | Select repos from GitHub, register |
| WP3.6 | Repo profile detection | Detect stack and test command (lint deferred) |
| WP3.7 | Repo settings UI | Edit detected settings, policies |

**Exit criteria:** Operator creates project, connects GitHub, adds repo — all in UI.

---

### WP4: Worktree & Environment Manager

**Goal:** Create isolated execution environments per run.

**Depends on:** WP1, WP3

| Task | Description | Output |
|------|-------------|--------|
| WP4.1 | Base repo cloning | Clone repo once, cache locally |
| WP4.2 | Worktree creation | `git worktree add` per run |
| WP4.3 | Branch creation | Deterministic branch naming |
| WP4.4 | Port allocation | Allocate/release ports for dev servers |
| WP4.5 | Worktree cleanup | Remove worktree on run completion |
| WP4.6 | Janitor process | Clean orphaned worktrees on startup |

**Exit criteria:** Run creates worktree + branch; cleanup removes them.

---

### WP5: Run Lifecycle & State Machine

**Goal:** Runs progress through phases; state is persisted and observable.

**Depends on:** WP1, WP3, WP4

| Task | Description | Output |
|------|-------------|--------|
| WP5.1 | Run creation | Create run record from issue (includes run_number, lineage fields) |
| WP5.2 | Phase state machine | pending → planning → awaiting_plan_approval → executing → blocked → completed/cancelled |
| WP5.3 | Event system | Persist events with sequence numbers |
| WP5.4 | Phase transition logic | Orchestrator emits `phase.transitioned` |
| WP5.5 | Run detail UI | Show run phases, timeline, current state |
| WP5.6 | Active runs list | UI list with phase chips, filters |

**Exit criteria:** Run progresses through phases; UI shows current state.

---

### WP6: Agent Runtime

**Goal:** Invoke Claude agents with context; capture output.

**Depends on:** WP1, WP4

| Task | Description | Output |
|------|-------------|--------|
| WP6.1 | Agent invocation framework | Call Claude API, handle response |
| WP6.2 | Context assembly | Issue content, relevant files, plan |
| WP6.3 | Planner agent | Generate plan from issue |
| WP6.4 | Reviewer agent | Critique plan or code |
| WP6.5 | Implementer agent | Write code following plan |
| WP6.6 | Agent output capture | Store artifacts (plan, review, code) |
| WP6.7 | Agent timeout handling | Kill after timeout, surface error |

**Exit criteria:** Planner generates plan; Implementer writes code; outputs stored.

---

### WP7: Agent Tool Shim

**Goal:** Agents have minimal, controlled access to repository files and test execution.

**Depends on:** WP4, WP6

| Task | Description | Output |
|------|-------------|--------|
| WP7.1 | Tool shim setup | Hardcoded tool surface for agents |
| WP7.2 | Filesystem tools | `read_file(path)`, `write_file(path, content)` scoped to worktree |
| WP7.3 | Test execution | `run_tests()` mapped to detected test command |
| WP7.4 | Tool invocation logging | Log all tool calls with inputs/outputs |
| WP7.5 | Policy enforcement | Block writes outside worktree |

**Blocking semantics:** Tool-level policy blocks are local (agent receives error, can adapt). Run-level blocks occur only at pre_push or when escalation triggers.

**Exit criteria:** Agent can read/write files, run commands; all logged.

---

### WP8: Gates & Approvals

**Goal:** Runs block at gates; operators approve via UI.

**Depends on:** WP5, WP6

| Task | Description | Output |
|------|-------------|--------|
| WP8.1 | Gate engine | Evaluate gates, block/pass |
| WP8.2 | Plan approval gate | Human approval required |
| WP8.3 | Tests pass gate | Run test command, check exit code |
| WP8.4 | Approvals inbox UI | List pending approvals by gate type |
| WP8.5 | Approve action | Operator approves with optional comment |
| WP8.6 | Reject action | Operator rejects with required comment |
| WP8.7 | Gate evaluation storage | Store gate results with evidence |
| WP8.8 | Policy exception actions | grant_policy_exception, deny_policy_exception for blocked runs |

**Exit criteria:** Run blocks at plan approval; operator approves in UI; run continues.

---

### WP9: GitHub Mirroring

**Goal:** Key state transitions appear as GitHub comments.

**Depends on:** WP2, WP5, WP8

| Task | Description | Output |
|------|-------------|--------|
| WP9.1 | Comment format | Structured header + body + details |
| WP9.2 | Phase transition comments | Post on phase change |
| WP9.3 | Plan artifact comment | Post plan for visibility |
| WP9.4 | Approval mirroring | Post operator decision to issue |
| WP9.5 | Failure comments | Post failure with context |
| WP9.6 | Rate limiting | Max 1 comment/30s per run |
| WP9.7 | Comment redaction | Redact sensitive content per policy before mirroring |

**Note:** GitHub is authoritative for collaboration artifacts (issues, PRs, comments). GitHub Projects is optional dashboard only—never authoritative for run state. Conductor DB is authoritative for run state.

**Exit criteria:** GitHub issue shows run narrative; decisions are auditable.

---

### WP10: PR Flow

**Goal:** Completed implementation becomes a PR.

**Depends on:** WP2, WP5, WP6

| Task | Description | Output |
|------|-------------|--------|
| WP10.1 | Commit changes | Commit to run branch |
| WP10.2 | Push branch | Push to GitHub |
| WP10.3 | Create PR | PR with title, body, linked issue |
| WP10.4 | PR state tracking | Detect merge via webhook |
| WP10.5 | Run completion | Mark run completed on merge |
| WP10.6 | Cleanup trigger | Cleanup worktree after completion |

**Exit criteria:** Code committed, pushed, PR created; merge completes run.

---

### WP11: Error Handling & Retry

**Goal:** Failures are visible; retries are bounded.

**Depends on:** WP5, WP6, WP8

| Task | Description | Output |
|------|-------------|--------|
| WP11.1 | Agent failure handling | Capture error, transition to blocked (single blocking reason) |
| WP11.2 | Test failure retry | Retry up to N times |
| WP11.3 | Blocked state UI | Show why blocked (blocked_reason), what's needed (blocked_context) |
| WP11.4 | Retry action | Operator retries from blocked |
| WP11.5 | Cancel action | Operator cancels run |
| WP11.6 | Force cancel | Kill sandbox if cancel stuck |

**Invariant:** A blocked run records exactly one blocking reason; resolution clears the blocked state before further progress. Multiple simultaneous failure conditions are queued, not stacked.

**Exit criteria:** Failures block with explanation; retry/cancel work from UI.

---

### WP12: End-to-End Validation

**Goal:** Complete flow works; ready for demo.

**Depends on:** All previous WPs

| Task | Description | Output |
|------|-------------|--------|
| WP12.1 | Happy path test | Manual test of full flow |
| WP12.2 | Plan rejection test | Reject → revise → approve |
| WP12.3 | Test failure test | Fail → retry → pass |
| WP12.4 | Parallel runs test | Two runs simultaneously |
| WP12.5 | Demo script | Documented demo scenario |
| WP12.6 | Known issues doc | List of known limitations |

**Exit criteria:** Demo works reliably; limitations documented.

---

## Dependency Graph

```
WP1 (Foundation)
 │
 ├── WP2 (GitHub Integration)
 │    │
 │    └── WP9 (GitHub Mirroring) ────┐
 │                                    │
 ├── WP3 (Projects & Repos UI) ──────┤
 │    │                               │
 │    └── WP4 (Worktree Manager) ────┤
 │         │                          │
 │         └── WP7 (MCP Tools) ──────┤
 │                                    │
 └── WP5 (Run Lifecycle) ────────────┤
      │                               │
      ├── WP6 (Agent Runtime) ───────┤
      │    │                          │
      │    └── WP10 (PR Flow) ───────┤
      │                               │
      ├── WP8 (Gates & Approvals) ───┤
      │                               │
      └── WP11 (Error Handling) ─────┤
                                      │
                                      ▼
                              WP12 (Validation)
```

---

## v0.1 Simplifications (Intentional)

These constraints exist to keep v0.1 shippable:

| Constraint | Rationale |
|------------|-----------|
| Agent tool access limited to file read/write and test execution | Avoid MCP complexity; prove core loop first |
| No arbitrary shell access outside test commands | Security boundary; defer generalized sandbox |
| Only one blocking reason may exist at a time | Clear UX; unambiguous retry semantics |
| Repo profile detection limited to test command inference | Lint gate not required for MVP promise |
| Max 2 concurrent runs per host | Avoid resource exhaustion; defer scheduler |

These are **not bugs**—they are intentional scope locks. See [ROADMAP.md](ROADMAP.md) for expansion plans.

---

## What's NOT in v0.1

### Deferred to v0.2

| Feature | Why Deferred |
|---------|--------------|
| Intelligent routing | Start with defaults |
| Issue Intake (PM agent) | Core flow first |
| GitHub Projects sync | Comments are sufficient |
| Concurrent runs (10+) | Validate with 2 first |
| Webhook queue | Accept missed webhooks for now |
| Remote deployment | Local mode only |

### Deferred to v0.3+

| Feature | Why Deferred |
|---------|--------------|
| Multi-operator auth | Single operator in v0.1 |
| Policy-gated auto-merge | Human merge only |
| Cross-repo runs | Single repo per run |
| Agent memory/learning | Fresh context is feature |
| Cost tracking | Build history first |

### Explicitly Out of Scope

| Non-Feature | Rationale |
|-------------|-----------|
| CLI as primary interface | UI-first; CLI only for host admin |
| GitLab/Bitbucket | GitHub-first |
| IDE integration | Control plane, not dev tool |
| Chat UI | Command-and-observe; Issue Intake (v0.2) is the only planned conversational surface |

---

## Known Limitations (Ship With)

These are acceptable for v0.1:

| Limitation | Mitigation |
|------------|------------|
| No retry on network errors | Operator can manually retry |
| Single concurrent run recommended | Parallel works but lightly tested |
| Basic error messages | Logs available for debugging |
| No metrics/analytics | Run history is queryable |
| Local mode only | Remote is post-MVP |

---

## Demo Scenario

```
1. Open Conductor UI → Projects
2. Create project "Demo App"
3. Connect GitHub → install app on demo-org
4. Add repo demo-org/demo-app
5. Go to Backlog tab → see issues from demo-app
6. Select issue "Add /health endpoint"
7. Click "Start Run"
8. Watch: Planning phase → plan appears
9. Review plan in Approvals inbox
10. Click "Approve"
11. Watch: Executing → tests run → PR created
12. Go to GitHub → review PR → merge
13. Run completes; worktree cleaned up
```

Total human involvement: Start, Approve, Merge.

---

## Milestones

| Milestone | Work Packages | Target |
|-----------|---------------|--------|
| **M1: Foundation** | WP1, WP2 | Week 2 |
| **M2: Projects & Repos** | WP3, WP4 | Week 4 |
| **M3: Run Engine** | WP5, WP6, WP7 | Week 7 |
| **M4: Gates & PR** | WP8, WP9, WP10 | Week 9 |
| **M5: Polish & Validate** | WP11, WP12 | Week 11 |

---

## Issue Template

When creating issues from this spec:

```markdown
## Work Package
WP{N}: {Name}

## Task
WP{N}.{M}: {Task name}

## Description
{From table above}

## Acceptance Criteria
- [ ] {Specific testable criterion}
- [ ] {Specific testable criterion}

## Dependencies
- Blocked by: #{issue}
- Blocks: #{issue}

## References
- MVP_SCOPE.md
- {Relevant design doc}
```

---

## Further Reading

- [ROADMAP.md](ROADMAP.md) — Future versions and deferred features
- [VISION.md](VISION.md) — Product philosophy
- [ARCHITECTURE.md](ARCHITECTURE.md) — System components
- [CONTROL_PLANE_UX.md](CONTROL_PLANE_UX.md) — UI specification
- [DATA_MODEL.md](DATA_MODEL.md) — Database schema
- [PROTOCOL.md](PROTOCOL.md) — State machine and events
- [ROUTING_AND_GATES.md](ROUTING_AND_GATES.md) — Gate definitions
