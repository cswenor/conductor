---
name: issue
description: Create new issues (PM interview) or work on existing issues. Use without arguments to create, with issue number to execute.
argument-hint: '[issue-number]'
allowed-tools: Read, Glob, Bash(./tools/scripts/worktree-detect.sh *), Bash(./tools/scripts/worktree-setup.sh *), Bash(./tools/scripts/tmux-session.sh *), Bash(./tools/scripts/find-plan.sh *), Bash(git status *), Bash(git checkout *), Bash(git pull *), Bash(git fetch *), Bash(git rebase *), Bash(git diff *), Bash(git worktree *), Bash(gh issue view * --json comments *), Bash(gh repo view *), Bash(gh pr checkout *), Bash({{SETUP_COMMAND}}), Bash(codex --version *), mcp__codex__codex, mcp__codex__codex-reply, mcp__github__get_issue, mcp__github__create_issue, mcp__github__update_issue, mcp__github__add_issue_comment, mcp__github__search_issues, mcp__github__get_pull_request, mcp__github__get_pull_request_files, mcp__github__get_pull_request_reviews, mcp__context7__resolve-library-id, mcp__context7__query-docs, mcp__pm_intelligence__get_issue_status, mcp__pm_intelligence__get_board_summary, mcp__pm_intelligence__move_issue, mcp__pm_intelligence__sync_from_github, mcp__pm_intelligence__add_dependency, mcp__pm_intelligence__triage_issue, mcp__pm_intelligence__auto_label, mcp__pm_intelligence__decompose_issue, mcp__pm_intelligence__recover_context, mcp__pm_intelligence__get_session_history, mcp__pm_intelligence__predict_completion, mcp__pm_intelligence__predict_rework, mcp__pm_intelligence__suggest_approach, mcp__pm_intelligence__get_issue_dependencies, mcp__pm_intelligence__check_readiness, mcp__pm_intelligence__detect_scope_creep, mcp__pm_intelligence__explain_delay, mcp__pm_intelligence__record_decision, mcp__pm_intelligence__get_history_insights, AskUserQuestion, EnterPlanMode, TaskOutput
---

# /issue - Issue Creation & Execution

Create new issues via PM interview OR work on existing issues.

**Input:** `$ARGUMENTS` (empty for create mode, issue number for execute mode)

---

## Reference

**Workflow states are defined in `docs/PM_PLAYBOOK.md`.** This skill uses those states (Backlog, Ready, Active, Review, Rework, Done) for mode detection but does not redefine them. See PM_PLAYBOOK.md for:

- State meanings and AI behavioral rules
- Transition rules and triggers
- WIP limits and entry/exit criteria

---

## Config

```yaml
repo:
  owner: {{OWNER}}
  repo: {{REPO}}
  project_id: {{PROJECT_ID}}
  project_number: {{PROJECT_NUMBER}}

tools:
  prefer: MCP (mcp__github__*)
  fallback: gh CLI (only when MCP lacks capability)
```

---

## Design Principles

These principles govern the collaborative AI workflow. They are derived from real failure modes and global research.

| Principle | Implication |
|-----------|-------------|
| **Structure over behavior** | Behavioral instructions ("be skeptical") drift under token pressure. Structural enforcement (mandatory sections, evidence gates, tool restrictions) does not. Prefer mode flags and required fields over prose instructions. |
| **Evidence over opinion** | Findings must cite `file:line`. Claims must be verified by reading code. Comments in code are claims, not evidence. Downgrade any finding that lacks a citation. |
| **Parallel over sequential** | Independent checks (tests, Codex review) run concurrently. Only create sequential dependencies when output of step N is input to step N+1. |
| **Risk-proportional depth** | Trivial changes skip expensive gates. Small changes get single-pass review. Standard changes get full adversarial loops. The review cost should match the change risk. |
| **One concern per PR** | Scope mixing couples unrelated risks, blocks independent rollback, and creates review confusion. Discovered work gets its own issue. |
| **Fail explicit, not silent** | No fallback defaults, no swallowed errors, no `2>/dev/null` on diagnostic output. Capture stderr, surface failures, require human decision on error. |

---

## Autonomous Mode

Controlled by the `autonomous_mode` flag in `.claude-pm-toolkit.json`. When `true`, the skill operates without interactive confirmation:

- **Skip AskUserQuestion calls** — make the recommended choice automatically and state what you chose
- **Skip confirmation gates** — preview mutations briefly in output, then execute
- **Auto-assign priority** — use the priority assessment logic but pick the result yourself
- **Auto-decide duplicates** — if no strong match found (>80% overlap), create new; otherwise update existing
- **Still enforce**: duplicate scans (3 searches), scope discipline, worktree creation, evidence citations
- **Still show**: brief previews of what you're about to create/mutate (one-liner, not full confirmation flow)

**Detection:** At skill start, read `.claude-pm-toolkit.json` and check `autonomous_mode`. If `true`, set `autonomous_mode = true` and auto-choose the recommended option for all `AskUserQuestion` calls. If `false` or missing, operate interactively as normal.

**To enable:** Set `"autonomous_mode": true` in `.claude-pm-toolkit.json` or run:
```bash
jq '.autonomous_mode = true' .claude-pm-toolkit.json > /tmp/pm-cfg.json && mv /tmp/pm-cfg.json .claude-pm-toolkit.json
```

## Hard Guardrails (Non-Negotiable)

| Guardrail          | Rule                                                                               |
| ------------------ | ---------------------------------------------------------------------------------- |
| Arg parsing        | Empty → Create Mode, Number → Execute Mode                                         |
| Create Mode prompt | User-invoked `/issue` (no args) MUST display prompt FIRST, before any other action |
| Context check      | AI-invoked Create Mode only: if context exists, skip to Decision Pack              |
| Questions          | 1-2 at a time, max ~5 total (only if needed)                                       |
| Candidates shown   | Top 3 max                                                                          |
| Duplicate scan     | MUST run at least 3 searches before any creation                                   |
| Preview            | MUST show before create/update/close (in autonomous mode: brief one-liner)         |
| Confirmation       | MUST get user confirmation before mutation (in autonomous mode: auto-confirm with recommended choice) |
| No auto-close      | NEVER close issues without confirmation (even in autonomous mode)                  |
| Merge limit        | NEVER close more than 3 issues in one merge without additional confirmation        |
| Merge default      | Default canonical = existing issue, not new                                        |
| Cite evidence      | When showing candidates, MUST cite one concrete overlap                            |
| Scope discipline   | One concern per PR - discovered work gets its own issue                            |
| Worktree enforce   | START mode from main repo MUST create worktree - no exceptions                     |

---

## Step 0: Route

Parse `$ARGUMENTS`:

- **Empty or not a number** → **Playbook: Create Mode**
- **Valid number** → **Playbook: Execute Mode**

---

## Playbook: Create Mode

### STOP CHECK: First Output MUST Be User Prompt

**Before ANY other action, verify which scenario applies:**

| Scenario                                             | First Action                                               |
| ---------------------------------------------------- | ---------------------------------------------------------- |
| User invoked `/issue` (no args)                      | Display: "Tell me what you want to change, fix, or build." |
| AI invoked `/issue` during development (has context) | Skip to Step 3 (Decision Pack)                             |

**How to determine who invoked (safe default = user-invoked):**

- **AI invoked (explicit):** Claude called the Skill tool itself during discovered work handling
- **Everything else → User invoked:** Default assumption for all other cases

**The safe default is user-invoked.** If uncertain, treat as user-invoked and display the prompt.

**CRITICAL:** If user invoked `/issue`, you MUST display the prompt. Do NOT:

- List existing issues
- Run duplicate scans
- Ask clarifying questions first
- Do anything else before showing the prompt

---

### Goal

Transform freeform user description into a well-structured, deduplicated issue.

### Step 1: Greet and Prompt (or Skip if AI-Invoked)

**DEFAULT ACTION (user invoked `/issue`):**

Display exactly:

```
Tell me what you want to change, fix, or build.
```

Then STOP and wait for user response. Do not do anything else.

---

**EXCEPTION (AI invoked `/issue` - must be explicit):**

Skip to Step 3 ONLY if ALL of these are true:

1. Claude explicitly called the Skill tool itself (not routing a user command)
2. Claude has clear context from the current conversation (e.g., discovered work)
3. Claude knows what issue to create without asking

**If ANY condition is uncertain, display the prompt and wait.** The safe default is always to prompt.

### Step 2: PM Interview (AI-Driven)

**Skip this step if you already have context from Step 1.**

Listen to user description. AI decides what to ask next.

**Constraints:**

- Ask 1-2 questions at a time
- Ask max ~5 total
- Stop early if confidence is high
- Goal: produce an execution-ready issue

**AI instruction:** Ask the minimum questions required to understand the problem, scope, and success criteria. Focus on:

- What's the problem or goal?
- Who is affected?
- What does success look like?
- What's explicitly out of scope?

### Step 3: Generate Decision Pack

After gathering enough context, produce a structured summary.

**3a. AI Classification (parallel with manual analysis):**

Call these PM intelligence tools to enrich your classification:

```
mcp__pm_intelligence__triage_issue({ issueNumber: <if updating existing>, title: "<proposed_title>", body: "<problem_summary>" })
mcp__pm_intelligence__auto_label({ issueNumber: <if updating existing> })
```

Use the intelligence output to inform (not replace) your Decision Pack. If the tools suggest a different type or area than your analysis, note both and explain your choice.

**3b. Decision Pack:**

- **intent**: bug | feature | spike | epic
- **area**: frontend | backend | contracts | infra
- **problem_summary**: 2-4 sentences describing the issue
- **proposed_title**: Issue title (format: `<type>: <description>`)
- **intelligence**: (from triage_issue) estimated effort, rework probability, risk level
- **fingerprint**:
  - **keywords**: 3-6 core terms for search
  - **alt_phrases**: 1-2 alternate phrasings

### Step 4: Duplicate Scan

Run **Sub-Playbook: Duplicate Scan** with the fingerprint.

Returns: `candidates[]`, `recommendation` (none | update | new | merge)

### Step 5: Branch on Recommendation

**If no candidates found:**

- Show "No similar issues found"
- Proceed to Step 6 (Draft)

**If candidates exist:**

Use AskUserQuestion:

```
question: "Found potentially related issues. How would you like to proceed?"
header: "Duplicates"
options:
  - label: "Create new issue (Recommended)"
    description: "The existing issues are different enough to warrant a new one"
  - label: "Update existing issue"
    description: "Add this information to one of the found issues"
  - label: "Merge/Consolidate"
    description: "Combine multiple fragmented issues into one"
```

### Step 6: Execute Branch

Based on user choice:

- **Create new** → Generate draft using Appendix B template, show preview, confirm draft content. Do NOT create yet — proceed to Step 7.
- **Update existing** → Run **Sub-Playbook: Update Existing** (then skip to Step 8)
- **Merge** → Run **Sub-Playbook: Merge/Consolidate** (then skip to Step 8)

### Step 7: Priority Assessment (When Creating a New Issue)

**This step runs whenever a new issue is being created:**

- **"Create new" path** (Step 6) → always runs Step 7
- **Merge path that chose "Create new consolidated issue"** → Step 8 invokes Step 7 before `pm add`
- **Update existing path** → skips Step 7 (no new issue created)
- **Merge path that updated an existing canonical** → skips Step 7 (no new issue created)

Using context from the Decision Pack (Step 3) and confirmed draft (Step 6), evaluate the issue's priority:

#### 1. Evaluate Factors

| Factor           | Rating       | Explanation                                       |
| ---------------- | ------------ | ------------------------------------------------- |
| **Urgency**      | Low/Med/High | _Is this blocking work? Time-sensitive?_          |
| **Impact**       | Low/Med/High | _How many users/developers affected? How severe?_ |
| **Dependencies** | Low/Med/High | _Does other planned work depend on this?_         |
| **Effort**       | Low/Med/High | _Quick win vs major undertaking?_                 |

Fill in each row with a brief, specific explanation based on the issue context.

#### 2. Apply Priority Rules

| Condition                                        | Priority     |
| ------------------------------------------------ | ------------ |
| Blocking other work right now                    | **Critical** |
| Impact=High OR (Urgency=High AND Impact>=Medium) | **High**     |
| Everything else                                  | **Normal**   |

#### 3. Display Reasoning

Show the completed factor table and recommendation to the user. **Read `.claude/skills/issue/appendices/priority.md` for factor evaluation signals and worked examples.**

#### 4. Confirm Priority

Use AskUserQuestion with the recommended priority listed first:

```
question: "What priority should this issue have?"
header: "Priority"
options:
  - label: "<recommended> (Recommended)"
    description: "<one-line reasoning summary>"
  - label: "<second option>"
    description: "<definition from priority guidelines>"
  - label: "<third option>"
    description: "<definition from priority guidelines>"
```

All three options (`Critical`, `High`, `Normal`) MUST be present. The recommended one goes first with `(Recommended)` suffix.

#### 5. Store Selection

Store the user's choice as `<selected_priority>` — the exact lowercase value (`critical`, `high`, or `normal`) passed to `pm add` in Step 8.

### Step 8: Issue Creation & Post-Creation

#### For "Create new" path:

1. **Create the issue** via `mcp__github__create_issue` (using the draft confirmed in Step 6)
2. **Add to project:** `pm add <num> <selected_priority>`
   - `<selected_priority>` comes from Step 7

#### For Update existing path:

1. The sub-playbook already applied changes in Step 6
2. **Do NOT run `pm add`** — the issue is already in the project with its own workflow state and priority. Running `pm add` would reset both to Backlog/normal.

#### For Merge path:

1. The sub-playbook already applied changes in Step 6
2. **If the merge updated an existing canonical issue:** Do NOT run `pm add` (same reason as Update — preserve existing state).
3. **If the merge created a new consolidated issue:** Run Step 7 (Priority Assessment) for the new issue, then `pm add <num> <selected_priority>`.

#### All paths:

Display issue number and URL, then:

Use AskUserQuestion:

```
question: "Issue created. Start working on it now?"
header: "Next Step"
options:
  - label: "Start work (Recommended)"
    description: "Move to Active and enter plan mode"
  - label: "Done for now"
    description: "Leave issue in backlog"
```

**On "Start work":** Run Execute Mode with the new issue number.

---

## Playbook: Execute Mode

### Goal

Load issue context, detect workflow mode, and offer appropriate actions.

### Step 1: Gather State (Parallel)

Run these in parallel:

#### 1a. Get Issue Details

Use `mcp__github__get_issue` with:

- owner: "{{OWNER}}"
- repo: "{{REPO}}"
- issue_number: $ARGUMENTS

Extract: title, state (open/closed), labels, body

#### 1b. Get Issue Comments (CRITICAL)

```bash
gh issue view $ARGUMENTS --json comments --jq '.comments[] | {author: .author.login, createdAt: .createdAt, body: .body}'
```

**WARNING:** Comments frequently contain spec corrections, plan updates, and review feedback. You MUST read ALL comments.

#### 1c. Get Project State

```bash
export PATH="./tools/scripts:$PATH" && pm status $ARGUMENTS
```

Extract the `workflow` field. **If the command fails** (non-zero exit, issue not in project, network error), set `workflow = null` — this will trigger MISMATCH(not_in_project) in Step 4, which offers to add the issue to the project.

#### 1d. PR Discovery

Search for linked PRs using multiple strategies:

**Strategy 1-3: Closing keywords (High confidence)**

Use `mcp__github__search_issues` with queries:

- `repo:{{OWNER}}/{{REPO}} is:pr "Fixes #$ARGUMENTS"`
- `repo:{{OWNER}}/{{REPO}} is:pr "Closes #$ARGUMENTS"`
- `repo:{{OWNER}}/{{REPO}} is:pr "Resolves #$ARGUMENTS"`

**Strategy 4: Issue URL (High confidence)**

Search for issue URL in PR body:

- `repo:{{OWNER}}/{{REPO}} is:pr "github.com/{{OWNER}}/{{REPO}}/issues/$ARGUMENTS"`

Deduplicate results by PR number.

#### 1e. PM Intelligence Context (Parallel)

Call these PM intelligence tools to enrich context gathering:

```
mcp__pm_intelligence__recover_context({ issueNumber: $ARGUMENTS })
mcp__pm_intelligence__get_issue_dependencies({ issueNumber: $ARGUMENTS })
```

`recover_context` returns: resumption guide with detected mode, what happened in prior sessions, next steps, warnings, context files to load. Use this to inform your briefing packet and plan.

`get_issue_dependencies` returns: blockers, dependents, execution order. Use this to detect blocked/blocking relationships in Step 2.

**If either call fails**, continue without it — these are enrichment, not gates.

#### 1f. Check Codex Availability

```bash
codex --version 2>/dev/null
```

Exit 0 → `codex_available = true` (store version string).
Non-zero → `codex_available = false`.

Used by Sub-Playbook: Collaborative Planning and Sub-Playbook: Codex Implementation Review. When false, both loops skip with a one-line notice.

### Step 1.5: Issue Readiness Check

Scan issue for structural completeness:

- [ ] Has acceptance criteria (`## Acceptance Criteria` with checkboxes)
- [ ] Has clear scope (`## Non-goals` section)
- [ ] Has problem statement (`## Problem / Goal` section)

**If missing critical sections, offer (don't block):**

Use AskUserQuestion:

```
question: "This issue is missing some structure. Want to upgrade it?"
header: "Readiness"
options:
  - label: "Upgrade to execution-ready (Recommended)"
    description: "Add missing acceptance criteria, non-goals, etc."
  - label: "Proceed anyway"
    description: "Work with issue as-is"
```

**On "Upgrade":**

1. Run a mini-PM pass to identify missing sections
2. Generate additions using Appendix C diff template
3. Show preview, confirm
4. Apply via `mcp__github__update_issue`

**On "Proceed anyway":** Continue to Step 2.

### Step 2: Check for Blockers (GATE)

If the issue has any `blocked:*` labels, stop and get acknowledgment.

Use AskUserQuestion:

```
question: "This issue has blockers. Acknowledge before proceeding?"
header: "Blocked"
options:
  - label: "I understand the blockers, proceed anyway"
    description: "Continue with awareness of the blocking issues"
  - label: "Stop - I need to resolve blockers first"
    description: "Exit without starting work"
```

**If user chooses "Stop", exit the skill.**

### Step 3: PR Selection

From discovered PRs:

1. Filter to open PRs only
2. If multiple open PRs → MISMATCH("multiple_prs")
3. If exactly one open PR → canonical PR (get details via `mcp__github__get_pull_request`)
4. If zero open PRs but closed/merged exist → select most recently merged
5. If zero PRs → canonical_pr = null

### Step 4: Compute Mode

Apply rules in order (first match wins):

| #   | Condition                                        | Mode                     |
| --- | ------------------------------------------------ | ------------------------ |
| 1   | workflow == null (not in project)                | MISMATCH(not_in_project) |
| 2   | Multiple open PRs found                          | MISMATCH(multiple_prs)   |
| 3   | issue.state == "closed" AND workflow == "Done"   | CLOSED                   |
| 4   | PR merged AND (issue open OR workflow != "Done") | MISMATCH(stage_behind)   |
| 5   | PR exists AND has CHANGES_REQUESTED review       | REWORK                   |
| 6   | PR exists AND open AND APPROVED AND not draft    | APPROVED                 |
| 7   | PR exists AND open AND (no review OR PENDING)    | REVIEW                   |
| 8   | workflow == "Done" AND issue.state == "open"     | MISMATCH(stage_behind)   |
| 9   | workflow == "Rework" AND no open PR              | MISMATCH(no_pr)          |
| 10  | workflow == "Review" AND no open PR              | MISMATCH(no_pr)          |
| 11  | workflow == "Active"                             | CONTINUE                 |
| 12  | workflow in ["Ready", "Backlog"]                 | START                    |

### Step 4.5: Worktree Detection (START/CONTINUE only)

**Only run this step for START or CONTINUE modes.** Other modes skip to Step 5.

**⚠️ MANDATORY: START mode from main repo MUST create worktree before any other work.**

Run: `./tools/scripts/worktree-detect.sh <issue_number>`

| Exit | Meaning                                        | Action                                     |
| ---- | ---------------------------------------------- | ------------------------------------------ |
| 0    | In correct worktree                            | Continue to Step 5                         |
| 1    | No worktree exists (in main repo)              | **CREATE WORKTREE NOW** - see below        |
| 2    | Worktree exists at `<path>`                    | **STOP** - Direct user there               |
| 3    | In wrong worktree                              | **STOP** - Direct user to correct worktree |
| 4    | Broken worktree (metadata exists, dir missing) | Offer to prune and recreate                |

**If exit 1 (no worktree, in main repo) - CREATE IMMEDIATELY:**

This is non-negotiable. Do NOT continue to Step 5. Create the worktree NOW:

```bash
# Ensure clean state
git status --porcelain  # Must be empty

# Sync with default branch
DEFAULT=$(gh repo view --json defaultBranchRef -q .defaultBranchRef.name)
git checkout "$DEFAULT" && git pull

# Create worktree - branch name from issue type
./tools/scripts/worktree-setup.sh <issue_num> <type>/<short-desc>
```

**After worktree creation, check for tmux:**

**IF `$TMUX` is set (running inside tmux portfolio session):**

Spawn the issue in a background tmux window instead of stopping:

```bash
./tools/scripts/tmux-session.sh start <issue_num>
```

Then display:

```markdown
## Issue #<num> started in background

Window: `{{prefix}}-<num>` | Branch: `<type>/<short-desc>`

Watch your tmux status bar for the alert indicator when it needs input.
Switch with: `Ctrl-b + <window-number>`

When you focus the window, run `/issue <num>` to load context.
```

**RETURN** — do NOT stop. The main session continues and can start more issues.

**ELSE (not in tmux) — display and STOP:**

```markdown
## Worktree created for #<num>

Location: `<worktree-path>`
Branch: `<type>/<short-desc>`

**Port isolation configured** (offset: <offset>)

**To continue, run:**
cd <worktree-path>

Then run `/issue <num>` again to continue setup.

For dev with port isolation:
eval "$(./tools/scripts/worktree-setup.sh <num> --print-env)"
pnpm install && {{DEV_COMMAND}}
```

**Do NOT continue working in main repo.** The user (or Claude) must switch to the worktree.

**If exit 2 (worktree exists elsewhere):**

**IF `$TMUX` is set (running inside tmux portfolio session):**

The worktree already exists — just needs a tmux window. `tmux-session.sh start` handles both cases automatically:

- If window already exists → prints "focus with..." and exits cleanly
- If window doesn't exist → creates window pointing to existing worktree, starts Claude

```bash
./tools/scripts/tmux-session.sh start <issue_num>
```

Then display:

```markdown
## Issue #<num> ready in tmux

Window: `{{prefix}}-<num>` | Worktree: `<worktree-path>`

Watch your tmux status bar for the alert indicator when it needs input.
Switch with: `Ctrl-b + <window-number>`

When you focus the window, run `/issue <num>` to load context.
```

**RETURN** — do NOT stop. The main session continues and can start more issues.

**ELSE (not in tmux) — display and STOP:**

```markdown
## Worktree for #<num> exists

The worktree for this issue already exists at:
<absolute-path>

To work on this issue:
cd <absolute-path>

Then run `/issue <num>` again to continue.
```

**If exit 3 (in wrong worktree):**

**IF `$TMUX` is set (running inside tmux portfolio session):**

No worktree exists for the target issue, but `tmux-session.sh start` resolves the main repo root from any worktree context via `git rev-parse --git-common-dir`. Spawn the worktree and window in one step:

```bash
./tools/scripts/tmux-session.sh start <issue_num> <type>/<short-desc>
```

Then display:

```markdown
## Issue #<num> started in background

Window: `{{prefix}}-<num>` | Branch: `<type>/<short-desc>`

Watch your tmux status bar for the alert indicator when it needs input.
Switch with: `Ctrl-b + <window-number>`

When you focus the window, run `/issue <num>` to load context.
```

**RETURN** — do NOT stop. The main session continues and can start more issues.

**ELSE (not in tmux) — display and STOP:**

```markdown
## Wrong worktree

You're currently in a worktree for a different issue.

To work on issue #<num>, first find or create its worktree:
cd <main-repo-path>
/issue <num>
```

**If exit 4 (broken worktree), offer fix:**

```markdown
## Broken worktree detected

Worktree for #<num> has stale metadata (directory missing).

To fix, run:
git worktree prune

Then run `/issue <num>` again to create a fresh worktree.
```

**If exit 0:** Continue to Step 5. You're in the correct worktree.

### Step 5: Load Context

#### Context Budget

Loading docs consumes context window. The skill router (~12K tokens) and issue content are already loaded. Budget the remaining context for implementation, not just reading.

**Estimate issue weight before loading docs:**

| Issue Weight | Signals | Loading Strategy |
|-------------|---------|-----------------|
| **Light** | ≤5 comments, body <5K chars | Load all tiers (P0–P3) |
| **Medium** | 6–20 comments OR body 5–15K chars | Load P0–P2, skip P3 |
| **Heavy** | >20 comments OR body >15K chars OR >3 area labels | Load P0–P1 only |

**Loading tiers (in order):**

| Tier | Category | Skip Rule |
|------|----------|-----------|
| **P0** | Core project docs (CLAUDE.md, PM_PLAYBOOK.md) | Never skip |
| **P1** | Area-specific docs (from area labels) | Only if issue is heavy AND has >3 area labels (load top 2) |
| **P2** | Keyword-matched docs (from issue body scan) | Skip if issue is heavy |
| **P3** | context7 library docs (external queries) | Skip if issue is medium or heavy |

**When skipping a tier:** Note what was skipped in the briefing packet (Step 7) so the user knows. If implementation stalls due to missing context, load skipped docs at that point rather than upfront.

#### P0: Always Load

1. Read `CLAUDE.md`
2. Read `docs/PM_PLAYBOOK.md`

#### P1: Load Based on Area Labels

Read `docs/PM_PROJECT_CONFIG.md` § "Area Documentation" for the mapping of area labels to documentation files. For each area label on the issue, load the corresponding docs listed in that table.

> **Note:** Not all area labels may exist in your project. Skip any that don't apply. If the issue has >3 area labels and is heavy, load only the 2 most relevant areas.

#### P2: Load Based on Keywords

Scan issue body AND comments for keywords listed in `docs/PM_PROJECT_CONFIG.md` § "Keyword Documentation" (see also Appendix G). Load the corresponding docs for any matching keywords.

> **Budget cap:** If P1 already loaded 3+ doc files, load at most 2 keyword-matched docs (prioritize by keyword frequency in the issue).

#### P3: Load External Library Docs (context7)

Scan for library references listed in `docs/PM_PROJECT_CONFIG.md` § "Library Documentation (context7)" and query context7:

```
mcp__context7__resolve-library-id { "libraryName": "<library>" }
mcp__context7__query-docs { "libraryId": "<resolved>", "query": "<relevant topic from issue>" }
```

> **Budget cap:** At most 2 context7 queries per issue. Prefer the library most central to the acceptance criteria.

### Step 6: Comment if Approach Differs (MANDATORY for START/CONTINUE)

**Before presenting actions, check if your understanding differs from the issue.**

Compare:

1. The original issue body (acceptance criteria, approach)
2. The latest comments (corrections, updates, review feedback)
3. Your planned approach

**If your approach differs from the original issue body**, post a comment via `mcp__github__add_issue_comment`:

```markdown
## Implementation Plan

[Explain your approach and how it differs from the original issue, citing which comments informed the changes]
```

**This ensures reviewers have context.**

### Step 7: Output Briefing Packet

**Read `.claude/skills/issue/appendices/briefing-format.md` for the standard and compact briefing packet formats.**

Display the briefing using the appropriate format (standard for non-CLOSED modes, compact for CLOSED mode).

### Step 8: Present Actions

Use AskUserQuestion with mode-specific options (see Appendix I below for all modes).

---

## Sub-Playbook Index

**When a step above says "Run Sub-Playbook: X", read the corresponding file for the full flow.**

| Sub-Playbook | File | When Used |
|-------------|------|-----------|
| **Duplicate Scan** | `.claude/skills/issue/sub-playbooks/duplicate-scan.md` | Create Mode Step 4 |
| **Update Existing** | `.claude/skills/issue/sub-playbooks/update-existing.md` | Create Mode Step 6 (update path) |
| **Merge/Consolidate** | `.claude/skills/issue/sub-playbooks/merge-consolidate.md` | Create Mode Step 6 (merge path) |
| **Discovered Work** | `.claude/skills/issue/sub-playbooks/discovered-work.md` | During implementation when out-of-scope work is found |
| **Collaborative Planning** | `.claude/skills/issue/sub-playbooks/collaborative-planning.md` | START/CONTINUE mode plan steps (Codex Plan B) |
| **Codex Implementation Review** | `.claude/skills/issue/sub-playbooks/implementation-review.md` | Post-implementation quality gate |
| **Post-Implementation Sequence** | `.claude/skills/issue/sub-playbooks/post-implementation.md` | After ExitPlanMode in START/CONTINUE/REWORK |

---

## Appendix Index

**When a step above references "Appendix X", read the corresponding file for details.**

| Appendix | File | Content |
|----------|------|---------|
| **A-E: Templates** | `.claude/skills/issue/appendices/templates.md` | Search queries, issue body, diff preview, merge plan, label derivation |
| **H: Briefing Format** | `.claude/skills/issue/appendices/briefing-format.md` | Standard + compact briefing packet formats |
| **J: Worktrees** | `.claude/skills/issue/appendices/worktrees.md` | Git worktrees, port isolation, tmux portfolio manager |
| **K: Priority** | `.claude/skills/issue/appendices/priority.md` | Priority definitions, factor evaluation, worked examples, plan files |
| **L: Codex Reference** | `.claude/skills/issue/appendices/codex-reference.md` | Command syntax, sandbox modes, output parsing, error handling |
| **Design Rationale** | `.claude/skills/issue/appendices/design-rationale.md` | Why two modes, why worktrees, why parallel gates, etc. |

**Note:** The full verification checklist (Appendix F) is in `.claude/skills/issue/VERIFICATION.md` — it is NOT loaded at runtime. Use it only for testing or modifying the skill.

---

## Appendix G: Keyword-Based Doc Loading

**Read `docs/PM_PROJECT_CONFIG.md` § "Keyword Documentation" for the full mapping.**

The config file maps keywords found in issue bodies/comments to documentation files that Claude should load for context. When scanning an issue, match against all keyword rows and load the corresponding docs.

---

## Appendix I: Mode-Specific Actions

### START Mode

```
question: "How would you like to proceed with this issue?"
header: "Start"
options:
  - label: "Move to Active and enter plan mode (Recommended)"
    description: "Create worktree, move issue to Active, then iterate on implementation plan"
  - label: "Just show context"
    description: "Display issue details without changing state"
```

**On "Move to Active and enter plan mode":**

**Prerequisite:** You MUST already be in the correct worktree (Step 4.5 handles this).
If Step 4.5 detected exit 1 (no worktree), worktree was created and you should have stopped.
If you're seeing this, you're in the correct worktree (exit 0).

1. **Move to Active BEFORE entering plan mode:**

   **⚠️ CRITICAL ORDER: This MUST happen before EnterPlanMode.**

   Plan mode restricts Bash tool usage, so this command will fail if called after EnterPlanMode:

   ```bash
   pm move <num> Active
   ```

1.5. **Background environment setup** (before plan mode):

Kick off {{SETUP_COMMAND}} in the background so the environment bootstraps while you plan.

Call the Bash tool with these exact parameters:

- command: "{{SETUP_COMMAND}}"
- run_in_background: true
- description: "Background environment setup for issue #<num>"

The Bash tool returns a result that includes a task_id. Store this task_id for
checking after plan mode exits.

Behavior: The command starts in a separate process and returns control to you
immediately (within seconds). You do not wait for {{SETUP_COMMAND}} to finish.

**If the Bash call fails or does not return a task_id:** Warn the user
("Background setup failed to launch, you may need to run `{{SETUP_COMMAND}}` manually")
and set task_id to null. Continue to step 2 regardless — setup
failure must never block planning.

Rules:

- Proceed immediately to step 2 (EnterPlanMode) after storing the task_id (or null)
- Do NOT call TaskOutput before EnterPlanMode
- Do NOT block planning for any reason related to setup
- The result is checked after plan mode exits (see "After ExitPlanMode" below)

Worktree prerequisite: This step only runs when you are already in the correct
worktree (exit 0 from Step 4.5). If Step 4.5 created a worktree and stopped, this
step runs on the NEXT /issue <num> invocation from within the worktree.

2. **Call EnterPlanMode tool** - Only after step 1.5 completes (task_id or null)

3. **Plan title convention:** Start the plan with `# Plan: <title> (#<issue_num>)` so plan files are discoverable by issue number via `./tools/scripts/find-plan.sh`.

4. **Launch Codex Plan B (inside plan mode, BEFORE writing Plan A):**

   **⚠️ This MUST happen before Claude writes Plan A.** Ordering-based independence.

   Uses `mcp__codex__codex` MCP tool (works inside plan mode — no Bash needed).

   If `codex_available` is true:

   AskUserQuestion: "Ready to plan. Launch Codex for independent Plan B?"
   - "Yes — launch Codex (Recommended)" — Run Phase 1, Step 1 of Sub-Playbook: Collaborative Planning. Then proceed to step 5.
   - "Skip — Claude-only plan" — Proceed to step 5, skip step 7.

   If `codex_available` is false:
   Display: "Codex not available — skipping collaborative planning."

5. **Gather planning intelligence** (inside plan mode, before writing Plan A):

   Call these in parallel to inform the plan:

   ```
   mcp__pm_intelligence__suggest_approach({ area: "<issue_area>", keywords: "<key terms>" })
   mcp__pm_intelligence__predict_completion({ issueNumber: <num> })
   mcp__pm_intelligence__predict_rework({ issueNumber: <num> })
   mcp__pm_intelligence__get_history_insights()
   ```

   - `suggest_approach`: Past decisions and outcomes for this area — what worked, what didn't
   - `predict_completion`: P50/P80/P95 delivery estimates to include in the plan
   - `predict_rework`: Rework probability — if high, add extra review steps to the plan
   - `get_history_insights`: Code hotspots and coupling — inform which files to touch carefully

   **If the issue is large (epic or has >5 ACs):**

   ```
   mcp__pm_intelligence__decompose_issue({ issueNumber: <num> })
   ```

   Use the subtask breakdown to structure the implementation phases in Plan A.

   **Use intelligence output to enrich the plan, not replace your judgment.** If past approaches failed in this area, call that out. If rework probability is >50%, add a "Risk Mitigation" section.

6. In plan mode, create Plan A that includes:
   - Acceptance criteria as checkboxes
   - **AC Traceability Table** (see below) — maps each criterion to implementation files and tests
   - Non-goals as DO NOT constraints
   - Inline policy snippets from loaded docs
   - Development guardrails (including port isolation via shell exports)
   - Implementation approach (informed by `suggest_approach` intelligence)
   - **Delivery estimate** from `predict_completion` (P50/P80/P95)
   - **Risk flags** from `predict_rework` (if probability >50%)
   - **Scope boundary check** (see below)

7. **Collaborative Planning: Refinement (after Plan A is written):**

   If collaborative planning was launched in step 4:

   **⚠️ Refinement iterations use `mcp__codex__codex` MCP tool (works inside plan mode), NOT `codex exec` via Bash.**

   Run Phases 2-3 of Sub-Playbook: Collaborative Planning
   (Questions with recommendations, then Iterative Refinement until convergence)
   Update the plan file with any revisions made during refinement.

   For Phase 3 Codex calls, use:
   ```
   mcp__codex__codex({
     prompt: "Review my updated plan for issue #<num> at <plan_a_path>. The decision ledger at /tmp/codex-plan-ledger-<num>.json shows what has already been proposed, accepted, and rejected. Do NOT re-propose rejected items. If you have NEW suggestions, propose them. If all your concerns are addressed, respond with CONVERGED.",
     sandbox: "read-only",
     cwd: "<repo_root>"
   })
   ```

   If skipped in step 4: skip this step.

8. Present the final plan to user for approval via ExitPlanMode

   Only start implementing when user approves.

#### Scope Boundary Check (in plan mode)

Before finalizing the plan, explicitly verify:

```markdown
### Scope Check

**This PR will ONLY contain:**

- [ ] Changes directly addressing the acceptance criteria above
- [ ] No infrastructure changes unless listed in acceptance criteria
- [ ] No dependency upgrades unless listed in acceptance criteria
- [ ] No refactoring beyond what's needed for the feature

**If you discover work outside this scope during implementation:**
→ STOP and run Sub-Playbook: Discovered Work
→ Create separate issue, establish blocker if needed
→ Do NOT bundle unrelated work into this PR
```

Include this in the plan output so the user sees and acknowledges scope boundaries.

#### AC Traceability Table (MANDATORY in all plans)

Every plan MUST include a traceability table mapping each acceptance criterion to its planned implementation and test. This makes review verification structural — the reviewer checks the table against the code, not the code against their memory of the AC.

```markdown
### AC Traceability

| # | Acceptance Criterion | Implementation File(s) | Test File(s) | Notes |
|---|---------------------|----------------------|-------------|-------|
| 1 | [criterion text] | `src/auth.ts` | `tests/auth.test.ts` | |
| 2 | [criterion text] | `src/api/route.ts` | `tests/api.test.ts` | Needs new test |
| 3 | [criterion text] | — | — | Spike: approach TBD |
```

**Rules:**
- Every AC must have a row, even if implementation is "TBD" or "spike needed"
- Empty Implementation/Test columns flag gaps early (before code is written)
- During implementation, update the table as files are created
- During review (/pm-review), the table is the verification checklist

**Why this matters:** The #1 review failure mode is accepting a PR that "looks complete" but silently misses an AC. The traceability table makes gaps visible before implementation starts and provides the reviewer with a structural checklist rather than relying on their thoroughness.

#### After ExitPlanMode (START)

Before beginning implementation, check the background {{SETUP_COMMAND}} result.

**If task_id is null** (step 1.5 failed to launch): Skip the TaskOutput call.
Report "Background setup was not launched. Run `{{SETUP_COMMAND}}` manually if needed."
Proceed to implementation.

**If task_id exists:** Call the TaskOutput tool with these exact parameters:

- task_id: the value stored from step 1.5
- block: false
- timeout: 5000

Interpret the result and always report to the user:

- Completed with exit code 0: Report "Environment ready." Proceed to implementation.
- Completed with non-zero exit code: Report "Background setup failed." Show the
  first 20 lines of output. Suggest the user run {{SETUP_COMMAND}} manually. Do NOT block
  implementation.
- Still running: Report "Setup is still running in the background. You can start
  working. Check back with TaskOutput if needed before running tests."

**Post-Implementation:** After implementation is complete, follow **Sub-Playbook: Post-Implementation Sequence** (Steps 1-5). Do NOT skip directly to `{{TEST_COMMAND}}` or `pm move` Review`.

### CONTINUE Mode

**CONTINUE mode MUST enter plan mode** - this is when re-grounding is most needed.

```
question: "Resume work on this issue?"
header: "Continue"
options:
  - label: "Enter plan mode and continue (Recommended)"
    description: "Re-ground in requirements and iterate on plan before continuing"
  - label: "Check linked PR status"
    description: "Just fetch and display current PR details"
```

**On "Enter plan mode and continue":**

1. **Check worktree detection result from Step 4.5:**
   - If exit 0 (already in correct worktree) → continue to step 2
   - If exit 1 (no worktree exists) → unexpected for CONTINUE, but proceed in-place
   - If exit 2, 3, or 4 → should have already stopped in Step 4.5

2. **Git sync (MANDATORY):**

   ```bash
   # Check for clean state
   git status --porcelain  # Must be empty, otherwise warn user

   # Fetch latest
   git fetch origin

   # If PR exists, check out the PR branch
   gh pr checkout <pr_num>

   # If no PR but branch exists locally, switch to it and rebase
   git checkout <branch> && git rebase origin/main
   ```

   If git state is not clean, warn the user and ask if they want to proceed anyway.

3. **Search for previous plans:**

   ```bash
   ./tools/scripts/find-plan.sh <issue_num> --latest
   ```

   If a plan file is found, read it before entering plan mode to recover prior context. If not found (exit 1), proceed without — this is normal for new issues.

3.5. **Background environment setup** (before plan mode):

Same as START mode step 1.5. Call the Bash tool with:

- command: "{{SETUP_COMMAND}}"
- run_in_background: true
- description: "Background environment setup for issue #<num>"

Store the returned task_id for checking after plan mode exits. If the call fails
or returns no task_id, set task_id to null, warn the user, and continue.

4. **Call EnterPlanMode tool** - Re-enter plan mode to re-ground in requirements.
   Only after step 3.5 completes (task_id or null).

5. **Launch Codex Plan B (inside plan mode, BEFORE writing Plan A):**

   **⚠️ This MUST happen before Claude writes Plan A.** Ordering-based independence.

   Uses `mcp__codex__codex` MCP tool (works inside plan mode — no Bash needed).

   Same pattern as START mode step 4. If `codex_available` is true, AskUserQuestion to
   launch Codex for independent Plan B or skip. Codex writes Plan B before Claude writes Plan A.

6. In plan mode, write Plan A showing:
   - Acceptance criteria with current status (done/remaining)
   - Non-goals as DO NOT constraints
   - Inline policy snippets
   - Development guardrails (including port isolation via shell exports if in worktree)
   - What work has been done (from PR if exists)
   - What remains to be done
   - **Scope drift check** (see below)

7. **Collaborative Planning: Refinement (after Plan A is written):**

   Same as START mode step 7. If collaborative planning was launched in step 5,
   use `mcp__codex__codex` MCP tool for refinement iterations (works inside plan mode).
   Run Phases 2-3 of Sub-Playbook: Collaborative Planning. If skipped, skip this step.

8. Present the final plan to user for approval via ExitPlanMode

   Only continue implementing when user approves.

#### Scope Drift Check (in plan mode for CONTINUE)

Before continuing, check if scope has drifted:

```markdown
### Scope Drift Check

**Review the work done so far. Does the PR contain:**

- [ ] Only changes for this issue's acceptance criteria?
- [ ] No unrelated infrastructure changes?
- [ ] No bundled features that should be separate issues?

**If scope has already drifted:**
→ Consider splitting the PR before continuing
→ Extract unrelated work into separate issues/PRs
→ It's easier to split now than after more work is done

**If you discover MORE work outside scope during implementation:**
→ STOP and run Sub-Playbook: Discovered Work
→ Do NOT continue bundling unrelated changes
```

This catches scope mixing early in the CONTINUE flow, before more work gets bundled.

#### After ExitPlanMode (CONTINUE)

Same as START mode "After ExitPlanMode." If task_id is null, skip TaskOutput and
report that setup was not launched. If task_id exists, call TaskOutput with
block: false using the task_id from step 3.5. Always report the result to the
user: ready, failed (with output), or still running.

**Post-Implementation:** After implementation is complete, follow **Sub-Playbook: Post-Implementation Sequence** (Steps 1-5). Do NOT skip directly to `{{TEST_COMMAND}}` or `pm move` Review`.

### REVIEW Mode

```
question: "This issue has a PR in review. What would you like to do?"
header: "Review"
options:
  - label: "Review with /pm-review (Recommended)"
    description: "Run the PM review persona to analyze the PR"
  - label: "Make more changes"
    description: "Move back to Active state to continue development"
```

**On "Review with /pm-review":**
Print: `Run: /pm-review <issue_number>`

**On "Make more changes":**

1. Confirm: "Move issue back to Active?"
2. If yes: `pm move <num> Active`

### APPROVED Mode

```
question: "PR is approved. What would you like to do?"
header: "Approved"
options:
  - label: "Show merge instructions (Recommended)"
    description: "Display the command to merge this PR"
  - label: "Mark as done (after you merge)"
    description: "Move issue to Done state after merging"
```

**On "Show merge instructions":**
Print: `gh pr merge <pr_num> --squash`

**On "Mark as done":**

1. Confirm: "Only run this AFTER merging the PR. Continue?"
2. If yes: `pm move <num> Done`

### REWORK Mode

```
question: "Changes were requested on this PR. What would you like to do?"
header: "Rework"
options:
  - label: "Continue addressing feedback (Recommended)"
    description: "Move to Active, sync git, then display feedback and guardrails"
  - label: "Show full PR review thread"
    description: "Fetch and display all review comments"
```

**On "Continue addressing feedback":**

**⚠️ CRITICAL ORDER: Fetch context BEFORE mutating state.** If we move to Active first and the fetch fails, we've changed state without having the feedback to act on.

1. **Fetch review comments FIRST** via `mcp__github__get_pull_request_reviews`
   Also fetch PR discussion comments: `gh pr view <pr_num> --json comments --jq '.comments[].body'`
2. **Git sync (MANDATORY):**

   ```bash
   # Check for clean state
   git status --porcelain  # Must be empty, otherwise warn user

   # Fetch latest
   git fetch origin

   # Check out the PR branch
   gh pr checkout <pr_num>
   ```

   If git state is not clean, warn the user and ask if they want to proceed anyway.

3. **Move to Active:** `pm move <num> Active`
4. Display feedback summary (from step 1)
5. Display guardrails
6. After feedback is addressed, follow **Sub-Playbook: Post-Implementation Sequence** (Steps 1-5).
   This ensures Codex review, tests, and /pm-review all pass before returning to Review.

### CLOSED Mode

```
question: "This issue is complete. What would you like to do?"
header: "Closed"
options:
  - label: "Acknowledged"
    description: "No action needed"
  - label: "Reopen for additional work"
    description: "Instructions to reopen the issue"
```

**On "Reopen":**
Print: `gh issue reopen <num>`

### MISMATCH Modes

#### not_in_project

```
question: "Issue #X is not in the project. Fix this?"
header: "Fix"
options:
  - label: "Add to project (Recommended)"
    description: "Add issue to project with normal priority"
  - label: "Just show the problem"
    description: "Display details without fixing"
```

**On "Add to project":**

1. Execute: `pm add <num> normal`
2. Re-run mode detection ONCE
3. If still MISMATCH, display error and stop

#### no_pr

```
question: "Issue is in <Review/Rework> but no PR found. Fix this?"
header: "Fix"
options:
  - label: "Move back to Active (Recommended)"
    description: "Reset to Active state to create/link a PR"
  - label: "I'll provide the PR number"
    description: "Manually specify the PR that should be linked"
```

**On "Move back to Active":**
Execute: `pm move <num> Active`

#### multiple_prs

```
question: "Multiple PRs found for this issue. Which is canonical?"
header: "Select PR"
options:
  - label: "PR #A: <title>"
    description: "Use this PR as the canonical one"
  - label: "PR #B: <title>"
    description: "Use this PR as the canonical one"
```

Select the chosen PR and continue with mode detection.

#### stage_behind

```
question: "PR was merged but issue/project not updated. Fix this?"
header: "Fix"
options:
  - label: "Move to Done (Recommended)"
    description: "Update project state to match reality"
  - label: "Just show the problem"
    description: "Display details without fixing"
```

**On "Move to Done":**
Execute: `pm move <num> Done`

---

## Allowed Mutations

**Shell PATH:** The `pm` CLI lives at `./tools/scripts/pm`. Always prefix Bash commands that use `pm` with:

```bash
export PATH="./tools/scripts:$PATH" && pm <command>
```

**This skill can execute:**

- `pm add <num> <priority>` - Add issue to project
- `pm move <num> <state>` - Change workflow state
- `./tools/scripts/worktree-detect.sh <num>` - Detect worktree status
- `./tools/scripts/worktree-setup.sh <num> <branch>` - Create worktree with port isolation
- `./tools/scripts/tmux-session.sh start <num>` - Start issue in tmux window (portfolio mode)
- `mcp__github__create_issue` - Create new issues
- `mcp__github__update_issue` - Update issues (including close with state=closed)
- `mcp__github__add_issue_comment` - Post comments
- Git operations: status, checkout, pull, fetch, rebase, worktree
- `codex --version` - Check Codex CLI availability
- `mcp__codex__codex({ prompt, sandbox, cwd })` - Launch Codex session (collaborative planning Phase 1, implementation review)
- `mcp__codex__codex-reply({ threadId, prompt })` - Continue Codex conversation (implementation review dialogue)
- `/pm-review <pr-or-issue-number>` - Self-review before Review transition (ANALYSIS_ONLY action)

**Print-only (user must run):**

- `gh pr merge` - Merge PR
- `gh issue reopen` - Reopen closed issue
- `gh pr create` - Create PR
- `cd <worktree-path> && claude` - Switch to worktree
- `eval "$(./tools/scripts/worktree-setup.sh <num> --print-env)"` - Apply port isolation
- `pnpm install && {{DEV_COMMAND}}` - Initialize and start worktree dev server

**Execution scope note:** The `allowed-tools` frontmatter restricts tools during skill execution (mode detection, briefing, plan mode entry). After ExitPlanMode, the skill has ended and Claude Code resumes normal operation with standard tool permissions. The Post-Implementation Sequence runs in this normal context.

---

## Remember

This skill exists because Claude tends to:

1. Skim issues without reading comments
2. Start implementing before understanding constraints
3. Ignore non-goals and policies
4. Forget to update workflow state
5. Not reconcile comment feedback with original spec
6. Create duplicate issues instead of searching first
7. **Bundle discovered work into the current PR instead of creating separate issues**
8. **Skip worktree creation and work in main repo, risking conflicts with other sessions**

**Follow every step. Read every comment. Post plan comments when approach differs. Search before creating. Always use worktrees.**

### Working in Worktrees (CRITICAL)

**The Bash tool resets working directory after each command.** When working in a worktree:

1. **Use absolute paths** for all file operations:
   - Read: `/Users/.../{{prefix}}-306/path/to/file.ts` (not `path/to/file.ts`)
   - Edit: Use full absolute path
   - Bash: `cd /path/to/worktree && command` or use absolute paths in commands

2. **Never assume you're in the worktree** - verify with `pwd` if uncertain

3. **Track which worktree you're in** - the path tells you the issue number (e.g., `{{prefix}}-306` = issue #306)

4. **Don't mix worktrees** - if you need to work on a different issue, that issue has its own worktree

### The Scope Discipline Lesson

A developer worked on a feature issue. During implementation, they discovered an infrastructure dependency needed upgrading. Instead of:

1. Creating a separate issue for the infrastructure upgrade
2. Establishing a blocker relationship
3. Implementing the upgrade in a separate PR first

They bundled both into one PR. Result:

- **3 reviews requesting changes** due to scope mixing
- **Can't merge infra** without also merging incomplete feature
- **Can't rollback infra** without losing feature work
- **Both issues stuck in Rework**

**The fix:** When you discover work outside the current issue's scope:

1. **STOP** - Don't just add it to the current PR
2. **Create separate issue** - Run Create Mode with your context
3. **Establish blocker** - If it blocks current work, add the relationship
4. **Implement in order** - Blocker first, then resume original work

**One concern per PR. Discovered work gets its own issue.**
