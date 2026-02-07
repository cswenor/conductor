# Control Plane UX (V2)

> This document supersedes [CONTROL_PLANE_UX.md](CONTROL_PLANE_UX.md). It is the canonical UX specification for Conductor.

---

## Part 1: Mental Model & Principles

### Conductor is a Control Tower, Not a Chat App

Conductor UI is where operators **command and monitor** automated engineering work. It is not:
- A chat interface with AI
- A GitHub wrapper
- A ticket management system

It is a **control plane** for runs — machines you start, pause, inspect, and kill.

### GitHub is an Audit Surface, Not a Control Surface

| Surface | Purpose | Operator Action |
|---------|---------|-----------------|
| **Conductor UI** | Control | Start, approve, reject, pause, cancel, configure |
| **GitHub Issues** | Audit + Context | Read the story, see agent reasoning |
| **GitHub PRs** | Deliverable | Review code, merge |
| **GitHub Projects** | Optional Dashboard | Passive view of state |

Operators never need to type commands in GitHub. Every control action has a button in Conductor.

### Runs are Machines

Think of each run as a machine with:
- **State** (planning, executing, blocked, etc.)
- **Controls** (start, pause, resume, cancel)
- **Gauges** (phase, duration, agent activity, resource usage)
- **Alarms** (failures, escalations, timeouts)

The UI surfaces these controls and gauges. GitHub shows the exhaust (comments, commits, PRs).

### Two-Layer Navigation

Conductor uses a **two-layer navigation model**:

1. **Global operator views** (left sidebar) — cross-project operational surfaces: Dashboard, Work, Approvals, Analytics
2. **Project-scoped views** (horizontal tabs) — project configuration and project-local work: Overview, Backlog, Work, Workflow, Repos, Policies, Settings

Global views answer "what needs my attention right now?" across all projects. Project views answer "what's happening in this specific project?" and "how is this project configured?"

### Core Principle

**GitHub is where work lives. Conductor UI is where work is operated.**

- **GitHub**: Issues, PRs, comments, checks = artifacts + narrative
- **Conductor UI**: Start, approve, reject, pause, cancel, configure = controls

Operators drive work through Conductor. GitHub shows the story. Every operator action is mirrored to GitHub as a comment for auditability.

---

### UX Invariants

These rules are non-negotiable. They prevent scope creep and keep the interface sharp.

#### Information Architecture Invariants

| Screen | Required Structure |
|--------|-------------------|
| Run Detail | Header → Phase Timeline → Current State Panel → Actions Bar (sticky, never scrolls) |
| Approvals Inbox | Always grouped by gate type; project/repo are filters, never grouping keys |
| Work (Active Runs) | Always sortable by phase, duration, repo; default: phase then oldest first |
| All screens | Global sidebar navigation is constant and identical |

**Actions Bar rule:** The Actions Bar on Run Detail is `position: sticky` at the bottom. Operators must **never** scroll to find Pause/Cancel/Approve.

**Conversational boundaries:**
- No free-form chat outside Issue Intake (v0.2)
- Issue Intake is the **only** planned conversational surface in Conductor; all other screens are command-and-observe

**Operator interaction:**
- No operator action requires typing commands
- Every control action has a visible button
- No slash commands, no GitHub-based control

**State visibility:**
- No hidden state; every blocked/paused run must explain why
- No "silent progress"; state transitions are always visible
- Operators never act on partial agent output — decisions operate on stable checkpoints (artifacts, gates)

**Destructive actions:**
- No destructive action without confirmation
- Destructive bulk actions require explicit "Confirm" (not just Enter)
- **No action without seeing target:** All destructive actions must show the exact affected run(s), phase(s), and repo(s) in the confirmation dialog. Prevents catastrophic "wrong tab" mistakes.

**Agent boundaries:**
- Agents propose, review, report, escalate — they never control
- Operator actions are visually distinct from agent output (different styling, iconography)
- Agents never appear as "people" in the UI

### What This UI Refuses to Do

| Refused Feature | Why |
|-----------------|-----|
| Inline code editing | Conductor operates runs, not code; use your IDE |
| GitHub settings management | Out of scope; use GitHub's UI |
| Agent configuration per-run | Agents are system-level; no per-run tuning |
| Implicit approvals | Every approval is explicit and logged |
| Real-time streaming decisions | Operators act on checkpoints, not partial output |
| Chat with agents (outside Intake) | Run Detail is observe-only; no conversation |

### Visual Consistency

#### Theme Extension

We extend shadcn's default variants with **two semantic variants** (`success`, `warning`) via CSS variables:

```css
--success: 142 76% 36%;
--success-foreground: 0 0% 100%;
--warning: 38 92% 50%;
--warning-foreground: 0 0% 0%;
```

**Variant rules:**
- Palette values defined once in theme, never inline on components
- `success` and `warning` variants added to: `Button`, `Badge`, `Alert`
- No one-off `bg-green-500` or `text-amber-600` — always use variant or token

| Semantic | Variant | When to Use |
|----------|---------|-------------|
| Critical/Error | `destructive` (shadcn default) | Failures, blocked runs |
| Warning | `warning` (theme extension) | Approaching limits, policy warnings |
| Info | `secondary` (shadcn default) | Awaiting states, neutral info |
| Success | `success` (theme extension) | Passed gates, completed runs |

#### Phase Label Mapping

| Canonical (DB/API) | UI Label | Variant | Meaning |
|--------------------|----------|---------|---------|
| `pending` | Pending | `secondary` | Run created, not yet started |
| `planning` | Planning | `secondary` | Agents negotiating plan |
| `awaiting_plan_approval` | Awaiting Approval | `secondary` | Plan ready for human |
| `executing` | Executing | `secondary` | Implementation in progress |
| `proposing` | Creating PR | `secondary` | PR being created |
| `awaiting_merge` | Ready for Merge | `success` | PR open, awaiting human merge |
| `merged` | Merged | `success` | GitHub merge observed (cleanup pending) |
| `completed` | Completed | `success` | Merge + cleanup + finalization complete |
| `blocked` | Blocked | `destructive` | Needs operator input to continue |
| `paused` | Paused | `warning` | Operator-initiated pause |
| `cancelled` | Cancelled | `secondary` | Operator-initiated termination |
| `failed` | Failed | `destructive` | Terminal failure |

Transitional states (`pausing…`, `stopping…`) use the same variant as their target phase with an animated spinner.

#### Severity Levels

| Severity | Visual | Examples |
|----------|--------|----------|
| **Critical** | Red badge, top of dashboard | System down, all runs blocked |
| **Error** | Orange indicator | Run blocked, agent failed |
| **Warning** | Yellow indicator | Run paused, approaching limits |
| **Info** | Blue indicator | Awaiting approval (normal state) |

---

## Part 2: Navigation Architecture

### Problems with the Old Model

The v1 navigation (`Project Switcher + Projects | Runs | Approvals`) had several issues:

1. **Projects/Runs/Approvals as siblings** — Projects are an environment concept (setup, configuration); Runs and Approvals are operational concepts (what's happening, what needs me). Mixing them at the same level creates confusion.
2. **Two competing nav systems** — The top-level tabs AND the project detail tabs both contained "Runs", creating ambiguity about which one to use.
3. **No attention concept** — No dedicated landing page that shows "what needs me right now?" across all projects. Operators had to check Runs and Approvals separately.
4. **No analytics** — No way to see trends, success rates, or cycle times.
5. **No workflow surface** — The pipeline contract (what happens when you click Start) was invisible in the UI.

### Global Left Navigation (Sidebar)

```
┌──────────────────┐
│  Conductor Core   │
│                   │
│  Dashboard    ◻   │  ← LayoutDashboard icon
│  Work         ◻   │  ← Play icon
│  Approvals    ◻ 3 │  ← CheckCircle icon + badge
│  Projects     ◻   │  ← FolderKanban icon
│  Analytics    ◻   │  ← BarChart3 icon
│                   │
│  ─────────────    │
│  Settings     ◻   │  ← Settings icon (separated)
│                   │
│  ┌─────────────┐  │
│  │ avatar  name│  │  ← UserMenu (sign out only)
│  └─────────────┘  │
└──────────────────┘
```

| Item | Route | Icon | Notes |
|------|-------|------|-------|
| Dashboard | `/dashboard` | `LayoutDashboard` | Mission control landing |
| Work | `/work` | `Play` | All runs, intent-driven tabs |
| Approvals | `/approvals` | `CheckCircle` | Pending decisions, badge with count |
| Projects | `/projects` | `FolderKanban` | Project list + create |
| Analytics | `/analytics` | `BarChart3` | Cross-project insights |
| Settings | `/settings` | `Settings` | Global config, separated by divider |

**Settings** is visually separated from the main nav items by a divider. It is not a primary operational surface — it's plumbing.

**UserMenu** retains avatar display and sign out only. Settings link moves to the sidebar.

### Project Sub-Navigation (Horizontal Tabs)

When viewing a project at `/projects/[id]`, horizontal tabs appear:

```
Overview | Backlog | Work | Workflow | Repos | Policies | Settings
```

| Tab | Content | Notes |
|-----|---------|-------|
| Overview | Operational dashboard | Active work, blocked items, health |
| Backlog | Issues from connected repos | Start Run from here |
| Work | Project-scoped runs | Same as global Work, auto-filtered |
| Workflow | Pipeline contract | Visual pipeline, step configuration |
| Repos | Connected repositories | Add/configure repos |
| Policies | Enforced constraints | Sensitive paths, gate requirements |
| Settings | Project plumbing | GitHub org, installation, danger zone |

**Workflow vs Policies distinction:**
- **Workflow** = expected flow, the contract between human and machine. "What happens when I click Start? Where does it pause? When do I get asked?"
- **Policies** = enforced constraints, hard stops. "What is forbidden? What's the blast radius limit?"

### Root Landing

```
/ → redirect → /dashboard
```

On login, Conductor opens the Dashboard. If no projects exist, the Dashboard shows an onboarding state directing to `/projects`.

### Route Mapping

| Current Route | New Route | Notes |
|---------------|-----------|-------|
| `/` | `/dashboard` | Root redirect changed |
| `/projects` | `/projects` | Unchanged |
| `/projects/new` | `/projects/new` | Unchanged |
| `/projects/[id]` | `/projects/[id]` | Tabs restructured |
| `/projects/[id]/repos/add` | `/projects/[id]/repos/add` | Unchanged |
| `/projects/[id]/repos/[repoId]` | `/projects/[id]/repos/[repoId]` | Unchanged |
| `/runs` | `/work` | Redirect for backward compat |
| `/runs/[id]` | `/runs/[id]` | Unchanged (deep-link target) |
| `/approvals` | `/approvals` | Unchanged |
| `/settings` | `/settings` | Unchanged (now in sidebar) |
| — | `/dashboard` | **New** |
| — | `/work` | **New** (replaces `/runs`) |
| — | `/analytics` | **New** |

### App Shell Wireframe

```
┌──────────────────┬────────────────────────────────────────────────────┐
│                  │  Page Header                              [Action] │
│  Conductor Core  ├────────────────────────────────────────────────────┤
│                  │                                                    │
│  Dashboard       │  (page content)                                    │
│  Work            │                                                    │
│  Approvals [3]   │                                                    │
│  Projects        │                                                    │
│  Analytics       │                                                    │
│                  │                                                    │
│  ─────────────   │                                                    │
│  Settings        │                                                    │
│                  │                                                    │
│  ┌────────────┐  │                                                    │
│  │ @user      │  │                                                    │
│  └────────────┘  │                                                    │
└──────────────────┴────────────────────────────────────────────────────┘
```

With project sub-nav:

```
┌──────────────────┬────────────────────────────────────────────────────┐
│                  │  Acme Platform                    [Project Settings]│
│  Conductor Core  ├────────────────────────────────────────────────────┤
│                  │  Overview │ Backlog │ Work │ Workflow │ Repos │ ...│
│  Dashboard       ├────────────────────────────────────────────────────┤
│  Work            │                                                    │
│  Approvals [3]   │  (tab content)                                     │
│  Projects        │                                                    │
│  Analytics       │                                                    │
│                  │                                                    │
│  ─────────────   │                                                    │
│  Settings        │                                                    │
│                  │                                                    │
│  ┌────────────┐  │                                                    │
│  │ @user      │  │                                                    │
│  └────────────┘  │                                                    │
└──────────────────┴────────────────────────────────────────────────────┘
```

---

## Part 3: Global Screens

### 3.1 Dashboard

**Route:** `/dashboard`
**Purpose:** Mission control landing — what needs your attention right now?

#### Layout

```
┌─────────────────────────────────────────────────────────┐
│ Dashboard                                                │
├──────────┬──────────┬──────────┬────────────────────────┤
│ Active   │ Blocked  │ Needs    │ Completed              │
│ Runs     │ Runs     │ You      │ Today                  │
│   12     │    2     │    3     │    7                   │
│ ◻ info   │ ◻ error  │ ◻ warn   │ ◻ success              │
├──────────┴──────────┴──────────┴────────────────────────┤
│                                                          │
│ Active Runs                              View All →      │
│ ┌────────────────────────────────────────────────────┐   │
│ │ Status  │ Task           │ Project │ Phase  │ Age  │   │
│ │ ●       │ Add auth #161  │ Acme    │ Exec.  │ 12m  │   │
│ │ ●       │ Fix bug #203   │ Acme    │ Plan.  │ 3m   │   │
│ │ ● blocked│ Refactor #89  │ Beta    │ Block. │ 1h   │   │
│ └────────────────────────────────────────────────────┘   │
│                                                          │
│ Needs Your Attention                                     │
│ ┌────────────────────────────────────────────────────┐   │
│ │ ◻ Plan Approval: "Add caching" (Acme) — 45m       │   │
│ │                          [Review]  [Quick Approve]  │   │
│ │ ◻ Escalation: "Fix auth" (Beta) — 2h              │   │
│ │                          [View Details]             │   │
│ └────────────────────────────────────────────────────┘   │
│                                                          │
│ Recently Completed                       View All →      │
│ ┌────────────────────────────────────────────────────┐   │
│ │ ✓ Add endpoint #142 (Acme)    — completed 10m ago  │   │
│ │ ✓ Update docs #155 (Beta)     — completed 1h ago   │   │
│ │ ✗ Fix parser #167 (Acme)      — cancelled 2h ago   │   │
│ └────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────┘
```

#### Stat Cards

| Card | Source | Badge Variant |
|------|--------|---------------|
| Active Runs | Count of runs where phase not in (`completed`, `cancelled`, `failed`) | `secondary` |
| Blocked Runs | Count of runs where phase = `blocked` | `destructive` |
| Needs You | Count of pending approvals | `warning` |
| Completed Today | Count of runs completed today | `success` |

#### Data Sources

| Section | API | Notes |
|---------|-----|-------|
| Stat cards | `GET /api/runs` + `GET /api/approvals/count` | Derive counts from phase field |
| Active Runs table | `GET /api/runs` | Filter: phase not in completed/cancelled/failed, limit 10 |
| Needs Your Attention | `GET /api/approvals` | Show first 3-5 items with quick actions |
| Recently Completed | `GET /api/runs?phase=completed&limit=5` | Last 5 completed/cancelled |

#### Empty State

```
┌─────────────────────────────────────────────────────────┐
│                                                          │
│          Welcome to Conductor                            │
│                                                          │
│  You don't have any projects yet.                        │
│  Create a project to start automating your work.         │
│                                                          │
│                [Create Project]                           │
│                                                          │
└─────────────────────────────────────────────────────────┘
```

If projects exist but no runs: show stat cards at 0 with "Start your first run from a project's Backlog tab."

#### Loading State

Skeleton cards (4x) + skeleton table rows (5x). Polling interval: **60 seconds**.

#### Components Used

`Card`, `Table`, `Badge`, `Button`, `Skeleton`

---

### 3.2 Work

**Route:** `/work`
**Purpose:** Intent-driven global view of all runs across projects.

This replaces the old `/runs` page. The key difference: tabs group runs by **operator intent** (what do I want to do?) rather than raw phase.

#### Tab Filters

```
[Active]  [Queued]  [Blocked]  [Completed]
```

| Tab | Phases Included | Operator Intent |
|-----|-----------------|-----------------|
| Active | `planning`, `executing`, `proposing`, `awaiting_merge`, `merged` | "What's in flight?" |
| Queued | `pending` | "What's waiting to start?" |
| Blocked | `awaiting_plan_approval`, `blocked`, `paused` | "What needs me?" |
| Completed | `completed`, `cancelled`, `failed` | "What finished?" |

#### Table Columns

| Column | Content |
|--------|---------|
| Status | Phase badge (colored) |
| Task | Issue title + `#number` |
| Project | Project name (link) |
| Repo | Repository name |
| Phase | Formatted phase label |
| Age | Time since run started |
| Action | Primary action button (context-dependent) |

**Action column:** Shows the most relevant action per row:
- Active: no action (in progress)
- Queued: no action (waiting)
- Blocked (`awaiting_plan_approval`): **Review** button
- Blocked (`blocked`): **View** button
- Completed: **View** button

#### Layout

```
┌─────────────────────────────────────────────────────────┐
│ Work                                                     │
├─────────────────────────────────────────────────────────┤
│ [Active ●12]  [Queued ●3]  [Blocked ●5]  [Completed]   │
├─────────────────────────────────────────────────────────┤
│ ☐ │ Status │ Task          │ Project │ Phase  │ Age │ ▶ │
│───┼────────┼───────────────┼─────────┼────────┼─────┼───│
│ ☐ │ ●      │ Add auth #161 │ Acme    │ Exec.  │ 12m │   │
│ ☐ │ ●      │ Fix bug #203  │ Acme    │ Plan.  │ 3m  │   │
│ ☐ │ ●      │ Update UI #45 │ Beta    │ Exec.  │ 8m  │   │
├─────────────────────────────────────────────────────────┤
│ Selected: 0                    [Pause]  [Cancel]         │
└─────────────────────────────────────────────────────────┘
```

#### Sorting & Filtering

- Default sort: phase (blocked first), then oldest first
- Sortable columns: Phase, Age, Project
- Filter: project dropdown (optional), repo dropdown (optional)

#### Bulk Actions by Tab

| Tab | Available Bulk Actions |
|-----|------------------------|
| Active | Pause, Cancel |
| Queued | Cancel |
| Blocked | Cancel (no bulk approve — use Approvals) |
| Completed | — (no actions) |

#### Relationship to Project Work Tab

The project-scoped Work tab (`/projects/[id]` → Work) uses the **identical component** with an automatic project filter applied. No separate implementation needed.

---

### 3.3 Approvals

**Route:** `/approvals`
**Purpose:** Strict inbox for decisions that block runs.

#### Grouping

Always grouped by gate type — **never** by repo, project, or time:

1. **Plan Approvals** — Plans ready for human review
2. **Escalations** — Failures that exceeded retry limits
3. **Policy Exceptions** — Actions blocked by policy

#### Per-Item Display

| Field | Content |
|-------|---------|
| Task title | Issue title + `#number` |
| Repo | Repository name |
| Project | Project name |
| Wait duration | How long this has been waiting |
| Context summary | Plan summary / error message / policy violated |

#### Layout

```
┌─────────────────────────────────────────────────────────┐
│ Approvals                           Project: [All ▼]     │
├─────────────────────────────────────────────────────────┤
│                                                          │
│ Plan Approvals (3)                                       │
│ ┌────────────────────────────────────────────────────┐   │
│ │ Add caching layer #201 — Acme / webapp — 45m       │   │
│ │ Plan: 4 files changed, 2 new files                 │   │
│ │ ┌──────────────────────────────────────────────┐   │   │
│ │ │ Add feedback (optional):                     │   │   │
│ │ │ [                                          ] │   │   │
│ │ └──────────────────────────────────────────────┘   │   │
│ │                    [Reject]  [Revise]  [Approve]   │   │
│ ├────────────────────────────────────────────────────┤   │
│ │ Fix auth flow #189 — Beta / api — 2h               │   │
│ │ Plan: 2 files changed                              │   │
│ │                    [Reject]  [Revise]  [Approve]   │   │
│ └────────────────────────────────────────────────────┘   │
│                                                          │
│ Escalations (1)                                          │
│ ┌────────────────────────────────────────────────────┐   │
│ │ Refactor parser #89 — Acme / compiler — 1h         │   │
│ │ Error: Test failures after 3 retries               │   │
│ │                    [Cancel]  [Retry with Feedback]  │   │
│ └────────────────────────────────────────────────────┘   │
│                                                          │
│ Policy Exceptions (1)                                    │
│ ┌────────────────────────────────────────────────────┐   │
│ │ Update payments #156 — Acme / webapp — 30m         │   │
│ │ Violation: Modified sensitive path src/payments/    │   │
│ │ Scope: [this_run ▼]                                │   │
│ │ Justification: [                                 ] │   │
│ │                           [Deny]  [Grant Exception]│   │
│ └────────────────────────────────────────────────────┘   │
│                                                          │
└─────────────────────────────────────────────────────────┘
```

#### Inline Actions

| Gate Type | Actions | Comment |
|-----------|---------|---------|
| Plan Approval | Approve, Revise, Reject | Optional on Approve; required on Revise/Reject |
| Escalation | Retry with Feedback, Cancel | Optional feedback text |
| Policy Exception | Grant Exception, Deny | Required justification; scope selector |

#### Policy Exception Scope Selector

```
[this_run ▼]
├── this_run      — Allow for this run only
├── this_task     — Allow for all runs on this issue
├── this_repo     — Allow for all runs in this repo
└── project_wide  — Allow for all runs in this project
```

#### Project Filter

Sticky dropdown at top right — remembers last selection across sessions. Options: "All Projects" + list of user's projects.

#### Bulk Approve Rules

Bulk approve is available **only** for Plan Approvals that meet **all** of:
1. `plan.files_changed` contains no paths matching `sensitive_paths` patterns
2. `plan.tools_requested` contains no tools in the `elevated_risk_tools` list
3. No `policy_warning` events exist for this run
4. The gate is `plan_approval` (not escalation or policy exception)
5. `plan.estimated_complexity` ≤ project's `bulk_approve_complexity_threshold` (default: `medium`)

Items that don't qualify are excluded from bulk selection.

#### Polling

Approvals badge count: **30 seconds**. Full list refresh: **30 seconds**.

#### Components Used

`Card`, `Badge`, `Button`, `Textarea`, `Select`, `Separator`

---

### 3.4 Projects

**Route:** `/projects`
**Purpose:** Environment management — create and navigate to projects.

#### Layout

```
┌─────────────────────────────────────────────────────────┐
│ Projects                              [Create Project]   │
├─────────────────────────────────────────────────────────┤
│                                                          │
│ ┌───────────────────────┐  ┌───────────────────────┐    │
│ │ Acme Platform         │  │ Beta App              │    │
│ │ acme-org              │  │ beta-org              │    │
│ │                       │  │                       │    │
│ │ Repos: 3              │  │ Repos: 1              │    │
│ │ Active Runs: 5        │  │ Active Runs: 2        │    │
│ │ ● Healthy             │  │ ● Needs Attention     │    │
│ └───────────────────────┘  └───────────────────────┘    │
│                                                          │
└─────────────────────────────────────────────────────────┘
```

#### Project Cards

| Field | Content |
|-------|---------|
| Name | Project name |
| Org | GitHub organization |
| Repos | Count of connected repos |
| Active Runs | Count of non-terminal runs |
| Health | Indicator: Healthy (green), Needs Attention (yellow), Blocked (red) |

**Health logic:**
- **Blocked** (red): Any run is in `blocked` phase
- **Needs Attention** (yellow): Any run is in `awaiting_plan_approval` for > 1 hour
- **Healthy** (green): All other states

#### Create Project Flow

1. Click **Create Project**
2. Enter project name (required)
3. Select GitHub installation (from connected orgs)
4. Click **Create**

**Onboarding guide** (when no GitHub App installed):

```
┌─────────────────────────────────────────────────────────┐
│                                                          │
│  To create a project, you need to connect GitHub first.  │
│                                                          │
│  Step 1: Install the Conductor GitHub App               │
│          [Install GitHub App]                            │
│                                                          │
│  Step 2: Create a project from your installation        │
│                                                          │
│  Step 3: Add repositories to your project               │
│                                                          │
└─────────────────────────────────────────────────────────┘
```

#### Empty State

"No projects yet. Create your first project to start automating engineering work." + **Create Project** button.

---

### 3.5 Analytics

**Route:** `/analytics`
**Purpose:** Cross-project operational insights.

#### Layout

```
┌─────────────────────────────────────────────────────────┐
│ Analytics                                                │
├──────────┬──────────┬──────────┬────────────────────────┤
│ Total    │ Success  │ Avg Cycle│ Avg Approval           │
│ Runs     │ Rate     │ Time    │ Wait                    │
│   47     │   82%    │  45m    │  28m                    │
├──────────┴──────────┴──────────┴────────────────────────┤
│                                                          │
│ Runs by Phase                                            │
│ ┌────────────────────────────────────────────────────┐   │
│ │ Completed  ████████████████████████████████  34     │   │
│ │ Executing  ████████                          8     │   │
│ │ Planning   ████                              4     │   │
│ │ Blocked    ██                                2     │   │
│ │ Cancelled  █                                 1     │   │
│ └────────────────────────────────────────────────────┘   │
│                                                          │
│ Runs by Project                                          │
│ ┌────────────────────────────────────────────────────┐   │
│ │ Acme Platform  ████████████████████████████  32    │   │
│ │ Beta App       ██████████████                15    │   │
│ └────────────────────────────────────────────────────┘   │
│                                                          │
│ Completions (Last 7 Days)                                │
│ ┌────────────────────────────────────────────────────┐   │
│ │ Mon  ████  4                                       │   │
│ │ Tue  ██████  6                                     │   │
│ │ Wed  ████████  8                                   │   │
│ │ Thu  ██████  6                                     │   │
│ │ Fri  ██████████  10                                │   │
│ │ Sat  ██  2                                         │   │
│ │ Sun  ██  2                                         │   │
│ └────────────────────────────────────────────────────┘   │
│                                                          │
└─────────────────────────────────────────────────────────┘
```

#### Summary Cards

| Card | Calculation |
|------|-------------|
| Total Runs | Count of all runs |
| Success Rate | `completed / (completed + failed + cancelled)` |
| Avg Cycle Time | `avg(completedAt - startedAt)` for completed runs |
| Avg Approval Wait | Average time runs spend in `awaiting_plan_approval` |

#### API Endpoint

**Route:** `GET /api/analytics`

```typescript
interface AnalyticsResponse {
  totalRuns: number;
  completedRuns: number;
  successRate: number;
  avgCycleTimeMs: number;
  avgApprovalWaitMs: number;
  runsByPhase: Record<string, number>;
  runsByProject: Array<{ projectId: string; projectName: string; count: number }>;
  recentCompletions: Array<{ date: string; count: number }>;  // last 7 days
}
```

#### Empty State

"No run data yet. Analytics will populate as runs complete."

#### Components Used

`Card`, `Badge`, `Skeleton`. v0.1 uses text-based bar charts (no recharts dependency needed).

---

### 3.6 Settings

**Route:** `/settings`
**Purpose:** Global system configuration. Things that make you think "should I really do this?"

#### Content

| Section | Risk Level | Content |
|---------|------------|---------|
| GitHub Connection | High | App installation status, connected orgs, webhook health |
| System Health | Info | Agent availability, queue depth, DB status |

#### What Lives Here vs Project Settings

| Setting | Location | Why |
|---------|----------|-----|
| GitHub App connection | Global Settings | System-wide, one installation |
| System health | Global Settings | Cross-project concern |
| GitHub org/installation for a project | Project → Settings | Per-project |
| Policies | Project → Policies | Per-project |
| Workflow configuration | Project → Workflow | Per-project |
| Port range, base branch | Project → Settings | Per-project |

---

## Part 4: Project Screens

### 4.1 Project → Overview

**Purpose:** Operational dashboard for a single project — what's happening right now?

#### Layout

```
┌─────────────────────────────────────────────────────────┐
│ Overview                                                 │
├──────────┬──────────┬──────────┬────────────────────────┤
│ Active   │ Blocked  │ Awaiting │ Completed              │
│ Runs     │          │ Approval │ This Week              │
│   5      │   1      │   2      │   12                   │
├──────────┴──────────┴──────────┴────────────────────────┤
│                                                          │
│ Blocked Items                            View All →      │
│ ┌────────────────────────────────────────────────────┐   │
│ │ ● Refactor parser #89 — compiler                   │   │
│ │   Error: Test failures after 3 retries             │   │
│ │                          [View] [Retry] [Cancel]   │   │
│ └────────────────────────────────────────────────────┘   │
│                                                          │
│ Awaiting Approval                        View All →      │
│ ┌────────────────────────────────────────────────────┐   │
│ │ ◻ Add caching #201 — webapp — waiting 45m          │   │
│ │ ◻ Fix auth #189 — api — waiting 2h                 │   │
│ └────────────────────────────────────────────────────┘   │
│                                                          │
│ Last Shipped PR                                          │
│ ┌────────────────────────────────────────────────────┐   │
│ │ #142 Add /health endpoint — webapp                 │   │
│ │ Merged 2 hours ago                                 │   │
│ └────────────────────────────────────────────────────┘   │
│                                                          │
│ Quick Links                                              │
│ [Go to Backlog]  [View All Work]  [Review Approvals]     │
│                                                          │
└─────────────────────────────────────────────────────────┘
```

#### Sections

| Section | Content | Action |
|---------|---------|--------|
| Stat cards | Active, Blocked, Awaiting Approval, Completed this week | Click drills to Work tab |
| Blocked Items | Runs in `blocked` phase with error summary | View, Retry, Cancel |
| Awaiting Approval | Runs in `awaiting_plan_approval` | Links to Approvals page |
| Last Shipped PR | Most recent merged PR from this project | Link to GitHub |
| Quick Links | Navigation shortcuts | Links to Backlog, Work, Approvals |

---

### 4.2 Project → Backlog

**Purpose:** Issue source — pick work to start.

#### Layout

```
┌─────────────────────────────────────────────────────────┐
│ Backlog                         [Sync Issues] Last: 5m   │
├─────────────────────────────────────────────────────────┤
│ Repo: [All ▼]  State: [Open ▼]  Label: [All ▼]  [🔍]  │
├─────────────────────────────────────────────────────────┤
│ ☐ │ #   │ Title              │ Repo    │ Labels  │ Run  │
│───┼─────┼────────────────────┼─────────┼─────────┼──────│
│ ☐ │ 203 │ Fix checkout bug   │ webapp  │ bug     │ [▶]  │
│ ☐ │ 201 │ Add caching layer  │ webapp  │ feature │ ●    │
│ ☐ │ 198 │ Update docs        │ docs    │ docs    │ [▶]  │
│ ☐ │ 195 │ Refactor auth      │ api     │ refactor│ [▶]  │
├─────────────────────────────────────────────────────────┤
│ Selected: 2                         [Start Run]          │
└─────────────────────────────────────────────────────────┘
```

#### Table Columns

| Column | Content |
|--------|---------|
| Checkbox | Multi-select for bulk Start Run |
| # | Issue number |
| Title | Issue title |
| Repo | Repository name |
| Labels | Issue labels (badges) |
| Run | Start Run button (or ● indicator if run already exists) |

#### Filters

- **Repo**: Dropdown of connected repos + "All"
- **State**: Open / Closed / All
- **Label**: Dropdown of available labels
- **Search**: Full-text search on title

#### Sync

**Sync Issues** button triggers a re-fetch from GitHub. Shows "Last synced: Xm ago" indicator.

#### Empty States

| Condition | Message | CTA |
|-----------|---------|-----|
| No repos connected | "Connect a repository to see issues." | [Go to Repos] |
| No issues found | "No issues match your filters." | Clear filters |
| Needs sync | "Issues haven't been synced yet." | [Sync Issues] |

---

### 4.3 Project → Work

**Purpose:** Project-scoped runs — identical to global Work view, auto-filtered.

Uses the same component as global Work (`/work`) with the project filter automatically applied and locked. Tab structure, columns, and bulk actions are identical.

---

### 4.4 Project → Workflow

**Purpose:** The pipeline contract — shows what happens when you click Start Run.

This is the visual representation of the run lifecycle. It answers: "What steps will my run go through? Where will it pause for me? What happens on failure?"

#### Layout

```
┌─────────────────────────────────────────────────────────┐
│ Workflow                                                 │
│ This workflow is used for all runs in this project.      │
├─────────────────────────────────────────────────────────┤
│                                                          │
│ ┌───────┐   ┌──────┐   ┌──────────┐   ┌───────────┐    │
│ │ Issue │──▶│ Plan │──▶│ Approval │──▶│ Implement │    │
│ └───────┘   └──────┘   └──────────┘   └─────┬─────┘    │
│                                              │          │
│                                              ▼          │
│                          ┌──────┐   ┌────────────┐      │
│                          │  PR  │◀──│   Tests    │      │
│                          └──┬───┘   └────────────┘      │
│                             │                            │
│                             ▼                            │
│                       ┌──────────┐                       │
│                       │ Complete │                       │
│                       └──────────┘                       │
│                                                          │
│ ● = Human gate   ○ = Automated   ◻ = Agent step         │
│                                                          │
├─────────────────────────────────────────────────────────┤
│                                                          │
│ Step: Plan Approval                              [Edit]  │
│ ┌────────────────────────────────────────────────────┐   │
│ │ Required: Yes                                      │   │
│ │ Timeout: 72 hours                                  │   │
│ │ Reminder: After 24 hours                           │   │
│ │ Auto-approve: Never                                │   │
│ │                                                    │   │
│ │ Routing rules:                                     │   │
│ │ • Small scope (< 3 files): Skip planning reviewer  │   │
│ │ • Docs-only: Simplified review                     │   │
│ │ • Sensitive paths: Force human approval             │   │
│ └────────────────────────────────────────────────────┘   │
│                                                          │
└─────────────────────────────────────────────────────────┘
```

#### Pipeline Steps

| Step | Type | Configurable Properties |
|------|------|------------------------|
| Issue | Input | — (source of the run) |
| Plan | Agent | Planner model, context sources |
| Approval | Human Gate | Required (yes/no), timeout, auto-approve rules, reminder |
| Implement | Agent | Implementer model, tool access |
| Tests | Automated Gate | Retry limit, timeout, failure escalation behavior |
| PR | Agent + System | Auto-create, review requirements |
| Complete | Terminal | Cleanup behavior |

#### Step Configuration Panel

Clicking a step in the pipeline opens a configuration panel below/to the right showing:
- Step properties (from table above)
- Routing rules that affect this step
- Override hierarchy: Base → Project overrides → Repo adjustments

#### Workflow vs Policies

| Aspect | Workflow | Policies |
|--------|----------|----------|
| Nature | Expected flow | Enforced constraints |
| Question | "What happens next?" | "What is forbidden?" |
| Example | "Plan requires approval before execution" | "Cannot modify files in src/payments/" |
| Override | Configurable per project | Exception requires justification |
| Where | Project → Workflow tab | Project → Policies tab |

#### v0.1 Scope

v0.1 shows a **read-only view** of the default pipeline. No editor yet. The pipeline visualization shows the fixed sequence from PROTOCOL.md. Configuration editing is deferred.

---

### 4.5 Project → Repos

**Purpose:** Manage connected repositories.

#### Layout

```
┌─────────────────────────────────────────────────────────┐
│ Repositories                        [Add Repository]     │
├─────────────────────────────────────────────────────────┤
│                                                          │
│ ┌────────────────────────────────────────────────────┐   │
│ │ acme-org/webapp                    ● Registered    │   │
│ │ Profile: node-pnpm │ Branch: main │ Last: 2h ago  │   │
│ ├────────────────────────────────────────────────────┤   │
│ │ acme-org/api                       ● Registered    │   │
│ │ Profile: node-pnpm │ Branch: main │ Last: 1h ago  │   │
│ ├────────────────────────────────────────────────────┤   │
│ │ acme-org/docs                      ● Registered    │   │
│ │ Profile: docs-only │ Branch: main │ Last: 3h ago  │   │
│ └────────────────────────────────────────────────────┘   │
│                                                          │
└─────────────────────────────────────────────────────────┘
```

#### Per-Repo Information

| Field | Content |
|-------|---------|
| Name | `org/repo` |
| Status | Badge: Registered, Scanning, Error |
| Profile | Detected stack profile |
| Default Branch | Branch used for worktrees |
| Last Indexed | Time since last scan |

#### Add Repository Flow

1. Click **Add Repository**
2. Select from available repos (from GitHub installation)
3. Conductor auto-detects profile (stack, test command)
4. Review detected settings
5. Click **Register**

If GitHub is not connected: prompt redirects to Settings → GitHub Connection.

#### Repo States

| State | Badge | Meaning |
|-------|-------|---------|
| `registered` | `success` | Ready for runs |
| `scanning` | `secondary` | Analyzing repo structure |
| `error` | `destructive` | Scan failed or permissions issue |

---

### 4.6 Project → Policies

**Purpose:** Enforced constraints — what is forbidden, what's the blast radius limit.

#### Content

| Section | Configuration |
|---------|---------------|
| Protected Paths | Glob patterns for sensitive files (e.g., `src/payments/**`, `**/secrets.*`) |
| Gate Requirements | Which gates are required (plan approval, tests, code review) |
| Concurrency Limits | Max concurrent runs for this project |
| Bulk Approve Threshold | Maximum complexity eligible for bulk approve |

#### Layout

```
┌─────────────────────────────────────────────────────────┐
│ Policies                                                 │
├─────────────────────────────────────────────────────────┤
│                                                          │
│ Protected Paths                              [Edit]      │
│ ┌────────────────────────────────────────────────────┐   │
│ │ src/payments/**                                    │   │
│ │ src/auth/**                                        │   │
│ │ **/secrets.*                                       │   │
│ │ .env*                                              │   │
│ └────────────────────────────────────────────────────┘   │
│                                                          │
│ Gate Requirements                            [Edit]      │
│ ┌────────────────────────────────────────────────────┐   │
│ │ Plan Approval: Required                            │   │
│ │ Tests Pass: Required                               │   │
│ │ Code Review: Required (3 max rounds)               │   │
│ │ Human Merge: Required (always)                     │   │
│ └────────────────────────────────────────────────────┘   │
│                                                          │
│ Limits                                       [Edit]      │
│ ┌────────────────────────────────────────────────────┐   │
│ │ Max concurrent runs: 2                             │   │
│ │ Test retry limit: 3                                │   │
│ │ Review rounds limit: 3                             │   │
│ │ Bulk approve max complexity: medium                │   │
│ └────────────────────────────────────────────────────┘   │
│                                                          │
└─────────────────────────────────────────────────────────┘
```

---

### 4.7 Project → Settings

**Purpose:** Project plumbing — connection info and dangerous operations.

#### Layout

```
┌─────────────────────────────────────────────────────────┐
│ Project Settings                                         │
├─────────────────────────────────────────────────────────┤
│                                                          │
│ GitHub Connection                                        │
│ ┌────────────────────────────────────────────────────┐   │
│ │ Organization: acme-org                             │   │
│ │ Installation ID: 12345678                          │   │
│ │ Status: ● Connected                                │   │
│ │ Permissions: Read/Write (repos, issues, PRs)       │   │
│ └────────────────────────────────────────────────────┘   │
│                                                          │
│ Configuration                                            │
│ ┌────────────────────────────────────────────────────┐   │
│ │ Default base branch: main                          │   │
│ │ Port range: 3100-3199                              │   │
│ └────────────────────────────────────────────────────┘   │
│                                                          │
│ Danger Zone                                              │
│ ┌────────────────────────────────────────────────────┐   │
│ │ Delete this project                                │   │
│ │ This will remove all project data. Runs will be    │   │
│ │ cancelled. GitHub repos will not be affected.      │   │
│ │                                [Delete Project]    │   │
│ └────────────────────────────────────────────────────┘   │
│                                                          │
└─────────────────────────────────────────────────────────┘
```

---

## Part 5: Detail Screens

### 5.1 Run Detail

**Route:** `/runs/[id]`
**Purpose:** Deep view into a single run's lifecycle.

#### Layout

```
┌─────────────────────────────────────────────────────────┐
│ Add user authentication #161                             │
│ Run: run_abc123 │ ● Executing │ Acme / webapp           │
│ Started 45m ago │ Workflow: Standard (view)              │
├─────────────────────────────────────────────────────────┤
│                                                          │
│ Phase Timeline                                           │
│ ✓ Pending → ✓ Planning → ✓ Approved → ● Executing → PR  │
│   (2m)       (8m)         (15m)        (20m...)          │
│                                                          │
├─────────────────────────────────────────────────────────┤
│                                                          │
│ Gate Status                                              │
│ ┌──────────────┬──────────────┬──────────────────────┐   │
│ │ Plan Approval│ Tests Pass   │ Code Review          │   │
│ │ ✓ Passed     │ ○ Pending    │ ○ Pending            │   │
│ │ by @alice    │              │                      │   │
│ └──────────────┴──────────────┴──────────────────────┘   │
│                                                          │
│ Plan                                     [View Full]     │
│ ┌────────────────────────────────────────────────────┐   │
│ │ Goal: Add JWT authentication to API endpoints      │   │
│ │ Files: 4 modified, 2 new                           │   │
│ │ Risks: Token expiry edge case (Medium)             │   │
│ └────────────────────────────────────────────────────┘   │
│                                                          │
│ Agent Activity                          [Expand All]     │
│ ┌────────────────────────────────────────────────────┐   │
│ │ ▸ Planner (8m) — produced PLAN v1                  │   │
│ │ ▸ Reviewer (3m) — APPROVED plan                    │   │
│ │ ▾ Implementer (20m) — in progress                  │   │
│ │   ├ read_file: src/auth/middleware.ts               │   │
│ │   ├ write_file: src/auth/jwt.ts (new)              │   │
│ │   ├ write_file: src/auth/middleware.ts              │   │
│ │   └ run_tests: 14 passed, 2 failed (attempt 1)    │   │
│ └────────────────────────────────────────────────────┘   │
│                                                          │
│ Operator Actions                                         │
│ ┌────────────────────────────────────────────────────┐   │
│ │ @alice approved plan (30m ago)                     │   │
│ │ "Looks good. Handle expired token edge case."      │   │
│ └────────────────────────────────────────────────────┘   │
│                                                          │
├─────────────────────────────────────────────────────────┤
│ Actions                                    (sticky bar)  │
│ [Pause]                                       [Cancel]   │
└─────────────────────────────────────────────────────────┘
```

#### Header

| Field | Content |
|-------|---------|
| Task title | Issue title + `#number` |
| Run ID | `run_abc123` |
| Status | Phase badge |
| Project / Repo | Link to project, repo name |
| Started | Time since start |
| Workflow | Link to project Workflow tab |

#### Phase Timeline

Visual horizontal timeline showing completed phases (checkmark), current phase (spinner), and future phases (hollow).

#### Gate Status Grid

Shows all gates for this run with their current status:
- `✓ Passed` (green) — with who/what passed it
- `✗ Failed` (red) — with failure reason
- `○ Pending` (gray) — not yet evaluated

#### Sections

| Section | Content |
|---------|---------|
| Plan | Summary of approved plan (if past planning) |
| Agent Activity | Collapsible log of agent invocations with tool calls |
| Operator Actions | History of human decisions on this run |

#### Actions Bar (Sticky)

The actions bar is **position: sticky** at the bottom of the viewport. It **never scrolls out of view**.

Available actions depend on current phase:

| Phase | Available Actions |
|-------|-------------------|
| `pending` | Cancel |
| `planning` | Pause, Cancel |
| `awaiting_plan_approval` | Approve, Revise, Reject, Cancel |
| `executing` | Pause, Cancel |
| `blocked` | Retry, Cancel |
| `paused` | Resume, Cancel |
| `awaiting_merge` | Cancel |
| `completed` / `cancelled` / `failed` | — (read-only) |

---

### 5.2 Repo Detail

**Route:** `/projects/[id]/repos/[repoId]`
**Purpose:** Repository configuration and run history.

#### Content

| Section | Content |
|---------|---------|
| Repo Info | Name, org, GitHub link |
| Profile | Detected stack, test command |
| Branch | Default branch |
| Recent Runs | Last 10 runs for this repo |
| Policy Overrides | Per-repo policy overrides (if any) |

---

## Part 6: Interaction Patterns

### 6.1 Control Actions

Every protocol action maps to a button. No slash commands. No GitHub-based control.

#### Action Button Table

| Action | Button Label | Variant | Icon | Enabled When | Comment | Confirmation |
|--------|-------------|---------|------|--------------|---------|--------------|
| Start Run | **Start** | Primary | `Play` | Issue selected, no active run | Optional | Optional: show run options |
| Approve Plan | **Approve** | Primary | `Check` | Phase = `awaiting_plan_approval` | Optional | None |
| Revise Plan | **Revise** | Secondary | `Pencil` | Phase = `awaiting_plan_approval` | Required | None |
| Reject & Cancel | **Reject** | Destructive | `X` | Phase = `awaiting_plan_approval` | Required | "This will cancel the run." |
| Retry | **Retry** | Primary | `RotateCcw` | Phase = `blocked` | Optional | None |
| Pause | **Pause** | Secondary | `Pause` | Any active phase | — | None |
| Resume | **Resume** | Primary | `Play` | Phase = `paused` | — | None |
| Cancel | **Cancel** | Destructive | `Square` | Any non-terminal phase | Optional | "Are you sure? This cannot be undone." |
| Force Cancel | **Force Cancel** | Destructive | `AlertTriangle` | Phase = `stopping…` | — | Type-to-confirm + second confirmation |

#### Button States

- **Primary** (green/default): Approve, Start, Resume, Retry — forward progress
- **Secondary** (gray): Revise, Pause — hold or redirect
- **Destructive** (red): Reject, Cancel, Force Cancel — stop or abort

#### Comment Integration Pattern

```
┌─────────────────────────────────────────┐
│  Approve Plan                           │
├─────────────────────────────────────────┤
│  Add feedback (optional):               │
│  ┌─────────────────────────────────┐    │
│  │ Handle the edge case for expired│    │
│  │ tokens in the refresh flow.     │    │
│  └─────────────────────────────────┘    │
│                                         │
│        [Cancel]  [Approve Plan]         │
└─────────────────────────────────────────┘
```

Feedback is:
1. **Stored in DB** as part of the action record
2. **Passed to agents** in their next invocation context
3. **Mirrored to GitHub** as part of the audit comment

---

### 6.2 Bulk Operations

#### What's Bulkable

| Action | Bulk Allowed? | Constraint |
|--------|---------------|------------|
| Start Runs | Yes | Same project only |
| Pause/Resume | Yes | Same project only |
| Cancel Runs | Yes | Same project only; confirmation required |
| Approve Plans | Yes | Only low-risk items (see Approvals section) |
| Grant Policy Exception | **Never** | Each exception reviewed individually |
| Override Gates | **Never** | Each override reviewed individually |
| Force Cancel | **Never** | Each force cancel requires individual confirmation |

#### Safety Friction

Destructive bulk actions (Cancel, Reject) require:
1. Confirmation dialog showing **exact affected items**
2. Summary of affected runs, phases, and repos
3. Explicit **Confirm** button (not just Enter key)

High-volume actions (>10 items) show additional warning: "You are about to affect N runs. Are you sure?"

---

### 6.3 Empty States

| Screen | Condition | Message | CTA |
|--------|-----------|---------|-----|
| Dashboard | No projects | "Welcome to Conductor. Create a project to get started." | [Create Project] |
| Dashboard | No runs | "No active runs. Start a run from a project's Backlog." | — |
| Work | No runs | "No runs yet. Start a run from a project's Backlog." | — |
| Work (tab) | No runs in tab | "No {active/queued/blocked/completed} runs." | — |
| Approvals | No pending | "All caught up. No approvals pending." | — |
| Projects | No projects | "No projects yet. Create your first project." | [Create Project] |
| Analytics | No data | "No run data yet. Analytics populate as runs complete." | — |
| Backlog | No repos | "Connect a repository to see issues." | [Go to Repos] |
| Backlog | No issues | "No issues match your filters." | Clear filters |
| Backlog | Needs sync | "Issues haven't been synced yet." | [Sync Issues] |
| Repos | No repos | "No repositories connected." | [Add Repository] |

---

### 6.4 Loading States

All screens use `Skeleton` components matching the layout shape (skeleton cards, skeleton table rows).

| Surface | Polling Interval |
|---------|-----------------|
| Approvals badge (sidebar) | 30 seconds |
| Dashboard | 60 seconds |
| Work (active tab) | 30 seconds |
| Run Detail | 10 seconds |
| Analytics | No polling (load on visit) |

---

### 6.5 Notifications

#### v0.1 (In-App Only)

| Indicator | Location | Content |
|-----------|----------|---------|
| Approvals badge | Sidebar, next to "Approvals" | Count of pending approvals |
| Dashboard stat cards | Dashboard | Blocked runs count, needs-you count |
| Project health | Projects list | Per-project health indicator |

#### Future (v0.2+)

| Channel | Trigger | Frequency |
|---------|---------|-----------|
| Email digest | Pending approvals summary | Configurable (hourly/daily) |
| Email immediate | Run failed / system health | Immediate |

---

## Part 7: User Journeys

### Journey 1: First-Time Setup

```
Login → Install GitHub App → Create Project → Add Repos → Sync Issues
```

1. Operator opens Conductor → redirected to `/login`
2. Clicks **Sign in with GitHub** → GitHub OAuth flow
3. Redirected back, lands on `/dashboard`
4. Dashboard shows empty state: "Create a project to get started"
5. Clicks **Create Project** → goes to `/projects/new`
6. Prompted to install GitHub App if not installed → redirects to GitHub
7. Returns with installation → selects installation, names project
8. Clicks **Create** → lands on `/projects/[id]` (Overview tab)
9. Overview shows "No repos connected" → clicks **Go to Repos**
10. Clicks **Add Repository** → selects repos from installation
11. Conductor detects profiles → clicks **Register**
12. Goes to **Backlog** tab → clicks **Sync Issues**
13. Issues appear → ready to start first run

### Journey 2: Start Work on an Issue

```
Dashboard → Project → Backlog → Select Issue → Start Run
```

1. Operator opens Conductor → lands on Dashboard
2. Sees project health cards, clicks into project
3. Goes to **Backlog** tab
4. Filters by repo or label
5. Selects issue "Add /health endpoint #142"
6. Clicks **Start Run** (or selects multiple + bulk Start)
7. Run appears in Work tab and on Dashboard

### Journey 3: Approve a Plan

```
Dashboard "Needs You" → Approvals → Review → Approve
```

1. Operator sees Dashboard: "Needs You: 3"
2. Clicks to Approvals page (or clicks specific item)
3. Sees plan approval: "Add caching layer #201"
4. Reads plan summary, checks files to change
5. Types optional feedback: "Handle expired cache gracefully"
6. Clicks **Approve**
7. Run proceeds to execution, decision mirrored to GitHub

### Journey 4: Handle a Failure

```
Dashboard "Blocked: 2" → Run Detail → Retry/Cancel
```

1. Operator sees Dashboard: "Blocked: 2" (red card)
2. Clicks blocked run in Active Runs table
3. Opens Run Detail → sees error: "Test failures after 3 retries"
4. Reviews agent logs, test output
5. Types feedback: "The mock setup is wrong, use the factory pattern"
6. Clicks **Retry** → run resumes from last checkpoint

### Journey 5: Emergency Stop

```
Work → Select All Active → Bulk Cancel
```

1. Something goes wrong across multiple runs
2. Operator goes to **Work** page
3. Switches to Active tab
4. Selects all affected runs (checkboxes)
5. Clicks **Cancel**
6. Confirmation: "Cancel 5 runs? This will post cancellation notices to GitHub."
7. Confirms → all runs cancelled, environments cleaned up

### Journey 6: Configure Workflow (v0.2+)

```
Project → Workflow → View Pipeline → Modify Step → Save
```

1. Operator opens project, goes to **Workflow** tab
2. Sees visual pipeline: Issue → Plan → Approval → Implement → Tests → PR → Complete
3. Clicks "Tests" step in pipeline
4. Configuration panel shows: retry limit (3), timeout (15m), failure escalation
5. Changes retry limit to 5 for this project
6. Clicks **Save** → pipeline updated

*In v0.1, this is read-only. The pipeline visualization shows the default configuration but is not editable.*

---

## Part 8: Technical Notes

### Available shadcn Components

Installed and available in `packages/web/src/components/ui/`:

| Component | Usage |
|-----------|-------|
| `Button` | All actions |
| `Badge` | Phase labels, status indicators, counts |
| `Card` | Stat cards, content sections |
| `Tabs` | Project sub-nav, Work tab filters |
| `Table` | Run lists, issue lists, agent logs |
| `Dialog` | Confirmation dialogs, destructive actions |
| `Input` | Search, form fields |
| `Textarea` | Comment/feedback fields |
| `Select` | Filters (project, repo, label, scope) |
| `Label` | Form labels |
| `Skeleton` | Loading states |
| `Separator` | Visual dividers (nav, sections) |
| `ScrollArea` | Long content panels |
| `Tooltip` | Abbreviated info, icon explanations |
| `DropdownMenu` | UserMenu, context menus |
| `Avatar` | User avatar in sidebar |
| `RadioGroup` | Option selection in settings |
| `Alert` | Warnings, info banners |
| `Sonner` | Toast notifications |

Custom components in `components/`:
| Component | Usage |
|-----------|-------|
| `Loading` | Full-page loading state |
| `ErrorState` | Error display with retry |
| `EmptyState` | Empty content with CTA |
| `PageHeader` | Page title + description + action button |

### Phase Label Mapping (Quick Reference)

```typescript
const phaseConfig: Record<string, { label: string; variant: string }> = {
  pending:                 { label: 'Pending',           variant: 'secondary' },
  planning:                { label: 'Planning',          variant: 'secondary' },
  awaiting_plan_approval:  { label: 'Awaiting Approval', variant: 'secondary' },
  executing:               { label: 'Executing',         variant: 'secondary' },
  proposing:               { label: 'Creating PR',       variant: 'secondary' },
  awaiting_merge:          { label: 'Ready for Merge',   variant: 'success' },
  merged:                  { label: 'Merged',            variant: 'success' },
  completed:               { label: 'Completed',         variant: 'success' },
  blocked:                 { label: 'Blocked',           variant: 'destructive' },
  paused:                  { label: 'Paused',            variant: 'warning' },
  cancelled:               { label: 'Cancelled',         variant: 'secondary' },
  failed:                  { label: 'Failed',            variant: 'destructive' },
};
```

### Chart Colors

Five CSS variables available for data visualization:

```css
--chart-1: 12 76% 61%;    /* Orange-red */
--chart-2: 173 58% 39%;   /* Teal */
--chart-3: 197 37% 24%;   /* Dark blue */
--chart-4: 43 74% 66%;    /* Gold */
--chart-5: 27 87% 67%;    /* Orange */
```

### Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `g d` | Go to Dashboard |
| `g w` | Go to Work |
| `g a` | Go to Approvals |
| `g p` | Go to Projects |
| `j` / `k` | Navigate list (down/up) |
| `Enter` | Open selected item |
| `a` | Approve (when in approval context) |
| `r` | Reject (when in approval context) |
| `Esc` | Close dialog / go back |

### Dark Mode

Dark mode is supported via the standard shadcn theme approach using `next-themes`. All semantic tokens (success, warning, destructive) have dark mode values. No component should use hardcoded colors — always use CSS variables or variant props.

### Density Control

Global "Compact / Comfortable" density toggle using Tailwind spacing variables. No per-screen tweaks. Stored in user preferences (localStorage).

### Icons

All icons from `lucide-react`. No other icon library.

---

## Real-Time vs Checkpoint Visibility

| What | Real-Time (Streaming) | Checkpoint (Stable) |
|------|----------------------|---------------------|
| Agent logs | Observable in Run Detail | — |
| Tool invocations | Live updates | — |
| Phase transitions | — | Operator sees stable state |
| Artifacts (PLAN, TEST_REPORT) | — | Only after validation |
| Operator decisions | — | Always on stable checkpoints |
| GitHub comments | — | Checkpointed, not streamed |

**Rule:** Streaming is observability. Decisions are always on stable checkpoints.

**Pause/Cancel safe boundaries:**

| Action Requested | UI State | Safe Boundary |
|------------------|----------|---------------|
| Pause requested | `pausing…` chip | After current agent invocation completes |
| Cancel requested | `stopping…` chip | After current tool call completes |
| Force Cancel | `killing…` chip | Immediate sandbox termination (requires confirmation) |

---

## Further Reading

- [VISION.md](VISION.md) — Product vision and philosophy
- [ARCHITECTURE.md](ARCHITECTURE.md) — System components and execution flow
- [PROTOCOL.md](PROTOCOL.md) — Event schemas and state machine
- [ROUTING_AND_GATES.md](ROUTING_AND_GATES.md) — Routing and quality gates
- [DATA_MODEL.md](DATA_MODEL.md) — Database schema
- [POLICIES.md](POLICIES.md) — Policy engine, enforcement points
- [MVP_SCOPE.md](MVP_SCOPE.md) — v0.1 scope and work packages
- [ISSUE_INTAKE.md](ISSUE_INTAKE.md) — PM agent and natural language issue creation (v0.2)
