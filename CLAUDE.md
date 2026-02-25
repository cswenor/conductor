# Conductor - Claude Code Instructions

## Validation

After completing any task that modifies code, run the validation command to confirm everything passes:

```bash
pnpm validate
```

This runs `typecheck`, `lint`, and `test` in sequence.

## Project Structure

- `packages/shared` - Shared utilities, types, and services
- `packages/web` - Next.js web application
- `packages/worker` - BullMQ job worker

## Key Patterns

- **Outbox pattern** - Persist writes before executing (crash-safe)
- **Webhook-first** - Persist webhooks before processing
- **Event normalization** - Convert GitHub webhooks to internal events

## UI Components

- **Always use shadcn/ui** - Never create custom components if shadcn has one available
- Check existing components in `packages/web/src/components/ui/` before creating new ones
- Add new shadcn components with: `pnpm dlx shadcn@latest add <component>`
- shadcn docs: https://ui.shadcn.com/docs/components

---

<!-- claude-pm-toolkit:start -->
## STOP CHECKS

**These checklists prevent the most common policy violations. Check them at each stage.**

### Before Starting Work

- [ ] Read the ENTIRE issue (Problem, Non-goals, Acceptance Criteria, Definition of Done)
- [ ] Issue is in Active state (`pm move <num> Active`)
- [ ] On a feature branch, not main
- [ ] For Tier 1 work: issue exists and is linked

### Before Creating PR

- [ ] ALL acceptance criteria are met
- [ ] Acceptance criteria checked off in issue body (`- [ ]` → `- [x]`)
- [ ] Completion comment added to issue (what changed, how to verify)
- [ ] Local tests pass
- [ ] PR body includes `Fixes #<issue>` (if issue exists)

### Before Declaring "Ready for Review"

- [ ] CI is passing (`gh pr checks <PR_NUMBER>`)
- [ ] Local tests passed — if tests fail, fix them (never skip or bypass)
- [ ] Issue is in Review state (`pm status <num>`)
- [ ] PR body contains `Fixes #<issue>`

### After Merging

- [ ] Move issue to Done: `pm move <num> Done`
- [ ] Verify issue closed (auto-closes if PR used `Fixes #`)
- [ ] Check parent epic if applicable

---

## Context Recovery

**If you've lost context about project management processes, read [`docs/PM_PLAYBOOK.md`](./docs/PM_PLAYBOOK.md).** It contains:

- Workflow state definitions (Backlog, Ready, Active, Review, **Rework**, Done)
- All GitHub Project field IDs and option IDs
- Complete command reference for `gh project item-edit`
- Tiered PR workflow (when issues are required)
- Post-merge checklist with exact commands
- Issue documentation policy

---

## PM Intelligence Tools

The `pm-intelligence` MCP server provides AI-powered project intelligence. Claude should use these tools proactively at the right moments — not just when asked.

### Session Lifecycle

| When | Call | Why |
|------|------|-----|
| Starting a new session | `/start` or `mcp__pm_intelligence__optimize_session` | Get situational awareness and a prioritized work plan |
| Resuming work on an issue | `mcp__pm_intelligence__recover_context` | Full context recovery — what happened, where you left off, what's next |
| Before picking an issue | `mcp__pm_intelligence__suggest_next_issue` | Data-driven recommendation based on priority, dependencies, risk |
| After completing work | `mcp__pm_intelligence__record_outcome` | Record what happened for future learning |
| After making a design decision | `mcp__pm_intelligence__record_decision` | Persist architectural decisions for future reference |

### Issue Intelligence

| When | Call | Why |
|------|------|-----|
| Creating a new issue | `mcp__pm_intelligence__triage_issue` | One-call classification: type, priority, estimates, risk, rework probability |
| Creating a new issue | `mcp__pm_intelligence__auto_label` | Suggest labels from content analysis (type, area, priority, risk) |
| Planning a large issue | `mcp__pm_intelligence__decompose_issue` | Break into dependency-ordered subtasks with estimates |
| Issue seems stuck | `mcp__pm_intelligence__explain_delay` | Root cause analysis — why is this slow or blocked? |
| Planning implementation | `mcp__pm_intelligence__suggest_approach` | Query past decisions/outcomes for what worked in this area |
| Planning implementation | `mcp__pm_intelligence__predict_completion` | P50/P80/P95 completion date estimates |
| Assessing risk | `mcp__pm_intelligence__predict_rework` | Probability this issue will need rework before approval |
| Understanding blockers | `mcp__pm_intelligence__get_issue_dependencies` | Full dependency tree — what blocks this, what this blocks |
| Checking issue timeline | `mcp__pm_intelligence__get_session_history` | Cross-session event history and workflow transitions |

### Pre-PR Checks

| When | Call | Why |
|------|------|-----|
| Before creating PR | `mcp__pm_intelligence__check_readiness` | Pre-review validation with readiness score (0-100) |
| Before creating PR | `mcp__pm_intelligence__detect_scope_creep` | Compare plan to actual file changes — catch out-of-scope work |
| Before creating PR | `mcp__pm_intelligence__analyze_pr_impact` | Blast radius: dependency impact, knowledge risk, coupling |

### Review Intelligence

| When | Call | Why |
|------|------|-----|
| Reviewing a PR | `mcp__pm_intelligence__review_pr` | Structured analysis: file classification, scope check, risk, verdict |
| After review verdict | `mcp__pm_intelligence__record_review_outcome` | Record finding dispositions for calibration learning |
| Checking review accuracy | `mcp__pm_intelligence__get_review_calibration` | Hit rates and false positive patterns |

### Project Health

| When | Call | Why |
|------|------|-----|
| Checking project health | `mcp__pm_intelligence__get_risk_radar` | Risk score across 6 categories with mitigations |
| Checking project health | `mcp__pm_intelligence__get_workflow_health` | Per-issue health scores, stale items, bottlenecks |
| Checking project health | `mcp__pm_intelligence__get_project_dashboard` | Comprehensive report synthesizing ALL intelligence |
| Checking team throughput | `mcp__pm_intelligence__get_team_capacity` | Contributor profiles, sprint forecast, area coverage |
| Checking delivery metrics | `mcp__pm_intelligence__get_dora_metrics` | DORA: deploy frequency, lead time, change failure rate, MTTR |
| Checking code hotspots | `mcp__pm_intelligence__get_history_insights` | Git hotspots, coupling analysis, commit patterns, risk areas |

### Planning & Forecasting

| When | Call | Why |
|------|------|-----|
| Sprint planning | `mcp__pm_intelligence__plan_sprint` | AI-powered sprint planning: deps + capacity + Monte Carlo |
| Forecasting throughput | `mcp__pm_intelligence__simulate_sprint` | Monte Carlo simulation for sprint throughput (P10-P90) |
| "When will we finish?" | `mcp__pm_intelligence__forecast_backlog` | Monte Carlo to forecast backlog completion date |
| What-if analysis | `mcp__pm_intelligence__simulate_dependency_change` | "What if issue X slips by N days?" — cascade modeling |
| Estimation accuracy | `mcp__pm_intelligence__compare_estimates` | Compare predicted vs actual cycle times |
| Visualizing dependencies | `mcp__pm_intelligence__visualize_dependencies` | ASCII + Mermaid dependency graph rendering |
| Analyzing dep graph | `mcp__pm_intelligence__analyze_dependency_graph` | Critical path, bottlenecks, cycle detection |

### Operations & Reporting

| When | Call | Why |
|------|------|-----|
| Daily standup | `mcp__pm_intelligence__generate_standup` | Auto-generated standup from project activity |
| Sprint retro | `mcp__pm_intelligence__generate_retro` | Data-driven retrospective with evidence |
| Release notes | `mcp__pm_intelligence__generate_release_notes` | Structured release notes from merged PRs |
| Detecting anomalies | `mcp__pm_intelligence__detect_patterns` | Cross-cutting anomaly detection and early warnings |
| Stale decisions | `mcp__pm_intelligence__check_decision_decay` | Decisions whose context has drifted |
| Board overview | `mcp__pm_intelligence__get_board_summary` | Issue counts by state, health score |
| Velocity tracking | `mcp__pm_intelligence__get_velocity` | PRs merged, issues closed/opened (7d/30d) |
| Sprint analytics | `mcp__pm_intelligence__get_sprint_analytics` | Cycle time, bottlenecks, flow efficiency, rework patterns |
| Context efficiency | `mcp__pm_intelligence__get_context_efficiency` | AI session count, rework rate, efficiency score per issue |
| Memory insights | `mcp__pm_intelligence__get_memory_insights` | Patterns from decision/outcome history |

### Batch Operations

| When | Call | Why |
|------|------|-----|
| Cleaning up backlog | `mcp__pm_intelligence__bulk_triage` | Triage all untriaged issues with suggested labels |
| Moving multiple issues | `mcp__pm_intelligence__bulk_move` | Batch state transitions with dry-run support |

### Proactive Usage Rules

Claude should call intelligence tools **automatically** at these moments — no user prompt needed:

1. **Starting any session** → Call `optimize_session` (or recommend `/start`)
2. **Resuming work** → Call `recover_context` before reading issue/PR
3. **Before creating a PR** → Call `check_readiness` and `detect_scope_creep`
4. **After merging** → Call `record_outcome`
5. **After any design decision** → Call `record_decision`
6. **When an issue has been Active >3 days** → Call `explain_delay`
7. **When user asks "what should I work on?"** → Call `suggest_next_issue`
8. **When user asks about project health** → Call `get_risk_radar`

---

## Critical Policies

### READ BEFORE ACTING

**Before starting work on any issue, Claude MUST:**

1. **Read the ENTIRE issue** - including Problem, Non-goals, Acceptance Criteria, and Definition of Done
2. **Identify constraints** - Non-goals explicitly say what NOT to do. These override acceptance criteria.
3. **Evaluate feasibility** - For items marked "if feasible", think critically about whether the approach makes sense before implementing
4. **Ask when uncertain** - If requirements conflict or seem wrong, ask the user instead of assuming

**Common mistakes to avoid:**

- Seeing an acceptance criterion and jumping to implementation without reading Non-goals
- Implementing something "because it's on the checklist" without evaluating if it's the right approach
- Adding automated rules/checks that create false positives or noise
- Rushing to complete tasks instead of understanding them

**The goal is to solve the user's actual problem, not to check boxes.**

### EXISTING ISSUE REFERENCES

**If you are given a plan, task, or instruction that references an issue number (e.g., "Issue #270", "implement #42"), you MUST:**

1. **Look up the issue FIRST** using `mcp__github__get_issue` or `gh issue view <NUMBER>`
2. **Follow the full workflow** - Move to Active, create branch, link PR with `Fixes #<NUMBER>`, move to Review
3. **Never skip the issue just because of Tier classification** - The Tier system determines whether you need to CREATE an issue. If an issue already exists, you MUST link to it regardless of tier.

**Why this matters:** The issue contains acceptance criteria, non-goals, and context. Ignoring it means ignoring requirements.

**Common mistake:** Seeing "Tier 2 (no issue required)" in a plan and using that to skip an issue that already exists. "No issue required" means you don't need to CREATE one - it does NOT mean you can IGNORE one that exists.

### NO TEST BYPASS

**When tests fail during the Review transition, you MUST fix the failures.**

`pm move <num> Review` runs the test suite before allowing the transition. If tests fail:

1. **Read the error output** — understand what failed and why
2. **Fix the root cause** — do not work around it
3. **Re-run the tests** — confirm the fix
4. **Then retry the transition** — `pm move <num> Review`

**FORBIDDEN:**

- Re-running with any bypass flags
- Commenting out or modifying test infrastructure to make tests pass
- Modifying the local database directly to skip the gate
- Declaring "ready for review" when tests haven't passed

### PREFER GITHUB MCP TOOLS

**Claude should prefer GitHub MCP tools over `gh` CLI in all workflows.**

**Repository identity — ALWAYS use these exact values:**

| Parameter | Value      |
| --------- | ---------- |
| `owner`   | `cswenor` |
| `repo`    | `conductor`  |

**NEVER infer `owner` or `repo` from the working directory, conversation history, or any other context.** Git worktrees use directory names that are NOT repository names. The owner is an organization name that cannot be guessed from filesystem paths.

| Instead of               | Use                                       |
| ------------------------ | ----------------------------------------- |
| `gh issue view 270`      | `mcp__github__get_issue`                  |
| `gh issue list --search` | `mcp__github__search_issues`              |
| `gh pr view 271`         | `mcp__github__get_pull_request`           |
| `gh pr diff 271`         | `mcp__github__get_pull_request_files`     |
| `gh pr merge`            | `mcp__github__merge_pull_request`         |
| `gh issue comment`       | `mcp__github__add_issue_comment`          |
| `gh pr review`           | `mcp__github__create_pull_request_review` |

**Why:** MCP tools return structured JSON, don't require parsing CLI output, and are more reliable.

**Exception:** Keep `gh` for operations not covered by MCP (e.g., `gh pr create` with heredoc body, `gh project item-add`).

---

## Workflow Rules

### Use /issue for Issue Management

**When Claude needs to create or work on issues, use the `/issue` skill:**

- **Creating issues:** Run `/issue` (no arguments) to start the PM interview flow
- **Working on issues:** Run `/issue <number>` to load context and start work

**The `/issue` skill handles:** duplicate detection, proper issue structure, adding to project, moving to Active, git sync, and branch creation.

**Do NOT manually run `gh issue create`** - always use `/issue` to ensure proper workflow.

### Tier Classification

**BIAS TOWARD TIER 1:** Claude has a documented tendency to classify work as Tier 2 to avoid creating issues. This is wrong.

**Default assumption: It's Tier 1 unless CLEARLY trivial.** Ask yourself:

1. Could this break something? → Tier 1
2. Does this change behavior? → Tier 1
3. Does this affect multiple files? → Probably Tier 1
4. Is this a "major" version update? → Tier 1
5. Would a team member want to review this approach before I start? → Tier 1
6. Am I tempted to call this Tier 2 because I don't want to create an issue? → Tier 1

**Tier 2 is ONLY for truly mechanical changes** like typo fixes, formatting, minor doc updates, or patch-level dependency bumps.

| Change Type                         | Prefix      | Tier | Issue Required? |
| ----------------------------------- | ----------- | ---- | --------------- |
| New feature, API endpoint           | `feat:`     | 1    | YES             |
| Bug fix, broken flow                | `fix:`      | 1    | YES             |
| Restructure, refactor               | `refactor:` | 1    | YES             |
| Major dependency upgrade            | `chore:`    | 1    | YES             |
| CI workflow logic change            | `ci:`       | 1    | YES             |
| New policies to CLAUDE.md           | `docs:`     | 1    | YES             |
| Typo fix, README update             | `docs:`     | 2    | No              |
| Patch dependency bump (1.2.3→1.2.4) | `chore:`    | 2    | No              |
| Code formatting                     | `chore:`    | 2    | No              |

### Decision Tree (MANDATORY)

```
Is this a new feature, bug fix, or code refactor?
├─ YES → TIER 1: MUST have issue first
│        ├─ Search for existing issue: gh issue list --search "keywords"
│        ├─ Create issue if none exists
│        ├─ Add to project: pm add <num> <priority>
│        ├─ Move to Active: pm move <num> Active
│        ├─ Use prefix: feat: / fix: / refactor:
│        └─ PR body MUST include: Fixes #<issue-number>
│
└─ NO → Is this TRULY trivial? (See "Tier 2 is ONLY for..." above)
        ├─ YES → TIER 2: No issue CREATION required
        │        ├─ Use prefix: chore: / docs: / ci:
        │        ├─ PR body: descriptive explanation
        │        └─ BUT: If issue already exists, MUST link with Fixes #<num>
        │
        └─ NO or UNCERTAIN → TIER 1 (create issue first)
```

### STOP CHECK Before Every PR

Before running `gh pr create`, verify:

1. **Was I given an issue number?** If yes, `Fixes #<num>` is REQUIRED regardless of tier
2. **Did I choose the right prefix?** (feat/fix/refactor vs chore/docs/ci)
3. **If Tier 1, do I have an issue?** (Check with `gh issue view <num>`)
4. **If Tier 1, is the issue in Active state?** (Check with `pm status <num>`)
5. **Does my PR body have `Fixes #<num>`?** (Required if issue exists)

**FAILURE TO FOLLOW THIS WILL CAUSE CI CHECK FAILURES.**

**If issue already exists:** Link with `Fixes #<num>` regardless of tier.

### Workflow States (Reference Only)

The canonical definition of workflow states and transitions (including the **Rework** state) lives in **PM_PLAYBOOK.md**.

This section exists only as a high-level behavioral reference for Claude. Do not treat it as a source of truth.

**Key rules:**

- Coding is ONLY permitted when an issue is in **Active**
- If changes are requested during Review, the issue MUST move to **Rework**
- Workflow definitions, tables, and transition rules are owned by **PM_PLAYBOOK.md**

### AI Behavioral Constraints

- **Backlog / Ready / Rework**: May analyze and plan, MUST NOT implement
- **Active**: May implement (ONLY state where coding is allowed)
- **Review**: Work complete, awaiting human feedback
- **Done**: No action required

**WIP Limit:** AI may have only ONE issue in Active at a time. Review does not count.

### PR Review Process

When acting as a reviewer, Claude Code MUST:

**If Approved:**

1. Post detailed review to PR (acceptance criteria table, implementation analysis)
2. Post summary to Issue (X/Y criteria met, approval status)
3. Move issue to Review state (if not already)
4. Merge the PR

**If Changes Requested:**

1. Post review to PR (what's missing, specific code locations)
2. Post summary to Issue (criteria NOT met, link to PR review)
3. Move issue to Rework: `pm move <num> Rework`

### Before Creating PR (MANDATORY)

**Before opening a PR, Claude Code MUST:**

1. **Verify ALL acceptance criteria are met** - Re-read the issue and confirm each criterion
2. **Check off acceptance criteria** - Update the issue body to mark completed items `[x]`
3. **Add completion comment** to the issue with:
   - What changed
   - How to verify
   - Any follow-ups
4. **Run local test suite** — all checks must pass

### After Opening PR (MANDATORY)

**After opening a PR, Claude Code MUST:**

1. **Ensure PR body includes `Fixes #<issue>`** (canonical linkage)
2. **Move issue to Review:**

   ```bash
   pm move <ISSUE_NUMBER> Review
   ```

3. Request reviewers if not auto-assigned

### Declaring "Ready for Review" (MANDATORY)

**NEVER tell the user a PR is "ready for review" without first verifying ALL of these:**

1. **CI is passing** - Check with `gh pr checks <PR_NUMBER>`
2. **Issue is in Review state** - Verify with:

   ```bash
   pm status <ISSUE_NUMBER>
   ```

   Check the `workflow` field in the output. If not "Review", run `pm move <ISSUE_NUMBER> Review`

   **WARNING:** Do NOT use `gh issue view --json projectItems` - it returns incorrect values for custom project fields.

3. **PR has issue link** - PR body must contain `Fixes #<issue>`
4. **Local tests passed** — enforced by `pm move`

**This applies every time you claim something is ready, even after amending commits or pushing fixes.** Re-verify the checklist each time before telling the user.

### Post-Merge Checklist (MANDATORY)

**After merging a PR that closes an issue, Claude Code MUST:**

1. **Update the Project Workflow field to "Done":**

   ```bash
   pm move <ISSUE_NUMBER> Done
   ```

2. **Verify the issue is closed** (should auto-close if PR used `Fixes #`)

3. **Check off "Code merged" in Definition of Done** if present

4. **Check parent epic** - If the issue has a parent epic, verify if all child issues are now complete. If so, update the parent epic's checkboxes and move it to Done.

**Why this matters:** The Project board views filter by Workflow. Issues stuck in Review after merge create confusion and make progress tracking inaccurate.

### Picking Up Existing Work (MANDATORY)

**When resuming work on a project with existing issues/PRs, Claude Code MUST follow the same PM process as new work:**

1. **Check issue state before acting:**

   ```bash
   pm status <ISSUE_NUMBER>
   ```

2. **Follow state-appropriate behavior:**

   | Current State | What Claude Can Do |
   |---------------|-------------------|
   | Backlog | Analyze only, NOT execute. Ask user to authorize (move to Ready) |
   | Ready | Move to Active, then begin work |
   | Active | Continue work (verify it's assigned to you) |
   | Review | Review the PR, post comments to BOTH PR and Issue |
   | Rework | Address feedback, move to Active to implement changes |
   | Done | No action needed |

3. **Never skip PM steps just because work already exists:**
   - Still verify acceptance criteria before approving
   - Still post comments to both PR AND issue
   - Still run post-merge checklist after merging
   - Still update parent epics

**The PM process applies to ALL work, not just work Claude initiates.**

---

## Issue Documentation Policy

Document work proportionally to its risk and impact.

### Plan Comments (on the issue)

**Required for:** `type:epic`, `needs:spec`, or Risk=High issues

**Not required for:** Normal features/bugs (issue body + acceptance criteria is the plan)

When required, use collapsible format with Approach, Key Files, and Risks sections.

### Completion Comments (on the issue)

**Required for:** User-facing changes, interface/contract changes, core workflow changes, Risk=High issues

**Not required for:** Chores, docs, CI, internal refactors, obvious bug fixes

When required, include: What changed, How to verify, Follow-ups (if any).

### Retrospectives

**Required only when:** `postmortem:needed` label is present

**Used for:** Outages, security issues, significant rework, learning opportunities

Do not add a "mistakes" section to every issue. Real issues deserve focused retrospectives, not performative honesty on routine work.

---

## Conventions

### Commit Convention

```
<type>(<scope>): <description>

Types: feat, fix, docs, refactor, test, chore
```

### Branch & PR Workflow

**Work on branches, not main.** Never commit on `main` (even locally). A pre-push hook enforces this.

**Branch naming:** `<type>/<short-desc>` (e.g., `fix/auth-bug`, `docs/pm-update`)
<!-- claude-pm-toolkit:end -->
