# Integration Model

Conductor is an **external application** that operates on GitHub repositories. Repositories do not need to be modified to work with Conductor.

---

## Core Principle

**Conductor is not a repo plugin. It's a control plane.**

```
┌─────────────────────────────────────────────────────────────────┐
│                         Conductor                                │
│                                                                  │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐        │
│  │ Database │  │  Agent   │  │   MCP    │  │ Worktrees│        │
│  │          │  │ Runtime  │  │  Tools   │  │          │        │
│  └──────────┘  └──────────┘  └──────────┘  └──────────┘        │
│                                                                  │
└────────────────────────────┬────────────────────────────────────┘
                             │
                        GitHub App
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│                          GitHub                                  │
│                                                                  │
│  ┌────────────┐  ┌────────────┐  ┌────────────┐                │
│  │  Repo A    │  │  Repo B    │  │  Repo C    │                │
│  │ (unchanged)│  │ (unchanged)│  │ (unchanged)│                │
│  └────────────┘  └────────────┘  └────────────┘                │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

Repos remain normal GitHub repos. They would work fine without Conductor.

---

## GitHub Identity (Normative)

All GitHub entities are keyed by **GraphQL `node_id`** in Conductor's database.

| Identifier | Role | Example |
|------------|------|---------|
| `node_id` | Primary key in DB | `I_kwDOBm...` |
| Numeric ID | Stored for REST API compatibility | `12345678` |
| `{owner}/{repo}#{number}` | Display ID only, never primary key | `acme/webapp#42` |

**Rules:**

- Conductor never uses mutable identifiers (repo name, issue title) as keys
- If a repo transfers owners or renames, `node_id` remains stable
- `task_id` in display contexts uses `{owner}/{repo}#{number}` but internal joins use `node_id`
- All `repos`, `tasks`, `github_writes` tables use `node_id` as the stable reference

This prevents dedupe bugs when repos transfer, rename, or issues are moved between repos.

### Task Identity Rules (Normative)

| Concept | Rule |
|---------|------|
| **Task primary key** | `Task` records are keyed by **GitHub Issue `node_id`** at time of ingestion |
| **Issue transfer** | If an issue is transferred to a different repo, Conductor treats it as a **new Task** (new `node_id`) unless explicit migration is configured |
| **task_slug** | Derived from *current* `{owner}/{repo}#{number}` display form; may change after transfer/rename; **never used for joins** |
| **Repo rename** | Repo `node_id` remains stable; display names update on next sync; no data migration needed |

**Key rule:** All joins use `node_id`. Display identifiers (`owner/repo#number`, `task_slug`) are for humans and branch names only.

---

## What Conductor Owns

Everything that makes Conductor work lives **inside Conductor**, not in repositories.

| Component | Lives In | Description |
|-----------|----------|-------------|
| Database | Conductor | Projects, repos, work items, runs, history |
| Agent Rules | Conductor | System prompts, behavior policies |
| MCP Servers | Conductor | Tool definitions and implementations |
| Routing Logic | Conductor | Which agent handles what |
| Gate Policies | Conductor | Quality checks, approval requirements |
| Profiles | Conductor | Language/framework presets |
| Worktrees | Conductor | Isolated checkouts for each task |
| Port Allocations | Conductor | Dev server ports |
| UI | Conductor | Dashboard and controls |

**Repos own nothing Conductor-related.**

---

## The Integration Surface

Conductor integrates with GitHub through exactly one mechanism: **the GitHub App**.

### GitHub App Repository Permissions (Minimum Required)

| Permission | Level | Why |
|------------|-------|-----|
| Metadata | Read | Identify repo, default branch, collaborators |
| Contents | Read & write | Clone repos, create branches, push commits |
| Issues | Read & write | Read issue context, post comments |
| Pull requests | Read & write | Create PRs, post comments, read state |
| Checks | Read & write | Create Conductor check runs for agent activity |

### GitHub App Repository Permissions (Optional)

| Permission | Level | Why |
|------------|-------|-----|
| Commit statuses | Read & write | Legacy status API support (if needed) |
| Actions | Read | Read CI run logs and artifacts (if introspecting failures) |

**Notes:**
- Conductor does **not** read GitHub Actions logs by default. If enabled, Actions read permission allows Conductor to surface CI failure details to agents.
- PR review submission uses the Pull requests permission (reviews are submitted via PR endpoints, not a separate permission).

### GitHub App Organization Permissions (Optional)

| Permission | Level | Why |
|------------|-------|-----|
| Projects | Read & write | Update GitHub Projects v2 fields |

Projects v2 uses GraphQL and requires organization-level permissions. Conductor works without it.

### What Conductor Reads

| Resource | Purpose |
|----------|---------|
| Issue titles and bodies | Understand tasks |
| Issue comments | Track conversation, observe discussion |
| PR status | Monitor review state, detect merge |
| Repository contents | Provide context to agents |
| GitHub Projects | Dashboard state (optional) |
| Package files | Infer language/tooling |

**All control actions originate from Conductor UI.** GitHub is used for artifacts, discussion, and audit logging. Conductor never relies on GitHub comments, labels, or Project card moves as commands.

Conductor tracks PR lifecycle via webhooks (merge, close, review events) and reconciles with periodic polling for missed events.

### What Conductor Writes

| Resource | Purpose |
|----------|---------|
| Issue comments | Agent conversations, operator decisions (mirrored), status updates |
| Branches | Task implementations |
| Pull requests | Deliver completed work |
| Check runs | Show agent activity |
| Project fields | Reflect task phase (optional) |

Note: Agents write comments via Conductor-proxied MCP tools. Operator decisions made in Conductor UI are mirrored to GitHub as comments for auditability.

---

## Inbound Model (Normative)

Conductor receives information from GitHub through two channels with distinct authority.

### Webhooks (Primary Facts Channel)

Webhooks are the primary inbound **facts** channel. They update cached GitHub snapshots and persist inbound `Event` records. **Only the orchestrator** may apply operational state transitions by emitting `phase.transitioned` events after processing inbound events.

Conductor normalizes GitHub webhook deliveries into internal inbound events. The table below describes **normalized** inbound events, not raw GitHub webhook names (e.g., GitHub sends `pull_request` with `action: closed` and `merged: true`; Conductor normalizes this to `pr.merged`).

| Normalized Inbound Event | Effect |
|--------------------------|--------|
| `pr.merged` | Persist inbound Event; orchestrator emits `phase.transitioned → completed` if PR belongs to a run |
| `pr.closed` | Persist inbound Event; orchestrator emits `phase.transitioned → cancelled` if not merged and PR belongs to a run |
| `pr.review_submitted` | Persist inbound Event; orchestrator may emit `phase.transitioned` based on review state policy |
| `issue_comment.created` | Persist inbound Event + store comment snapshot; never creates OperatorAction |

**Key invariant:** Webhooks never directly mutate run state. They provide facts; the orchestrator decides.

**PR association (Normative):**

- A PR "belongs to a run" only if `runs.pr_node_id == pull_request.node_id`
- PR number is never used for association joins; it's display-only
- If a webhook references a PR not attached to any run, Conductor stores the Event but it does not affect run state

### Polling (Reconciliation)

Periodic polling reconciles cached state but never drives control flow directly.

| What Polling Does | What Polling Never Does |
|-------------------|------------------------|
| Updates cached PR state (review status, check status) | Creates `OperatorAction` records |
| Detects missed webhook deliveries | Directly transitions run phases |
| Refreshes issue/PR metadata | Overwrites authoritative DB state |

**Reconciliation rule:** If polling discovers a PR was merged but no webhook arrived, polling persists an inbound Event with `source: 'system'` and `payload.reconcile: true`. The orchestrator handles this Event under the same rules as webhook-sourced Events—polling never directly mutates run state.

### Idempotency

All inbound events persist as `Event` records with `idempotency_key UNIQUE`:

```
idempotency_key = {event_type}:{github_delivery_id | system_reconcile_hash}
```

Duplicate webhook deliveries and reconciliation reruns are safe—duplicates are rejected at insert.

---

## Command Surface (Normative)

**Only Conductor UI creates `OperatorAction` records. GitHub is never a command interface.**

### Enforcement Rules

| Source | Creates OperatorAction? | Effect |
|--------|------------------------|--------|
| Conductor UI button click | Yes | Drives run state |
| GitHub webhook | No | Updates cached state; persists inbound Event; orchestrator may transition phase after evaluation |
| GitHub comment (any content) | No | Captured as context only |
| GitHub label change | No | Ignored for control; may be read as metadata |
| GitHub Project card move | No | Ignored for control |

### Slash Commands Are Ignored

Even if a GitHub comment contains `/conductor start` or `/approve`, Conductor treats it as plain text. There is no comment-based command interface.

**Rationale:** A single command surface (UI) prevents ambiguity, race conditions, and audit confusion. GitHub comments are the audit trail, not a control channel.

### What Conductor Never Modifies

| Resource | Why | Read Access? |
|----------|-----|--------------|
| Repo settings (secrets, branch protections, permissions) | Not Conductor's business | No |
| Org/repo admin configuration | Too dangerous | No |
| GitHub Actions workflows (`.github/workflows/`) | Separate concern | Yes (read-only, for CI pattern inference) |
| Git history (no force push, no rebase) | Trust boundary | Yes (read-only) |

**Clarification:** Conductor may **read** workflow files as normal repo contents (to infer CI patterns), but **never modifies** them.

Conductor changes code only through normal Git operations: branches → commits → PRs. No Conductor-specific files are ever added to repositories.

---

## Zero-Config by Default

You can point Conductor at any repository and start immediately.

### How It Works

1. **Add repo via UI**
   - Open **Projects → [Your Project] → Add Repo**
   - Select repos from your connected GitHub org

2. **Conductor clones and analyzes**
   - Detects language from file extensions
   - Finds package manager from lock files
   - Discovers test command from package.json/Makefile/etc.
   - Identifies framework from config files

3. **Assigns a profile**
   - `node-pnpm`, `python-pytest`, `go-standard`, etc.
   - Profiles are built into Conductor
   - Can be overridden per-repo in Conductor's settings

4. **Ready to work**
   - No PR to the repo
   - No config files to add
   - No setup ceremony

### What Conductor Infers

| Signal | What Conductor Learns |
|--------|----------------------|
| `package.json` | Node.js, scripts available |
| `pnpm-lock.yaml` | Use pnpm |
| `go.mod` | Go project |
| `pyproject.toml` | Python project |
| `Cargo.toml` | Rust project |
| `next.config.*` | Next.js framework |
| `.github/workflows/` | Existing CI patterns |
| `Makefile` | Available make targets |

If Conductor can't infer something, it uses safe defaults and asks.

### Command Discovery Safety (Normative)

Conductor infers commands but constrains execution to prevent dangerous operations.

**Explicit allowlist per profile:**

Profiles define **explicit allowlists** per category; wildcards are not permitted.

| Profile | Allowed Scripts/Commands | Execution Method |
|---------|--------------------------|------------------|
| `node-pnpm` | `test`, `test:unit`, `test:integration`, `test:ci`, `build`, `lint` | `pnpm run <script>` |
| `python-pytest` | `pytest`, `python -m pytest`, `ruff check .`, `mypy` | Direct execution (argv) |
| `go-standard` | `go test ./...`, `go build ./...`, `golangci-lint run` | Direct execution (argv) |

**Note:** For `node-*` profiles, allowlists are defined over **package.json script names** (e.g., `test:ci`), and Conductor executes them via `pnpm run <script>` (or `npm run`, `yarn run`), not via arbitrary command strings.

**Safety rules:**

1. Inferred commands/scripts must match an explicit allowlist entry for the detected profile
2. If inference yields an unrecognized script (e.g., `test:e2e`, `deploy`), Conductor:
   - Logs a warning
   - Requires explicit operator confirmation in UI before first use
   - Stores the override in DB (not silent acceptance)
3. **Makefile targets are never executed based on name inference alone.** Targets may only be executed if the repo configuration explicitly maps a target to a safe category (test/lint/build) in Conductor settings
4. **No shell by default:** Commands are executed without a shell (argv/exec style). Any command requiring shell parsing (e.g., `sh -c ...`) requires explicit operator override
5. Shell metacharacters (`&&`, `|`, `;`, `$()`, backticks, redirects, `sudo`) are examples of patterns that trigger the "requires shell" check—this list is non-exhaustive

**No running arbitrary discovered commands.** This prevents catastrophic "make prod" or "npm run deploy" moments.

---

## Context Sources (Read-Only)

Conductor reads standard project files as context for agents. These are:
- **Read-only** — Conductor never modifies these files
- **Best-effort** — Missing files are not errors
- **No required format** — Standard project documentation, not Conductor-specific schemas

### Standard Files Conductor Reads

Conductor reads standard documentation and configuration files that exist for humans and other tools:

| File | What Conductor Learns |
|------|----------------------|
| `README.md` | Project description, setup instructions |
| `CONTRIBUTING.md` | Contribution guidelines, code standards |
| `ARCHITECTURE.md` | System design, module boundaries |
| `package.json` scripts | Available commands |
| `Makefile` targets | Available commands |
| `.gitignore` | What to exclude |
| `tsconfig.json` | TypeScript configuration |

These are standard files—not Conductor-specific. If your repo has good documentation for humans, Conductor benefits too.

---

## Configuration Lives in Conductor

All Conductor-specific configuration lives in Conductor's database and settings, not in repos.

### Per-Project Settings

```yaml
# Stored in Conductor's database
project: house-of-voi
settings:
  default_profile: node-pnpm
  required_gates:
    - tests_pass
    - human:plan_approval
  routing:
    plan_revisions: 3
    test_fix_attempts: 3
```

### Per-Repo Overrides

```yaml
# Stored in Conductor's database
project: house-of-voi
repo: house-of-voi/api
overrides:
  profile: node-pnpm
  test_command: pnpm test:ci
  sensitive_paths:
    - src/payments/
```

### Global Defaults

```yaml
# Conductor's built-in defaults
defaults:
  profiles:
    node-pnpm:
      test_command: pnpm test
      lint_command: pnpm lint
      dev_command: pnpm dev
    python-pytest:
      test_command: pytest
      lint_command: ruff check .
```

To change behavior, you change Conductor's settings — not repo files.

---

## Worktrees Are Conductor's Domain

Worktrees are checkouts that Conductor creates, uses, and destroys. Repos never know they exist.

### Worktree Location (Configurable)

Worktrees live under a **configurable workspace root**. Example layout:

```
{CONDUCTOR_WORKSPACE}/           # Configurable (default: ~/.conductor)
├── data/
│   └── conductor.db            # Database
├── worktrees/
│   └── house-of-voi/           # Project
│       ├── webapp/             # Repo
│       │   ├── run-abc123/    # Run abc123
│       │   └── run-def456/    # Run def456
│       └── api/
│           └── run-ghi789/
└── logs/
```

The workspace root is configurable via `CONDUCTOR_WORKSPACE` environment variable or config file. Paths shown are examples, not commitments.

Worktrees are named by Run ID, not issue number. One issue can have multiple runs (retries, revisions).

### Branch Naming (Normative)

Branch names follow a deterministic pattern for traceability:

```
conductor/{task_slug}/run-{run_number}-{short_run_id}
```

Example: `conductor/acme-webapp-42/run-1-abc123`

**Slug rules:**

The `task_slug` is derived from `{owner}-{repo}-{issue_number}` with normalization:
- Lowercase only
- Characters restricted to `[a-z0-9-]`
- Consecutive hyphens collapsed to single hyphen
- If resulting slug exceeds 40 characters: truncate to 32 + `-` + 7-char hash suffix

Example: `my-org/My-Really-Long-Repository-Name#42` → `my-org-my-really-long-reposit-a1b2c3d`

**Rules:**

- Branch names are **never reused** across runs
- `run_number` increments per task (1, 2, 3 for retries)
- `short_run_id` is the first 8 characters of `run_id`

**Cleanup:**

- Branches may be deleted after merge (configurable: `cleanup.delete_merged_branches`)
- PR remains as the permanent audit record
- Unmerged branches are retained for debugging (configurable retention period)

### Worktree Lifecycle

1. **Create** — When a run starts, Conductor creates a worktree and branch
2. **Use** — Agents work in the worktree
3. **Push** — Conductor pushes the branch to GitHub
4. **PR** — Conductor creates a PR
5. **Destroy** — After completion, cancellation, or failure retention window, worktree is removed

**Retention clarification:**

- Worktrees are ephemeral and may be removed after completion/cancel or after a configurable failure retention window (default: 24 hours)
- Branch retention is **independent** of worktree retention and separately configurable
- Failed runs retain worktrees temporarily to enable debugging; branches are retained longer

The repo sees: a branch appeared, a PR was opened. That's it.

---

## How This Differs from Repo-Local Tools

| Aspect | Repo-Local Tools | Conductor |
|--------|------------------|-----------|
| Config location | `.tool/config.yml` in repo | Conductor's database |
| Setup | PR to add config files | Add repo via UI |
| Rules | Per-repo | Central, with per-repo overrides |
| Updates | PR to each repo | Update Conductor once |
| Multiple repos | Configure each | One project, many repos |
| Repo cleanliness | Tool artifacts in repo | Repo stays clean |

---

## Benefits of External Model

### 1. Repos Stay Clean

No hidden directories. No config files. No Conductor artifacts. A repo that works with Conductor looks identical to one that doesn't.

### 2. Central Control

Change agent rules once, apply everywhere. No need to update 10 repos when you improve a prompt.

### 3. Consistent Behavior

Two repos in the same project behave the same way. No config drift between repos.

### 4. Easy Adoption

Point at a repo and go. No setup PR. No waiting for merge. No convincing repo owners to add files.

### 5. Easy Removal

Stop using Conductor? Nothing to clean up. The repo never knew Conductor existed.

### 6. Multi-Repo Coordination

Orchestrate across repos easily. One project, unified backlog, coordinated runs.

---

## GitHub Projects Integration (Optional)

Conductor can use GitHub Projects for visual state management.

### How It Works

1. Conductor creates (or connects to) a GitHub Project
2. Issues become cards on the board
3. Conductor updates Project fields as run state changes
4. Project provides a secondary visual dashboard

Note: Moving cards in GitHub Projects does **not** trigger Conductor actions. All control actions originate from Conductor UI.

### What's Stored Where

| Data | Location |
|------|----------|
| Task state | GitHub Project (visual) + Conductor DB (authoritative) |
| Agent conversations | GitHub Issue comments |
| Artifacts (plans, reports) | GitHub Issue comments |
| Run history | Conductor DB |
| Metrics | Conductor DB |

GitHub is the **visible surface**. Conductor's database is the **source of truth**.

### Drift Behavior (Normative)

If a human moves a card in GitHub Projects, Conductor's behavior depends on `enforce_projects` setting:

| Setting | Behavior |
|---------|----------|
| `enforce_projects: false` (default) | Conductor ignores the drift; Project may show stale state until next Conductor update |
| `enforce_projects: true` | Conductor snaps the card back to match DB state on next sync |

**Rule:** Projects are always mirror-only. Conductor never reads Project state as authoritative input. The `enforce_projects` flag only controls whether Conductor corrects drift.

---

## Security Model

### Conductor's Trust Level

Conductor is a **trusted operator tool**. It acts via a GitHub App installation with explicitly granted permissions. Conductor never requires your personal access token for normal operation.

### Agent Isolation

Agents never hold credentials directly:
- No GitHub tokens passed to LLMs
- Agents use MCP tools provided by Conductor
- Conductor mediates and enforces policy on all external actions

### Secret Protection Mechanism (Normative)

Secrets are protected at multiple layers with **severity-based** semantics:

| Layer | Mechanism |
|-------|-----------|
| **Tool args** | Policy engine scans for secret patterns; action depends on severity |
| **Tool results** | Conductor scans output before returning to agent; action depends on severity |
| **Env injection** | Secrets mounted in worktree environment, but never included in tool output logs |
| **GitHub writes** | If a write is detected to contain secrets, action depends on severity |

**Detection severity levels:**

| Severity | Trigger | Action |
|----------|---------|--------|
| `block` | High-confidence formats: GitHub tokens (`ghp_...`, `gho_...`), AWS keys with valid checksum (`AKIA...`), private keys (`-----BEGIN`) | Block execution/write; record `PolicyViolation`; require operator override |
| `warn` | Pattern-only matches: `*_KEY`, `*_SECRET`, `*_TOKEN`, `*_PASSWORD` without format validation | Log warning; redact in logs with `[REDACTED:pattern]` marker; allow execution |

**On `block` severity detection in GitHub writes:**

1. Write is blocked (not silently redacted)
2. `PolicyViolation` record created with `severity: 'blocking'`
3. Operator must explicitly override to proceed
4. If overridden, a redacted summary comment is posted with visible `[REDACTED]` markers and a reference to the violation ID

**Rationale:** Silent redaction in an audit trail system can corrupt meaning. High-confidence secrets block; pattern matches warn and redact in logs but don't block legitimate operations (e.g., docs mentioning `API_TOKEN`).

See [POLICIES.md](POLICIES.md) for full detection rules and severity classification.

### What Agents Can Access

| Resource | Access | How |
|----------|--------|-----|
| Repo code | Read | Via MCP tools |
| Worktree files | Read/Write (scoped) | Via MCP tools |
| Shell commands | Execute (sandboxed) | Via MCP tools |
| GitHub (comments, checks) | Write (policy-enforced) | Via Conductor-proxied MCP tools |
| GitHub credentials | Never | Conductor holds these |
| Secrets | Never | Not exposed to agents |

### How GitHub Writes Work

Agents can initiate GitHub writes (comments, check updates) through MCP tools. Conductor:
1. Receives the write request from the agent
2. Validates against policy (target, rate limits, content)
3. Computes `idempotency_key` and creates `GitHubWrite` record
4. Executes via GitHub API using Conductor's credentials
5. Updates `GitHubWrite` with result (`github_url`, `github_id`)

Agents experience "I can post to GitHub." In reality, Conductor is the policy-enforcing proxy.

**Idempotency key composition (Normative):**

```
idempotency_key = sha256(run_id + target_node_id + write_kind + logical_key)
```

Where `logical_key` depends on write type:

| Write Kind | Logical Key |
|------------|-------------|
| `phase_comment` | `phase:{phase}:seq:{sequence}` |
| `artifact_comment` | `artifact:{type}:{version}` |
| `operator_mirror` | `action:{operator_action_id}` |
| `check_run` | `check:{phase}:{attempt}` |

This ensures retries are safe and semantically identical writes dedupe correctly.

### GitHub Write Guarantees (Normative)

| Guarantee | Mechanism |
|-----------|-----------|
| **Idempotent** | All writes go through `GitHubWrite` with `idempotency_key UNIQUE` |
| **Retryable** | Worker retries are safe; duplicates rejected at DB level |
| **Append-only** | Conductor never edits or deletes its own comments |
| **Auditable** | Every write is logged with payload hash, timestamp, and policy decision |

**Append-only rule:** Conductor's GitHub comments are permanent audit records. To "update" status, Conductor posts a new comment rather than editing. This ensures the audit trail cannot be rewritten.

### What Only Conductor Core Does

| Action | Why Conductor Core |
|--------|-------------------|
| Hold GitHub credentials | Security boundary |
| Push branches | Requires auth |
| Create PRs | Orchestrator decision |
| Update Project fields | Orchestrator decision |
| Execute policy decisions | Authority boundary |

---

## Summary

| Question | Answer |
|----------|--------|
| Does Conductor add files to repos? | No |
| Does Conductor require repo setup? | No |
| Where do rules live? | In Conductor |
| Where do worktrees live? | In Conductor |
| How does Conductor access repos? | GitHub App |
| Can I use Conductor without modifying repos? | Yes |
| Can repos provide hints? | Optionally, via standard files |

**Conductor is infrastructure that operates on repos, not a plugin that lives in them.**

---

## Further Reading

- [VISION.md](VISION.md) — What Conductor is and why
- [PROJECTS.md](PROJECTS.md) — Multi-tenant project model
- [DATA_MODEL.md](DATA_MODEL.md) — Database schema (node_id references, GitHubWrite)
- [PROTOCOL.md](PROTOCOL.md) — State machine, events, idempotency
- [POLICIES.md](POLICIES.md) — Policy engine, redaction strategy
- [DEPLOYMENT.md](DEPLOYMENT.md) — Local and remote deployment
- [ARCHITECTURE.md](ARCHITECTURE.md) — System components
