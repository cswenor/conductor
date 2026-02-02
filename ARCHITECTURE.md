# Conductor Architecture

## System Overview

Conductor is an external control plane that orchestrates AI agents to perform engineering work on GitHub repositories.

```
┌─────────────────────────────────────────────────────────────────┐
│                        Conductor Host                           │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────┐  │
│  │  Conductor   │  │   Agent      │  │   Worktree &         │  │
│  │  Core        │◄─┤   Runtime    │◄─┤   Environment Mgr    │  │
│  │  (Orchest.)  │  │              │  │                      │  │
│  └──────┬───────┘  └──────────────┘  └──────────────────────┘  │
│         │                                                       │
│  ┌──────┴───────┐  ┌──────────────┐  ┌──────────────────────┐  │
│  │   Database   │  │  MCP Tool    │  │   Control Plane      │  │
│  │              │  │  Layer       │  │   UI                 │  │
│  └──────────────┘  └──────────────┘  └──────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                         GitHub                                  │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────┐  │
│  │   Issues     │  │   Pull       │  │   Projects           │  │
│  │              │  │   Requests   │  │                      │  │
│  └──────────────┘  └──────────────┘  └──────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

Conductor requires no repo-local files or workflows. It does create branches, commits, and PRs as part of executing work. It observes GitHub events, makes decisions, invokes agents, and writes results back to GitHub. All orchestration state lives in Conductor's database. All collaboration state lives in GitHub.

**Integration requirements (not repo-local files):**
- GitHub App installation on org/repo (grants API permissions)
- Webhook configuration (Conductor receives events)
- Optional: CI/check configuration if using external CI

These are org/repo-level integrations, not files committed to the repository.

---

## Core Components

### Conductor Core (Orchestrator)

The central coordinator. Receives events, makes routing decisions, manages run lifecycle, enforces policies.

**Responsibilities:**
- Listen for events from two sources:
  - **GitHub**: webhooks (issue events, PR events, merge events)
  - **Conductor UI**: operator actions (start run, approve, reject, pause, cancel)
- Create and manage Runs (the unit of work)
- Decide which agents to invoke and in what order
- Enforce gates and policies
- Coordinate retries and error handling
- Emit events to GitHub (comments, checks, PR creation)
- Mirror operator decisions to GitHub as comments (audit trail)

**Does not:**
- Execute agent code directly
- Hold agent context between invocations
- Make merge decisions

### Agent Runtime

Executes AI agents (Claude, Codex, or others) in isolated contexts.

**Responsibilities:**
- Receive invocation requests from Orchestrator
- Assemble context for the agent (issue, files, history)
- Execute the agent with appropriate tools (MCP)
- Stream output back to Orchestrator
- Enforce token limits and timeouts

**Does not:**
- Decide what to do next (that's the Orchestrator)
- Persist anything between invocations
- Call GitHub APIs directly or hold GitHub credentials (GitHub writes occur via Conductor-proxied MCP tools)

**Note on streaming:** Agent Runtime streams output to Conductor UI for real-time observability. Streaming is **ephemeral**—only validated artifacts and tool invocation logs are persisted. Streaming is an observation channel, not persistent memory.

### MCP Tool Layer

Provides tools to agents via Model Context Protocol.

**Responsibilities:**
- Expose file read/write tools scoped to the Run worktree
- Expose shell execution tools (sandboxed)
- Expose **GitHub read + write tools**, implemented by Conductor as **proxied, policy-enforced operations** (comments, PR review comments, check runs, Project field updates)
- Enforce tool-level policies (no writes outside worktree, no secrets access, GitHub target scoping)
- Log all tool invocations (including GitHub writes)

**Does not:**
- Make orchestration decisions (that's the Orchestrator)
- Hold credentials directly (tools delegate to GitHub Integration)
- Persist tool state between invocations

### Worktree & Environment Manager

Creates and destroys isolated execution environments.

**Responsibilities:**
- Clone repositories (once per repo, cached)
- Create Git worktrees (one per Run)
- Create branches (one per Run)
- Allocate ports for dev servers
- Start/stop sandboxed processes
- Clean up environments when Runs complete or fail

**Does not:**
- Decide when to create environments (Orchestrator does)
- Share state between worktrees

### GitHub Integration (App)

The authenticated gateway between Conductor and GitHub.

**Responsibilities:**
- Receive webhooks (issues, PRs, comments, Projects events)
- Authenticate as a GitHub App
- Execute GitHub API operations on behalf of agents and the Orchestrator, including:
  - Posting comments and PR review comments
  - Creating/updating check runs
  - Reading issue/PR content and metadata
  - Updating GitHub Project fields
  - Creating PRs
- Enforce GitHub API rate limiting and retry/backoff behavior
- Provide a consistent, auditable interface for all GitHub writes (agent or orchestrator initiated)

GitHub writes originate from agents through MCP tools, but execution and permissioning are owned by GitHub Integration.

**GitHub Write Path (data flow):**

```
Agent → MCP Tool → Conductor Core (Policy Check) → GitHub Integration → GitHub API
         │              │                              │
         │              ├─ Validates target scope      ├─ Rate limiting
         │              ├─ Checks policy rules         ├─ Credential injection
         │              └─ Logs decision               └─ Retry/backoff
         │
         └─ Worktree-only writes (no policy check for local files)
```

**Policy decision authority:** Conductor Core is the single source of truth for policy. MCP Tool Layer enforces worktree boundaries; GitHub Integration enforces rate limits and credentials; but **business policy** (what can be written, to what targets) is decided by Core.

**Does not:**
- Decide what to do (the Orchestrator decides)
- Merge PRs (humans do that)
- Allow unconstrained agent writes (writes must pass policy)

### Control Plane UI

Web interface for configuration and observability.

**Responsibilities:**
- Display Projects, Repos, and Runs
- Configure policies, prompts, and MCP servers
- Show real-time Run progress
- Provide audit log search
- Enable bulk operations (cancel all, reprioritize)

**Does not:**
- Replace GitHub for collaboration (issues/PRs stay there)
- Execute agents
- Store its own state (reads from DB)

### Database

Persistent storage for all Conductor state.

**Responsibilities:**
- Store Projects and Repos (registration, config)
- Store Runs (lifecycle, history, artifacts)
- Store policies and prompts
- Store port allocations and worktree mappings
- Store audit logs and metrics
- Index repository content for context retrieval (derived representations only: embeddings, symbol indexes, file hashes)

**Does not:**
- Store Git history (that's in the repo)
- Store collaboration content (that's in GitHub)
- Store agent memory (agents are stateless)
- Store authoritative file content (only derived, lossy representations)

---

## State Ownership & Boundaries

This table defines what each component owns and what it must never own. Violations of this table are architectural bugs.

| Component | Owns | Never Owns |
|-----------|------|------------|
| **Conductor Core** | Run lifecycle, routing decisions, gate state | Agent context, file content, GitHub auth tokens |
| **Agent Runtime** | Current invocation context, tool call log | Anything between invocations, routing decisions |
| **MCP Tool Layer** | Tool definitions, invocation logs | File content (passes through), policy source of truth |
| **Worktree Manager** | Worktree paths, port allocations, process PIDs | Git history, branch naming strategy |
| **GitHub Integration** | Webhook delivery, API rate limits, GitHub auth tokens | Issue content (passes through), merge authority |
| **Control Plane UI** | Session state, UI preferences | Any source of truth (reads from DB) |
| **Database** | Projects, Repos, Runs, Policies, Configs, Audit logs | Git content, GitHub collaboration history |
| **GitHub** | Issues, PRs, Comments, Checks, Projects, Reviews | Run state, policies, agent configuration |
| **Filesystem** | Cloned repos, worktrees, temp artifacts | Configuration, run history, audit logs |

### Trust Boundaries

Security depends on treating each boundary correctly:

| Component | Trust Level | Boundary Role |
|-----------|-------------|---------------|
| **Agent Runtime** | **Untrusted** | Treat all agent output as hostile input |
| **Conductor Core** | Trusted | Policy enforcement, state machine authority |
| **GitHub Integration** | Trusted | Credential boundary, rate limit enforcement |
| **MCP Tool Layer** | Trusted | Policy enforcement point, audit capture |
| **Worktree Manager** | Trusted | Filesystem boundary, isolation enforcement |

**Critical Rule:** All agent-produced strings are untrusted and must be validated/sanitized before they become:
- GitHub writes (comments, PR bodies, check names)
- Shell commands (injection prevention)
- File paths (traversal prevention)
- Database values (SQL injection prevention, even with ORMs)

This is the difference between "nice architecture" and "secure system."

### Key Boundaries

**GitHub owns collaboration. Conductor owns orchestration.**
- If a human needs to see it → GitHub
- If the system needs to track it → Database

**Agents are stateless. Orchestrator tracks state.**
- Agents receive context, produce output, forget everything
- Run history, retry counts, and gate status live in the Orchestrator/DB

**Worktrees are ephemeral. Repos are cached.**
- Base repo clone persists (saves clone time)
- Worktrees are created and destroyed per Run

---

## Execution Flow

### Event Sources

The Orchestrator receives events from two sources:

| Source | Events | Examples |
|--------|--------|----------|
| **GitHub Webhooks** | Repository activity | PR merged, issue edited, check completed |
| **Conductor UI** | Operator actions | Start run, approve plan, reject, pause, cancel |

Operator actions are authoritative. GitHub webhooks are **external triggers** that inform specific state transitions.

**Webhook-Driven Transitions (exhaustive list):**

| Webhook Event | Condition | Transition |
|---------------|-----------|------------|
| `pull_request.closed` | `merged = true` | Run → `completed` |
| `pull_request.closed` | `merged = false` | Run → `cancelled` (PR closed without merge) |
| `pull_request_review` | `state = changes_requested` | Run → `executing` (address feedback) |
| `check_suite.completed` | CI failed on Run's PR | Fact recorded; Orchestrator decides retry/block |
| `issue_comment.created` | Human comment on tracked issue | Fact recorded; no automatic transition |

All other webhooks are informational (fact events). Only the Orchestrator emits decision events that mutate run state.

### Issue → Run

1. **Trigger**: Operator clicks "Start Run" in Conductor UI (selecting one or more issues)
2. **Validation**: Orchestrator checks if repo is registered, policies allow activation
3. **Run Creation**: Orchestrator creates Run record in DB (status: `pending`)
4. **Environment Setup**: Worktree Manager creates worktree, allocates ports
5. **GitHub Mirror**: Orchestrator posts "Run started" comment to issue
6. **Run Activation**: Run status → `planning`

### Planning Phase

1. **Context Assembly**: Orchestrator gathers issue content, relevant files, past PRs
2. **Planning Agent**: Agent Runtime invokes planning agent with context
3. **Plan Output**: Agent produces plan (approach, files to change, risks)
4. **Review Agent**: Agent Runtime invokes review agent to critique plan
5. **Iteration**: If review rejects, planning agent revises (up to N times)
6. **Plan Posting**: Orchestrator posts final plan to issue as comment
7. **Gate**: Run status → `awaiting_plan_approval`

### Human Approval Gate

1. **Wait**: Orchestrator pauses Run, UI shows run in "Awaiting Approval" state
2. **Notification**: Run appears in operator's Approvals Inbox
3. **Decision**: Operator clicks Approve or Reject in UI (with optional comment)
4. **DB Update**: Orchestrator records decision in DB (authoritative)
5. **GitHub Mirror**: Orchestrator posts decision + comment to issue thread
6. **Resume**: Run status → `executing` or `cancelled`

### Execution Phase

1. **Implementation Agent**: Agent Runtime invokes implementation agent
2. **Code Changes**: Agent writes code via MCP tools (scoped to worktree)
3. **Commit**: Agent commits changes to Run branch
4. **Test Execution**: **Orchestrator** initiates test command execution (via MCP tool); exit code and output captured as ground truth in DB
5. **Test Interpretation**: Tester agent produces interpretation artifact, but **Orchestrator stores the authoritative pass/fail result**
6. **Self-Review**: Review agent checks implementation against plan
7. **Iteration**: If tests fail (per Orchestrator's ground truth) or review rejects, implementation agent retries (up to N times)
8. **Completion**: Run status → `proposing`

**Why Orchestrator owns test truth:** Test results feed into gates. Gates require authoritative data, not agent interpretation. The Orchestrator captures exit codes and stores them; agents provide human-readable analysis only.

### Proposal Phase

1. **PR Creation**: Orchestrator creates PR via GitHub Integration
2. **PR Content**: Title, body, linked issue, plan summary, link to Conductor run detail
3. **Checks**: GitHub runs CI; Conductor posts check for agent work
4. **Run Status**: → `awaiting_merge`

### Human Merge Gate

1. **Wait**: Orchestrator pauses, PR awaits human review in GitHub
2. **Human Action**: Human reviews PR in GitHub, requests changes or merges
3. **If Changes Requested**: Webhook notifies Conductor, run status → `executing`, agent addresses feedback
4. **If Merged**: Webhook notifies Conductor, run status → `completed`, Worktree Manager cleans up

Note: Merge happens in GitHub (human clicks merge button). Conductor detects it via webhook.

### Failure & Recovery

- **Agent Failure**: Log error, retry up to limit, then pause for human (appears in UI)
- **Environment Failure**: Log error, attempt environment recreation, then pause
- **Policy Violation**: Immediate pause, post explanation to GitHub, await operator action in UI
- **Timeout**: Pause Run, post status, await operator decision

All failures are **loud**. Silent retries are forbidden. Failed runs appear prominently in the UI.

**"Loud" failure definition:**

| Failure Event | GitHub Mirror | UI Visibility |
|---------------|---------------|---------------|
| Initial failure (first attempt) | ✅ Posted to issue | ✅ Immediate |
| Intermediate retries (attempts 2..N-1) | ❌ UI only | ✅ Visible in Run Detail |
| Final failure (max retries exceeded) | ✅ Posted with full context | ✅ Prominent + notification |
| Policy violation | ✅ Posted immediately | ✅ Prominent |
| Timeout | ✅ Posted | ✅ Prominent |

This prevents GitHub spam while ensuring humans are always informed of blocking issues.

### Operator Override Actions

Available at any time via Conductor UI:

| Action | Effect | GitHub Mirror |
|--------|--------|---------------|
| **Pause** | Suspends run after current step | Posts "Run paused by operator" |
| **Resume** | Continues paused run | Posts "Run resumed" |
| **Cancel** | Terminates run, cleans up environment | Posts "Run cancelled" |
| **Retry** | Restarts current phase | Posts "Retrying from [phase]" |
| **Reprioritize** | Changes queue position | No comment (internal) |

---

## GitHub Write Policy (v1)

Agents are allowed to write to GitHub **only through Conductor-proxied MCP tools**. These tools enforce scope, rate limits, formatting, and attribution. This enables natural multi-agent collaboration in GitHub while preventing spam, privilege escalation, and accidental cross-target writes.

### Identity Model

v1 uses **one GitHub bot identity** (the Conductor GitHub App). Every message is **role-stamped** in the content:

- `Planner`
- `Implementer`
- `Reviewer`
- `Tester`
- `Orchestrator` (system messages)
- `Operator` (mirrored human actions)

Every message includes a `run_id`.

**Audit Attribution Rules:**
- Operator actions posted by the bot must include `Actor: @username` in the comment body and in DB
- Agent posts must include `Role` and must never claim human identity
- All GitHub writes record `actor_type` (`agent` | `operator` | `system`) in the `github_writes` table

### Allowed Write Targets

By default, agents may write only to resources associated with the current Run:

- ✅ Issue comments on the originating issue
- ✅ PR comments and PR review comments on the Run's PR
- ✅ Create/update Conductor-owned check runs for the Run
- ✅ Update Conductor-owned GitHub Project fields for the linked Project item (phase/status/run_id)

All other writes are denied unless explicitly enabled by policy:

- ❌ Create/close issues
- ❌ Edit or delete user comments
- ❌ Write to other issues or PRs
- ❌ Modify repo settings, branch protections, workflows, secrets
- ❌ Merge PRs

### Rate Limits & Anti-Spam

To keep threads readable and GitHub usable:

- **Comment rate limit:** configurable, default `1 comment / 30 seconds` per Run, burst `3`
- **Phase-based updates:** progress updates only on phase transitions; detailed logs stay in Conductor UI
- **Deduping:** repeated status updates are collapsed
- **Escalation priority:** failures, gates, and human questions bypass throttles

**Aggregation Rules (enforceable):**

| Message Type | Who May Post | When |
|--------------|--------------|------|
| Phase transition | Orchestrator only | On each phase change |
| Plan artifact | Planner agent | Once per planning cycle |
| Review findings | Reviewer agent | Once per review cycle |
| Test report | Tester agent | Once per test cycle |
| Escalation question | Any agent | When human input required |
| Final summary | Orchestrator | On Run completion |
| Failure report | Orchestrator | On blocking failure |

All other agent output routes to Conductor UI logs only. This keeps GitHub threads clean and focused on decision points.

### Message Contract

Agent messages posted to GitHub must be:

1. Human-readable summary (first line)
2. Optional details (markdown)
3. Link to Conductor Run Detail for full audit

Example header format:
`[Conductor | <Role> | run:<run_id>] <message>`

**Structured payloads are stored in DB, not GitHub comments.** GitHub comments include only:
- Stable header (role, run_id)
- Human-readable summary
- Optional `<details>` block with redacted key/value summary (never raw JSON)
- Link to Run Detail in Conductor UI

This prevents:
- Accidental secret leakage in public comments
- Versioning burden of a "public API" in comment format
- Cluttered GitHub threads

**Canonical audit data** lives in the `events` table with:
- `schema_version` (for replay compatibility)
- `event_id` (correlation)
- `payload_hash` (integrity)
- Full payload (redacted per policy)

### Write Logging & Replay

Every GitHub write is logged as a tool invocation event with:

- tool name
- target (issue/pr/check/project item)
- payload hash
- timestamp
- policy decision (allowed/denied + reason)

This enables full audit and deterministic replay.

---

## Isolation Model

Every Run operates in complete isolation from every other Run.

### Git Isolation

```
/conductor/repos/
  └── github.com/
      └── acme/
          └── webapp/              # Base clone (shared, read-only to Runs)
              ├── .git/
              └── ...

/conductor/worktrees/
  └── run-abc123/                  # Worktree for Run abc123
      ├── .git -> ../../repos/... # Linked to base repo
      └── ...                      # Working files (Run owns this)
```

- **Base clone**: Fetched once, updated periodically, never modified by Runs
- **Worktree**: Created per Run, linked to base repo, isolated working directory
- **Branch**: Created per Run (`conductor/run-abc123`), never conflicts with other Runs

The shared base clone is treated as immutable and protected by filesystem permissions; all writes occur in per-Run worktrees.

### Process Isolation

- Each Run's dev server gets dedicated ports (allocated from pool, tracked in DB)
- Agent processes run in sandboxed environments
- File writes are restricted to the Run's worktree

### Sandbox Security Posture (v1)

Shell execution operates under **deny-by-default** with explicit allowlists:

**Network Egress:**
- Default: **Denied**
- Allowlist (configurable per-project):
  - `api.github.com`, `github.com` (required)
  - `registry.npmjs.org`, `pypi.org`, etc. (package registries, opt-in)
  - Custom internal artifact storage (opt-in)
- DNS: Allowed only for allowlisted hosts
- All other outbound connections blocked

**Filesystem:**
- Worktree: Read/write
- Base clone: Read-only
- System paths: No access
- `/tmp`: Scoped per-Run (`/tmp/conductor-run-{id}/`)

**Environment:**
- No access to operator credentials or host environment
- Run-scoped variables only (injected by Orchestrator)
- Secrets: Never exposed to agents; if needed, use scoped tokens with minimal permissions

**Process Limits:**
- CPU: cgroup limit (configurable, default: 2 cores)
- Memory: cgroup limit (configurable, default: 4GB)
- Max processes: ulimit (default: 256)
- Max open files: ulimit (default: 1024)

### Resource Limits

- Token limits per agent invocation
- Time limits per agent invocation
- Retry limits per phase
- Concurrent Run limits per repo (configurable)

### Cleanup Guarantees

When a Run completes (success or failure):
1. Processes killed (dev servers, watchers)
2. Ports released back to pool
3. Worktree deleted
4. Branch optionally deleted (configurable)
5. Artifacts optionally preserved (configurable)

Cleanup is **attempted synchronously** with Run completion. If interrupted (host crash, OOM), a **Janitor process** enforces eventual cleanup.

### Janitor Process (Required)

The Janitor runs periodically (default: every 5 minutes) and enforces resource cleanup for crash recovery:

| Resource | Lease Mechanism | Janitor Action |
|----------|-----------------|----------------|
| Worktrees | `last_heartbeat` in DB | Delete worktrees with no heartbeat for > 15 minutes and Run in terminal state |
| Ports | `lease_expires_at` in DB | Release ports where lease expired and no active process |
| Processes | PID + cgroup tracking | Kill processes in orphaned cgroups (Run completed/cancelled) |
| Branches | `branch_cleanup_after` timestamp | Delete branches past retention for completed Runs |

**Invariant:** Every resource allocation writes a lease record before use. Janitor only reclaims resources with expired leases and Runs in terminal states.

---

## Deployment Model

Conductor runs identically in local and remote modes. The difference is only where the host is.

### Local Mode

```
┌─────────────────────────────────────────┐
│            Your Machine                 │
│  ┌─────────────────────────────────┐   │
│  │         Conductor                │   │
│  │  (all components in one process) │   │
│  └─────────────────────────────────┘   │
│              │                          │
│              ▼                          │
│  ┌─────────────────────────────────┐   │
│  │  SQLite DB    Local Filesystem   │   │
│  └─────────────────────────────────┘   │
└─────────────────────────────────────────┘
```

- Single binary, single process
- SQLite for persistence
- Repos clone to local disk
- Ports allocated from local range
- UI served on localhost

**Webhook Reception (Local Mode):**

| Strategy | How It Works | Trade-offs |
|----------|--------------|------------|
| `conductor tunnel` (recommended) | Secure tunnel to receive webhooks | Requires tunnel service; real-time events |
| Polling fallback | Conductor polls GitHub API periodically | Higher latency (30s-5min); rate limit aware; no tunnel dependency |

Default: Polling fallback with 60-second interval. Run `conductor tunnel` for real-time webhook delivery.

**Best for**: Solo developers, trust building, debugging

### Remote Mode

```
┌─────────────────────────────────────────┐
│           Linux Instance                │
│  ┌─────────────────────────────────┐   │
│  │         Conductor                │   │
│  │  (all components in one process) │   │
│  └─────────────────────────────────┘   │
│              │                          │
│              ▼                          │
│  ┌─────────────────────────────────┐   │
│  │  PostgreSQL   Attached Storage   │   │
│  └─────────────────────────────────┘   │
└─────────────────────────────────────────┘
```

- Same binary, same process model
- PostgreSQL for persistence (optional, SQLite still works)
- Repos clone to attached storage
- Ports allocated from configured range
- UI accessible via HTTPS

**Best for**: Teams, always-on orchestration, long-running tasks

### Host Adapter Abstraction

The only deployment-specific code lives in **Host Adapters**:

| Adapter | Responsibility |
|---------|----------------|
| `LocalHostAdapter` | Local paths, localhost URLs, SQLite defaults |
| `RemoteHostAdapter` | Cloud paths, public URLs, PostgreSQL defaults |

Orchestration logic never branches on deployment mode. If it does, that's a bug.

### Migration Path

Moving from local to remote:
1. Export DB (`conductor export`)
2. Copy repo cache (optional, can re-clone)
3. Import on remote (`conductor import`)
4. Update GitHub App webhook URL

No reconfiguration of Projects, Repos, or Policies required.

---

## Multi-Project / Multi-Repo Model

### Hierarchy

```
Conductor Instance
  └── Project (e.g., "Acme Platform")
        ├── Repo (github.com/acme/webapp)
        ├── Repo (github.com/acme/api)
        └── Repo (github.com/acme/shared-lib)
```

- **One Conductor instance** manages all your work
- **Projects** group related repos (maps to GitHub organization or logical product)
- **Repos** are registered individually (no auto-discovery)
- **Runs** belong to exactly one Repo

### Issue → Repo Mapping

An issue belongs to exactly one repo (GitHub enforces this). The Run executes in that repo's worktree.

### Cross-Repo Work (Future)

Not in v1, but the architecture supports it:
- A Run could span multiple worktrees
- Changes would be coordinated commits or linked PRs
- The Orchestrator already tracks Runs independent of repos

For now: one issue, one repo, one Run, one PR.

---

## Threat Model / Security Posture (v1)

This section makes Conductor's security stance explicit and auditable.

### Core Security Principles

1. **Agents are untrusted input.** All agent-produced strings are validated/sanitized before use in shell commands, file paths, GitHub writes, or DB queries.

2. **Deny-by-default network egress.** Sandbox blocks all outbound except explicit allowlist (GitHub API, configured package registries).

3. **Secrets never exposed to agents.** Agents cannot access operator credentials, GitHub tokens, or environment variables. If an agent needs external access, it receives a scoped, short-lived token with minimal permissions.

4. **All GitHub writes go through policy + audit.** No direct API access from agents. Every write is logged with target, payload hash, and policy decision.

5. **Diff inspection before push.** Commits are inspected for secrets, large binaries, and policy-violating patterns before push to remote.

6. **Redaction rules for logs and comments.** Sensitive patterns (API keys, tokens, passwords) are redacted from:
   - GitHub comments
   - Conductor UI logs
   - Stored artifacts (unless explicitly marked sensitive with short retention)

7. **Supply chain stance.** Dependency changes (package.json, requirements.txt, go.mod, etc.) trigger elevated review. New dependencies require explicit approval.

8. **Emergency stop capability.** Operators can:
   - Pause/Cancel any Run immediately (takes effect at safe boundary)
   - Bulk cancel all Runs in a project
   - Kill switch: disable all agent execution system-wide

### Attack Surface Summary

| Vector | Mitigation |
|--------|------------|
| Agent prompt injection | Agents are sandboxed; writes go through policy |
| Agent code execution escape | cgroup isolation, network deny-by-default, filesystem restrictions |
| Secret exfiltration via agent | No secrets exposed; network egress blocked |
| Malicious PR content | Diff inspection, human merge gate |
| Dependency confusion | Supply chain policy, elevated review |
| GitHub token theft | Tokens never exposed to agents; short-lived scoped tokens only |

---

## Non-Goals (Architectural)

These are explicit decisions, not missing features.

### No IDE Integration

Conductor is not a coding assistant in your editor. It's a background system that produces PRs. IDE integration adds coupling without proportional value.

### No Repository Mutation

Conductor does not add files to your repos (no `.conductor/`, no config files, no workflows). Configuration lives in Conductor's database. Repos stay clean.

### No Long-Lived Agent Memory

Agents do not remember previous Runs. Each invocation assembles context fresh. This is intentional:
- Reproducibility (same inputs → same behavior)
- Auditability (context is logged)
- No hidden drift

### No Autonomous Merges (By Default)

By default, Conductor never merges a PR without human action. This is a trust boundary. Policy-gated autonomous merge is supported for trusted repos, change classes, and confidence thresholds, but is never implicit and is not enabled in MVP. See [README.md](README.md) for merge policy examples.

### No Bidirectional GitHub Sync

Conductor reads from GitHub and writes to GitHub, but it doesn't try to keep its DB perfectly in sync with GitHub state. GitHub is authoritative for collaboration artifacts.

The sync model:
- **DB caches snapshots** for performance (run metadata, indexing, event logs)
- **GitHub is authoritative** for collaboration artifacts (issues, PRs, comments)
- **GitHub Projects is optional dashboard only** — never authoritative for run state
- **On-demand refresh** from GitHub when decisions depend on current state

This is intentional: eventual consistency with explicit refresh beats complex bidirectional sync.

---

## Further Reading

- [VISION.md](VISION.md) — Product vision and philosophy
- [CONTROL_PLANE_UX.md](CONTROL_PLANE_UX.md) — UI screens, operator workflows, comment mirroring
- [ISSUE_INTAKE.md](ISSUE_INTAKE.md) — PM agent and natural language issue creation
- [INTEGRATION_MODEL.md](INTEGRATION_MODEL.md) — GitHub App, Projects, permissions
- [DATA_MODEL.md](DATA_MODEL.md) — Database schema and entities
- [PROTOCOL.md](PROTOCOL.md) — Events, state machine, comment format
- [ROUTING_AND_GATES.md](ROUTING_AND_GATES.md) — Routing logic and quality gates
- [POLICIES.md](POLICIES.md) — Policy engine, enforcement points, redaction
- [DEPLOYMENT.md](DEPLOYMENT.md) — Local and remote setup
