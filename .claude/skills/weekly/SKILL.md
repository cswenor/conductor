---
name: weekly
description: Generate AI narrative analysis from weekly JSON snapshots. Use for weekly reports, project health, or progress analysis.
argument-hint: '[--from YYYY-MM-DD] [--to YYYY-MM-DD]'
allowed-tools: Read, Write, Glob, Grep, Bash, AskUserQuestion, mcp__github__get_issue, mcp__github__get_pull_request, mcp__github__get_pull_request_files, mcp__github__search_issues, mcp__github__list_issues, mcp__github__list_pull_requests, mcp__github__get_pull_request_status, mcp__pm_intelligence__get_risk_radar, mcp__pm_intelligence__generate_release_notes, mcp__pm_intelligence__get_dora_metrics, mcp__pm_intelligence__compare_estimates, mcp__pm_intelligence__detect_patterns, mcp__pm_intelligence__get_workflow_health, mcp__pm_intelligence__simulate_sprint, mcp__pm_intelligence__forecast_backlog, mcp__pm_intelligence__get_velocity, mcp__pm_intelligence__get_sprint_analytics, mcp__pm_intelligence__get_board_summary
---

# /weekly - AI-Powered Weekly Report Analysis

Generate an AI narrative analysis from weekly JSON snapshots.

## Usage

```
/weekly                                    # Analyze latest report
/weekly --from 2026-01-19                  # Analyze specific report
/weekly --from 2026-01-01 --to 2026-01-26  # Analyze date range
```

Arguments: $ARGUMENTS

---

## Step 1: Read PM Playbook for Context

**Before analyzing any data, read `docs/PM_PLAYBOOK.md` to understand:**

- The AI-first workflow model (Backlog → Ready → Active → Review → Rework → Done)
- WIP limits (AI: 1 Active issue at a time)
- Workflow states represent permissions, not just progress
- Tiered PR workflow (Tier 1 requires issues, Tier 2 does not)
- What makes issues "spec ready" for AI execution

This context is critical for meaningful analysis. Without it, you'll misinterpret patterns like "single contributor" (irrelevant in AI-agentic workflow) or "empty pipeline" (clean completion, not a problem).

---

## Step 2: Load JSON Snapshot(s)

Read JSON files from `reports/weekly/`:

- **No arguments:** Find the most recent `YYYY-MM-DD.json`
- **`--from` only:** Load that specific date's JSON
- **`--from` and `--to`:** Load all JSON files in the date range

**Also load previous reports for comparison:**

- Always read the 2-4 most recent weekly reports (not just the one being analyzed)
- This enables velocity comparison, trend identification, and pattern recognition
- If analyzing the latest report, read prior weeks to establish baseline
- Check `reports/stats.csv` for historical metrics summary

**Validate JSON files before processing:**

For each JSON file loaded, verify it parses correctly. If a file is corrupt (truncated, invalid JSON), skip it with a warning rather than crashing:

```
Warning: reports/weekly/2026-02-01.json is not valid JSON — skipping.
```

If ALL files in the range are invalid, report the error and exit.

If no JSON files exist:

```
No weekly report data found.

Run `pnpm report:weekly` to generate the canonical report first,
or wait for the Monday morning GitHub Action to create one automatically.
```

---

## Step 2.7: Gather PM Intelligence (Parallel with Step 3)

Run these PM intelligence tools in parallel to enrich the report with live analytics:

```
mcp__pm_intelligence__get_risk_radar()
mcp__pm_intelligence__get_dora_metrics()
mcp__pm_intelligence__get_workflow_health()
mcp__pm_intelligence__detect_patterns()
mcp__pm_intelligence__get_velocity()
mcp__pm_intelligence__get_sprint_analytics()
mcp__pm_intelligence__compare_estimates()
```

**For the latest report only** (period ended within 7 days), also run:

```
mcp__pm_intelligence__generate_release_notes({ since: "<period_start>", until: "<period_end>" })
mcp__pm_intelligence__forecast_backlog()
mcp__pm_intelligence__simulate_sprint()
```

**Use intelligence output to enrich (not replace) the JSON data.** The JSON is the canonical source of truth for activity counts. Intelligence tools provide analytical context: risk scores, delivery metrics, anomalies, forecasts.

**If any tool call fails**, continue without it — these are enrichment, not gates.

---

## Step 3: Deep Analysis (MANDATORY before any questions)

**Do the work yourself before asking the user anything.** The data is in the JSON and MD files — read it thoroughly. Use PM intelligence data from Step 2.7 to add analytical depth.

### 3a. Categorize What Actually Shipped

Do NOT summarize shipped items by area label alone. Read the actual issue titles and descriptions, then group by **theme** (what problem was being solved):

- Read every issue in the `shipped` section of the MD report
- Group by theme (e.g., "test coverage build-out", "LP system features", "CI consolidation") not just area labels
- Count issues per theme
- Identify which themes represent user-facing progress vs internal investment

**Common mistake:** Seeing 34 infra issues and concluding "infrastructure-heavy week" without checking that 15 of those are test coverage work that improves product reliability, and 4 are LP pipeline features labeled as infra.

### 3b. Calculate Epic Deltas

For each epic in `epicProgress`, compare to the prior week's JSON:

- Calculate actual % change (not just current %)
- Flag epics where checkbox tracking may lag behind actual work (e.g., epic at 0% but child issues shipped this week)
- Note epics closed this week and why (completed vs absorbed vs deferred)

### 3c. Assess Stale Items

For stale items, determine:

- Are these the same items from last week (just older), or are there new entrants?
- What phase/category do they belong to? (future-phase features vs forgotten work)
- Check if any "stale" items were actually closed — the `updatedAt` field may not reflect recent activity

### 3d. Verify Board State Claims

When cross-referencing the live board (latest report only):

- If an item shows as Critical/P0, **check if the issue is actually open** before flagging it as an active concern
- If the JSON says 0 in progress but the board shows items, determine which moved after the period end vs which were missed

### 3e. Produce Draft Outline

Output a draft outline showing your analysis:

```markdown
## Draft Outline

Based on the data from [date range]:

**Activity Summary:**

- X PRs merged (WoW: +/-N)
- Y issues closed (WoW: +/-N)
- Z issues currently open (WoW: +/-N)

**Shipped by Theme:**

- [Theme 1]: N issues — [brief description of what this accomplished]
- [Theme 2]: N issues — [brief description]
- [Theme 3]: N issues — [brief description]

**Epic Movement:**

- [Epic advancing: #N went from X% to Y%]
- [Epic closed: #N — reason]
- [Epic stalled: #N at X% for N weeks]

**Risks Identified:**

- [Specific risk with evidence]
```

---

## Step 4: Ask Clarifying Questions (ONLY if genuinely needed)

**Default: Skip this step.** Most weeks, the data is sufficient to write the report without human input.

### Pre-check (MANDATORY before asking ANY question)

For each potential question, ask yourself:

1. **Can I answer this from the data?** Read the shipped items, epic progress, contributor data, and stale items more carefully. If the answer is in the data, do not ask.
2. **Does this question assume something I haven't verified?** (e.g., "Was this week infrastructure-heavy?" — did you actually check what shipped, or are you guessing from area labels?)
3. **Would asking this feel like I'm being lazy?** If yes, do the analysis instead.

### When questions ARE appropriate

Only ask when the answer genuinely cannot be determined from the data:

- **External context:** "I see a new epic (#382 Patent Portfolio) with 0% progress — is this actively planned or placeholder?" (The JSON cannot tell you business intent.)
- **Contradictory data:** "The board shows #X as Active but the issue is closed — which is correct?" (When you've already investigated and found a genuine conflict.)
- **Strategic direction:** "Three epics were closed this week. Is the focus shifting to [area]?" (Only if the data is ambiguous about future direction.)

### When questions are NOT appropriate

Do NOT ask:

- "Was this week infrastructure-heavy?" — Check the actual shipped items yourself.
- "Is [stale item] still planned?" — You can see its state, labels, and age. State your assumption in the report instead.
- "Was the velocity change expected?" — Compare to prior weeks and explain the pattern yourself.
- "Is the contributor pattern expected?" — You have multi-week contributor data to compare.

**If you have 0 questions (common case), proceed directly to Step 5.**

If you have 1-2 genuine questions, use AskUserQuestion. Never ask more than 3. Include "Skip all — generate best-effort report" as an option.

---

## Step 5: Generate Final Narrative

Write the report to `reports/weekly/analysis/YYYY-MM-DD.ai.md` (or `YYYY-MM-DD--YYYY-MM-DD.ai.md` for ranges).

**Important:** AI analysis files go in `reports/weekly/analysis/`, NOT alongside the JSON/MD files. This keeps the canonical data separate from the AI-generated narrative.

### Required Sections

**1. Executive Summary**

```markdown
## Executive Summary

[1-2 sentence health assessment with week-over-week context]

| Metric        | This Week | Prior Week | Δ    | Trend (4wk) |
| ------------- | --------- | ---------- | ---- | ----------- |
| PRs Merged    | X         | Y          | +/-Z | ↑/↓/→       |
| Issues Closed | X         | Y          | +/-Z | ↑/↓/→       |
| Open Issues   | X         | Y          | +/-Z | ↑/↓/→       |

**Health:** [Healthy | Needs Attention | At Risk]
**Key Theme:** [One sentence summary of the week]
```

Use previous weeks' data to populate Prior Week and calculate trends. If this is the first report, note "N/A" for prior week.

**2. Stakeholder Update** (copy-pasteable for investors/users)

```markdown
## Stakeholder Update

> [1-2 sentence TL;DR highlight — the single most important thing this week]

**Product Progress:**

- [Feature described in user/business terms, e.g., "User onboarding launched — new users can now sign up and complete profile setup"]
- [Another user-facing milestone, if any]
- [Include epic completion percentages, e.g., "Auth system: 75% complete (6/8 milestones)"]

**Platform Development:**

- [Investor-relevant infrastructure milestones, e.g., "Security hardening completed across all environments"]
- [Team/contributor milestones, e.g., "Second developer began contributing to the liquidity pool system"]

**What Users Can Do Now:**

- [Specific user capabilities enabled this week, e.g., "Users can now reset their password via email"]
- [Frame in terms of stakeholder questions from `docs/PM_PROJECT_CONFIG.md` § "Progress Questions"]

**What's Next:**

- [1-2 items coming in the next sprint, described in business terms]
```

**Tone guidance for Stakeholder Update:**

- Write for someone who does NOT read code — no PRs, CI, turbo.json, ESLint, linting, etc.
- Describe features by what they enable for users, not by implementation details
- Translate epic names into user-facing language (see `docs/PM_PROJECT_CONFIG.md` § "Product Framing")
- Include infrastructure only when investor-relevant (security, scalability, team growth) — omit pure DX items
- Keep it to 5-8 bullet points maximum across all sub-sections
- Must be copy-pasteable as a standalone update — do not reference other report sections
- Factual and honest, not promotional — "Auth system launched" not "Amazing auth system revolutionizes onboarding"
- Omit items that are purely internal: linting rules, CI checks, code formatting, AI tooling improvements
- If nothing user-facing shipped, say so honestly: "This week focused on platform foundations — no new user-facing features"
- Include epic completion percentages from `epicProgress` JSON to give concrete progress metrics
- For user-facing epics, always address the stakeholder progress questions from `docs/PM_PROJECT_CONFIG.md`

**3. Roadmap Progress** (between Stakeholder Update and What Shipped)

```markdown
## Roadmap Progress

Source: `epicProgress` array in JSON

| Epic     | Progress | %   | Status    | WoW Delta |
| -------- | -------- | --- | --------- | --------- |
| #N Title | X/Y      | Z%  | Open/Done | +N%       |

**Guidance:**

- Compare to prior week's epic progress to calculate week-over-week delta
- Call out stalled epics (0% change or no update in 14+ days)
- For epics at 100% but still open, flag as "Ready to close"
- Group by area if there are many epics
```

**4. What Shipped**

- **Primary grouping: by theme** (what problem was solved — e.g., "Test Coverage Build-Out", "LP System Progress", "CI Consolidation"). This tells a story about what the week accomplished.
- **Secondary grouping: by area** (Frontend, Backend, Contracts, Infrastructure) as a raw count summary table.
- Include business context where known
- Link to PRs/issues
- Do NOT characterize a week as "infrastructure-heavy" or "feature-light" based solely on area labels. Read the actual issues — test coverage work improves product reliability, indexer work enables features, CI consolidation reduces costs. Categorize by what it accomplishes, not where the code lives.

**5. Contributors**

```markdown
## Contributors

Source: `contributors` array in JSON

| Contributor | PRs Merged | Issues Closed |
| ----------- | ---------- | ------------- |
| @login      | N          | M             |

**Guidance:**

- Compare to prior week's contributor data for week-over-week changes
- Note new contributors (not in prior week)
- If contributor data is absent (older JSON reports), note "No contributor data available for this period"
```

**6. In Progress**

- Current open work with assignees
- Days since last update for each item

**7. Risk Dashboard** (from `get_risk_radar` intelligence)

```markdown
## Risk Dashboard

**Overall Risk Score:** <score>/100 <trend arrow>

| Category       | Level    | Top Concern                  | Trend |
|---------------|----------|------------------------------|-------|
| Delivery      | <level>  | <one-line>                   | <arrow> |
| Quality       | <level>  | <one-line>                   | <arrow> |
| Knowledge     | <level>  | <one-line>                   | <arrow> |
| Process       | <level>  | <one-line>                   | <arrow> |
| Dependencies  | <level>  | <one-line>                   | <arrow> |
| Capacity      | <level>  | <one-line>                   | <arrow> |
```

Include mitigations for any HIGH or CRITICAL risks. Also include:

- **Stale items** (from `staleItems` JSON array + `get_workflow_health`):
  - Top 10 stalest items with days-since-update
  - Group by area, severity tiers: 14-30 days (amber), 30+ days (red)
- **Anomalies** (from `detect_patterns`): Early warnings and unusual patterns
- Blocked items, missing expected areas
- Workflow bottlenecks (items stuck in Review, Active pileup)

**8. Delivery Metrics** (from `get_dora_metrics` + `get_sprint_analytics`)

```markdown
## Delivery Metrics

| Metric | This Week | Prior Week | Trend |
|--------|-----------|------------|-------|
| Deployment Frequency | <value> | <value> | <arrow> |
| Lead Time (median) | <value> | <value> | <arrow> |
| Change Failure Rate | <value> | <value> | <arrow> |
| MTTR | <value> | <value> | <arrow> |
| Flow Efficiency | <value> | <value> | <arrow> |
| Rework Rate | <value> | <value> | <arrow> |
```

Also include: estimation accuracy from `compare_estimates` (predicted vs actual cycle times).

**9. Week-over-Week Analysis**

Compare to previous weeks:

- Velocity trend: Is throughput increasing, decreasing, or stable?
- Area balance: Are we shipping across all areas or stuck in one?
- Pipeline health: Are items flowing through states or getting stuck?
- Backlog trajectory: Is open issue count growing or shrinking?

**10. Forecasts** (from `forecast_backlog` + `simulate_sprint`, latest report only)

```markdown
## Forecasts

**Sprint Forecast (Monte Carlo):**
- P50: <items> items | P80: <items> items | P90: <items> items

**Backlog Completion Forecast:**
- <N> items remaining → P50: <date> | P80: <date>
```

Skip this section for historical reports (no forecast data available).

**11. Recommendations**

- 3-5 specific, actionable items
- Prioritized by impact
- Reference trends from prior weeks and intelligence data where relevant
- Include risk mitigations from `get_risk_radar` if applicable

**12. Appendix: Raw Metrics**

- Full metrics table from JSON
- Historical comparison table if prior data available
- DORA metrics detail from `get_dora_metrics`

**11. Assumptions & Unknowns** (include when assumptions were made)

```markdown
## Assumptions & Unknowns

The following assumptions were made based on data analysis:

- Assumed stale epics at 0% represent planned future-phase work, not forgotten commitments
  (evidence: they were all created during the Jan scoping sprint)
- Assumed velocity increase reflects sustainable output, not a one-time clearance
  (evidence: issues closed were substantial, not pre-scoped small items)
- ...

These assumptions may affect the accuracy of risk assessments and recommendations.
```

**Note:** This section documents analytical assumptions, not just unanswered questions. If you made judgment calls about the data (e.g., "the 0% epic checkboxes are a tracking gap, not lack of work"), state them here so the reader can evaluate your reasoning.

---

## Tone Requirements

Write like an honest engineering manager:

- **Quantified:** Use numbers, percentages, days
- **Direct:** State problems clearly
- **Actionable:** Recommendations should be specific
- **No cheerleading:** Don't default to "great job"
- **Risk-aware:** Call out concerns explicitly

**Good example:**

```markdown
Four workstreams shipped in parallel: test coverage across all code layers (15 issues),
LP system advancement (4 issues, epic 16% → 37%), CI consolidation from 7 jobs to 2
(4 issues), and DX hardening (12 issues). Area labels show 77% infra, but by theme:
34% was quality investment, 9% was LP features, and 43% was genuine infra.

Health: **Healthy** - quality foundations established, feature pipeline advancing.
```

**Bad example (lazy categorization):**

```markdown
Infrastructure-heavy week: 49 PRs merged, mostly tooling. Was this planned?
```

This is bad because it didn't actually examine what shipped. "Mostly tooling" is a guess from area labels, not analysis. The 49 PRs included contract tests, LP features, CI optimization, and quality gates — calling it "mostly tooling" misrepresents the week.

**Bad example (cheerleading):**

```markdown
Great progress this week! The team shipped 49 PRs and is making excellent
progress on the foundation. Keep up the good work!
```

---

## Automatic Batch Processing

When `/weekly` is run without arguments, automatically check for and analyze any unanalyzed reports:

1. Scan `reports/weekly/*.json` for all weekly reports
2. Check `reports/weekly/analysis/*.ai.md` for existing analyses
3. For each JSON file without a corresponding `.ai.md` file, generate the analysis
4. Process in chronological order (oldest first)

This ensures all historical reports get analyzed without manual intervention.

---

## Step 2.5: Cross-Reference Live State (CONDITIONAL)

**Live cross-referencing only applies to the LATEST report.** For historical reports, the JSON snapshot is the sole source of truth.

### Historical data accuracy

The report generator is now **history-aware** for `--from/--to` regeneration:

- **`openIssues`** is reconstructed from `createdAt`/`closedAt` date math — it accurately reflects the open-issue count at the period end date, not today's count.
- **`inProgress`, `inReview`, `blocked`, `p0Items`** come from **trusted snapshots** when available. A snapshot is trusted if it was generated within 2 days of the period end date.
- When no trusted snapshot exists, these fields are set to **`-1`** (sentinel value meaning "data unavailable for this historical period", NOT zero).

**Interpreting sentinel values (`-1`):**

- A value of `-1` means the data was not available at generation time — the generator chose "no data" over "wrong data"
- Do NOT treat `-1` as zero. In narrative text, describe these as "unavailable" or "not tracked for this period"
- The MD report shows "N/A (historical)" for these fields

**Trust check results for existing snapshots (generated Feb 10):**

- Jan 25 snapshot (diff=16d) → untrusted → board fields are `-1`
- Feb 01 snapshot (diff=9d) → untrusted → board fields are `-1`
- Feb 08 snapshot (diff=2d) → trusted → board fields from snapshot

### Known limitations of historical reconstruction

1. **`updatedAt` is mutable.** Stale item detection for historical reports is best-effort — an issue that appears "stale as of Jan 25" may have been actively worked on at that time but updated since.
2. **Labels are mutable.** `blocked:*`, `spec:ready`, and `area:*` labels can change over time. Historical reports with untrusted snapshots set these to unavailable rather than using current labels.
3. **Project board state has no GitHub API history.** `inProgress`/`inReview`/`p0Items` are only available from trusted snapshots.

### When to cross-reference (latest/current report ONLY)

If you are analyzing the **most recent** weekly report (i.e., the report period ended within the last 7 days), cross-reference live project board state for mutable fields:

- **P0/Critical count:** Query the project board for actual Priority field values.
- **Workflow distribution:** Items may have moved between states after the snapshot.

```bash
# Get current project board state for mutable field verification
gh project item-list  --owner cswenor --format json --limit 200
```

**If the live board query fails** (token permissions, network error, project not found):

- Log a warning: "Could not cross-reference live board state — using JSON snapshot as-is"
- Continue with the JSON data for all fields
- Note in the Appendix that live cross-referencing was unavailable

If the live state contradicts the JSON for mutable fields:

- Use the live state for the narrative
- Note the discrepancy in the Appendix as a data quality issue
- Do NOT blindly trust `p0Items`, `inProgress`, or `inReview` from the JSON

### When NOT to cross-reference (historical reports)

**If you are analyzing a report whose period ended more than 7 days ago, do NOT query live state.** The JSON snapshot is authoritative for ALL fields — both activity counts and mutable state. Live data from today is meaningless for a report from weeks ago.

For historical reports:

- Use JSON values as-is for all fields (P0, In Progress, In Review, etc.)
- If board fields are `-1`, note them as "unavailable" in narrative — do not attempt to compensate
- Do NOT add a "Live State Cross-Reference" section to the Appendix

### What is NEVER cross-referenced (any report)

**Do NOT pull in activity that happened after the report period's end date.** Issues closed, PRs merged, issues created, and items entering Review after the period end belong to the NEXT report. The JSON's activity counts (issuesClosed, prsMerged, issuesCreated) are authoritative for their period.

---

## Constraints

- **Read-only source:** Only reads `.json` files, never modifies them
- **Non-destructive:** Never modifies canonical `.json` or `.md` reports
- **Self-sufficient by default:** Generate the report from data analysis without asking questions. Only ask when genuinely unable to determine something from the data. If assumptions were made, list them in the Assumptions section.
- **Cross-reference conditional:** Only verify mutable metrics against live project board for the latest report (period ended within 7 days). Historical reports use JSON as sole source of truth.
- **Output location:** Always writes to `reports/weekly/analysis/` directory
