# Control Plane UX v3 — The Living Pipeline

> **Design philosophy:** You should be able to glance at Conductor and know exactly what's happening across all your work in under 3 seconds. The interface is a living pipeline — work flows through it like marbles through a machine. You see where things are, where they're stuck, and where you're needed.

**Supersedes:** `CONTROL_PLANE_UX.md` (v1), `CONTROL_PLANE_UX_V2.md` (v2). This is the canonical UX specification.

**Guiding invariants (from v1/v2, non-negotiable):**
- Conductor is the **control surface**; GitHub is the **audit surface**
- Decisions operate on **stable checkpoints**, not streaming partial output
- Every operator action is a **button** — no slash commands, no GitHub-based control
- Comments integrate: stored in DB → passed to agents → mirrored to GitHub
- Runs are **machines** with state, controls, gauges, alarms
- Destructive actions require **explicit confirmation** showing what's affected

---

## 1. Navigation: Two Layers

V3 preserves V2's two-layer navigation model (global + project-scoped) but replaces tables with visual pipeline views as the primary interface.

### 1.1 Global Left Sidebar (Always Visible)

```
┌────────────┐
│  ◈ CONDUCTOR│
│             │
│  ◉(3)       │  ← "Needs You" badge (pulsing if items waiting)
│  Dashboard  │
│             │
│  ● Work     │  ← Active/Queued/Blocked/Done tabs
│  ◉ Approvals│  ← Grouped by gate type
│  📊 Analytics│
│             │
│  ─────────  │
│  PROJECTS   │
│  acme/webapp│  ← Health dot (🟢🟡🔴)
│  acme/mobile│
│             │
│  ─────────  │
│  ⚙ Settings │
└────────────┘
```

**Sidebar rules:**
- Always visible on desktop (collapsible to icons on narrow screens)
- Approvals badge count updates via WebSocket in real-time (30s polling only if WebSocket disconnected)
- Project health dots: 🟢 Healthy, 🟡 Needs Attention, 🔴 Blocked
- Active project highlighted; clicking switches project context

### 1.2 Project Horizontal Tabs (When Viewing a Project)

```
┌──────────────────────────────────────────────────────────────────────────┐
│  acme/webapp                                                    🟢 Healthy │
│  Overview │ Backlog │ Work │ Pipeline │ Workers │ Policies │ Settings    │
└──────────────────────────────────────────────────────────────────────────┘
```

| Tab | Purpose |
| --- | --- |
| **Overview** | Project-scoped dashboard (stat cards + mini pipeline + blocked items) |
| **Backlog** | Issues from connected repos, "Start Run" button per issue |
| **Work** | Project-scoped run list (Active/Queued/Blocked/Done) |
| **Pipeline** | Workflow template visualization (read-only v0.1, editable v0.2) |
| **Workers** | AI/human/script worker configuration for this project |
| **Policies** | Protected paths, gate requirements, concurrency limits |
| **Settings** | GitHub connection, branch config, budget, danger zone |

---

## 2. Core Metaphor: The Pipeline View

The primary interface is NOT a table. It's a **horizontal pipeline visualization** — a series of connected stages that work flows through, left to right.

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                                                                                 │
│                ┌──────────┐        ┌───────────┐                               │
│  ┌────────┐   │ APPROVAL │   ┌───────────┐   │ QUALITY  │   ┌────────┐        │
│  │PLANNING│──▶│   GATE   │──▶│IMPLEMENTING│──▶│  CHECKS  │──▶│ REVIEW │──▶ ✓   │
│  │        │   │          │   │           │   │          │   │        │         │
│  │  ●     │   │    ◉     │   │  ● ●      │   │  ┌─┬─┐  │   │   ●    │         │
│  │        │   │  ⏳ #42  │   │           │   │  └─┴─┘  │   │        │         │
│  └────────┘   └──────────┘   └───────────┘   └──────────┘   └────────┘        │
│                                                                                 │
│  ● = run    ◉ = needs you    ⏳ = waiting    ┌┬┐ = parallel group              │
│  3 active runs · 1 needs attention · $4.20 today                               │
└─────────────────────────────────────────────────────────────────────────────────┘
```

Each **marble** (●) is a run. Marbles move left-to-right through the pipeline. When a marble reaches a human gate, it pulses (◉) to signal "you're needed." When it's blocked or stuck, it turns red.

### 2.1 What You See at a Glance

- **Pipeline stages** — fixed horizontal track showing the workflow template
- **Marbles** — each run is a colored dot positioned at its current stage
- **Pulse** — marbles needing human action pulse/glow (CSS animation)
- **Flow lines** — subtle animated dashes between stages show the direction of flow
- **Parallel fan-out** — when a stage has parallel sub-stages, the track splits into lanes that rejoin
- **Stage labels** — human-friendly names (not internal phase IDs)
- **Run count badge** — each stage shows how many marbles are inside it

```
                    ┌─ testing ─────┐
                    ├─ linting ─────┤
  formatting ──▶    ├─ typechecking ┤   ──▶  reviewing
                    └─ security ────┘
```

### 2.2 Marble States

| Visual | Meaning | Color | CSS |
| --- | --- | --- | --- |
| ● | Active — AI or script is working | Blue | `animate-shimmer` (subtle pulse) |
| ◉ | Needs you — human gate waiting | Amber | `animate-pulse` (attention-grabbing) |
| ◆ | Blocked — something is wrong | Red | Static, tooltip explains why |
| ✓ | Done — completed successfully | Green | Fades to 30% opacity after 1h |
| ✗ | Failed — terminal failure | Red outline | Static |
| ⏸ | Paused — operator paused | Gray | Static |

**Color tokens (theme-aware):**
```css
--marble-active: hsl(217, 91%, 60%);      /* Blue */
--marble-needs-you: hsl(38, 92%, 50%);    /* Amber */
--marble-blocked: hsl(0, 84%, 60%);       /* Red */
--marble-done: hsl(142, 71%, 45%);        /* Green */
--marble-paused: hsl(220, 9%, 46%);       /* Gray */
```

### 2.3 Marble Tooltip (Hover)

Hovering over a marble shows a compact card:

```
┌──────────────────────────────────┐
│ #42 — Add JWT authentication     │
│                                  │
│ Phase: awaiting_plan_approval    │
│ Waiting: 45 min (assigned: @bob) │
│ Cost so far: $1.20               │
│ Attempt: 1/3                     │
│                                  │
│ [Approve]  [View Plan]  [Pause]  │
└──────────────────────────────────┘
```

The tooltip includes **inline actions** — you can approve a gate directly from the tooltip without navigating away. This is the fastest path: hover → approve → done.

### 2.4 Pipeline Scaling

| Active runs | Behavior |
| --- | --- |
| 1-10 | Individual marbles visible per stage |
| 11-30 | Marbles stack as a count badge per stage: `●(5)` |
| 31-100 | Stages show heat-map intensity (darker = more runs). Click to expand. |
| 100+ | Switch to aggregated view: "23 planning · 45 implementing · 12 reviewing" |

---

## 3. The Dashboard — Mission Control

The default landing page. Shows cross-project state at a glance.

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│  CONDUCTOR DASHBOARD                                                     Feb 19 │
├─────────────────────────────────────────────────────────────────────────────────┤
│                                                                                 │
│  ┌─ NEEDS ATTENTION (3) ─────────┐  ┌─ ACTIVE RUNS ──────────────────────┐    │
│  │                                │  │                                     │    │
│  │  ◉ #42 Plan approval (45m)    │  │  acme/webapp:                       │    │
│  │    assigned: @bob              │  │    ● #42 JWT auth ........... 67%   │    │
│  │    [Approve] [View] [Reassign]│  │    ● #55 Fix login .......... 23%   │    │
│  │                                │  │    ● #61 Add search ........ 89%   │    │
│  │  ◉ #67 Merge approval (10m)   │  │                                     │    │
│  │    assigned: @carol            │  │  acme/mobile:                       │    │
│  │    [Merge] [View] [Reassign]  │  │    ● #12 Push notifs ....... 45%   │    │
│  │                                │  │                                     │    │
│  │  ◆ #51 Budget exhausted       │  │  5 active · 2 queued · 12 done     │    │
│  │    $200/$200 used              │  └─────────────────────────────────────┘    │
│  │    [Increase Budget] [Cancel]  │                                             │
│  │                                │  ┌─ COST ──────────────────────────────┐    │
│  └────────────────────────────────┘  │  ▁▂▃▅▇▅▃▂▁▂▃▅ daily cost (14 days) │    │
│                                      │  $18.40 today · $142 this week      │    │
│  ┌─ TODAY ────────────────────────┐  │  Budget: $200/mo → 71% remaining    │    │
│  │  Runs started:    4            │  └─────────────────────────────────────┘    │
│  │  Runs completed:  2            │                                             │
│  │  Cost today:      $18.40      │  ┌─ VELOCITY ──────────────────────────┐    │
│  │  Tokens used:     1.2M        │  │  Avg cycle time:  3.2h              │    │
│  │  Fix cycles:      1           │  │  Success rate:    85%               │    │
│  │  Approval wait:   avg 38min   │  │  Fix cycle rate:  40%               │    │
│  └────────────────────────────────┘  │  Approval wait:   avg 38min         │    │
│                                      └─────────────────────────────────────┘    │
│                                                                                 │
│  ┌─ PIPELINE ──────────────────────────────────────────────────────────────┐    │
│  │  [Full pipeline visualization from § 2 — all active runs, all projects] │    │
│  └─────────────────────────────────────────────────────────────────────────┘    │
│                                                                                 │
│  ┌─ RECENTLY COMPLETED ───────────────────────────────────────────────────┐    │
│  │  ✓ #61 Add search endpoint   1.8h  $6.20  0 fix cycles  (12 min ago)  │    │
│  │  ✓ #38 Refactor auth         2.1h  $8.90  0 fix cycles  (3 hours ago) │    │
│  └─────────────────────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────────────────────┘
```

### 3.1 Dashboard Sections

| Section | Purpose | Update | Position |
| --- | --- | --- | --- |
| **Needs Attention** | Human gates waiting, blocked runs, errors | Real-time (WebSocket) | Top-left, always visible |
| **Active Runs** | In-progress runs across all projects | Real-time | Top-right |
| **Today** | Daily aggregate metrics | Every 30s | Mid-left |
| **Cost** | Sparkline of daily spend + budget remaining | Every 5m | Mid-right |
| **Velocity** | Cycle time, success rate, fix cycle rate | Every 5m | Mid-right |
| **Pipeline** | The marble pipeline from § 2 | Real-time | Center (hero) |
| **Recently Completed** | Last 5 finished runs | Every 30s | Bottom |

### 3.2 Empty State

When no runs exist (new installation):

```
┌─────────────────────────────────────────────────────────────────┐
│                                                                 │
│           Welcome to Conductor                                  │
│                                                                 │
│   No runs yet. Create your first project to get started.        │
│                                                                 │
│   1. Connect your GitHub repository                             │
│   2. Configure worker assignments                               │
│   3. Start a run from your backlog                              │
│                                                                 │
│   [Create Project →]                                            │
│                                                                 │
│   Already have a project? [Import from GitHub →]                │
└─────────────────────────────────────────────────────────────────┘
```

### 3.3 Priority: Needs Attention

The **Needs Attention** panel is always visible, always top-left, always sorted by urgency (longest-waiting first). This is the operator's inbox. Every item here is something only a human can unblock.

**Badge in browser tab title:** `(3) Conductor`

**Sorting rules:**
1. Blocked runs (red) first — these are failures
2. Gates by wait time (longest first) — oldest gates are most urgent
3. Budget warnings last — important but not blocking work

**Each item includes inline actions** — the operator can act without navigating. Approve, merge, increase budget, reassign, cancel — all from the dashboard.

---

## 4. The Run Detail View — Timeline Waterfall

Clicking a marble (or a run in any table) opens the **run detail view**. This is where the "bouncing ball" metaphor comes alive. Instead of a log, you see a **vertical waterfall** of every task in this run, with timing bars proportional to wall-clock time.

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│  #42 — Add JWT authentication                          Total: 3h 12m · $12.40  │
│  Status: active · Phase: reviewing · Attempt: 1/3            [Pause] [Cancel]   │
├─────────────────────────────────────────────────────────────────────────────────┤
│                                                                                 │
│  Phase          Worker                  0m    30m       60m      120m     180m  │
│  ─────          ──────                  ├─────┼─────────┼────────┼────────┤     │
│                                                                                 │
│  pending        pm-engine               ██ intelligence                         │
│                                         (12s · $0.00)                           │
│                                                                                 │
│  planning       planner-claude-opus     ████████████████████ create plan        │
│                                         (1m 30s · $2.10)                        │
│                 notifier                ░ notify                (async, 1s)     │
│                                                                                 │
│  approval       @bob                    ··············◉···············           │
│                                         ⏳ WAITING 45m     ✓ approved           │
│                                                                                 │
│  executing      impl-claude-sonnet      ████████████████████████████ implement  │
│                                         (8 min · $4.80)                         │
│                 notifier                ░ notify                (async, 1s)     │
│                                                                                 │
│  quality        prettier                ██ format (sync, 2s)                    │
│                 ┌ vitest                 ████ test                               │
│                 ├ eslint                 ██ lint          ← parallel             │
│                 ├ tsc                    ██ typecheck        group               │
│                 └ semgrep               ████ security ✗ FAILED (vuln found)     │
│                                                                                 │
│  fix cycle 1    impl-claude-sonnet      ████████ fix (2 min · $1.20)           │
│                 ┌ vitest                 ████ test                               │
│                 ├ eslint                 ██ lint          ← retry                │
│                 ├ tsc                    ██ typecheck                            │
│                 └ semgrep               ██ security ✓                           │
│                                                                                 │
│  review         reviewer-claude-opus    ██████ code review                      │
│                 reviewer-claude-opus    ██ scope review                         │
│                 pm-engine               █ scope creep                           │
│                 @alice                  ···············◉····· ← LIVE (2h)      │
│                                                                                 │
│  ─ remaining ─  merge → post-completion                                        │
│                                                                                 │
├─────────────────────────────────────────────────────────────────────────────────┤
│  Legend: ████ AI work  ██ script  ·◉· human wait  ░ async  ✗ fail  ✓ pass      │
│                                                                                 │
│  Time breakdown: AI 12m (6%) · Script 1m (<1%) · Human 2h45m (86%) · Async 3s  │
│  Cost breakdown: Planning $2.10 · Implementing $6.00 · Reviewing $0.80         │
└─────────────────────────────────────────────────────────────────────────────────┘
```

### 4.1 Key Design Decisions

**Time is the x-axis.** Everything is proportional to wall-clock time. This immediately shows you where time is being spent — and it's almost always the human gates. The AI work compresses into thin bars. The human waits stretch wide. This is intentional: **it makes the cost of slow approvals viscerally obvious.**

**Parallel work fans out vertically.** When multiple workers run in parallel (the quality checks), they stack vertically within the same time window, connected by a bracket `┌├└` showing they're a group.

**Async work is ghosted.** Fire-and-forget async tasks (notifications, analytics) appear as translucent/dashed `░` bars below the main flow. They don't affect the critical path but you can see they happened.

**The bouncing ball.** On a live run, a small glowing indicator moves along the current task's progress bar in real-time. As a task completes and the next starts, the indicator jumps to the new bar. You literally watch the ball bounce through the pipeline.

**Fix cycles are labeled.** When quality checks fail and trigger a fix + re-check, this appears as "fix cycle 1", "fix cycle 2", etc. Multiple fix cycles stack, making retry amplification visible. If you see "fix cycle 3" you immediately know something is struggling.

**Remaining phases are dimmed.** For in-progress runs, phases that haven't started yet appear as a dimmed placeholder ("merge → post-completion"), giving a sense of how far along the run is.

**Time/cost summary footer.** The bottom bar shows a breakdown: how much time was AI vs human vs script, and cost by phase. This is the single most important metric for understanding efficiency.

### 4.2 Interaction: Click Any Bar

Clicking a task bar opens a **side panel** on the right:

```
┌───────────────────────────────────┐
│  task: planning.create            │
│  Worker: planner-claude-opus      │
│  Duration: 1m 30s                 │
│  Cost: $2.10                      │
│  Tokens: 12K in / 8.5K out       │
│  Checkpoint: 2 of 3 steps        │
│                                   │
│  ─── Artifact: PLAN ───           │
│  ## Approach                      │
│  Implement JWT middleware...      │
│  [Full plan →]                    │
│                                   │
│  ─── Streaming Output ───         │
│  [if live: real-time agent output]│
└───────────────────────────────────┘
```

The side panel is the **artifact viewer**. The waterfall always stays visible on the left, maintaining context.

### 4.3 Sticky Actions Bar

At the top of the run detail, a sticky bar shows context-dependent actions:

| Run State | Actions |
| --- | --- |
| Active (AI working) | `[Pause]` `[Cancel]` |
| Gate waiting | `[Approve]` `[Reject]` `[Request Changes]` `[Pause]` |
| Blocked | `[Retry]` `[Cancel]` `[Manual Fix]` |
| Paused | `[Resume]` `[Cancel]` |
| Finished | `[View PR]` `[Rerun]` |

**Pause semantics (from v1):** Pause does not interrupt the current task. It sets a flag: `pausing...` → current task completes → run pauses at the next transition boundary. The operator sees "Pausing after current task..." in the actions bar.

**Cancel semantics (from v1):** Three escalation levels:
1. `[Cancel]` → `stopping...` — waits for current task to complete, then stops
2. After 30s: `[Force Cancel]` → `killing...` — sends abort to worker, waits for acknowledgment
3. After 60s: `[Force Kill]` → immediate termination, task marked as abandoned

---

## 5. The Approval Experience

When an operator clicks on a pulsing marble (◉) or a Needs Attention item, they enter the **approval experience**. This is the most important interaction in Conductor — it's where humans add value.

### 5.1 Plan Approval

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│  PLAN APPROVAL — #42 Add JWT authentication                  Waiting: 45 min   │
│                                                       assigned: @bob           │
├─────────────────────────────────────────────────────────────────────────────────┤
│                                                                                 │
│  ┌─ PLAN ─────────────────────────────────────────────────┐  ┌─ CONTEXT ─────┐ │
│  │                                                         │  │               │ │
│  │  ## Approach                                            │  │ Issue #42     │ │
│  │  Implement JWT auth middleware using RS256 signing.      │  │ 3 ACs         │ │
│  │  Token refresh via rotating refresh tokens.             │  │ Area: backend │ │
│  │  Rate limiting via express-rate-limit.                  │  │               │ │
│  │                                                         │  │ Risk: medium  │ │
│  │  ## AC Traceability                                     │  │ Est: 3.2h     │ │
│  │  ┌───┬──────────────┬──────────────┬──────────┐        │  │ Rework: 23%   │ │
│  │  │ # │ Criterion    │ Impl File    │ Test     │        │  │               │ │
│  │  ├───┼──────────────┼──────────────┼──────────┤        │  │ ── History ── │ │
│  │  │ 1 │ JWT on /api  │ middleware/  │ auth.t   │        │  │ Similar: #31  │ │
│  │  │ 2 │ Refresh      │ routes/auth  │ auth.t   │        │  │ (2.8h, $9.20) │ │
│  │  │ 3 │ Rate limit   │ middleware/  │ rate.t   │        │  │               │ │
│  │  └───┴──────────────┴──────────────┴──────────┘        │  │ ── Budget ──  │ │
│  │                                                         │  │ Est: $8-12    │ │
│  │  ## Scope Boundary                                      │  │ Run: $50 left │ │
│  │  ✓ Only JWT middleware + routes                         │  │ Project: $142 │ │
│  │  ✗ No OAuth (separate issue)                            │  │               │ │
│  │  ✗ No frontend (separate issue)                         │  │ ── Workers ── │ │
│  │                                                         │  │ Plan: opus    │ │
│  │  ## Risks                                               │  │ Impl: sonnet  │ │
│  │  - Token storage needs secure httpOnly cookies          │  │ Review: opus  │ │
│  │  - Rate limit config should be env-variable             │  │               │ │
│  └─────────────────────────────────────────────────────────┘  └───────────────┘ │
│                                                                                 │
│  ┌──────────────────────────────────────────────────────────────────────────┐   │
│  │  Comment (optional — required on reject):                                │   │
│  │  ┌──────────────────────────────────────────────────────────────────┐    │   │
│  │  │                                                                  │    │   │
│  │  └──────────────────────────────────────────────────────────────────┘    │   │
│  │                                                                          │   │
│  │  [✓ Approve]   [✗ Reject]   [↻ Request Changes]   [⏸ Pause Run]        │   │
│  └──────────────────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────────────┘
```

### 5.2 Gate Types and Actions

| Gate Type | Left Panel Shows | Actions |
| --- | --- | --- |
| **Plan Approval** | Rendered plan with AC traceability table | Approve, Reject, Request Changes, Pause |
| **Code Review** | Diff view (Monaco, unified/split) with AI findings inline | Approve, Request Changes, Pause |
| **Merge Approval** | PR summary, CI status, all review verdicts | Merge, Reject, Pause |
| **Failure Escalation** | Error details, failed task output, retry history | Retry with Feedback, Cancel, Manual Fix |
| **Policy Exception** | Policy rule, violation details, risk assessment | Grant Exception (with scope), Deny |

### 5.3 Policy Exception Scope

When granting a policy exception, the operator selects scope:

| Scope | Meaning |
| --- | --- |
| `this_run` | Exception applies to this run only |
| `this_task` | Exception applies to this task only (within the run) |
| `this_repo` | Exception applies to all runs in this repo |
| `project_wide` | Exception applies to all runs in this project |

### 5.4 Approval Principles

- **Show the plan, not the prompt.** Plans are rendered as structured markdown with the traceability table front and center. The operator reads a document, not a chat log.
- **Context sidebar.** Risk score, estimated cost, rework probability, similar past work — all from PM intelligence. Informed decisions without digging.
- **One-click action.** No multi-step workflow. The operator's time is the most expensive resource.
- **Comment is optional** on approve, **required** on reject (becomes the rework directive).
- **Comment integration:** Stored in DB → passed to planner/implementer as rework context → mirrored to GitHub issue as comment.

### 5.5 Bulk Approve

In the Approvals global view, low-risk items can be bulk-approved. An item qualifies for bulk approve ONLY if ALL conditions are met:

- No paths match `sensitive_paths` patterns (from project policies)
- No `elevated_risk_tools` in the plan
- No `policy_warning` events on the run
- Gate type is `plan_approval` (not escalation or exception)
- Estimated complexity ≤ `bulk_approve_complexity_threshold` (default: `medium`)

Qualifying items show a checkbox. The operator selects multiple and clicks `[Approve Selected]`. Each approval is individually recorded with `bulk_approve: true` metadata.

---

## 6. Global Views

### 6.1 Work (`/work`)

The global Work view shows all runs across all projects, organized by intent:

| Tab | Phases Included | Default Sort |
| --- | --- | --- |
| **Active** | planning, executing, proposing, awaiting_merge, merged | Oldest first |
| **Queued** | pending | Oldest first |
| **Blocked** | awaiting_plan_approval, blocked, paused | Longest-blocked first |
| **Done** | completed, cancelled, failed | Most recent first |

**Why `merged` is in Active:** It's an intermediate state — GitHub merge was observed but cleanup (branch deletion, worktree removal, issue close) is still pending. The run isn't finished until cleanup completes.

**Why `awaiting_plan_approval` is in Blocked:** From the operator's perspective, "waiting for me" and "blocked by error" are the same intent: "things that aren't moving forward." The Needs Attention badge distinguishes between "needs you" (amber) and "broken" (red).

Each row shows: Status marble, Issue #, Title, Project, Repo, Phase, Age, Cost, and a context-dependent action button.

### 6.2 Approvals (`/approvals`)

A strict inbox showing **only** items that need human action. Grouped by gate type (never by project):

```
┌─ PLAN APPROVALS ──────────────────────────────────────────────────────────────┐
│  ☐ ◉ #42 Add JWT auth          acme/webapp   45 min   @bob    [Approve][View]│
│  ☐ ◉ #78 Add caching           acme/webapp   12 min   @bob    [Approve][View]│
│                                                                               │
│  [Approve Selected (2)]  ← only shown if items qualify for bulk approve      │
├─ ESCALATIONS ─────────────────────────────────────────────────────────────────┤
│    ◆ #55 Fix login race         acme/webapp   Budget exhausted  [Retry][Cancel]│
├─ POLICY EXCEPTIONS ───────────────────────────────────────────────────────────┤
│    (none)                                                                     │
└───────────────────────────────────────────────────────────────────────────────┘
```

**Project filter:** Sticky dropdown, remembers last selection. Filters all three groups.

### 6.3 Analytics (`/analytics`)

Cross-project operational insights:

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│  ANALYTICS                                              Last 30 days │ 7 days │ │
├─────────────────────────────────────────────────────────────────────────────────┤
│                                                                                 │
│  ┌─ SUMMARY ──────────────────────────────────────────────────────────────┐    │
│  │  Total Runs: 47   Success: 85%   Avg Cycle: 2.8h   Avg Cost: $8.40   │    │
│  └────────────────────────────────────────────────────────────────────────┘    │
│                                                                                 │
│  ┌─ TIME BREAKDOWN ─────────────┐  ┌─ COST BREAKDOWN ─────────────────┐      │
│  │  ████████████████ AI: 23%     │  │  Planning:      $142 (34%)       │      │
│  │  ██ Script: 2%                │  │  Implementing:  $198 (47%)       │      │
│  │  ████████████████████ Human:  │  │  Reviewing:     $52 (12%)        │      │
│  │                     75%       │  │  Other:         $30 (7%)         │      │
│  └───────────────────────────────┘  └─────────────────────────────────┘      │
│                                                                                 │
│  ┌─ RUNS BY PHASE ───────────────────────────────────────────────────────┐    │
│  │  planning      ████ 4                                                  │    │
│  │  implementing  ████████ 8                                              │    │
│  │  reviewing     ██████████████ 14                                       │    │
│  │  completed     ████████████████████████████████████████ 40             │    │
│  └────────────────────────────────────────────────────────────────────────┘    │
│                                                                                 │
│  ┌─ COMPLETIONS (14 days) ────────────────────────────────────────────────┐   │
│  │  ▁▂▃▅▇▅▃▂▁▂▃▅▇▅                                                      │   │
│  │  Mon Tue Wed Thu Fri Mon Tue Wed Thu Fri Mon Tue Wed Thu               │   │
│  └────────────────────────────────────────────────────────────────────────┘   │
│                                                                                 │
│  ┌─ APPROVAL WAIT TIMES ─────────┐  ┌─ FIX CYCLE RATE ───────────────┐      │
│  │  Plan approval: avg 38 min     │  │  40% of runs need ≥1 fix cycle │      │
│  │  Code review:   avg 2.1 hr     │  │  12% of runs need ≥2 fix cycles│      │
│  │  Merge:         avg 18 min     │  │  Avg fix cycles per run: 0.6   │      │
│  │  ▁▃▅▃▁▃▅▇▅▃ trend             │  │  ▅▃▁▃▅▃▁ trend (improving)    │      │
│  └────────────────────────────────┘  └─────────────────────────────────┘      │
└─────────────────────────────────────────────────────────────────────────────────┘
```

**Key analytics insight:** The time breakdown bar makes it immediately obvious that human wait time dominates. This drives organizational change: faster approvals = faster cycle time.

### 6.4 History (`/history`)

Past runs in a **timeline view** grouped by date:

```
┌─ HISTORY ───────────────────────────────────────────────────────────────────────┐
│  [Search: ____________]  [Project: All ▼]  [Status: All ▼]  [Date range ▼]    │
│                                                                                 │
│  Feb 19  ──────────────────────────────────────────────                         │
│  ✓ #42 Add JWT authentication          3.2h  $12.40  1 fix cycle               │
│  ✓ #61 Add search endpoint             1.8h  $6.20   0 fix cycles              │
│  ✗ #55 Fix login race condition         0.5h  $2.10   blocked (budget)          │
│                                                                                 │
│  Feb 18  ──────────────────────────────────────────────                         │
│  ✓ #38 Refactor auth middleware         2.1h  $8.90   0 fix cycles              │
│  ✓ #39 Add rate limiting               1.4h  $5.60   2 fix cycles              │
│                                                                                 │
│  Showing 5 of 47 runs  ·  Avg: 2.1h  $7.04  ·  Fix rate: 40%                 │
│  [Load more]                                                                    │
└─────────────────────────────────────────────────────────────────────────────────┘
```

Clicking a history entry opens the run detail waterfall (§ 4).

---

## 7. Project Views

### 7.1 Project Overview

Project-scoped dashboard with mini pipeline:

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│  acme/webapp                                                    🟢 Healthy      │
│  Overview │ Backlog │ Work │ Pipeline │ Workers │ Policies │ Settings           │
├─────────────────────────────────────────────────────────────────────────────────┤
│                                                                                 │
│  ┌─ STAT CARDS ───────────────────────────────────────────────────────────┐    │
│  │  Active: 3    Blocked: 0    Awaiting Approval: 1    Done This Week: 8 │    │
│  └────────────────────────────────────────────────────────────────────────┘    │
│                                                                                 │
│  ┌─ MINI PIPELINE ─── (project-scoped) ──────────────────────────────────┐    │
│  │  PLAN ──▶ APPROVE ──▶ IMPLEMENT ──▶ CHECK ──▶ REVIEW ──▶ ✓           │    │
│  │   ●         ◉           ● ●                      ●                    │    │
│  └────────────────────────────────────────────────────────────────────────┘    │
│                                                                                 │
│  ┌─ NEEDS ATTENTION ─────┐  ┌─ LAST SHIPPED ────────────────────────────┐    │
│  │  ◉ #42 Plan approval  │  │  #38 Refactor auth — merged 3h ago        │    │
│  │    [Approve] [View]   │  │  PR #124 · 2.1h · $8.90 · 0 fix cycles  │    │
│  └────────────────────────┘  └──────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────────────────────┘
```

### 7.2 Backlog

Issues from connected repos with "Start Run" capability:

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│  BACKLOG                                      [Sync Issues]  Last synced: 5m ago│
├─────────────────────────────────────────────────────────────────────────────────┤
│  [Repo: All ▼]  [Labels: ________]  [Search: ____________]                     │
│                                                                                 │
│  │ #  │ Title                        │ Repo   │ Labels        │ Action    │    │
│  ├────┼──────────────────────────────┼────────┼───────────────┼───────────┤    │
│  │ 42 │ Add JWT authentication       │ webapp │ backend, auth │ [Start ▶] │    │
│  │ 55 │ Fix login race condition     │ webapp │ bug, frontend │ [Start ▶] │    │
│  │ 67 │ Add user search              │ webapp │ feature       │ ● Active  │    │
│  │ 78 │ Upgrade to Next.js 16        │ webapp │ infra         │ [Start ▶] │    │
│  │ 81 │ Add rate limiting            │ webapp │ security      │ ✓ Done    │    │
│                                                                                 │
│  Showing 5 of 23 open issues                                                   │
└─────────────────────────────────────────────────────────────────────────────────┘
```

**Start Run flow:** Click `[Start ▶]` → confirmation dialog with autonomy level and budget → run created → marble appears in pipeline.

### 7.3 Pipeline (Workflow Template)

Visual representation of the project's workflow template:

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│  WORKFLOW TEMPLATE: default                                        v0.1 (readonly)│
├─────────────────────────────────────────────────────────────────────────────────┤
│                                                                                 │
│  ┌────────┐   ┌──────────┐   ┌───────────┐   ┌──────────┐   ┌────────┐        │
│  │ PLAN   │──▶│ APPROVE  │──▶│ IMPLEMENT │──▶│ QUALITY  │──▶│ REVIEW │──▶ ✓   │
│  │        │   │          │   │           │   │          │   │        │         │
│  │ sync   │   │ human    │   │ sync      │   │ parallel │   │ sync   │         │
│  │ AI     │   │ gate     │   │ AI        │   │ scripts  │   │ AI+    │         │
│  │        │   │          │   │           │   │          │   │ human  │         │
│  └────────┘   └──────────┘   └───────────┘   └──────────┘   └────────┘        │
│                                                                                 │
│  Click a stage to see its configuration ▼                                      │
│                                                                                 │
│  ┌─ IMPLEMENT ────────────────────────────────────────────────────────────┐    │
│  │  Mode: sync                                                            │    │
│  │  Role: implementer                                                     │    │
│  │  Operation: implementation.execute                                     │    │
│  │  Timeout: 600s                                                         │    │
│  │  Max retries: 3                                                        │    │
│  │  On failure: retry → rework → block                                   │    │
│  │  Sandbox: workspace-write                                              │    │
│  │  Post-stage: async notify                                              │    │
│  └────────────────────────────────────────────────────────────────────────┘    │
│                                                                                 │
│  Autonomy level: L2 (Supervised)                                               │
│  Plan approval: Human required (L0-L2)                                         │
│  Merge approval: Human required (L0-L2)                                        │
│  Max rework cycles: 3                                                          │
└─────────────────────────────────────────────────────────────────────────────────┘
```

**v0.1:** Read-only. Shows the current template configuration.
**v0.2:** Editable. Drag-and-drop stage reordering, add/remove stages, edit configurations.

### 7.4 Workers

Worker assignment configuration per project:

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│  WORKERS                                                                        │
├─────────────────────────────────────────────────────────────────────────────────┤
│                                                                                 │
│  ┌─ AI WORKERS ───────────────────────────────────────────────────────────┐    │
│  │  Role        │ Primary                │ Failover             │ Status  │    │
│  │  ────        │ ───────                │ ────────             │ ──────  │    │
│  │  planner     │ claude-opus-4-6        │ gpt-4.1              │ 🟢 idle │    │
│  │  implementer │ claude-sonnet-4-6      │ gpt-4.1-mini         │ ● busy  │    │
│  │  reviewer    │ claude-opus-4-6        │ claude-sonnet-4-6    │ 🟢 idle │    │
│  │  documenter  │ claude-sonnet-4-6      │ —                    │ 🟢 idle │    │
│  │                                                                         │    │
│  │  [Add AI Worker]  [Edit]                                                │    │
│  └─────────────────────────────────────────────────────────────────────────┘    │
│                                                                                 │
│  ┌─ HUMAN WORKERS ─────────────────────────────────────────────────────────┐   │
│  │  Role            │ Primary    │ Backup     │ Escalation Timeout         │   │
│  │  plan_approver   │ @bob       │ @alice     │ 4h → backup → 48h cancel  │   │
│  │  merge_approver  │ @carol     │ @bob       │ 4h → backup → 48h cancel  │   │
│  │  human_reviewer  │ @alice     │ @bob       │ 24h → backup → 72h cancel │   │
│  │                                                                          │   │
│  │  [Add Human Worker]  [Edit]                                              │   │
│  └──────────────────────────────────────────────────────────────────────────┘   │
│                                                                                 │
│  ┌─ SCRIPT WORKERS (auto-configured) ─────────────────────────────────────┐    │
│  │  linter: eslint · tester: vitest · formatter: prettier · ...           │    │
│  │  [Configure Scripts →]                                                  │    │
│  └─────────────────────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────────────────────┘
```

---

## 8. The Artifacts Drawer

Every run produces artifacts. These are viewable in a **right-side drawer** that slides in when you click an artifact reference anywhere in the UI.

### 8.1 Artifact Types and Renderers

| Artifact Type | Renderer | Interactive? |
| --- | --- | --- |
| `PLAN` | Markdown with AC traceability table | Yes — checkbox toggle for AC status |
| `CODE` / `PATCHSET` | Diff view (Monaco, unified/split toggle) | Yes — inline comments |
| `REVIEW` | Markdown with findings, severity badges | Yes — finding dismissal |
| `TEST_REPORT` | Structured table with pass/fail/skip counts | Yes — expand to see output |
| `SECURITY_REPORT` | Finding cards with severity, CWE links, fix suggestions | Yes — suppress finding |
| `SCOPE_MAP` | Visual file tree with highlighted changed files | No |
| `RISK_ASSESSMENT` | Radar chart with 7 risk dimensions (0-100 scale) | No |
| `RETROSPECTIVE` | Markdown narrative | No |
| `RELEASE_NOTES` | Markdown with grouped changes | Yes — edit before publish |

### 8.2 Artifact Version Comparison

When a plan is revised (planning → rework → re-plan), the drawer shows a version selector:

```
┌─ PLAN ARTIFACT ─────────────────────────────────────────────────┐
│  Version: [v1 ▼]  [v2]  [v3 (current)]     [Compare v1 ↔ v3]  │
│                                                                  │
│  + Added: Rate limiting approach changed to sliding window       │
│  - Removed: Fixed window approach (per reviewer feedback)        │
│  ~ Modified: Token storage moved from localStorage to httpOnly   │
└──────────────────────────────────────────────────────────────────┘
```

---

## 9. Notifications and Alerts

### 9.1 In-App Notification Feed

The notification bell in the header shows a feed:

```
┌─ NOTIFICATIONS ─────────────────────┐
│                                      │
│ ◉ #42 needs plan approval (45m ago) │
│ ✓ #61 completed (12m ago)           │
│ ✗ #55 quality check failed (8m ago) │
│ ◉ #67 needs merge approval (2m ago) │
│ ⚠ Budget 80% consumed               │
│                                      │
│ [Mark all read]                      │
└──────────────────────────────────────┘
```

### 9.2 External Notification Channels

Configured per project:

| Channel | When | Content |
| --- | --- | --- |
| **Slack** | Gate waiting > 30min, run failed, run completed | Actionable link to Conductor |
| **Email** | Gate waiting > 4h (escalation step 2) | Summary + approve link (magic link auth) |
| **GitHub** | Plan posted, review posted, PR created | Mirrored artifacts as issue/PR comments |
| **Webhook** | All events (configurable filter) | Raw event JSON for custom integrations |

### 9.3 Browser Tab State

```
(3) Conductor          ← 3 items need attention (pulsing favicon)
● Conductor            ← runs active, nothing needs you
Conductor              ← idle, no active runs
```

### 9.4 Escalation Ladder (from INTERFACES.md)

When a human gate times out, notifications escalate:

```
Step 1: Primary assignee timeout (default 4h approval / 24h review)
  → Notify backup assignee + in-app warning

Step 2: Backup assignee timeout (same duration)
  → Notify team channel (Slack/email)

Step 3: Team channel timeout (default 48h)
  → Terminal policy: auto_reject | auto_approve (L3 only) | block | cancel
```

The escalation state is visible in the Needs Attention panel with a countdown timer.

---

## 10. Mobile / Responsive

### 10.1 Design Principle

On mobile, the operator's primary action is **approving gates**. Everything else is secondary.

### 10.2 Mobile Layout

| Breakpoint | Pipeline | Waterfall | Approval |
| --- | --- | --- | --- |
| Desktop (>1024px) | Horizontal | Full waterfall | Side-by-side (plan + context) |
| Tablet (768-1024) | Horizontal, compact | Simplified waterfall | Stacked (plan above context) |
| Mobile (<768px) | Vertical (top-to-bottom) | Time list (no bars) | Card stack (swipeable) |

### 10.3 Mobile Approval (Swipe)

```
┌─────────────────────┐
│ ← REJECT   APPROVE →│
│                     │
│ #42 — JWT Auth      │
│                     │
│ Plan summary...     │
│ 3 ACs mapped        │
│ Risk: medium        │
│ Est: $8-12          │
│                     │
│ [View Full Plan]    │
│                     │
│ ◄═══════●══════════►│
│  swipe to decide    │
└─────────────────────┘
```

Swipe right = approve, swipe left = reject. Swipe triggers a haptic feedback confirmation before committing. "View Full Plan" expands to full-screen scrollable plan.

### 10.4 Push Notifications

Mobile push notifications for gate arrivals. Tapping opens directly to the approval view. On iOS, the notification action buttons allow approve/reject from the notification itself (no app launch needed for simple approvals).

---

## 11. Technical Architecture

### 11.1 Stack

| Layer | Technology | Why |
| --- | --- | --- |
| **Framework** | Next.js 16 (App Router) | Server components for initial load, client for real-time |
| **Styling** | Tailwind CSS v4 + Radix UI primitives (shadcn/ui) | CSS-first config, consistent, accessible, composable |
| **Real-time** | **WebSocket-first** via `next-ws` + orchestrator event bus | Live marble movement, streaming output — **no polling as primary transport** |
| **Pipeline viz** | SVG (React component) | Interactive, accessible, animatable with CSS |
| **Waterfall viz** | Canvas (offscreen rendering) | Performance for 100+ task bars |
| **State** | React Server Components + TanStack Query v5 | Server-first, client revalidation, built-in WebSocket cache invalidation |
| **Auth** | GitHub OAuth | Single sign-on with the connected repos |
| **Diff view** | Monaco Editor (read-only diff mode) | Industry-standard diff UX |
| **Deployment** | Self-hosted (Docker / `next start` standalone) | WebSocket requires persistent connections — not serverless |

> **Why these versions (updated Feb 2026):**
>
> - **Next.js 16** (current LTS: 16.1.x) — over Next.js 15 for improved App Router performance and React 19 integration
> - **Tailwind CSS v4** — CSS-first configuration with `@theme` directive (no more `tailwind.config.js`), 5x faster full builds, 100x faster incremental builds
> - **Radix UI** (via shadcn/ui) — Feb 2026 unified package; alternative: JollyUI (shadcn + React Aria) if deeper accessibility needed
> - **TanStack Query v5** over SWR — superior for complex real-time apps: built-in WebSocket cache invalidation, `streamedQuery` for streaming data, `broadcastQueryClient` for multi-tab sync
> - **`next-ws`** — adds native WebSocket `UPGRADE` handler support to Next.js App Router routes, enabling `ws://` connections at `/api/ws` without a separate server process
> - **Self-hosted requirement** — WebSocket connections are stateful and long-lived; Vercel/serverless platforms don't support them. Conductor runs self-hosted via Docker or `next start --standalone`

### 11.2 Data Flow

**Architecture: WebSocket-first.** The WebSocket connection is the primary data transport for all live state. REST endpoints are used for initial page loads and mutations only. There is no polling loop in steady state.

```
Orchestrator DB (PostgreSQL)
    │
    ▼
Next.js Server (self-hosted, next start --standalone)
    │
    ├── REST  /api/dashboard         → Dashboard aggregate data (initial load)
    ├── REST  /api/runs              → Run list (initial load, filterable)
    ├── REST  /api/runs/:id          → Run detail + timeline + cost (initial load)
    ├── REST  /api/runs/:id/tasks    → Task list for waterfall rendering (initial load)
    ├── REST  /api/gates             → Pending gates (initial load)
    ├── REST  /api/gates/count       → Badge count (initial load)
    ├── POST  /api/gates/:id/resolve → Approve/reject/grant with comment
    ├── REST  /api/artifacts/:id     → Artifact content (rendered markdown/diff)
    ├── REST  /api/projects          → Project list with health (initial load)
    ├── REST  /api/projects/:id      → Project detail + settings (initial load)
    ├── REST  /api/analytics         → Cross-project analytics (load on visit)
    ├── POST  /api/runs              → Start a new run
    ├── POST  /api/runs/:id/pause    → Pause a run
    ├── POST  /api/runs/:id/cancel   → Cancel a run (with escalation level)
    │
    └── WS    /api/ws                → PRIMARY real-time event stream (via next-ws UPGRADE handler)
              │
              ├── Subscribes to orchestrator event bus on connection
              ├── Multiplexes all event types over single connection
              ├── Client sends: subscribe/unsubscribe per run/project scope
              └── Server sends: all events in § 11.3 table
    │
    ▼
React Components (TanStack Query v5 for cache + WebSocket invalidation)
    ├── PipelineView           → SVG marble pipeline (§ 2)
    ├── WaterfallView          → Canvas timeline waterfall (§ 4)
    ├── ApprovalPanel          → Gate approval experience (§ 5)
    ├── ArtifactDrawer         → Right-side artifact viewer (§ 8)
    ├── DashboardLayout        → Mission control layout (§ 3)
    ├── NeedsAttentionPanel    → Prioritized action inbox
    ├── NotificationFeed       → Notification bell dropdown
    ├── ProjectOverview        → Project-scoped mini dashboard
    ├── BacklogTable           → Issue list with Start Run
    ├── AnalyticsCharts        → Sparklines, bar charts, trends
    ├── WorkerConfig           → AI/Human/Script worker editor
    └── HistoryTimeline        → Date-grouped past runs
```

### 11.3 Real-Time Events (WebSocket-First)

**WebSocket is the primary transport.** All live state updates flow through a single multiplexed WebSocket connection per browser tab. Polling exists only as a degraded fallback when WebSocket is unavailable.

#### Connection Lifecycle

```
Browser tab opens
    │
    ▼
Connect WS to /api/ws (with auth token in first message)
    │
    ├─ On open: Subscribe to relevant scopes (projects, runs)
    ├─ On message: TanStack Query cache invalidation per event type
    ├─ On close: Exponential backoff reconnect (1s, 2s, 4s, 8s, max 30s)
    │            Show yellow banner after 5s: "Reconnecting..."
    │            Activate polling fallback after 15s disconnected
    └─ On error: Same as close
```

**Client → Server messages:**

| Message | Purpose |
| --- | --- |
| `{ type: "auth", token: "..." }` | Authenticate on connect |
| `{ type: "subscribe", scope: "run:42" }` | Subscribe to events for run #42 |
| `{ type: "subscribe", scope: "project:acme/webapp" }` | Subscribe to project events |
| `{ type: "unsubscribe", scope: "run:42" }` | Unsubscribe when navigating away |
| `{ type: "ping" }` | Keepalive (every 30s) |

**Server → Client events:**

| Event | Trigger | UI Effect | TanStack Query Invalidation |
| --- | --- | --- | --- |
| `run.created` | New run started | Marble appears at first pipeline stage | `["runs"]`, `["dashboard"]` |
| `run.phase_changed` | Run moves to new phase | Marble slides to new pipeline stage (300ms ease-out) | `["runs", runId]` |
| `task.started` | Worker begins task | New bar appears in waterfall, bouncing ball jumps | `["runs", runId, "tasks"]` |
| `task.progress` | Worker reports progress | Bar grows, progress % updates | (direct state update, no refetch) |
| `task.completed` | Worker finishes | Bar completes, shimmer stops | `["runs", runId, "tasks"]` |
| `gate.waiting` | Human gate reached | Marble changes to ◉ (pulse), notification fires | `["gates"]`, `["gates", "count"]` |
| `gate.resolved` | Human approves/rejects | Marble changes back to ● or ◆, moves on | `["gates"]`, `["gates", "count"]` |
| `run.finished` | Run completes/fails/cancelled | Marble fades to ✓ or ✗ | `["runs"]`, `["dashboard"]` |
| `budget.warning` | Budget threshold hit | Cost card flashes amber | `["runs", runId]` |
| `budget.exhausted` | Budget exceeded | Cost card turns red, affected runs show ◆ | `["runs", runId]` |
| `worker.circuit_open` | Worker type failing | Worker status badge turns red in Workers view | `["workers"]` |
| `escalation.step` | Gate timeout escalation | Countdown timer updates in Needs Attention | `["gates"]` |

**Multi-tab sync:** TanStack Query's `broadcastQueryClient` plugin synchronizes cache state across browser tabs via the Broadcast Channel API. When one tab receives a WebSocket event, all tabs update without redundant connections.

#### Degraded Mode: Polling Fallback

Polling activates **only** when WebSocket has been disconnected for >15 seconds. A yellow banner displays: "Live updates paused — refreshing periodically. [Reconnect]"

| Screen | Polling Interval (degraded only) |
| --- | --- |
| Dashboard | 30s |
| Run Detail | 10s |
| Approvals | 15s |
| Work (active tab) | 30s |
| Analytics | Load on visit only |

**When WebSocket reconnects:** Polling stops immediately. Banner disappears. Client sends a `subscribe` for all active scopes and requests a state snapshot to catch up on missed events.

### 11.4 Performance Budget

| Metric | Target | Measurement |
| --- | --- | --- |
| Dashboard initial load | < 1.5s | Largest Contentful Paint |
| Pipeline animation | 60fps | requestAnimationFrame consistency |
| Waterfall render (100 tasks) | < 100ms | Canvas draw time |
| Waterfall render (500 tasks) | < 300ms | Canvas draw time |
| WebSocket event → UI update | < 200ms | Event receipt to DOM paint |
| Marble transition animation | 300ms | CSS transition duration |
| Approval action → confirmed | < 500ms | Click to API response |
| Artifact drawer open | < 300ms | Panel slide animation + content load |
| Side panel artifact render | < 500ms | Markdown/diff parse + display |

### 11.5 Accessibility

| Requirement | Implementation |
| --- | --- |
| **WCAG 2.1 AA** | All interactive elements, color contrast ratios |
| **Pipeline keyboard nav** | Arrow keys move between stages, Enter selects marble, Escape closes |
| **Marble state** | `aria-label` on each marble: "Run 42, awaiting plan approval, waiting 45 minutes" |
| **Screen reader** | Pipeline has `role="img"` with descriptive `aria-label`; tables exist as SR-only alternative |
| **Reduced motion** | `prefers-reduced-motion: reduce` disables shimmer/pulse, uses static indicators instead |
| **Focus management** | Approval panel traps focus; Escape returns to pipeline |
| **Color independence** | Marble states use shape + color (● vs ◉ vs ◆ vs ✓ vs ✗) |

---

## 12. Design Principles

1. **Pipeline first, tables second.** The visual pipeline is the primary navigation. Tables exist for detail views and history, never as the landing page.

2. **Operator time is sacred.** Every human interaction (approval, review) should be achievable in under 30 seconds. Show what they need, let them act, get out of the way.

3. **Make the invisible visible.** AI work is invisible by default (it happens fast). Human wait time is invisible by default (it's just... waiting). The waterfall makes both visible and proportional, revealing where time actually goes.

4. **Progressive disclosure.** Dashboard → Pipeline → Run Detail → Task Detail → Streaming Output. Each click goes deeper. You never see more than you need at any level.

5. **Sound and motion with purpose.** The marble animation isn't decorative — it tells you something changed. The pulse isn't decorative — it means you're needed. Motion conveys state, not decoration.

6. **No dead screens.** If nothing is happening (no active runs), the dashboard shows useful information: recent history, cost trends, team velocity. Never a blank page.

7. **GitHub is the mirror, Conductor is the source.** The operator works in Conductor. GitHub shows mirrored summaries (plan comments, review comments, PR). The operator never needs to leave Conductor to understand or approve work.

8. **Checkpoint-first decisions.** Streaming output is for observability only. Every operator decision (approve, reject, grant exception) operates on a stable artifact that won't change while you're reading it.

9. **Runs are machines.** Each run has state (phase), controls (pause/cancel/approve), gauges (cost, time, progress), and alarms (blocked, failed, budget). The UI is a control panel, not a feed.

10. **Every action is a button.** No slash commands, no GitHub-based control, no CLI required. If an operator needs to do something, there's a button for it in Conductor.

---

## 13. Screen Inventory

Complete list of screens/routes:

| Route | Screen | Primary Component |
| --- | --- | --- |
| `/` | Redirect to `/dashboard` | — |
| `/dashboard` | Mission Control | DashboardLayout + PipelineView |
| `/work` | Global Work (tabs) | WorkTabs + RunTable |
| `/approvals` | Approval Inbox | ApprovalGroups + ApprovalCards |
| `/analytics` | Analytics | AnalyticsCharts |
| `/history` | Run History | HistoryTimeline |
| `/projects` | Project List | ProjectCards |
| `/projects/:id` | Project Overview | ProjectOverview + MiniPipeline |
| `/projects/:id/backlog` | Backlog | BacklogTable |
| `/projects/:id/work` | Project Work | WorkTabs (auto-filtered) |
| `/projects/:id/pipeline` | Workflow Template | TemplateViz |
| `/projects/:id/workers` | Worker Config | WorkerConfig |
| `/projects/:id/policies` | Policies | PolicyEditor |
| `/projects/:id/settings` | Project Settings | SettingsForm |
| `/runs/:id` | Run Detail | WaterfallView + StickyActions |
| `/settings` | Global Settings | SettingsForm |

---

## 14. Migration from v1/v2

This spec supersedes CONTROL_PLANE_UX.md (v1) and CONTROL_PLANE_UX_V2.md (v2). Key changes:

| v2 Feature | v3 Change | Rationale |
| --- | --- | --- |
| Table-based run views | Pipeline + waterfall | Visual flow reveals timing and state |
| Phase timeline (horizontal) | Waterfall (vertical, time-proportional) | Shows actual time distribution |
| Polling-only real-time | **WebSocket-first** (polling only as degraded fallback) | True real-time marble movement, no polling in steady state |
| No cost visibility | Cost per run, per day, budget tracking | Cost awareness drives optimization |
| Desktop-only | Responsive with mobile-first approval | Operators approve from anywhere |
| No analytics | Time/cost/velocity analytics | Data-driven process improvement |
| Tab-based navigation only | Pipeline as primary + tabs for detail | Visual-first, progressive disclosure |

**Preserved from v1/v2:**
- Two-layer navigation (global sidebar + project tabs)
- Gate type grouping in approvals
- Bulk approve with deterministic safety rules
- Safe cancel semantics (pause → stop → kill)
- Comment integration (DB → agents → GitHub)
- Checkpoint-first decision model
- Empty states for every screen
- Project health indicators

---

## 15. Appendix A: Codex Review Resolutions

This section addresses findings from adversarial review of this spec.

### A.1 Pipeline Across Heterogeneous Templates (BLOCKING #1)

**Problem:** The global dashboard pipeline assumes all projects share the same workflow template. When projects have custom templates (v0.2+), a single pipeline track is undefined.

**Resolution — Canonical Phase Map:**

All workflow templates MUST map their stages to a canonical global phase sequence. Custom stages are placed within these canonical phases:

| Canonical Phase | Meaning | Custom stages map here |
| --- | --- | --- |
| `planning` | Any planning/scoping activity | design, spike, decompose, etc. |
| `approval` | Any human gate before execution | plan_approval, scope_approval, etc. |
| `executing` | Any implementation activity | implementing, migration, docs, etc. |
| `checking` | Any automated quality checks | testing, linting, security scan, etc. |
| `reviewing` | Any review (AI or human) | code_review, security_review, etc. |
| `merging` | PR/merge gate | merge_approval, CI, deploy, etc. |
| `done` | Terminal state | completed, cancelled, failed |

The **global pipeline** always shows these 6 canonical phases. Marbles are positioned by their canonical phase, regardless of which custom stage they're actually in. The marble tooltip shows the actual stage name.

**Per-project pipeline** (Project → Pipeline tab) shows the project's actual template stages, which may differ from the canonical map.

### A.2 Action Accessibility (BLOCKING #2)

**Problem:** Hover tooltips with inline actions, swipe-to-decide, and canvas waterfall create keyboard/screen-reader gaps.

**Resolution:**

1. **Tooltips are convenience, not the only path.** Every action available in a tooltip MUST also be accessible via:
   - The **Needs Attention panel** (dashboard) — always visible, always keyboard-navigable
   - The **Approvals page** (`/approvals`) — full approval experience with buttons
   - The **Run Detail actions bar** — sticky bar with all context-dependent actions

2. **Waterfall DOM fallback.** The Canvas waterfall has a hidden semantic `<table>` underneath it with the same data (phase, worker, duration, status). Screen readers access the table; sighted users see the Canvas. The table is also shown when `prefers-reduced-motion: reduce` is set.

3. **Keyboard navigation for pipeline:**
   - `Tab` to reach pipeline → `Arrow keys` to move between stages → `Enter` to open stage (shows marble list) → `Arrow keys` to select marble → `Enter` to open run detail
   - Focus ring visible on all interactive elements

4. **Swipe is preselect only.** On mobile, swipe gestures pre-select the action and show a confirmation sheet. The actual commit requires tapping "Confirm Approve" or "Confirm Reject" on the sheet. No accidental approvals.

### A.3 Destructive Action Safety (BLOCKING #3)

**Problem:** Cancel/force-cancel/force-kill lack confirmation dialogs.

**Resolution — Cancel Confirmation Flow:**

```
Operator clicks [Cancel]
    │
    ▼
┌─────────────────────────────────────────────────┐
│  Cancel Run #42?                                 │
│                                                  │
│  This will:                                      │
│  • Stop after current task completes             │
│  • Mark run as cancelled                         │
│  • PR (if created) will NOT be deleted           │
│                                                  │
│  Affected:                                       │
│  • Run: #42 — Add JWT authentication             │
│  • Repo: acme/webapp                             │
│  • Phase: executing (task in progress)            │
│                                                  │
│  [Cancel Run]  [Go Back]                         │
└─────────────────────────────────────────────────┘
```

**Force Cancel** (appears after 30s if run hasn't stopped):

```
┌─────────────────────────────────────────────────┐
│  Force Cancel Run #42?                           │
│                                                  │
│  Current task has not responded to cancel signal. │
│  Force cancel will:                              │
│  • Immediately abort the current task            │
│  • Partial work may be lost                      │
│  • Worker will be sent kill signal               │
│                                                  │
│  Type "force cancel" to confirm:                 │
│  ┌──────────────────────────────┐               │
│  │                              │               │
│  └──────────────────────────────┘               │
│                                                  │
│  [Force Cancel]  [Keep Waiting]                  │
└─────────────────────────────────────────────────┘
```

**Bulk operations** also require confirmation showing the count and list of affected runs.

### A.4 Repo Management (BLOCKING #4)

**Problem:** Repos tab was dropped. Backlog depends on connected repos.

**Resolution:** Restore **Repos** as a sub-tab of Project Settings, not a top-level tab (it's a setup concern, not a daily operation):

```
Project → Settings
  ├── General (branch config, budget)
  ├── Repos ← restored here
  │     ├── Connected repos list
  │     ├── Add Repository flow
  │     ├── Per-repo: status (Registered/Scanning/Error), profile, branch, last indexed
  │     └── Repo-level troubleshooting (re-index, disconnect)
  ├── Notifications
  └── Danger Zone
```

Updated project tab bar:
```
Overview │ Backlog │ Work │ Pipeline │ Workers │ Policies │ Settings
```

Settings subsumes Repos (since repo management is infrequent after initial setup).

### A.5 Auth and Approval Security (BLOCKING #5)

**Problem:** GitHub OAuth + magic links + iOS notification approval create conflicting auth models.

**Resolution — Single Auth Model:**

1. **Primary auth:** GitHub OAuth. All web sessions authenticated via GitHub OAuth flow. Session token is httpOnly, SameSite=Strict, 24h expiry.

2. **Approval-grade actions** (approve, reject, grant exception, cancel, force-cancel) require:
   - Valid session token (not expired)
   - `request_id` for idempotency
   - `actor` field recorded in audit log
   - If session is >4h old: **step-up auth** (re-authenticate via GitHub OAuth)

3. **Email approve links:** Use short-lived signed tokens (1h expiry, single-use, bound to specific gate ID). Token resolves the action; user still sees a confirmation page before committing. NOT a magic link that auto-approves.

4. **Mobile push notifications:** Deep-link into the web app (PWA or native wrapper). The notification action opens the approval view; the actual approval still requires the authenticated session and confirmation tap. No approve-from-lock-screen (too risky).

### A.6 Gate Concurrency (BLOCKING #6)

**Problem:** Two operators can act on the same gate simultaneously.

**Resolution — Optimistic Locking:**

```typescript
// Gate resolution request
POST /api/gates/:id/resolve
{
  action: 'approve' | 'reject' | 'request_changes' | 'grant_exception',
  comment?: string,
  gate_version: number,  // ← optimistic lock token
  request_id: string,    // ← idempotency key
}

// If gate_version doesn't match current:
409 Conflict
{
  error: 'GATE_ALREADY_RESOLVED',
  resolved_by: '@alice',
  resolved_at: '2026-02-19T10:30:00Z',
  action: 'approved',
}
```

**UI behavior on conflict:**

```
┌─────────────────────────────────────────────────┐
│  This gate was already resolved                  │
│                                                  │
│  @alice approved this gate 2 minutes ago.        │
│  Your action was not applied.                    │
│                                                  │
│  [View Run Detail]  [Dismiss]                    │
└─────────────────────────────────────────────────┘
```

WebSocket `gate.resolved` events update the UI in real-time, so in most cases the operator will see the approval disappear before they can click. The optimistic lock is a safety net.

### A.7 Phase Label Consistency (HIGH #7)

**Resolution — Canonical Phase-to-Label Map:**

| Internal Phase | UI Label | Marble State | Badge Variant |
| --- | --- | --- | --- |
| `pending` | Queued | ⏸ (gray) | `secondary` |
| `planning` | Planning | ● (blue) | `default` |
| `awaiting_plan_approval` | Plan Approval | ◉ (amber) | `warning` |
| `executing` | Implementing | ● (blue) | `default` |
| `testing` | Checking | ● (blue) | `default` |
| `awaiting_review` | Review | ● (blue) | `default` |
| `reviewing` | Review | ● (blue) | `default` |
| `proposing` | PR Ready | ● (blue) | `default` |
| `awaiting_merge` | Merge Gate | ◉ (amber) | `warning` |
| `merged` | Merging | ● (blue) | `default` |
| `completed` | Done | ✓ (green) | `success` |
| `cancelled` | Cancelled | ✗ (red outline) | `destructive` |
| `failed` | Failed | ✗ (red outline) | `destructive` |
| `blocked` | Blocked | ◆ (red) | `destructive` |
| `paused` | Paused | ⏸ (gray) | `secondary` |

This table is the **single source of truth** for phase display. All views (pipeline, tooltip, work tabs, run detail) use this map. Internal phase IDs never appear in the UI.

### A.8 Scaling: Never Hide Urgent Items (HIGH #8)

**Resolution:** Amend § 2.4 Pipeline Scaling:

At ANY scale level (even 100+ runs), marbles in the `◉ needs-you` state are **never aggregated away**. They remain as individually visible pulsing dots pinned to the top of their pipeline stage. The "Needs Attention" panel is also always visible as an escape hatch.

Revised scaling:

| Active runs | Behavior |
| --- | --- |
| 1-10 | Individual marbles per stage |
| 11-30 | ◉ needs-you marbles shown individually; other marbles as count badge: `●(5)` |
| 31-100 | ◉ pinned at top; rest as heat-map. Click stage to expand. |
| 100+ | ◉ pinned at top; aggregated count + heat-map. Needs Attention panel is primary nav. |

### A.9 Dashboard Information Density (HIGH #9)

**Resolution:** Dashboard sections are **collapsible**. Default collapsed state:

| Section | Default State | Why |
| --- | --- | --- |
| Needs Attention | **Always expanded** | Primary purpose of the dashboard |
| Pipeline | **Always expanded** | Core visualization |
| Active Runs | Collapsed to count only ("5 active") | Expand if you want the list |
| Today / Cost / Velocity | Collapsed to single summary line | "4 runs · $18.40 · avg 3.2h" |
| Recently Completed | Collapsed | Expand for history |

The collapsed summary line reads: `Today: 4 started · 2 done · $18.40 · 3.2h avg` — fitting the "3-second glance" promise.

### A.10 WebSocket Rate Control (HIGH #10)

**Resolution — Event Coalescing:**

| Event | Max rate | Coalescing strategy |
| --- | --- | --- |
| `task.progress` | 1/second per run | Latest value wins (discard intermediate) |
| `run.phase_changed` | No limit | Always delivered (infrequent, high-value) |
| `gate.waiting` / `gate.resolved` | No limit | Always delivered (action-required) |
| `task.started` / `task.completed` | 2/second global | Queue and batch-deliver every 500ms |
| `budget.warning` | 1/minute | Deduplicate by scope_id |

**Client-side throttling:** The WebSocket client buffers events and applies them in `requestAnimationFrame` batches. This prevents DOM thrashing when multiple events arrive in the same frame.

**Degraded mode:** If WebSocket event rate exceeds 50 events/second sustained for >5 seconds, the client switches to coalesced mode (batching all events into 1-second windows) and shows a banner: "High activity — updates batched." It does NOT fall back to polling — the WebSocket connection stays open; only the rendering frequency is throttled.

### A.11 Mobile Reject Comment (HIGH #11)

**Resolution:** Swipe-to-reject always opens a **comment sheet** before committing:

```
Swipe left (reject)
    │
    ▼
┌─────────────────────┐
│  Reject #42?         │
│                      │
│  Comment (required): │
│  ┌──────────────────┐│
│  │                  ││
│  │                  ││
│  └──────────────────┘│
│                      │
│  [Confirm Reject]    │
│  [Cancel]            │
└─────────────────────┘
```

Swipe-to-approve shows a brief confirmation ("Approve #42? [Confirm] [Cancel]") without requiring a comment.

### A.12 Bulk Emergency Controls (HIGH #12)

**Resolution — Bulk Controls on Work View:**

The Work view (`/work`) Active tab includes bulk controls:

```
┌─ ACTIVE RUNS ────────────────────────────────────────────────────────────┐
│  ☐ All  [⏸ Pause Selected]  [✗ Cancel Selected]  ← only when items checked│
│                                                                          │
│  ☐ ● #42 JWT auth          acme/webapp   implementing   $4.80          │
│  ☐ ● #55 Fix login         acme/webapp   planning       $0.40          │
│  ☐ ● #61 Add search        acme/mobile   reviewing      $6.20          │
└──────────────────────────────────────────────────────────────────────────┘
```

Bulk cancel requires:
- Same-project constraint (can't bulk-cancel across projects)
- Confirmation dialog listing all affected runs
- No typed confirmation needed for bulk pause (reversible)
- Typed confirmation needed for bulk cancel ("cancel N runs")

### A.13 Screen State Matrix (HIGH #13)

Every screen handles these states:

| State | Behavior |
| --- | --- |
| **Loading** | Skeleton placeholders (not spinner). Pipeline shows gray empty stages. |
| **Empty (no data)** | Contextual message + CTA (see § 3.2 for dashboard; each screen has equivalent) |
| **Error (API failure)** | Red banner at top: "Failed to load [section]. [Retry]". Other sections still render. |
| **WebSocket offline** | Yellow banner: "Live updates paused — reconnecting..." (after 15s: activates polling fallback + "[Reconnect Now]" button) |
| **Partial data** | Each dashboard section loads independently. Failed sections show error; successful sections render. |
| **Stale data** | If data is >5m old, show "Last updated X min ago" label. |

**Key empty states:**

| Screen | Empty Message | CTA |
| --- | --- | --- |
| Dashboard (no projects) | "Welcome to Conductor" | [Create Project →] |
| Dashboard (no runs) | "No active runs" | "Start a run from your backlog" |
| Backlog (no repos) | "Connect a repository to see issues" | [Add Repository →] |
| Backlog (no issues) | "No open issues found" | [Sync Issues] |
| Approvals (none) | "Nothing needs your attention" | (show recently completed instead) |
| Analytics (no data) | "Complete some runs to see analytics" | — |

### A.14 Navigation Discoverability (HIGH #14)

**Resolution — Updated sidebar:**

```
┌────────────┐
│  ◈ CONDUCTOR│
│             │
│  ◉(3)       │
│  Dashboard  │
│  ● Work     │
│  ◉ Approvals│
│  📈 Analytics│
│  🕐 History  │   ← added
│             │
│  ─────────  │
│  PROJECTS   │
│  acme/webapp│
│  acme/mobile│
│  [+ Add]    │   ← added
│             │
│  ─────────  │
│  ⚙ Settings │
└────────────┘
```

History and Add Project are now explicitly in the sidebar.

### A.15 Request Changes Comment Requirement (MEDIUM #15)

**Resolution:** Updated comment requirements:

| Action | Comment |
| --- | --- |
| Approve | Optional |
| Reject | **Required** (becomes cancellation reason) |
| Request Changes | **Required** (becomes rework directive passed to AI) |
| Grant Exception | **Required** (justification for audit trail) |
| Deny Exception | Optional |

### A.16 Accessibility: Interactive Pipeline Semantics (MEDIUM #16)

**Resolution:** The pipeline SVG uses `role="grid"` semantics:

- Each stage is a `role="row"` with `aria-label="Planning stage, 2 active runs"`
- Each marble is a `role="gridcell"` with `aria-label="Run 42, Add JWT authentication, active, 67% complete"`
- Arrow keys navigate between stages (left/right) and marbles within a stage (up/down)
- Enter opens run detail; Space activates inline action

A separate `role="region" aria-label="Pipeline summary"` provides a text description: "3 runs active: 1 in planning, 1 in implementing, 1 in review. 1 run needs your approval."

### A.17 Unified Detail Drawer (MEDIUM #17)

**Resolution:** The run detail view has ONE right-side panel with tabs:

```
┌─ PANEL ──────────────────────┐
│  [Task] [Artifacts] [Stream] │
│                              │
│  (content based on tab)      │
└──────────────────────────────┘
```

- **Task tab:** Task details, operation, worker, cost, tokens, checkpoint
- **Artifacts tab:** Artifact list for this run, click to render
- **Stream tab:** Live streaming output for current task (or replay for completed)

Only one panel exists. No collision between task panel and artifact drawer.

### A.18 Polling Interval Consistency (MEDIUM #18)

**Resolution — Single source of truth. WebSocket is the primary transport. Polling activates ONLY when WebSocket has been disconnected for >15 seconds:**

| Screen | WebSocket (primary) | Polling (degraded fallback only) |
| --- | --- | --- |
| Dashboard | Real-time | 30s |
| Run Detail | Real-time | 10s |
| Approvals | Real-time | 15s |
| Work (Active tab) | Real-time | 30s |
| Work (Done tab) | None | Load on visit |
| Analytics | None | Load on visit |
| History | None | Load on visit |
| Sidebar badge | Real-time | 30s |

This is the **only** polling interval table. No other section may define conflicting intervals. In normal operation, no polling occurs — all updates arrive via WebSocket. See § 11.3 for the full connection lifecycle and degraded mode activation rules.

### A.19 First-Run Experience (SUGGESTION #19)

On first visit (no prior sessions), show a brief walkthrough:

1. Highlight pipeline: "This is your workflow. Work flows left to right."
2. Highlight marble: "Each dot is a run. Pulsing dots need your action."
3. Highlight Needs Attention: "This is your inbox. Items here are waiting on you."
4. "You can switch to table view anytime" → toggle in header: `[Pipeline] [Table]`

The table view is always available as an alternative. Some operators prefer density over visualization.

### A.20 Keyboard Shortcuts (SUGGESTION #20)

Global keyboard shortcuts (configurable in Settings):

| Shortcut | Action |
| --- | --- |
| `g d` | Go to Dashboard |
| `g w` | Go to Work |
| `g a` | Go to Approvals |
| `g h` | Go to History |
| `?` | Show shortcut help |
| `j / k` | Navigate list items (down/up) |
| `Enter` | Open selected item |
| `Escape` | Close panel / go back |
| `a` | Approve (when on gate) |
| `r` | Reject (when on gate) |

**Density control:** `Ctrl+Plus` / `Ctrl+Minus` adjusts UI density (compact/comfortable/spacious) across all views.
