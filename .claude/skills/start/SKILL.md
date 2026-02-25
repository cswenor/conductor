---
name: start
description: Start your session with AI-powered planning. Analyzes project state, surfaces risks, recommends what to work on, and generates standup.
argument-hint: '[available-minutes] [focus-area]'
allowed-tools: Read, Glob, Grep, Bash(gh issue view *), Bash(gh pr list *), mcp__pm_intelligence__optimize_session, mcp__pm_intelligence__get_risk_radar, mcp__pm_intelligence__detect_patterns, mcp__pm_intelligence__generate_standup, mcp__pm_intelligence__suggest_next_issue, mcp__pm_intelligence__get_project_dashboard, mcp__pm_intelligence__get_board_summary, mcp__pm_intelligence__get_issue_status, mcp__pm_intelligence__move_issue, mcp__pm_intelligence__sync_from_github, mcp__pm_intelligence__check_decision_decay, mcp__pm_intelligence__bulk_triage, mcp__pm_intelligence__get_workflow_health, mcp__pm_intelligence__get_velocity, mcp__pm_intelligence__get_dora_metrics, mcp__pm_intelligence__forecast_backlog, mcp__pm_intelligence__get_team_capacity, mcp__github__get_issue, mcp__github__search_issues, AskUserQuestion
---

# /start - Intelligent Session Kickoff

Start every session with full situational awareness. This skill uses PM intelligence tools to analyze project state, surface risks, recommend work, and generate a standup — all in one command.

**Input:** `$ARGUMENTS` (optional: available minutes and/or focus area)

---

## Why This Exists

Without `/start`, Claude begins each session blind — no idea what's important, what's risky, what's stuck. You waste the first 10 minutes figuring out where things stand. `/start` front-loads that intelligence so you're productive immediately.

---

## Step 1: Parse Arguments

Parse `$ARGUMENTS`:

- **Empty** → Full session planning (default 60 minutes, no area filter)
- **Number only** (e.g., `30`) → Session planning with time constraint
- **Text only** (e.g., `frontend`) → Session planning focused on area
- **Number + text** (e.g., `45 contracts`) → Time-constrained + area-focused

Store as `available_minutes` (default: 60) and `focus_area` (default: null).

---

## Step 2: Gather Intelligence (Parallel)

Run ALL of these in parallel — they are independent:

### 2a. Session Plan

```
mcp__pm_intelligence__optimize_session({
  availableMinutes: <available_minutes>,
  focusArea: <focus_area or omit>
})
```

Returns: recommended work plan, quick wins, deferrals, session goal.

### 2b. Risk Radar

```
mcp__pm_intelligence__get_risk_radar()
```

Returns: overall risk score (0-100), prioritized risks across 6 categories (delivery, quality, knowledge, process, dependencies, capacity), mitigations.

### 2c. Pattern Detection

```
mcp__pm_intelligence__detect_patterns()
```

Returns: anomalies and early warning signals from cross-cutting analysis.

### 2d. Yesterday's Activity

```
mcp__pm_intelligence__generate_standup()
```

Returns: what was done yesterday, what's planned today, blockers.

### 2e. Board Health

```
mcp__pm_intelligence__get_workflow_health()
```

Returns: per-issue health scores, stale items, bottlenecks.

### 2f. Stale Decisions Check

```
mcp__pm_intelligence__check_decision_decay()
```

Returns: architectural decisions whose context has drifted since they were made.

---

## Step 3: Synthesize Briefing

Combine all intelligence into a single briefing. Use this format:

```markdown
## Session Briefing

**Time budget:** <minutes> min | **Focus:** <area or "all"> | **Risk level:** <score>/100

---

### What Happened Since Last Session

<From standup: 2-3 bullet points of recent activity>

### Recommended Plan

<From optimize_session: ordered list of recommended work>

**Session goal:** <one sentence>

#### Quick Wins (< 15 min each)
<From optimize_session: items that can be knocked out fast>

#### Can Defer
<From optimize_session: items that can wait>

---

### Risk Dashboard

**Overall:** <score>/100 <trend arrow>

| Category       | Level    | Top Concern                  |
|---------------|----------|------------------------------|
| Delivery      | <level>  | <one-line>                   |
| Quality       | <level>  | <one-line>                   |
| Knowledge     | <level>  | <one-line>                   |
| Process       | <level>  | <one-line>                   |
| Dependencies  | <level>  | <one-line>                   |
| Capacity      | <level>  | <one-line>                   |

<If any risk is HIGH or CRITICAL, expand with details and mitigations>

---

### Early Warnings

<From detect_patterns: anomalies that need attention, or "None detected">

### Stale Decisions

<From check_decision_decay: decisions that may need revisiting, or "All decisions current">

### Board Health

**Stale items:** <count> | **Bottlenecks:** <list or "none">

<If stale items exist, list top 3 with days-since-update>
```

---

## Step 4: Offer Actions

Use AskUserQuestion:

```
question: "What would you like to do?"
header: "Next Step"
options:
  - label: "Start top recommendation"
    description: "Begin work on <recommended issue> with /issue <num>"
  - label: "Triage backlog"
    description: "Clean up untriaged issues (bulk_triage)"
  - label: "Deep dive on risks"
    description: "Expand risk radar with full details and mitigations"
  - label: "Just the briefing"
    description: "I'll decide what to work on myself"
```

### On "Start top recommendation"

Run `/issue <recommended_issue_number>` via the Skill tool. This hands off to the full issue lifecycle.

### On "Triage backlog"

Run `mcp__pm_intelligence__bulk_triage()` to find untriaged issues, then present each with suggested labels for user confirmation.

### On "Deep dive on risks"

Run `mcp__pm_intelligence__get_project_dashboard()` for the comprehensive health report, then display:

- Full risk breakdown with evidence
- DORA metrics
- Dependency graph bottlenecks
- Team capacity analysis
- Recommended mitigations

### On "Just the briefing"

Done. The briefing is already displayed.

---

## Tool Integration Map

Every tool called by `/start` and what it provides:

| Tool | What It Provides | When Used |
|------|-----------------|-----------|
| `optimize_session` | Prioritized work plan, quick wins, deferrals | Always (Step 2a) |
| `get_risk_radar` | Risk score across 6 categories | Always (Step 2b) |
| `detect_patterns` | Anomalies and early warnings | Always (Step 2c) |
| `generate_standup` | Yesterday/today/blockers summary | Always (Step 2d) |
| `get_workflow_health` | Per-issue health, stale items, bottlenecks | Always (Step 2e) |
| `check_decision_decay` | Stale architectural decisions | Always (Step 2f) |
| `suggest_next_issue` | Best issue to work on | Via optimize_session |
| `get_board_summary` | Board state overview | Via optimize_session |
| `bulk_triage` | Untriaged issue cleanup | On user request |
| `get_project_dashboard` | Full health report | On "Deep dive" |
| `get_dora_metrics` | DORA performance metrics | Via get_project_dashboard |
| `forecast_backlog` | "When will we finish?" | Via get_project_dashboard |
| `get_team_capacity` | Contributor throughput | Via get_project_dashboard |

---

## Design Rationale

### Why parallel gathering?

The 6 intelligence calls in Step 2 are independent. Running them in parallel means the briefing loads in ~3 seconds instead of ~18 seconds.

### Why synthesize instead of dumping raw output?

Raw tool output is verbose and overlapping. The synthesized briefing extracts the signal, deduplicates across tools, and presents a coherent narrative. Users don't need to see 6 separate JSON blobs.

### Why offer actions instead of auto-starting?

The user might have a different priority than what the AI recommends. The briefing gives them the information to decide. Auto-starting the top recommendation would bypass their judgment.

### Why triage as an option?

Untriaged issues accumulate silently. Offering triage as a session-start option keeps the backlog clean without requiring a separate workflow.
