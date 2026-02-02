# Projects

Conductor is **multi-tenant by design**. A Project is the unit of organization that contains repositories, work items, and runs.

---

## Core Hierarchy

```
Conductor Instance
└── Project (e.g., "House of Voi")
    ├── Repo: house-of-voi/webapp
    ├── Repo: house-of-voi/api
    └── Repo: house-of-voi/shared
        │
        └── Work Items (Issues across repos)
            └── Runs (Execution attempts)
                └── Worktrees (Isolated environments)
```

### Definitions

| Entity | Description |
|--------|-------------|
| **Conductor Instance** | The control plane: UI, orchestrator, database, runners |
| **Project** | A workspace containing repos, policies, and a unified backlog |
| **Repo** | A GitHub repository attached to a Project |
| **Work Item** | A GitHub Issue (or PR) that Conductor can work on |
| **Run** | A concrete execution attempt against a work item |
| **Worktree** | An isolated environment for a run (branch, files, ports) |

---

## What is a Project?

A Project is:

- **One unified backlog** across multiple repos
- **One set of policies** (with per-repo overrides)
- **One dashboard** to see all work
- **One "Start" button** to begin runs

A Project maps to **one GitHub organization + one GitHub Project (v2)**:

```
Project: "House of Voi"
├── GitHub Org: house-of-voi
├── GitHub Project: "Development" (the board)
├── Repos: webapp, api, shared, mobile
└── Policies: house-of-voi defaults + repo overrides
```

### Mono-Repo vs Multi-Repo

| Mode | Repos | Use Case |
|------|-------|----------|
| **Mono-Repo** | 1 | Single codebase, all code in one repo |
| **Multi-Repo** | N | Microservices, separate frontend/backend, shared libraries |

Conductor handles both. The difference is configuration, not capability.

---

## Project Lifecycle

### 1. Create Project

In Conductor UI → **Projects → Create Project**:
- Name the project (e.g., "House of Voi")
- Link to a GitHub organization
- Optionally connect a GitHub Project board

### 2. Add Repos

In Conductor UI → **Projects → [Your Project] → Add Repo**:
- Select repos from the connected GitHub org
- Multi-select supported

Each repo is analyzed and registered:
- Profile detected (language, framework, test commands)
- Configuration stored in Conductor's database
- No changes made to the repository itself

### 3. Configure Policies

All policies are stored in Conductor's database and managed via UI:

Project-level policies:
```yaml
# Project: House of Voi (stored in Conductor DB)
policies:
  default_profile: node-pnpm
  required_gates:
    - tests_pass
    - human:plan_approval
  protected_paths:
    - ".github/workflows/**"
```

Repo-level overrides (also stored in Conductor DB):
```yaml
# Repo: house-of-voi/api (stored in Conductor DB)
policies:
  # Inherits from project, adds:
  sensitive_paths:
    - "src/payments/**"
```

### 4. Work

Issues across all repos appear in the unified backlog. Select issues, start runs, approve plans, merge PRs.

---

## The Unified Backlog

A Project has **one backlog** that aggregates issues from all attached repos.

### How It Works

1. **Conductor's database** is the source of truth for run state and work item status
2. **Conductor syncs** issues from GitHub into its database
3. **UI shows** issues from all repos in one view
4. **GitHub Project board** is a mirror for visibility (Conductor → GitHub sync)
5. **Filters** let you slice by repo, label, status, priority

### Backlog Sources

| Source | How It Gets There |
|--------|-------------------|
| Issues in attached repos | Sync from GitHub |
| Items added to GitHub Project | Sync from GitHub |
| Items created in Conductor UI | Created in GitHub, synced back |

### Work Item States

| State | Meaning | Where Visible |
|-------|---------|---------------|
| **Available** | In backlog, not started | Project board: Inbox |
| **Planning** | Agents negotiating | Project board: Planning |
| **Awaiting Approval** | Plan ready for human | Project board: Awaiting Approval |
| **In Progress** | Implementation underway | Project board: In Progress |
| **In Review** | PR open | Project board: In Review |
| **Done** | Merged | Project board: Done |
| **Blocked** | Needs intervention | Project board: Blocked |

---

## Policy Inheritance

Policies cascade from general to specific:

```
Conductor Defaults
    ↓
Project Policies (in Conductor DB)
    ↓
Repo Policies (in Conductor DB)
    ↓
Run Overrides (one-off constraints)
```

### Resolution Rules

1. **More specific wins** — Repo policy overrides Project policy
2. **Additive for lists** — Protected paths combine, not replace
3. **Override for values** — Time budgets replace, not merge
4. **Explicit disable** — Can explicitly disable inherited policies

### Example

**Project policy:**
```yaml
gates:
  automatic:
    tests_pass:
      required: true
      retry_limit: 3
```

**Repo override:**
```yaml
gates:
  automatic:
    tests_pass:
      retry_limit: 5  # Override: more retries for flaky tests
```

**Effective policy for repo:**
```yaml
gates:
  automatic:
    tests_pass:
      required: true   # Inherited
      retry_limit: 5   # Overridden
```

---

## Multi-Repo Orchestration

### Single-Repo Work Items (Default)

Most work items are single-repo:
- Issue in `webapp` repo → Run in `webapp` worktree
- Changes only affect `webapp`
- PR opens in `webapp`

### Cross-Repo Work Items (Advanced)

Some work spans repos:
- "Add user authentication" affects `api` + `webapp` + `shared`
- Changes must coordinate
- Multiple PRs, sequenced

**How Conductor handles this:**

1. **Epic Issue** — Create issue in a "control repo" or as a GitHub Project item
2. **Decomposition** — Planner agent breaks into sub-tasks per repo
3. **Child Issues** — Conductor creates issues in each affected repo
4. **Dependency Graph** — Define ordering (api before webapp)
5. **Coordinated Runs** — Execute in order, gate on dependencies

```
Epic: "Add user authentication"
├── api: "Add auth endpoints" (run first)
│   └── PR: api#42
├── shared: "Add auth types" (run in parallel with api)
│   └── PR: shared#15
└── webapp: "Add login UI" (run after api + shared)
    └── PR: webapp#78
```

### Cross-Repo Context

When working on `webapp`, agents may need to read `api`:

```yaml
# Stored in Conductor DB for house-of-voi/webapp
context:
  cross_repo:
    - repo: house-of-voi/api
      paths:
        - src/routes/auth/**
        - src/types/**
      reason: "Need API contract for frontend"
```

This is configured in Conductor's UI or database. Conductor clones/fetches the other repo and includes specified paths in agent context.

---

## Worktree Management

### Namespacing

Worktrees are namespaced by project and repo:

```
~/conductor/
└── worktrees/
    └── house-of-voi/           # Project
        ├── webapp/             # Repo
        │   ├── 42-add-auth/   # Issue #42
        │   └── 45-fix-nav/    # Issue #45
        └── api/                # Repo
            └── 38-auth-endpoints/
```

### Branch Naming

Branches include project context:

```
conductor/hov/42-add-user-auth
         └─┬─┘
      project key
```

### Port Allocation

Ports are leased per-project to avoid collisions:

| Project | Port Range |
|---------|------------|
| house-of-voi | 3000-3499 |
| my-palate | 3500-3999 |

Within a project, ports are allocated per-worktree:

```
house-of-voi/webapp/42 → port 3000
house-of-voi/webapp/45 → port 3001
house-of-voi/api/38 → port 3002
```

---

## UI: How Projects Feel

### Projects List

```
┌─────────────────────────────────────────────────────────────┐
│ My Projects                                                  │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  ┌──────────────────┐  ┌──────────────────┐                │
│  │ House of Voi     │  │ My Palate        │                │
│  │ 4 repos          │  │ 2 repos          │                │
│  │ 12 active runs   │  │ 3 active runs    │                │
│  │ 2 awaiting you   │  │ 0 awaiting you   │                │
│  └──────────────────┘  └──────────────────┘                │
│                                                              │
│  + Create Project                                           │
└─────────────────────────────────────────────────────────────┘
```

### Project Dashboard

```
┌─────────────────────────────────────────────────────────────┐
│ House of Voi                                                 │
├─────────────────────────────────────────────────────────────┤
│ Repos: webapp │ api │ shared │ mobile                       │
│ Filter: [All repos ▼] [All labels ▼] [Status ▼]            │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│ ☐ #42 Add user authentication        webapp    Planning     │
│ ☐ #38 Auth API endpoints             api       In Progress  │
│ ☑ #45 Fix navigation bug             webapp    Awaiting You │
│ ☐ #15 Shared auth types              shared    In Progress  │
│ ☐ #67 Update dependencies            mobile    Available    │
│                                                              │
│ [Start Selected Runs]                                       │
├─────────────────────────────────────────────────────────────┤
│ Active Runs: 4    │  Awaiting You: 1   │  Done Today: 3    │
└─────────────────────────────────────────────────────────────┘
```

### Unified Actions

From the dashboard, you can:
- **Select issues** across any repo
- **Start runs** with one click
- **View all runs** in one list
- **Configure policies** at project or repo level

---

## GitHub Integration

### One GitHub Project per Conductor Project

The GitHub Project board is the **shared control surface**:

| GitHub Project Column | Conductor State |
|----------------------|-----------------|
| Inbox | Available |
| Planning | Planning |
| Awaiting Approval | Awaiting Approval |
| In Progress | In Progress |
| In Review | In Review |
| Done | Done |
| Blocked | Blocked |

### Sync Behavior

**Conductor's database is authoritative for run state.** GitHub mirrors state for visibility.

**GitHub → Conductor (issue sync):**
- New issues in repos → appear in Conductor backlog
- Issue updates (title, body, labels) → sync to Conductor

**Conductor → GitHub (state mirror):**
- Run started → move card to Planning, post comment
- Plan ready → move card to Awaiting Approval, post comment
- PR created → move card to In Review
- All events → post as comments for audit trail

**Note:** Column changes in GitHub Projects do NOT update Conductor state. Control actions must originate from Conductor UI.

### Multi-Repo in One Board

GitHub Projects (v2) can include items from multiple repos. Conductor leverages this:

```
GitHub Project: "House of Voi Development"
├── webapp#42 (Add auth)
├── api#38 (Auth endpoints)
├── shared#15 (Auth types)
└── mobile#67 (Update deps)
```

One board, multiple repos, unified view.

---

## Configuration

### Project-Level Config

Stored in Conductor database (not in repos):

```yaml
# Project: House of Voi
id: hov
name: "House of Voi"
github:
  org: house-of-voi
  project: "Development"  # GitHub Project name or ID

defaults:
  profile: node-pnpm
  base_branch: main

policies:
  required_gates:
    - tests_pass
    - human:plan_approval
    - human:pr_merge
  protected_paths:
    - ".github/workflows/**"

port_range:
  start: 3000
  end: 3499

repos:
  - owner: house-of-voi
    name: webapp
    profile: nextjs
  - owner: house-of-voi
    name: api
    profile: node-pnpm
  - owner: house-of-voi
    name: shared
    profile: node-pnpm
```

### Repo-Level Config

Stored in Conductor's database (no files in the repo):

```yaml
# Inherits from project, customizes for this repo
# Stored in Conductor DB, editable via UI
profile: nextjs

# Repo-specific overrides
dev_server:
  port: 3000  # This repo's preferred port

policies:
  sensitive_paths:
    - "src/payments/**"  # Extra protection for this repo
```

---

## Examples

### Example 1: Mono-Repo Project

```
Project: "Acme Monolith"
└── Repo: acme/monolith
    ├── apps/web
    ├── apps/api
    └── packages/shared
```

Configuration:
- One repo registered in Conductor
- Turborepo profile detected and stored in Conductor DB
- Worktree for each issue

### Example 2: Multi-Repo Microservices

```
Project: "House of Voi"
├── Repo: house-of-voi/webapp (Next.js frontend)
├── Repo: house-of-voi/api (Node.js API)
├── Repo: house-of-voi/shared (Shared types)
└── Repo: house-of-voi/mobile (React Native)
```

Configuration:
- Four repos registered in Conductor
- All configuration stored in Conductor DB
- Project-level policies inherited
- Cross-repo context enabled
- Unified backlog mirrored to GitHub Project

### Example 3: Cross-Repo Epic

Issue: "Add user authentication" (spans api + webapp + shared)

```
1. Create epic issue in house-of-voi/webapp#42
   (or as a GitHub Project item)

2. Conductor's Planner decomposes:
   - api: "Add auth endpoints"
   - shared: "Add auth types"
   - webapp: "Add login UI"

3. Conductor creates child issues:
   - api#38
   - shared#15

4. Runs execute with dependencies:
   - shared#15 runs first (types needed by both)
   - api#38 runs second (endpoints needed by webapp)
   - webapp#42 runs last (depends on both)

5. PRs:
   - shared#15 merges first
   - api#38 merges second
   - webapp#42 merges last
```

---

## Further Reading

- [DATA_MODEL.md](DATA_MODEL.md) — Database schema and entity relationships
- [ARCHITECTURE.md](ARCHITECTURE.md) — System components
- [ONBOARDING.md](ONBOARDING.md) — How to onboard repos to a project
