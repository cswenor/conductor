# Control Plane UX

> **This document has been superseded by [CONTROL_PLANE_UX_V2.md](CONTROL_PLANE_UX_V2.md).** The V2 spec incorporates a restructured navigation model, new screens (Dashboard, Work, Analytics, Workflow), and detailed per-screen specifications. This document is retained for historical reference.

---

## Mental Model

### Conductor is a Control Tower, Not a Chat App

Conductor UI is where operators **command and monitor** automated engineering work. It is not:
- A chat interface with AI
- A GitHub wrapper
- A ticket management system

It is a **control plane** for runs—machines you start, pause, inspect, and kill.

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

### Projects are Namespaces; Runs are Machines

**Projects organize work. Runs are the operational objects inside projects.**

- Projects scope repos, policies, and backlogs
- Runs are the units you start, pause, and cancel
- The UI maintains an **active project context**; global views default to that context

---

## Core Principle

**GitHub is where work lives. Conductor UI is where work is operated.**

- **GitHub**: Issues, PRs, comments, checks = artifacts + narrative
- **Conductor UI**: Start, approve, reject, pause, cancel, configure = controls

Operators drive work through Conductor. GitHub shows the story. Every operator action is mirrored to GitHub as a comment for auditability.

---

## UX Invariants

These rules are non-negotiable. They prevent scope creep and keep the interface sharp.

### Information Architecture Invariants

Layout drift kills control planes. These constraints prevent "Where is Cancel?" problems:

| Screen | Required Structure |
|--------|-------------------|
| Run Detail | Header → Phase Timeline → Current State Panel → Actions Bar (sticky, never scrolls) |
| Approvals Inbox | Always grouped by gate type; project/repo are filters, never grouping keys |
| Active Runs | Always sortable by phase, duration, repo; default: phase then oldest first |
| All screens | Global navigation bar is constant and identical |

**Actions Bar rule:** The Actions Bar on Run Detail is position-sticky at the bottom. Operators must **never** scroll to find Pause/Cancel/Approve.

**Conversational boundaries:**
- No free-form chat outside Issue Intake
- Issue Intake is the **only** conversational surface in Conductor; all other screens are command-and-observe

**Operator interaction:**
- No operator action requires typing commands
- Every control action has a visible button
- No slash commands, no GitHub-based control

**State visibility:**
- No hidden state; every blocked/paused run must explain why
- No "silent progress"; state transitions are always visible
- Operators never act on partial agent output—decisions operate on stable checkpoints (artifacts, gates)

**Destructive actions:**
- No destructive action without confirmation
- Destructive bulk actions require explicit "Confirm" (not just Enter)
- **No action without seeing target:** All destructive actions must show the exact affected run(s), phase(s), and repo(s) in the confirmation dialog. Prevents catastrophic "wrong tab" mistakes.

**Agent boundaries:**
- Agents propose, review, report, escalate—they never control
- Operator actions are visually distinct from agent output (different styling, iconography)
- Agents never appear as "people" in the UI

---

## What This UI Refuses to Do

Explicit non-goals to keep Conductor sharp:

| Refused Feature | Why |
|-----------------|-----|
| Inline code editing | Conductor operates runs, not code; use your IDE |
| GitHub settings management | Out of scope; use GitHub's UI |
| Agent configuration per-run | Agents are system-level; no per-run tuning |
| Implicit approvals | Every approval is explicit and logged |
| Real-time streaming decisions | Operators act on checkpoints, not partial output |
| Chat with agents (outside Intake) | Run Detail is observe-only; no conversation |

---

## Real-Time vs Checkpoint Visibility

| What | Real-Time (Streaming) | Checkpoint (Stable) |
|------|----------------------|---------------------|
| Agent logs | ✅ Observable in Run Detail | — |
| Tool invocations | ✅ Live updates | — |
| Phase transitions | — | ✅ Operator sees stable state |
| Artifacts (PLAN, TEST_REPORT) | — | ✅ Only after validation |
| Operator decisions | — | ✅ Always on stable checkpoints |
| GitHub comments | — | ✅ Checkpointed, not streamed |

**Rule:** Streaming is observability. Decisions are always on stable checkpoints.

Operators may watch real-time logs for awareness, but **all control actions operate on validated, stable state**. No "approve mid-stream" or "cancel based on partial output."

**Exception: Pause and Cancel** may be initiated at any time, but they take effect at safe boundaries. The UI must show a "pending stop" state:

| Action Requested | UI State | Safe Boundary (Protocol) | Notes |
|------------------|----------|--------------------------|-------|
| Pause requested | `pausing…` chip | After current agent invocation completes | Never mid-invocation; waits for agent to return |
| Cancel requested | `stopping…` chip | After current tool call completes | Can hard-kill sandbox if operator confirms force-cancel |
| Force Cancel | `killing…` chip | Immediate sandbox termination | Requires explicit confirmation; may leave artifacts |

**Safe boundary definitions:**
- **Tool call boundary:** After a single tool (read/write/bash) returns, before next tool
- **Agent invocation boundary:** After agent returns control to orchestrator, before next agent dispatch
- **Commit boundary:** After git commit completes, before push

**Cancel semantics (critical):**
- Once `stopping…` is set, orchestrator may finish the current tool call but **must not start any new commit/push steps**
- If a commit already happened locally, it stays local (no auto-push after cancel)
- This prevents "I cancelled but a PR still appeared" loss-of-control scenarios

This aligns UX with protocol semantics: the *intent* is immediate, the *effect* is at a safe boundary.

---

## UI Framework Decision

**Decision (v1):** Conductor UI uses **shadcn/ui** as the primary component system, with **Tailwind** for layout/spacing and **Radix UI primitives** (via shadcn) for accessibility and interaction patterns.

**Goal:** Ship a polished, consistent "control tower" UI without custom product design work.

Using shadcn/ui enforces consistent interaction primitives so operators can rely on muscle memory across screens.

### Non-negotiables

- **No second design system.** Do not introduce MUI/Ant/Chakra/etc.
- **No bespoke component styling** beyond Tailwind utility composition.
- **Use shadcn defaults** for typography, spacing, radii, shadows, focus rings.
- **Accessibility is default.** Keyboard navigation + focus states must work everywhere.

### Composition rules

Screens are built from a small, reusable set of primitives:

- `Button`, `Badge`, `Card`, `Tabs`, `Dialog`, `Drawer`, `Popover`, `Tooltip`
- `Table`, `DataTable` pattern, `Command` (search), `DropdownMenu`
- `Form` + `zod` validation, `Toast`/`Sonner` notifications
- `Skeleton` loading states, `Separator`, `ScrollArea`

Avoid new one-off components unless they are reused on ≥2 screens.
Prefer "patterns" over custom design (e.g., DataTable + filters for lists, Card stacks for inbox, Dialog confirmations for destructive actions).

### Visual consistency constraints

**Severity + state styling uses tokens**, not ad-hoc colors.

**Theme extension policy:** We extend shadcn's default variants with **two semantic variants** (`success`, `warning`) implemented via CSS variables in the theme config, not ad-hoc Tailwind colors:

```css
/* In globals.css / theme layer — values defined once, swappable per theme */
--success: 142 76% 36%;
--success-foreground: 0 0% 100%;
--warning: 38 92% 50%;
--warning-foreground: 0 0% 0%;
```

**Variant implementation rules:**
- Palette values defined once in theme, never inline on components
- `success` and `warning` variants added to: `Button`, `Badge`, `Alert`
- Other components use existing variants or semantic tokens
- No one-off `bg-green-500` or `text-amber-600` — always use variant or token

| Semantic | Variant | When to Use |
|----------|---------|-------------|
| Critical/Error | `destructive` (shadcn default) | Failures, blocked runs |
| Warning | `warning` (theme extension) | Approaching limits, policy warnings |
| Info | `secondary` (shadcn default) | Awaiting states, neutral info |
| Success | `success` (theme extension) | Passed gates, completed runs |

Phase chips use the same badge variants everywhere. No one-off color overrides.

**Phase label mapping:** Canonical phase names from PROTOCOL.md map to user-friendly labels:

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
| `blocked` | Blocked | `destructive` | Needs operator input to continue (not terminal) |
| `paused` | Paused | `warning` | Operator-initiated pause |
| `cancelled` | Cancelled | `secondary` | Operator-initiated termination |
| `failed` | Failed | `destructive` | Terminal failure (no continuation possible) |

**Phase distinctions:**
- `merged` vs `completed`: `merged` = fact observed from GitHub; `completed` = system state after cleanup. UI may show "Merged" then "Completed" in sequence.
- `blocked` vs `failed`: `blocked` = recoverable with operator input (retry, guidance); `failed` = terminal, cannot continue.

Transitional states (e.g., `pausing…`, `stopping…`) use the same variant as their target phase with an animated spinner.

**Density control:** Provide a global "Compact / Comfortable" density toggle using Tailwind spacing variables (no per-screen tweaks).

**Dark mode required** using the standard shadcn theme approach.

### Approved add-ons

| Category | Library |
|----------|---------|
| Icons | `lucide-react` only |
| Charts | `recharts` only |
| Date/time | `date-fns` only |
| Tables | shadcn DataTable pattern (TanStack Table) |

### Component ownership

**Rule:** All shadcn components live in a single `components/ui/` directory and are only modified via a documented upgrade path; deviations must be justified in code review.

### Explicit non-goals (v1)

- No custom illustration/branding work
- No bespoke design explorations
- No pixel-perfect design review cycle; consistency comes from the system + patterns

---

## User Journeys

### Journey 1: Create an Issue from a Thought

1. Operator opens Conductor → lands in last active project (e.g., "Acme Platform")
2. Clicks **New Issue** → opens Issue Intake (dedicated full-page route)
3. Types freely: "The checkout flow is broken for users with expired promo codes"
4. PM agent silently checks repos, recent issues, relevant code
5. PM agent proposes issue with title, description, acceptance criteria
6. Operator reviews proposal, sees flagged assumption about repo
7. Clicks **Revise**, types "this is in the payments repo, not webapp"
8. PM agent updates proposal
9. Operator clicks **Accept & Start Run**
10. Issue created in GitHub, run begins immediately

### Journey 2: Start Work on an Existing Issue

1. Operator opens Conductor → lands in last active project
2. Clicks **Backlog** tab in Project Detail
3. Filters by repo, label, or assignee
4. Selects one or more issues
5. Clicks **Start Run**
6. Conductor creates Runs, posts "Run started" to each issue
7. Runs appear in **Runs** tab (and top-level Runs if viewing cross-project)

### Journey 3: Approve a Plan

1. Operator sees notification: "3 runs awaiting approval"
2. Opens **Approvals Inbox**
3. Clicks into a run → sees plan summary, risks, files to change
4. Types optional comment: "Looks good, but handle the edge case for expired tokens"
5. Clicks **Approve**
6. Conductor records decision, posts approval + comment to GitHub issue
7. Run proceeds to execution

### Journey 4: Handle a Failure

1. Operator sees red indicator: "1 run failed"
2. Opens **Run Detail** for failed run
3. Sees error: "Test failure in auth_test.py after 3 retries"
4. Reviews agent logs, test output
5. Options:
   - **Retry**: Agent tries again
   - **Cancel**: Abort the run
   - **Intervene**: Operator fixes issue manually, then resumes
6. Selects action; Conductor mirrors decision to GitHub

### Journey 5: Emergency Stop

1. Something goes wrong across multiple runs
2. Operator opens **Active Runs**
3. Selects all affected runs
4. Clicks **Bulk Cancel**
5. Confirmation dialog: "Cancel 5 runs? This will post cancellation notices to GitHub."
6. Confirms
7. All runs cancelled, environments cleaned up, GitHub notified

---

## Navigation Structure

Projects are the primary organizing unit, not a configuration setting.

**Top-level navigation:**
```
┌─────────────────────────────────────────────────────┐
│  [Project Switcher ▼]   Projects │ Runs │ Approvals │ Settings  │
└─────────────────────────────────────────────────────┘
```

- **Project Switcher** (always visible): Sets active project context. All views default to this project.
- **Projects**: List all projects, create new projects
- **Runs**: Active/completed runs (filtered by active project by default)
- **Approvals**: Pending approvals (filtered by active project by default)
- **Settings**: Global config, GitHub connection, policies

**Active Project Context:**
- UI maintains an active project; views are scoped to it by default
- Explicit "All Projects" option available for cross-project views
- Switching projects updates all views immediately

**Default Landing:**
- On login, Conductor opens the **last active project** (Project Detail view)
- If no project exists, opens Projects list with prominent "Create Project" CTA
- This "resume context" pattern is essential for control planes

**Where things live:**

| Screen | Location | Notes |
|--------|----------|-------|
| Backlog | Project Detail → Backlog tab | Not top-level; avoids cross-project "issue soup" |
| Issue Intake | Project Detail → New Issue (dedicated route) | Creates issues in active project's repos |
| Repo management | Project Detail → Repos tab | Add/configure repos for this project |
| Project policies | Project Detail → Policies tab | Project-scoped defaults |
| Global policies | Settings → Policies | System-wide defaults |

**Top-level Runs vs Project Runs tab:**

| View | Purpose | Typical Use |
|------|---------|-------------|
| **Top-level Runs** | Operational console for bulk operations | "Show me all blocked runs across projects" |
| **Project Detail → Runs tab** | Project-local workbench | "What's happening in Acme Platform right now?" |

The top-level Runs screen defaults to active project but supports "All Projects" for cross-project triage. The Project Runs tab is always scoped to that project.

---

## Screens

### 1. Projects

**Projects are the primary unit of work in Conductor.** This is where operators create projects, add repos, and see project health.

**Projects List:**
- List of projects with: name, repo count, active runs, blocked runs, awaiting approval count
- Project status indicators (healthy, needs attention, blocked)
- Quick stats per project

**Actions:**
- **Create Project** (primary CTA, always visible)
- Click project → opens Project Detail

**Create Project Flow:**
1. Click **Create Project**
2. Enter project name (required)
3. Enter description (optional)
4. Select default GitHub org (optional; can add repos from multiple orgs later)
5. Click **Create**

**Note:** Projects can be created without GitHub connected. Repos can't be added until GitHub is connected. This allows creating the project structure first, then connecting GitHub when ready.

---

**Project Detail View (Tabbed Interface):**

```
┌─────────────────────────────────────────────────────────────┐
│  Acme Platform                              [Project Settings]│
├─────────────────────────────────────────────────────────────┤
│  [Overview] [Backlog] [Repos] [Runs] [Policies]              │
├─────────────────────────────────────────────────────────────┤
│  (Tab content here)                                          │
└─────────────────────────────────────────────────────────────┘
```

| Tab | Content |
|-----|---------|
| **Overview** | Project health dashboard: run counts, approvals needed, recent activity (default landing) |
| **Backlog** | Issues available for work in this project's repos. Start Run here. New Issue button. |
| **Repos** | Registered repos, Add Repo button, repo health, per-repo settings |
| **Runs** | Active and recent runs for this project |
| **Policies** | Project-scoped defaults: gates, sensitive paths, concurrency, bulk approve thresholds |

**Backlog Tab (Project-Scoped):**
- Issues from all repos in this project
- Filters: repo, label, assignee, age
- **Start Run** (single or bulk)
- No cross-project "issue soup" — backlog is always project-scoped

**Repos Tab:**
- List of registered repos with status
- **Add Repo** (prominent button)
- Per-repo quick actions: configure, view runs, remove

**Add Repo Flow:**
1. Click **Add Repo**
2. If GitHub not connected → prompt to connect (redirects to Settings → GitHub Connection, then returns)
3. Select from connected GitHub repos
4. Review detected profile (stack, test commands)
5. Configure policies or accept defaults
6. Click **Register**

**Repo States:**
| State | Meaning |
|-------|---------|
| `unregistered` | Visible (GitHub App has access) but not tracked by Conductor |
| `scanning` | Analyzing repo structure, detecting stack |
| `registered` | Conductor tracks this repo; ready for runs |
| `error` | Scan failed or permissions issue |

**Visibility note:** Unregistered repos are visible only because the GitHub App has access to them. Conductor does not scan or index unregistered repos — they're just selectable in the Add Repo flow.

**Policies Tab (Project-Scoped Defaults):**
- Default gates for this project
- Sensitive path patterns
- Concurrency limits
- Bulk approve thresholds
- These override global defaults; per-repo overrides override these

---

### 2. Project Overview (replaces generic "Dashboard")

**Project Detail opens to an Overview tab** showing project health at a glance. There is no separate global "Dashboard" — the Project Overview is the dashboard.

**Content (scoped to active project):**
- Active runs count (by phase)
- Runs awaiting approval (with urgency indicator)
- Recent completions
- Recent failures
- Repo health summary

**Content (system-wide, shown in header or sidebar):**
- System health indicator (agent availability, queue depth)
- Cross-project alerts (if any project has critical issues)

**Actions:**
- Click any metric to drill down to relevant tab
- Quick access to Backlog, Runs, Approvals tabs

---

### 3. Issue Intake

Natural language interface for creating new issues. **Accessed from Project Detail → New Issue.**

**Issue Intake is a dedicated full-page route** (not a modal, not a tab) to preserve conversational boundaries and provide a clean layout (chat left, draft right).

**This is the only conversational surface in Conductor.** All other screens are command-and-observe. Do not add chat interfaces elsewhere.

**Content:**
- Conversation pane (left): free-form chat with PM agent
- Proposal pane (right): live-updating issue draft
- Repo selector (defaults to active project's repos)

**Actions:**
- **Accept & Create**: Creates issue in GitHub
- **Accept & Start Run**: Creates issue and immediately starts execution
- **Revise**: Provide feedback, agent updates proposal
- **Regenerate**: Agent retries with fresh assumptions
- **Cancel**: Discard without creating

**Behavior:**
- PM agent harvests context silently before responding
- Maximum 2 clarification questions before proposing
- Always converges to a proposal, never open-ended chat
- Flagged assumptions shown inline for review

See [ISSUE_INTAKE.md](ISSUE_INTAKE.md) for full PM agent specification.

---

### 4. Backlog (Project-Scoped)

**Backlog lives inside Project Detail → Backlog tab.** This avoids cross-project "issue soup."

**Content:**
- Issues from all repos in the active project
- Filters: repo, label, assignee, age
- Search by keyword
- Selection checkboxes

**Actions:**
- **Start Run** (single or bulk)
- **New Issue** → opens Issue Intake
- **View in GitHub** (opens issue in new tab)

**Notes:**
- Issues already in active runs are marked and cannot be re-started
- Sorted by priority (configurable: manual, age, label-based)
- Cross-project search available via global omnibox (future)

---

### 5. Active Runs

All runs currently in progress.

**Content:**
- Run list with: issue title, repo, phase, duration, agent activity indicator
- Filters: phase, repo, started by
- Phase chips: `planning`, `awaiting_plan_approval`, `executing`, `proposing`, `awaiting_merge`

**Actions:**
- **Pause** / **Resume** (per run or bulk)
- **Cancel** (per run or bulk)
- **Reprioritize** (drag to reorder or set priority)
- Click run → opens Run Detail

---

### 6. Approvals Inbox

Runs waiting for human decision. **Defaults to active project; "All Projects" available.**

**Content:**
- **Always grouped by gate type** (not by repo, not by time):
  - Plan approvals
  - Failure escalations
  - Policy exceptions
- **Filtered by project** (default: active project; can select "All Projects")
- Each item shows: issue title, repo, project, waiting duration, summary

**Actions:**
- **Approve** (with optional comment)
- **Reject** (with required comment)
- **View Details** → opens Run Detail
- **Bulk Approve** (for low-risk, with confirmation)

**UX Notes:**
- Approval button is prominent (`success` variant)
- Reject requires a reason (text field)
- Items sorted by wait time within each gate type (oldest first)
- Project filter is sticky (remembers last selection)

---

### 7. Run Detail

Deep view into a single run's lifecycle.

**Sections:**

#### Header
- Issue title + link to GitHub
- Run ID, status, current phase
- Timing: started, duration, phase durations

#### Phase Timeline
- Visual timeline showing phases completed and current
- Click any phase to see details

#### Plan (if past planning)
- Plan summary as approved
- Files to change
- Risks identified

#### Agent Activity
- Collapsible log of agent invocations
- For each invocation: role, tokens used, duration, tool calls
- Expandable tool call details (file reads, writes, shell commands)

#### GitHub Thread (Mirror)
- Embedded view of issue comments (read-only)
- Shows agent posts, operator decisions, human comments
- **Redaction note:** Mirrored comments are redacted per policy rules. Conductor stores hashes/metadata for audit purposes rather than raw sensitive payloads. Full unredacted content remains in the Conductor event log (access-controlled).

#### PR (if created)
- Link to PR
- CI status
- Review status

#### Actions Bar
- **Approve** / **Reject** (if awaiting approval)
- **Pause** / **Resume**
- **Cancel**
- **Retry Phase**

---

### 8. PR Review Assist (v1.1)

Helps operators review PRs created by Conductor.

**Content:**
- PR diff with inline agent annotations
- Summary of agent review findings
- Test results at a glance
- Files changed vs plan

**Actions:**
- **Send Back**: Returns run to execution with feedback
- **Mark Ready**: Signals PR is ready for human merge (in GitHub)
- **View in GitHub**: Opens PR for final review and merge

**Notes:**
- This screen is optional in v1—operators can review directly in GitHub
- Value: consolidated view of agent analysis + easy "send back" flow

---

### 9. Completed Runs

History of finished runs.

**Content:**
- Run list with: issue title, repo, outcome (success/cancelled/failed), duration, completed date
- Filters: outcome, repo, date range
- Search

**Actions:**
- Click run → opens Run Detail (read-only)
- **Rerun** (creates new run for same issue)

---

### 10. Settings

Configuration for policies, system behavior, and dangerous operations.

**Settings vs Projects:** Projects and repos are managed in the **Projects** screen (first-class navigation). Settings is for things that make you think *"should I really do this?"* — not *"cool, now I can work."*

**Settings are organized by authority level and risk:**

| Category | Risk Level | Restart Required? | Who Should Change |
|----------|------------|-------------------|-------------------|
| Notification preferences | Low | No | Any operator |
| Cleanup settings | Low | No | Any operator |
| Per-repo policies | Medium | Re-evaluation | Project admin |
| Agent prompts | Medium | Active runs restart | Project admin |
| Global policies | High | Re-evaluation of all runs | System admin |
| MCP configuration | High | Restart required | System admin |
| GitHub connection | High | — | System admin |
| System settings | High | Restart required | System admin |

**Visual indicators:**
- 🔵 Low risk: Change freely
- 🟡 Medium risk: "Changes take effect on next run" warning
- 🔴 High risk: Confirmation dialog + restart notice

**Subsections:**

#### GitHub Connection 🔴

Manage the connection to GitHub (first-time setup and maintenance):
- Install/authorize Conductor GitHub App
- View connected orgs and permission status
- Verify webhook delivery
- Rotate credentials

This is the **only** place to manage GitHub App credentials. Project/repo management happens in **Projects**.

#### Policies 🟡🔴
- Global policies (what requires approval, rate limits) — 🔴 High risk
- Per-repo policy overrides — 🟡 Medium risk
- Policy changes create new `PolicySet` version (see DATA_MODEL.md)

#### Agent Prompts 🟡
- System prompts for each role (Planner, Implementer, Reviewer, Tester)
- Per-repo prompt overrides
- **Warning:** Prompt changes affect active runs on their next agent invocation

#### MCP Configuration 🔴
- Enabled tools
- Tool-specific settings
- GitHub write policies
- **Warning:** Changes require Conductor restart

#### System 🔴
- Port range allocation
- Cleanup settings (branch retention, artifact retention)
- Notification preferences — 🔵 Low risk
- **Warning:** Some changes require Conductor restart

---

## Control Actions UX

Every protocol action maps to a button. No slash commands. No GitHub-based control.

### Action Buttons

| Action | Button | Icon | Enabled When | Confirmation |
|--------|--------|------|--------------|--------------|
| Start Run | **Start** | ▶️ | Issue selected, no active run | Optional: show run options |
| Approve Plan | **Approve** | ✅ | Phase = `awaiting_plan_approval` | None (comment optional) |
| Revise Plan | **Revise** | ✏️ | Phase = `awaiting_plan_approval` | Comment required |
| Reject & Cancel | **Reject** | ❌ | Phase = `awaiting_plan_approval` | Comment required |
| Retry | **Retry** | 🔁 | Phase = `blocked` | None |
| Pause | **Pause** | ⏸️ | Any active phase | None |
| Resume | **Resume** | ▶️ | Phase = `paused` | None |
| Cancel | **Cancel** | 🛑 | Any non-terminal phase | "Are you sure? This cannot be undone." |
| Force Cancel | **Force Cancel** | ⚠️ | Phase = `stopping…` (cancel already requested) | Type-to-confirm + explicit second confirmation |

**Force Cancel behavior:**
- Only available after Cancel already requested (run is in `stopping…` state)
- Immediately terminates sandbox (may leave local artifacts)
- Hidden in "danger zone" accordion within Cancel confirmation dialog
- **Never bulkable** — each force cancel requires individual confirmation

### Button States

- **Primary** (green): Approve, Start, Resume — forward progress
- **Secondary** (gray): Revise, Pause — hold or redirect
- **Destructive** (red): Reject, Cancel — stop or abort

### Comment Integration

Every action includes an optional (or required) comment field:

```
┌─────────────────────────────────────────┐
│  ✅ Approve Plan                        │
├─────────────────────────────────────────┤
│  Add feedback (optional):               │
│  ┌─────────────────────────────────┐   │
│  │ Handle the edge case for expired│   │
│  │ tokens in the refresh flow.     │   │
│  └─────────────────────────────────┘   │
│                                         │
│        [Cancel]  [Approve Plan]         │
└─────────────────────────────────────────┘
```

Feedback is:
1. **Stored in DB** as part of the action record
2. **Passed to agents** in their next invocation context
3. **Mirrored to GitHub** as part of the audit comment

---

## Gate Types

Gates are decision points where operator input is required.

| Gate | Trigger | Options | Comment Required |
|------|---------|---------|------------------|
| **Plan Approval** | Plan ready for review | Approve, Reject, Request Changes | No (Approve), Yes (Reject/Changes) |
| **Failure Escalation** | Agent exceeded retry limit | Retry, Cancel, Manual Fix | Yes |
| **Policy Exception** | Action would violate policy | Allow Once, Allow Always, Deny | Yes |
| **PR Feedback** | Human requested changes on PR | Acknowledge, Cancel | No |

### Gate Card UI

Each gate shows:
- **What**: Brief description of decision needed
- **Context**: Relevant details (plan summary, error message, policy violated)
- **Options**: Buttons for each choice
- **Comment Field**: Text input (optional or required depending on action)

---

## Comment Mirroring

Every operator action that affects a run is mirrored to GitHub as a comment.

### Mirror Format

```
[Conductor | <Actor> | run:<run_id>] <Action>

<Optional comment from operator>

---
<Structured metadata as collapsed details>
```

### Examples

**Run Started:**
```
[Conductor | Operator | run:abc123] Run started

Starting automated implementation for this issue.

<details>
<summary>Run details</summary>

- Run ID: abc123
- Started by: @username
- Conductor link: https://conductor.example.com/runs/abc123
</details>
```

**Plan Approved:**
```
[Conductor | Operator | run:abc123] Plan approved

Looks good. Make sure to handle the edge case for expired refresh tokens.

<details>
<summary>Approval details</summary>

- Approved by: @username
- Plan version: 2
- Conductor link: https://conductor.example.com/runs/abc123
</details>
```

**Run Cancelled:**
```
[Conductor | Operator | run:abc123] Run cancelled

Cancelling due to changed requirements. Will restart after product review.

<details>
<summary>Cancellation details</summary>

- Cancelled by: @username
- Phase at cancellation: executing
- Conductor link: https://conductor.example.com/runs/abc123
</details>
```

### Mirror Rules

- All operator actions mirror to GitHub (start, approve, reject, pause, resume, cancel)
- Agent posts go directly to GitHub (not mirrored, they're native)
- System events (phase transitions) optionally mirror based on verbosity setting
- Failures always mirror with explanation

---

## Bulk Operations

### Available Bulk Actions

| Action | Available In | Confirmation |
|--------|--------------|--------------|
| Start Runs | Backlog | "Start N runs?" |
| Pause Runs | Active Runs | "Pause N runs?" |
| Resume Runs | Active Runs | "Resume N runs?" |
| Cancel Runs | Active Runs | "Cancel N runs? This cannot be undone." |
| Approve Plans | Approvals Inbox | "Approve N plans? Review summary below." |

### Bulk Action Boundaries (Normative)

Some actions are **never bulkable** or require elevated permissions:

| Action | Bulk Allowed? | Constraint |
|--------|---------------|------------|
| Start Runs | ✅ Yes | Same project only |
| Pause/Resume | ✅ Yes | Same project only |
| Cancel Runs | ✅ Yes | Same project only; confirmation required |
| Approve Plans | ✅ Yes | Only low-risk (no sensitive paths, no policy warnings) |
| Grant Policy Exception | ❌ Never | Each exception reviewed individually |
| Override Gates | ❌ Never | Each override reviewed individually |
| Cross-repo bulk Pause/Cancel | ⚠️ Emergency only | Allowed within same project (emergency stop scenario) |
| Cross-repo bulk Start/Approve | ❌ Never | Starting and approving require single-repo selection |

**Why these constraints:**
- Policy exceptions require individual justification (audit trail)
- Gate overrides require understanding each failure context
- Cross-repo bulk prevents accidental mass operations

### Safety Friction

Destructive actions (Cancel, Reject) require:
1. Confirmation dialog
2. Summary of affected items
3. Explicit "Confirm" button (not just Enter key)

High-volume actions (>10 items) show additional warning.

**Bulk approve exclusions:** Bulk approve in Approvals Inbox excludes:
- Runs with policy warnings
- Runs touching sensitive paths
- Runs with failed gates (only escalations)

These must be approved individually.

**Low-risk definition (deterministic):** A run is eligible for bulk approve if and only if ALL of the following are true:
1. `plan.files_changed` contains no paths matching `sensitive_paths` patterns in project config
2. `plan.tools_requested` contains no tools in the `elevated_risk_tools` list
3. No `policy_warning` events exist for this run
4. The gate is `plan_approval` (not `failure_escalation` or `policy_exception`)
5. `plan.estimated_complexity` ≤ project's `bulk_approve_complexity_threshold` (default: `medium`)

This rule is evaluated server-side; the UI shows "Bulk Approve" only for qualifying runs.

---

## Permissions Model (v1)

v1 uses simple permission model:

| Role | Capabilities |
|------|--------------|
| **Operator** | Full access: start, approve, reject, cancel, configure |
| **Viewer** | Read-only: view runs, view logs, view settings |

Future: granular permissions (per-repo, per-action).

---

## Notifications

Conductor notifies operators when action is needed.

### Notification Channels (v1)

- **In-app**: Badge on Approvals Inbox, dashboard indicators
- **Email**: Digest of pending approvals (configurable frequency)

### Notification Triggers

- Run awaiting approval (immediate)
- Run failed (immediate)
- Run completed (batched daily digest)
- System health issue (immediate)

---

## Keyboard Shortcuts

For power users:

| Shortcut | Action |
|----------|--------|
| `g b` | Go to Backlog |
| `g a` | Go to Active Runs |
| `g i` | Go to Approvals Inbox |
| `j` / `k` | Navigate list (down/up) |
| `Enter` | Open selected item |
| `a` | Approve (when in approval context) |
| `r` | Reject (when in approval context) |
| `Esc` | Close dialog / go back |

---

## Visibility Rules

What operators see depends on where they're looking.

### Conductor UI Shows Everything

| Data | Conductor UI |
|------|--------------|
| Real-time agent activity | ✅ Streaming |
| Tool-by-tool execution trace | ✅ Expandable |
| Token usage, timing | ✅ Full metrics |
| All events (including internal) | ✅ Complete log |
| Plan/Review/Test artifacts | ✅ Full content |
| Phase transitions | ✅ Instant |

### GitHub Shows Checkpoints

| Data | GitHub |
|------|--------|
| Phase transitions | ✅ One comment each |
| Gate results | ✅ Pass/fail comment |
| Final artifacts | ✅ Rendered in comments |
| Operator actions | ✅ Mirrored as audit |
| Errors and escalations | ✅ Always posted |
| Incremental progress | ❌ Not posted |
| Internal agent chatter | ❌ Not posted |
| Performance metrics | ❌ Not posted |

This is the **Verbosity Policy** from [PROTOCOL.md](PROTOCOL.md) made concrete.

### Summary View vs Detail View

| Screen | Shows |
|--------|-------|
| Dashboard | Counts, health, urgency indicators |
| Active Runs list | Phase, duration, status chip |
| Run Detail | Everything—full timeline, logs, artifacts |
| GitHub Issue | Checkpointed narrative |

---

## Failure UX

When things go wrong, the UI must make failures **obvious, understandable, and actionable**.

### Failure Severity Levels

| Severity | Visual | Examples |
|----------|--------|----------|
| **Critical** | 🔴 Red badge, top of dashboard | System down, all runs blocked |
| **Error** | 🟠 Orange indicator | Run blocked, agent failed |
| **Warning** | 🟡 Yellow indicator | Run paused, approaching limits |
| **Info** | 🔵 Blue indicator | Awaiting approval (normal state) |

### Run Failure States

When a run enters `blocked` phase:

```
┌─────────────────────────────────────────────────────────────┐
│  🔴 Run Blocked                                             │
│                                                             │
│  Issue: Add user authentication (#161)                      │
│  Run: run_abc123 (Attempt 2)                               │
│                                                             │
├─────────────────────────────────────────────────────────────┤
│  ❌ Error: Test failures after 3 retry attempts             │
│                                                             │
│  Failed tests:                                              │
│  • auth.service.test.ts > should reject expired tokens      │
│  • auth.middleware.test.ts > should handle malformed tokens │
│                                                             │
│  Last agent action: Attempted fix for token expiry logic    │
│                                                             │
├─────────────────────────────────────────────────────────────┤
│  What went wrong:                                           │
│  The agent tried 3 times to fix failing tests but couldn't  │
│  resolve the underlying issue. Human review needed.         │
│                                                             │
│  Suggested actions:                                         │
│  • Review the test expectations (may be incorrect)          │
│  • Check if the implementation approach is viable           │
│  • Provide guidance and retry                               │
│                                                             │
├─────────────────────────────────────────────────────────────┤
│  [View Test Output]  [View Agent Logs]  [View in GitHub]    │
│                                                             │
│  Actions:                                                   │
│  [🔁 Retry with Feedback]  [🛑 Cancel Run]                  │
└─────────────────────────────────────────────────────────────┘
```

### Failure Types and Actions

| Failure | What Happened | Suggested Action |
|---------|---------------|------------------|
| **Test failures (max retries)** | Agent couldn't fix failing tests | Review test output, provide guidance, retry |
| **Agent timeout** | Agent didn't respond in time | Retry (usually works) or cancel |
| **Agent error** | Model returned invalid output | Retry with fresh context |
| **Plan rejected** | Review agent found critical issues | Revise requirements or cancel |
| **Gate violation** | Action blocked by policy | Request exception or modify approach |
| **Infrastructure error** | System issue (disk, network, etc.) | Check system health, retry when resolved |

### Safe Defaults

When in doubt, the UI guides toward safe actions:

- **Default button is non-destructive** (Retry, not Cancel)
- **Destructive actions require confirmation**
- **"What went wrong" explanation always visible**
- **Links to relevant logs/output always provided**

### Dashboard Failure Indicators

The dashboard surfaces failures prominently:

```
┌─────────────────────────────────────────┐
│  System Status                          │
├─────────────────────────────────────────┤
│  🟢 Agents: Healthy                     │
│  🟢 Queue: 3 pending                    │
│  🔴 Blocked Runs: 2 (needs attention)   │
│  🟡 Awaiting Approval: 5                │
└─────────────────────────────────────────┘
```

Clicking "Blocked Runs" goes directly to filtered list of blocked runs.

---

## Further Reading

- [VISION.md](VISION.md) — Product vision and philosophy
- [ARCHITECTURE.md](ARCHITECTURE.md) — System components and execution flow
- [ISSUE_INTAKE.md](ISSUE_INTAKE.md) — PM agent and natural language issue creation
- [PROTOCOL.md](PROTOCOL.md) — Event schemas and state machine
