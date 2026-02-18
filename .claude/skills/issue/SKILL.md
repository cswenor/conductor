---
name: issue
description: Create new issues (PM interview) or work on existing issues. Use without arguments to create, with issue number to execute.
argument-hint: '[issue-number]'
allowed-tools: Read, Glob, Bash(./tools/scripts/project-add.sh *), Bash(./tools/scripts/project-move.sh *), Bash(./tools/scripts/project-status.sh *), Bash(./tools/scripts/worktree-detect.sh *), Bash(./tools/scripts/worktree-setup.sh *), Bash(./tools/scripts/tmux-session.sh *), Bash(./tools/scripts/find-plan.sh *), Bash(./tools/scripts/codex-mcp-overrides.sh), Bash(git status *), Bash(git checkout *), Bash(git pull *), Bash(git fetch *), Bash(git rebase *), Bash(git worktree *), Bash(gh issue view * --json comments *), Bash(gh repo view *), Bash(gh pr checkout *), Bash(pnpm install), Bash(codex --version *), Bash(codex exec -s read-only *), Bash(codex exec -s workspace-write *), Bash(codex exec -c *), mcp__github__get_issue, mcp__github__create_issue, mcp__github__update_issue, mcp__github__add_issue_comment, mcp__github__search_issues, mcp__github__get_pull_request, mcp__github__get_pull_request_files, mcp__github__get_pull_request_reviews, mcp__context7__resolve-library-id, mcp__context7__query-docs, AskUserQuestion, EnterPlanMode, TaskOutput
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
  owner: cswenor
  repo: conductor
  project_id: PVT_kwHOAAnhG84BPhU0
  project_number: 1

tools:
  prefer: MCP (mcp__github__*)
  fallback: gh CLI (only when MCP lacks capability)
```

---

## Hard Guardrails (Non-Negotiable)

| Guardrail          | Rule                                                                               |
| ------------------ | ---------------------------------------------------------------------------------- |
| Arg parsing        | Empty → Create Mode, Number → Execute Mode                                         |
| Create Mode prompt | User-invoked `/issue` (no args) MUST display prompt FIRST, before any other action |
| Context check      | AI-invoked Create Mode only: if context exists, skip to Decision Pack              |
| Questions          | 1-2 at a time, max ~5 total (only if needed)                                       |
| Candidates shown   | Top 3 max                                                                          |
| Duplicate scan     | MUST run at least 3 searches before any creation                                   |
| Preview            | MUST show before create/update/close                                               |
| Confirmation       | MUST get explicit user confirmation before any mutation                            |
| No auto-close      | NEVER close issues without confirmation                                            |
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

After gathering enough context, produce a structured summary:

**Decision Pack:**

- **intent**: bug | feature | spike | epic
- **area**: frontend | backend | contracts | infra
- **problem_summary**: 2-4 sentences describing the issue
- **proposed_title**: Issue title (format: `<type>: <description>`)
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
- **Merge path that chose "Create new consolidated issue"** → Step 8 invokes Step 7 before `project-add.sh`
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

Show the completed factor table and recommendation to the user. See Appendix K for factor evaluation signals and worked examples.

#### 4. Confirm Priority

Use AskUserQuestion with the recommended priority listed first:

```
question: "What priority should this issue have?"
header: "Priority"
options:
  - label: "<recommended> (Recommended)"
    description: "<one-line reasoning summary>"
  - label: "<second option>"
    description: "<definition from Appendix K>"
  - label: "<third option>"
    description: "<definition from Appendix K>"
```

All three options (`Critical`, `High`, `Normal`) MUST be present. The recommended one goes first with `(Recommended)` suffix.

#### 5. Store Selection

Store the user's choice as `<selected_priority>` — the exact lowercase value (`critical`, `high`, or `normal`) passed to `project-add.sh` in Step 8.

### Step 8: Issue Creation & Post-Creation

#### For "Create new" path:

1. **Create the issue** via `mcp__github__create_issue` (using the draft confirmed in Step 6)
2. **Add to project:** `./tools/scripts/project-add.sh <num> <selected_priority>`
   - `<selected_priority>` comes from Step 7

#### For Update existing path:

1. The sub-playbook already applied changes in Step 6
2. **Do NOT run `project-add.sh`** — the issue is already in the project with its own workflow state and priority. Running `project-add.sh` would reset both to Backlog/normal.

#### For Merge path:

1. The sub-playbook already applied changes in Step 6
2. **If the merge updated an existing canonical issue:** Do NOT run `project-add.sh` (same reason as Update — preserve existing state).
3. **If the merge created a new consolidated issue:** Run Step 7 (Priority Assessment) for the new issue, then `./tools/scripts/project-add.sh <num> <selected_priority>`.

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

- owner: "cswenor"
- repo: "conductor"
- issue_number: $ARGUMENTS

Extract: title, state (open/closed), labels, body

#### 1b. Get Issue Comments (CRITICAL)

```bash
gh issue view $ARGUMENTS --json comments --jq '.comments[] | {author: .author.login, createdAt: .createdAt, body: .body}'
```

**WARNING:** Comments frequently contain spec corrections, plan updates, and review feedback. You MUST read ALL comments.

#### 1c. Get Project State

```bash
./tools/scripts/project-status.sh $ARGUMENTS
```

Extract the `workflow` field.

#### 1d. PR Discovery

Search for linked PRs using multiple strategies:

**Strategy 1-3: Closing keywords (High confidence)**

Use `mcp__github__search_issues` with queries:

- `repo:cswenor/conductor is:pr "Fixes #$ARGUMENTS"`
- `repo:cswenor/conductor is:pr "Closes #$ARGUMENTS"`
- `repo:cswenor/conductor is:pr "Resolves #$ARGUMENTS"`

**Strategy 4: Issue URL (High confidence)**

Search for issue URL in PR body:

- `repo:cswenor/conductor is:pr "github.com/cswenor/conductor/issues/$ARGUMENTS"`

Deduplicate results by PR number.

#### 1e. Check Codex Availability

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

Window: `cond-<num>` | Branch: `<type>/<short-desc>`

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
pnpm install && pnpm dev
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

Window: `cond-<num>` | Worktree: `<worktree-path>`

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

Window: `cond-<num>` | Branch: `<type>/<short-desc>`

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

#### Always Load

1. Read `CLAUDE.md`
2. Read `docs/PM_PLAYBOOK.md`

#### Load Based on Area Labels

| Label            | Docs to Load                                                                         |
| ---------------- | ------------------------------------------------------------------------------------ |
| `area:frontend`  | `docs/development/LOCAL_DEV.md`, `docs/architecture/OVERVIEW.md`                     |
| `area:backend`   | `docs/architecture/DATABASE.md`, `docs/architecture/OVERVIEW.md`                     |
| `area:contracts` | `docs/contracts/GAME_CONTRACT_INTERFACE.md`, `packages/contracts/algorand/README.md` |
| `area:infra`     | `docs/ENV_WORKFLOW.md`, `docs/SECRETS.md`, `docs/development/SETUP.md`               |

> **Note:** Not all area labels may exist in your project. Skip any that don't apply.

#### Load Based on Keywords

Scan issue body AND comments for keywords (see Appendix G).

#### Load External Library Docs (context7)

Scan for library references and query context7:

| Keywords                 | Library to Query |
| ------------------------ | ---------------- |
| sveltekit, svelte, $app/ | sveltekit        |
| algosdk, algorand sdk    | algosdk          |
| supabase, supabase-js    | supabase         |
| tailwind, tailwindcss    | tailwindcss      |
| vitest                   | vitest           |
| playwright               | playwright       |

```
mcp__context7__resolve-library-id { "libraryName": "<library>" }
mcp__context7__query-docs { "libraryId": "<resolved>", "query": "<relevant topic from issue>" }
```

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

Display using format in Appendix H.

### Step 8: Present Actions

Use AskUserQuestion with mode-specific options (see Appendix I for all modes).

---

## Sub-Playbook: Duplicate Scan

### Goal

Find similar issues before creating new ones.

### Inputs

- `fingerprint` (keywords, alt_phrases, type, area)

### Flow

#### Step 1: Generate Queries

Construct at least 3 search queries using Appendix A strategies.

#### Step 2: Execute Searches

Run queries via `mcp__github__search_issues`. Deduplicate by issue number.

**Edge case:** If searches fail (rate limit, network), log failure and return "No matches found" - don't block creation.

#### Step 3: AI Analysis (With Cited Evidence)

For each candidate, assess overlap and MUST cite concrete evidence:

**Example output:**

> **#187: Fix wallet connection timeout**
> Related - mentions Kibisis SDK, has AC "handle timeout errors" (overlaps your timeout handling goal)

#### Step 4: Recommend

Based on analysis:

- No candidates → `recommendation: none`
- One strong match → `recommendation: update`
- Multiple fragments → `recommendation: merge`
- Related but different → `recommendation: new` (with cross-links)

#### Step 5: Return

Return candidates, recommendation, and formatted display for top 3 (with cited evidence).

---

## Sub-Playbook: Update Existing

### Goal

Add new information to existing issue instead of creating duplicate.

### Inputs

- Target issue number
- New information from conversation

### Flow

#### Step 1: Load Target Issue

Fetch full issue body via `mcp__github__get_issue`.

#### Step 2: AI Synthesis

Determine what to add:

- New acceptance criteria
- Additional context to problem statement
- Reproduction steps (if bug)
- Missing labels

**AI instruction:** Determine what new information should be added. Do not duplicate existing content.

#### Step 3: Show Diff Preview

Display additions using Appendix C template.

#### Step 4: Confirm

Use AskUserQuestion:

```
question: "Apply these changes to the issue?"
header: "Update"
options:
  - label: "Apply changes (Recommended)"
    description: "Update the issue with the additions shown"
  - label: "Revise"
    description: "Let me modify the proposed changes"
  - label: "Cancel"
    description: "Don't update, go back"
```

#### Step 5: Apply

On confirm:

1. Update via `mcp__github__update_issue`
2. Add comment if substantial context was added
3. Offer handoff to Execute Mode

---

## Sub-Playbook: Merge/Consolidate

### Goal

Combine fragmented issues into one canonical issue.

### Safety Rules

- **Default canonical = existing issue** (not new), unless user explicitly prefers new
- **Max 3 closes per action** - if more than 3, require additional confirmation

### Flow

#### Step 1: Select Issues

User confirms which issues to merge (from candidates + can add more).

**If > 3 issues selected:** Warn and require explicit confirmation.

#### Step 2: Select Canonical

Default to oldest or most complete existing issue.

Use AskUserQuestion:

```
question: "Which issue should be the canonical one?"
header: "Canonical"
options:
  - label: "Use #<oldest> (oldest, most complete) (Recommended)"
    description: "Update this existing issue with merged content"
  - label: "Use #<other>"
    description: "Update this existing issue instead"
  - label: "Create new consolidated issue"
    description: "Start fresh (only if existing issues are messy)"
```

#### Step 3: AI Synthesis

Read all issue bodies and produce:

- Canonical title
- Merged body (preserving valuable content)
- Supersedes section listing merged issues

#### Step 4: Show Merge Plan

Display using Appendix D template.

#### Step 5: Confirm

Use AskUserQuestion:

```
question: "Execute this merge plan?"
header: "Merge"
options:
  - label: "Execute merge (Recommended)"
    description: "Update canonical and close duplicates"
  - label: "Revise"
    description: "Let me modify the plan"
  - label: "Cancel"
    description: "Don't merge"
```

#### Step 6: Execute

On confirm:

1. Update canonical issue (or create new)
2. Close duplicates via `mcp__github__update_issue` with state=closed
3. Add comment to each closed issue: "Closed as duplicate of #X. Content preserved."
4. Offer handoff to Execute Mode

---

## Sub-Playbook: Discovered Work

### Goal

Handle work discovered during implementation that is outside the current issue's scope. Prevents scope mixing by creating separate issues with proper blocker relationships.

### When to Trigger

During START or CONTINUE mode, if you discover:

- Infrastructure changes needed (Docker, CI, tooling)
- A bug that must be fixed first
- A prerequisite feature not in the current issue
- Refactoring required to enable the feature
- Dependency upgrades blocking progress

**Key question:** "Is this work in the current issue's acceptance criteria?"

- If YES → continue, it's in scope
- If NO → trigger this sub-playbook

### Why This Matters

**The PR #266 lesson:** A developer working on Demo Wallet (#60) discovered algod needed upgrading. They bundled both into one PR. Result:

- 3 reviews requesting changes due to scope mixing
- Can't merge infra fix without also merging incomplete feature
- Can't rollback infra without losing feature work
- Both issues stuck in Rework

**The fix:** Create separate issues, establish blocker relationship, implement in order.

### Flow

#### Step 1: Recognize Discovered Work

When you realize work is needed that's not in the current issue's acceptance criteria, STOP and announce:

```markdown
## ⚠️ Discovered Work Outside Current Scope

**Current issue:** #<num> - <title>
**Discovered work:** <brief description>

This is NOT in the current issue's acceptance criteria. Following scope discipline, I need to create a separate issue.
```

#### Step 2: Classify the Discovered Work

Determine the type and relationship:

| Type             | Examples                                        | Relationship                       |
| ---------------- | ----------------------------------------------- | ---------------------------------- |
| **Blocker**      | Infra upgrade required, bug preventing progress | Current issue blocked by new issue |
| **Prerequisite** | Feature A needs Feature B first                 | Current issue blocked by new issue |
| **Related**      | Found bug while working, not blocking           | Cross-reference, no blocker        |
| **Follow-up**    | Nice-to-have discovered during work             | Cross-reference, implement later   |

#### Step 3: Create the New Issue

Use Create Mode flow but with pre-filled context:

1. Skip PM interview (you have context)
2. Run duplicate scan (MANDATORY - maybe it already exists!)
3. Generate issue with:
   - Clear problem statement referencing discovery context
   - Appropriate labels (type + area)
   - Reference to current issue: "Discovered while working on #<current>"

**Issue body template for discovered work:**

```markdown
## Problem / Goal

<description of the discovered work>

## Discovery Context

Found while working on #<current_issue>: <brief explanation of why this is needed>

## Non-goals

- Anything beyond the specific fix/feature described above
- Changes to #<current_issue>'s scope

## Acceptance Criteria

- [ ] <specific criterion>

## Definition of Done

- [ ] Code merged to main
- [ ] Tests passing
- [ ] #<current_issue> unblocked (if blocker)
```

#### Step 4: Establish Blocker Relationship (if applicable)

If the discovered work is a blocker:

1. Add `blocked:prerequisite` label to current issue
2. Post comment on current issue:

```markdown
## 🚧 Blocked by Discovered Work

While implementing this issue, discovered that #<new_issue> must be completed first.

**Blocker:** #<new_issue> - <title>
**Reason:** <why it blocks>

This issue will remain blocked until #<new_issue> is merged.
```

3. Add comment on new issue:

```markdown
## Blocks

This issue blocks #<current_issue> - <title>

**Context:** <why it's a blocker>
```

#### Step 5: Decide Next Steps

Use AskUserQuestion:

```
question: "Discovered work created as #<new_num>. How do you want to proceed?"
header: "Next Step"
options:
  - label: "Work on blocker first (Recommended)"
    description: "Switch to #<new_num>, implement it, then return to #<current>"
  - label: "Continue current work"
    description: "Work around the blocker for now, address #<new_num> later"
  - label: "Pause and reassess"
    description: "Stop work, review priorities with the team"
```

**On "Work on blocker first":**

1. Move current issue to Ready (parking it)
2. Run Execute Mode on the new issue
3. After new issue is Done, prompt to resume current issue

**On "Continue current work":**

1. Warn: "Working around blockers may result in incomplete implementation"
2. Remove `blocked:` label if user insists
3. Continue with current issue

**On "Pause and reassess":**

1. Keep current issue in Active
2. Keep new issue in Backlog
3. Exit skill

---

## Sub-Playbook: Collaborative Planning

### Goal

Independent plan generation by both Claude and Codex, followed by iterative refinement on Claude's plan until convergence. Eliminates anchoring bias by having Codex write its own plan before seeing Claude's.

### Prerequisites

- `codex_available` is true
- Inside plan mode, BEFORE Claude writes Plan A
- Issue context loaded (issue body, acceptance criteria, non-goals)

### Overview

Three phases:

1. **Independent Plan Writing** — Codex writes Plan B first, then Claude writes Plan A (ordering-based independence)
2. **Questions with Recommendations** — Both agents surface spec ambiguities with recommendations
3. **Iterative Refinement** — Claude incorporates Codex ideas, then iterates with Codex on Claude's plan until convergence

### Phase 1: Independent Plan Writing

**Key property:** Codex writes Plan B BEFORE Claude writes Plan A. Plan A does not exist on disk when Codex runs — ordering-based independence.

#### Step 1: Launch Codex Plan B

This runs inside plan mode, BEFORE Claude writes the plan file. Claude has loaded context (issue, docs, codebase) but has NOT yet written anything to the plan file.

1. Ensure `.codex-work/` directory exists and generate a unique prefix:

```bash
mkdir -p .codex-work
PLAN_B_PREFIX=$(uuidgen | tr -d '-' | head -c 8)
```

2. Launch Codex (fresh session, `-s workspace-write`):

```bash
set -o pipefail
codex exec $(./tools/scripts/codex-mcp-overrides.sh) --json -s workspace-write --skip-git-repo-check \
  -o /tmp/codex-collab-output-<issue_num>.txt \
  "Write an implementation plan for issue #<issue_num>. Save to .codex-work/plan-<issue_num>-${PLAN_B_PREFIX}.md" \
  2>/tmp/codex-collab-stderr-<issue_num>.txt \
  | tee /tmp/codex-collab-events-<issue_num>.jsonl
```

3. Check for failures:
   - Non-zero exit via `PIPESTATUS[0]`
   - Missing or empty Plan B file (`.codex-work/plan-<issue_num>-${PLAN_B_PREFIX}.md`)
   - 0-byte `-o` output (context exhaustion)

**Stderr capture (inline, no rerun):** Stderr is redirected to a file on the first run — never suppressed, never requires a rerun. On non-zero exit, read the stderr file for the "Show error" option.

```bash
set -o pipefail
codex exec $(./tools/scripts/codex-mcp-overrides.sh) --json -s workspace-write --skip-git-repo-check \
  -o /tmp/codex-collab-output-<issue_num>.txt \
  "Write an implementation plan for issue #<issue_num>. Save to .codex-work/plan-<issue_num>-${PLAN_B_PREFIX}.md" \
  2>/tmp/codex-collab-stderr-<issue_num>.txt \
  | tee /tmp/codex-collab-events-<issue_num>.jsonl
CODEX_EXIT=${PIPESTATUS[0]}
if [ $CODEX_EXIT -ne 0 ]; then
  CODEX_STDERR=$(cat /tmp/codex-collab-stderr-<issue_num>.txt)
  # Display CODEX_STDERR in "Show error" option
fi
```

**NEVER rerun `codex exec -s workspace-write` to capture stderr.** A rerun can mutate state (create duplicate plan files). Always capture stderr from the original invocation via file redirect.

On failure: AskUserQuestion with options:

- "Retry" — re-run Codex Plan B
- "Continue with Claude-only plan" — skip collaborative planning
- "Show error" — display full error output

Do NOT auto-fall back on failure.

#### Step 2: Claude Writes Plan A

After Codex completes successfully, Claude writes Plan A to the standard plan file (`.claude/plans/`). Claude writes Plan A WITHOUT reading Plan B first — this preserves independence.

#### Step 3: Read Plan B and Extract Questions

After both plans exist, Claude reads Plan B from `.codex-work/plan-<issue_num>-${PLAN_B_PREFIX}.md` and the `-o` output file. Extract any questions Codex surfaced about spec ambiguity.

**Independence guarantee (START mode):** Ordering-based. Codex writes Plan B first — Plan A does not exist on disk. After Codex finishes, Claude writes Plan A without reading Plan B. Neither agent sees the other's plan before writing their own.

**Independence in CONTINUE mode:** The AC "Neither agent sees the other's plan before writing their own" refers to the current iteration's plans. Prior session plan artifacts in `.claude/plans/` are previous context, not "the other agent's current plan." The ordering guarantee still applies: Codex writes its Plan B before Claude writes this iteration's Plan A.

### Phase 2: Questions with Recommendations

1. Extract questions from Codex's Plan B (look for questions, ambiguities, or recommendations)
2. Claude surfaces its own questions about spec ambiguities
3. Present all questions to user via AskUserQuestion, with each agent's recommendation and rationale
4. User answers are included in the next iteration prompt to Codex
5. Claude updates Plan A with answers
6. If neither agent has questions, skip to Phase 3

### Phase 3: Iterative Refinement on Claude's Plan

This is the core loop. Claude reads Codex's plan, incorporates good ideas, then iterates with Codex on Claude's plan.

#### Step 1: Incorporate and Prompt Codex

1. Claude reads both plans and incorporates good ideas from Plan B into Plan A
2. Claude updates the plan file on disk
3. Claude prompts Codex (fresh session, `-s read-only`):

```bash
set -o pipefail
codex exec $(./tools/scripts/codex-mcp-overrides.sh) --json -s read-only --skip-git-repo-check \
  -o /tmp/codex-collab-review-<issue_num>.txt \
  "Review my updated plan for issue #<issue_num> at <plan_a_path>. I incorporated [X, Y] from your plan. I didn't take [Z] because [reason]. Read the plan file and either agree or suggest specific changes." 2>/dev/null \
  | tee /tmp/codex-collab-events-<issue_num>.jsonl
```

4. Read Codex's response from `-o` output
5. Check for failures (same pattern as Phase 1 Step 1.3)

#### Step 2: Per-Iteration Display

```markdown
### Collaborative Planning — Iteration N

**Incorporated from Codex:** [list of ideas taken]
**Not incorporated (with reasons):** [list with justification]
**Codex response:** [agrees / suggests specific changes]
```

#### Step 3: Evaluate Convergence

- **If Codex agrees (no meaningful changes proposed):** Convergence reached. Proceed to ExitPlanMode.
- **If Codex suggests changes:** Claude evaluates suggestions, incorporates good ones into Plan A, updates the plan file, then launches a NEW fresh Codex session (repeat from Step 1).

#### Step 4: 3-Iteration Checkpoint

After 3 iterations without convergence, display status and AskUserQuestion:

```
question: "Collaborative planning has iterated 3 times without convergence. How to proceed?"
header: "Plan Review"
options:
  - label: "Continue iterating (Recommended)"
    description: "Keep refining until Codex agrees"
  - label: "Accept Claude's current plan"
    description: "Stop iterating and use Claude's plan as-is"
  - label: "Use Codex's plan instead"
    description: "Replace Claude's plan with Codex's Plan B"
  - label: "Show full Codex output"
    description: "Display the complete Codex response"
```

On "Use Codex's plan instead": Copy Plan B content to the plan file, replacing Plan A.
On "Accept Claude's current plan": Stop iterating, proceed to ExitPlanMode.

#### User Override

User can override at any iteration display (Step 2) by choosing to accept or switch plans. Override terminates the loop immediately.

### Key Properties

| Property                        | Detail                                                                                                                 |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| **Fresh sessions**              | Each Codex call is a new `codex exec` invocation. Context passed in the prompt. No `resume` sessions.                  |
| **No user arbitration**         | Agents iterate until Codex agrees. User only sees the final result via ExitPlanMode. User CAN override at checkpoints. |
| **Ordering-based independence** | Codex writes Plan B first. Plan A doesn't exist when Codex runs.                                                       |
| **One canonical plan**          | Claude's plan evolves. No separate "merged plan."                                                                      |
| **Sandbox modes**               | `-s workspace-write` ONLY for Plan B creation. `-s read-only` for all iterations.                                      |
| **Plan B location**             | `.codex-work/plan-<issue_num>-<prefix>.md` — gitignored, outside `find-plan.sh` scope.                                 |

---

## Sub-Playbook: Codex Implementation Review

### Goal

Adversarial code review from Codex after implementation, before tests and Review transition.

### Prerequisites

- `codex_available` is true
- Implementation complete, changes committed (or use `--uncommitted` for pre-commit review without custom prompt)

### Flow

#### Step 1: Initial Review

```bash
echo "Implementation review for issue #<issue_num>." | \
  codex exec \
    $(./tools/scripts/codex-mcp-overrides.sh) \
    --json \
    -s read-only \
    --skip-git-repo-check \
    -o /tmp/codex-impl-review-<issue_num>.txt \
    review --base main 2>/dev/null \
  | tee /tmp/codex-impl-events-<issue_num>.jsonl
```

**Why a minimal prompt instead of no prompt:** The Post-Implementation Sequence runs Codex review (Step 2) BEFORE PR creation (Step 4). At review time, no PR exists yet, so Codex can't find the issue via a `Fixes #X` link. The minimal prompt gives Codex the issue number so it can look it up on GitHub independently. This doesn't bias the review — it just points to the issue, same as the plan review approach.

**Session ID capture (same pattern as plan review):**

```bash
CODEX_SESSION_ID=$(head -1 /tmp/codex-impl-events-<issue_num>.jsonl | jq -r '.thread_id')
```

- `-s read-only` enforces read-only sandbox (never write mode)
- `--json` outputs JSONL events for session ID capture
- `-o` is on `codex exec` level, before `review` subcommand
- `review --base main` automatically diffs against main
- Codex looks up the issue on GitHub, reads the diff from `review --base main`, and reviews independently
- **Limitation:** Stdin prompt consumption by `review --base` is best-effort in Codex CLI v0.101.0. If Codex does not consume the piped prompt, it falls back to its default review prompt. The minimal prompt ("Implementation review for issue #<num>.") is short enough to avoid context exhaustion but stdin delivery is not guaranteed. Codex still reads AGENTS.md (which defines the output format unconditionally) and browses the codebase regardless.

#### Step 2: Check for Failures

1. If non-zero exit code → Error Handling (Appendix L)
2. Check output file: if the `-o` output file does not exist OR has size 0 bytes (`[ ! -s /tmp/codex-impl-review-<issue_num>.txt ]`), this indicates context exhaustion (Codex ran out of context window on a large diff/plan). Surface via AskUserQuestion:
   - "Codex produced empty output (likely context exhaustion on large diff/plan)."
   - Options: Retry / Override

#### Step 3: Per-Iteration Display

Same format as plan review:

```markdown
### Codex Review — Iteration N

**Codex says:** [1-3 sentence summary]
**Items raised:** X findings (Y blocking, Z suggestions)
**Suggestions addressed:** [list each suggestion with action taken or justification for skipping]
**Claude's response:** [what will be revised/fixed]
```

#### Step 4: User Choice

Use AskUserQuestion:

```
question: "Codex raised findings on the implementation. How do you want to proceed?"
header: "Impl Review"
options:
  - label: "Continue — fix and re-submit (Recommended)"
    description: "Claude addresses feedback and re-submits for review"
  - label: "Override — proceed to tests"
    description: "Skip Codex findings and proceed to pnpm validate"
  - label: "Show full Codex output"
    description: "Display the complete Codex review output"
```

#### Step 5: Fix Loop

##### Suggestion Handling (part of Continue path)

When the user chooses "Continue" in Step 4, Claude MUST handle each SUGGESTION before fixing:

1. **Address it** — implement the suggestion and note what changed
2. **Justify skipping** — explain why the suggestion doesn't apply or would cause harm

"It's just a suggestion" is NOT valid justification. Valid reasons include:

- Conflicts with a non-goal
- Would require out-of-scope work (trigger Discovered Work sub-playbook)
- Codex misunderstood the context (cite specific misunderstanding)

Include the suggestion disposition in the per-iteration display (Step 3).

This step is skipped entirely when the user chooses "Override" — Override supersedes all finding handling.

After handling suggestions and addressing findings, Claude resumes the Codex session **by session ID**:

```bash
echo "This is Claude (Anthropic). <respond to Codex — answer questions if asked, explain revisions if findings were raised>" | \
  codex exec \
    $(./tools/scripts/codex-mcp-overrides.sh) \
    --json \
    -s read-only \
    --skip-git-repo-check \
    -o /tmp/codex-impl-review-<issue_num>.txt \
    resume "$CODEX_SESSION_ID" 2>/dev/null \
  | tee /tmp/codex-impl-events-<issue_num>.jsonl
```

**Dialogue guidance:** This is a two-way conversation, not a one-way submission:

- If Codex asked questions → answer them
- If Codex raised findings → explain what was changed and why
- If Codex asked for clarification → provide it
- Do not include review-content instructions (e.g., "re-review the ENTIRE diff", "check for X") — Codex decides what to review

- Uses `resume "$CODEX_SESSION_ID"` (NOT `resume --last`) for worktree isolation
- `$CODEX_SESSION_ID` was captured in Step 1
- `-o` before `resume` subcommand
- Repeat Steps 2-4 for each iteration

#### Step 6: Termination

Loop terminates when:

- Codex says APPROVED with no BLOCKING findings AND Claude has addressed or explicitly justified skipping each SUGGESTION, OR
- User chooses "Override"

**Anti-shortcut rule (Continue path only — does not apply to Override):** Claude MUST NOT self-certify its revisions are correct. Every revision MUST be re-submitted to Codex. When the user chooses Continue, the loop cannot terminate until Codex reviews the REVISED version and says APPROVED. Claude fixing all findings in one pass and declaring "done" without re-submission is the exact failure mode this loop prevents. This rule does not restrict the Override path — Override terminates the loop immediately regardless of Codex state.

---

## Sub-Playbook: Post-Implementation Sequence

### Goal

Enforced ordered sequence from completed implementation to Review transition. Prevents steps from being skipped.

### Prerequisites

- Implementation complete
- On a feature branch (not main)

### Execution Model

**After ExitPlanMode (START/CONTINUE):** The skill has completed. Claude Code resumes normal operation with its standard tool permissions (Bash, Edit, Write, etc.). The skill's `allowed-tools` frontmatter only restricts tools during skill execution — it does not apply after the skill ends. Claude Code follows this sequence as behavioral guidance.

**During REWORK mode:** The skill presents feedback and instructs Claude Code to follow this sequence. Claude Code executes each step with its normal capabilities. This is the same pattern used today — REWORK already instructs `pnpm validate` which is not in the skill's `allowed-tools` but is executed by Claude Code.

### Sequence (MANDATORY — execute in order, do not skip steps)

#### Step 1: Commit

Commit all implementation changes:

```
git add <specific files>
git commit -m "<type>(<scope>): <description>"
```

#### Step 2: Codex Implementation Review

**⚠️ STOP — do not skip this step.**

If `codex_available` is true:

1. Run **Sub-Playbook: Codex Implementation Review** (Codex reviews the diff against main independently)
2. Address all findings (BLOCKING and SUGGESTION per the Continue path's suggestion handling)
3. Amend commit or add fixup commit after addressing findings
4. Loop until Codex APPROVED or user override

If `codex_available` is false:
Display: "Codex not available — skipping implementation review."

#### Step 3: Run Tests

`pnpm validate`

Fix any failures — do NOT bypass. If fixes require code changes, commit the fixes and return to Step 2 (Codex re-review).

#### Step 4: Create or Update PR

If no PR exists yet: create PR with `Fixes #<issue_num>` in body.
If PR already exists: push changes.

**Note:** Tests run before PR creation per CLAUDE.md "Before Creating PR" checklist.

#### Step 5: Self-Review with /pm-review

Run `/pm-review <pr-or-issue-number>` as a self-check. When invoking /pm-review in this context, select the **ANALYSIS_ONLY** action — do NOT select APPROVE_ONLY, POST_REVIEW_COMMENTS, MERGE_AND_CHECKLIST, or any other mutating action. This step is diagnostic only. State transitions happen in Step 6.

**⚠️ Constraint:** When /pm-review prompts for PM-process fixes, select **SKIP_PM_FIXES**. When prompted for a verdict action, select **ANALYSIS_ONLY**. Even if /pm-review's output includes automatic PM-fix actions (workflow moves, label changes, comment posting), Claude MUST NOT execute them during this step. Read the analysis output, discard any mutation recommendations, and act only on the diagnostic findings. Structural enforcement of a non-mutating /pm-review mode is a follow-up enhancement.

If /pm-review identifies **code/implementation issues** (missing AC, scope drift, policy violations in the diff):

1. Address the feedback
2. If code changed, commit fixes and return to Step 2
3. Re-run /pm-review until code findings are resolved

**PM-process findings** (workflow state, labels, project fields, missing issue comments) are NOT code issues — do not loop on them. Step 6 handles the Review transition, and post-merge checklist handles Done.

If user overrides: proceed to Step 6 with acknowledgment.

#### Step 6: Transition to Review

`./tools/scripts/project-move.sh <num> Review`

Verify with `./tools/scripts/project-status.sh <num>` that workflow is now "Review".

#### Precedence Note

This sequence deliberately extends CLAUDE.md's generic "After Opening PR → move to Review" (CLAUDE.md §"After Opening PR") and PM_PLAYBOOK.md's Review entry criteria (PM_PLAYBOOK.md §"Review") by inserting a /pm-review quality gate (Step 5) between PR creation (Step 4) and Review transition (Step 6). The purpose is to catch issues BEFORE signaling "ready for human review" — if we moved to Review first, a human reviewer might begin reviewing while /pm-review is still running. This precedence applies ONLY to /issue-managed work; non-skill workflows still follow the generic CLAUDE.md rule.

---

## Appendix A: Search Query Strategies

Run these queries via `mcp__github__search_issues`:

1. **Title keyword:** `repo:cswenor/conductor is:issue "{keyword}" in:title`
2. **Body keyword:** `repo:cswenor/conductor is:issue "{keyword}" in:body`
3. **Area + keyword:** `repo:cswenor/conductor is:issue label:area:{area} "{keyword}"`
4. **Alternate phrasing:** `repo:cswenor/conductor is:issue "{alt_phrase}"`
5. **Open only:** `repo:cswenor/conductor is:issue is:open "{keyword}"`

Deduplicate results by issue number before returning.

---

## Appendix B: Issue Body Template

```markdown
## Problem / Goal

{problem_summary}

## User Story (if feature)

As a {user_type}, I want {goal} so that {benefit}.

## Why Now

{urgency_rationale}

## Non-goals

- {exclusion_1}
- {exclusion_2}

## Assumptions

- {assumption_1}

## Related Issues (if any)

- #{num} - {title} ({relationship})

## Acceptance Criteria

- [ ] {criterion_1}
- [ ] {criterion_2}

## Definition of Done

- [ ] Code merged to main
- [ ] Tests passing
```

---

## Appendix C: Diff Preview Template

```markdown
## Proposed Update to Issue #{num}

### Additions to Acceptance Criteria:

- - [ ] {new_criterion}

### Additions to Problem Statement:

- {additional_context}

### Labels to Add:

- {label}
```

---

## Appendix D: Merge Plan Template

```markdown
## Merge Plan

**Canonical Issue:** #{num} (existing) OR "New consolidated issue"

**Will close as duplicates:**

- #{num} - {title}

**Content to preserve:**

- From #{num}: {what_to_preserve}

**Supersedes section to add:**

> This issue consolidates #{a}, #{b}, and #{c}.
```

---

## Appendix E: Label Derivation

### Type Labels

| User signals                           | Type Label     |
| -------------------------------------- | -------------- |
| broken, doesn't work, error, crash     | `type:bug`     |
| add, new, want to be able to           | `type:feature` |
| not sure, explore, research            | `type:spike`   |
| multiple features, initiative, project | `type:epic`    |

### Area Labels

| User mentions                         | Area Label       |
| ------------------------------------- | ---------------- |
| UI, button, page, component, Svelte   | `area:frontend`  |
| API, endpoint, database, Supabase     | `area:backend`   |
| contract, on-chain, Algorand, Voi     | `area:contracts` |
| CI, deploy, script, tooling, workflow | `area:infra`     |

> **Note:** Not all area labels may exist in your project. Only create the ones relevant to your work.

---

## Appendix F: Verification Checklist

### Create Mode - New Issue

- [ ] `/issue` (no args) triggers Create Mode
- [ ] PM interview asks relevant questions (1-2 at a time)
- [ ] Duplicate scan runs before draft (at least 3 searches)
- [ ] Draft matches template structure
- [ ] Confirmation required before creation
- [ ] Priority reasoning shown with factor table after draft confirmation, before issue creation
- [ ] User given choice to accept or override recommended priority
- [ ] Selected priority (including overrides) is passed to project-add.sh

### Create Mode - Update Existing

- [ ] Candidates shown with overlap explanation
- [ ] Diff preview shown
- [ ] Existing issue updated, not new created

### Create Mode - Merge

- [ ] Merge plan shown
- [ ] Canonical updated, duplicates closed with comment

### Execute Mode (MUST NOT DEGRADE)

**These behaviors from the original `/issue ####` command MUST be preserved:**

- [ ] `/issue <number>` triggers Execute Mode (not Create Mode)
- [ ] Gathers state in parallel: issue details, comments, project status, PR discovery
- [ ] Issue readiness check runs (offers upgrade, doesn't block)
- [ ] Blocker check gates progress if `blocked:*` labels present
- [ ] Mode detection uses all 12 rules in correct order
- [ ] Loads context based on area labels and keywords
- [ ] Loads external library docs via context7
- [ ] "Comment if Approach Differs" step runs for START/CONTINUE
- [ ] Briefing packet displays all required sections
- [ ] START mode: move to Active, run pnpm install in background, enter plan mode with full detail
- [ ] CONTINUE mode: git sync, run pnpm install in background, enter plan mode with full detail
- [ ] REVIEW mode: offers /pm-review or make changes
- [ ] APPROVED mode: shows merge instructions
- [ ] REWORK mode: moves to Active, syncs git, displays feedback and guardrails
- [ ] CLOSED mode: offers reopen instructions
- [ ] MISMATCH modes: detect and offer fixes for all 4 variants
- [ ] Handoff works from Create Mode to Execute Mode

### Discovered Work Handling

- [ ] When discovering work outside current scope, STOP before bundling
- [ ] Duplicate scan runs for discovered work (maybe issue already exists)
- [ ] Blocker relationship established when discovered work blocks current issue
- [ ] Comment posted on current issue explaining the blocker
- [ ] User offered choice: work on blocker first, continue anyway, or pause

### Worktree Support

- [ ] `/issue <num>` in START mode from main repo creates worktree at `../hov-<num>/`
- [ ] Worktree setup prints shell exports for port offsets (via `--print-env`)
- [ ] If worktree already exists + tmux, spawns/focuses tmux window (not recreated)
- [ ] If worktree already exists + no tmux, user is directed there (not recreated)
- [ ] If already in correct worktree, proceeds normally without redirection
- [ ] If in wrong worktree + tmux, spawns worktree + window in background
- [ ] If in wrong worktree + no tmux, user is directed to correct location
- [ ] Broken worktree (stale metadata) is detected and fix offered
- [ ] Port isolation allows `pnpm dev` in multiple worktrees simultaneously
- [ ] CONTINUE mode detects worktree and proceeds if in correct location

### Background Setup

- [ ] /issue <num> in START mode runs pnpm install in background before plan mode
- [ ] /issue <num> in CONTINUE mode runs pnpm install in background before plan mode
- [ ] Bash tool called with run_in_background: true (returns task_id within 2 seconds)
- [ ] TaskOutput called with block: false after ExitPlanMode to check result
- [ ] Completed setup: user told "Environment ready"
- [ ] Failed setup: user shown error output and told to run pnpm install manually
- [ ] Still-running setup: user informed, not blocked
- [ ] Background setup only runs in correct worktree (not during worktree creation handoff)

### Portfolio Manager (tmux)

- [ ] `tmux-session.sh init` creates session `cond` with `main` window
- [ ] `tmux-session.sh start <num> <branch>` creates worktree + window + state
- [ ] `tmux-session.sh list` shows all tracked issues with status
- [ ] `tmux-session.sh focus <num>` switches to correct window
- [ ] `tmux-session.sh stop <num>` closes window and updates state
- [ ] Hooks fire and update `~/.cond/portfolio/<num>/status`
- [ ] `portfolio-notify.sh` is a no-op when `COND_ISSUE_NUM` not set
- [ ] tmux bell triggers on `needs-input` events — window shows alert indicator in status bar
- [ ] `/issue <num>` in START mode + tmux spawns background window instead of stopping
- [ ] `/issue <num>` in START mode without tmux uses existing fallback behavior

### Codex Review Loops

#### Collaborative Planning

- [ ] `codex --version` check in Step 1e (parallel)
- [ ] Graceful skip when codex unavailable (notice shown, not silent)
- [ ] Collaborative Planning fires inside plan mode, BEFORE ExitPlanMode, in START and CONTINUE
- [ ] Codex Plan B launches BEFORE Claude writes Plan A (ordering-based independence)
- [ ] Plan B written to `.codex-work/plan-<issue_num>-<prefix>.md` (gitignored)
- [ ] `-s workspace-write` ONLY for Plan B creation (Phase 1)
- [ ] `-s read-only` for all iterative review rounds (Phase 3)
- [ ] No `--full-auto` anywhere (overrides sandbox to workspace-write)
- [ ] Each Codex iteration is a fresh session — no resume
- [ ] `-o` flag always on `exec` level, BEFORE subcommands
- [ ] `set -o pipefail` on all `codex exec | tee` pipelines
- [ ] Claude prompts Codex with what was incorporated and what wasn't (with reasons)
- [ ] Convergence when Codex agrees — no user arbitration
- [ ] 3-iteration checkpoint with user choice (continue / accept Claude's / use Codex's / show output)
- [ ] On exec failure: error context surfaced, explicit user choice required (Retry/Claude-only/Show error)
- [ ] Never auto-skip on failure (no-fallback compliance)
- [ ] Stderr captured to file on original invocation (`2>/tmp/codex-collab-stderr-<num>.txt`), never via rerun
- [ ] No write-capable (`-s workspace-write`) rerun in error paths
- [ ] User can override at any iteration
- [ ] 0-byte output file detected as failure (context exhaustion)

#### Behavioral Verification (START/CONTINUE flow)

- [ ] START mode step 4: AskUserQuestion fires BEFORE Plan A is written (step 5)
- [ ] START mode step 4 "Skip": step 6 (refinement) is skipped, flow goes directly to step 7 (ExitPlanMode)
- [ ] START mode step 4 "Yes": Phase 1 runs, Plan B exists on disk before Plan A is written
- [ ] CONTINUE mode step 5: same AskUserQuestion fires BEFORE Plan A is written (step 6)
- [ ] CONTINUE mode step 5 → step 7 → step 8: same flow as START 4 → 6 → 7
- [ ] `codex_available = false`: both START step 4 and CONTINUE step 5 display skip notice, no AskUserQuestion
- [ ] Plan A file does NOT exist on disk when Codex Plan B `codex exec` starts (ordering invariant)
- [ ] After convergence (Phase 3 Codex agrees): flow reaches ExitPlanMode with no further Codex calls
- [ ] After 3-iteration checkpoint "Accept Claude's plan": loop terminates, ExitPlanMode called
- [ ] After 3-iteration checkpoint "Use Codex's plan": Plan B content replaces Plan A in plan file

#### Implementation Review (unchanged)

- [ ] Implementation Review fires before tests in guardrails and REWORK
- [ ] `-s read-only` on all implementation review invocations (initial + resume)
- [ ] `resume "$CODEX_SESSION_ID"` for implementation review follow-ups (NOT `--last`)
- [ ] Per-iteration summary with Continue/Override/Show options
- [ ] Claude self-identifies when resuming sessions
- [ ] Implementation review uses minimal issue pointer via stdin with `review --base main`
- [ ] No review-content instructions in prompts or AGENTS.md
- [ ] AGENTS.md documents adversarial reviewer principle
- [ ] Resume loop supports two-way dialogue (questions + revisions)
- [ ] Resume messages respond to Codex (not just push revisions)
- [ ] SUGGESTION findings addressed or justified (not just BLOCKING)
- [ ] Termination requires both no BLOCKING findings AND suggestions handled
- [ ] Revisions re-submitted to Codex (Claude cannot self-certify)
- [ ] Implementation review documents `--uncommitted` flag constraints (can't combine with --base or prompt)

### Post-Implementation Sequence

- [ ] Sequence enforced: commit → Codex review → tests → PR → /pm-review → Review
- [ ] Tests run before PR creation (aligned with CLAUDE.md "Before Creating PR")
- [ ] No step can be skipped (each validates the previous)
- [ ] /pm-review runs as self-check after PR creation (PR or issue number)
- [ ] Only after /pm-review passes (or user override) does Claude move to Review
- [ ] START mode "After ExitPlanMode" references Post-Implementation Sequence
- [ ] CONTINUE mode "After ExitPlanMode" references Post-Implementation Sequence
- [ ] REWORK mode step 6 references Post-Implementation Sequence
- [ ] Code changes after test failures trigger return to Codex review
- [ ] Appendix H guardrails contain full explicit checklist (not indirect reference)
- [ ] Execution model documented (skill guidance vs Claude Code capabilities)
- [ ] Post-Implementation Sequence includes Precedence Note re: /pm-review gate vs CLAUDE.md §"After Opening PR"
- [ ] Suggestion handling is in Continue path (not before user choice) in both sub-playbooks

### Regression Prevention

**If any of these break, the skill has regressed:**

1. `/issue` (no args) user-invoked MUST display "Tell me what you want to change, fix, or build" as first output
2. `/issue` (no args) MUST NOT list existing issues before prompting user
3. `/issue 123` should NOT ask "what do you want to build?"
4. `/issue 123` should NOT run duplicate scan
5. `/issue 123` should display issue title, acceptance criteria, non-goals
6. `/issue 123` in START mode from main repo should create worktree (+ tmux window if in tmux, or direct user there if not)
7. `/issue 123` in START mode from correct worktree should move to Active, enter plan mode
8. Plan mode content should include acceptance criteria as checkboxes
9. Plan mode content should include non-goals as DO NOT items
10. Plan mode content should include scope boundary check
11. Discovered work during implementation triggers separate issue creation
12. `/issue 123` in REWORK mode → "Continue addressing feedback" should move to Active and sync git

---

## Appendix G: Keyword-Based Doc Loading

| Keywords                          | Docs to Load                              |
| --------------------------------- | ----------------------------------------- |
| env, environment, secrets, .env   | `docs/ENV_WORKFLOW.md`, `docs/SECRETS.md` |
| database, supabase, postgres, sql | `docs/architecture/DATABASE.md`           |
| game, unity, bridge, postmessage  | `docs/architecture/GAME_INTEGRATION.md`   |
| wallet, account, auth, magic      | `docs/ACCOUNT_AND_WALLET_UX.md`           |
| chain, algorand, voi, multi-chain | `docs/architecture/MULTI_CHAIN.md`        |
| test, vitest, playwright          | `docs/development/TESTING.md`             |
| deploy, production, release       | `docs/runbooks/DEPLOY.md`                 |

---

## Appendix H: Briefing Packet Format

### Standard Format (non-CLOSED modes)

```markdown
## Issue #<num>: <title>

**Mode:** <MODE> _(rule #X: <reason>)_
**Projects:** <workflow> | **PR:** <#num or "none">

---

### What's Changed

<Latest update: most recent of issue comment, PR update, or review>

---

### Acceptance Criteria

- [ ] <criterion 1>
- [x] <criterion 2>
      (<X of Y complete>)

### Non-goals (DO NOT)

- <non-goal 1>
- <non-goal 2>

---

### Previous Work

<If PR exists>
**PR #<num>:** <title>
- State: <open|merged|closed>
- Review: <pending|approved|changes_requested>
- Draft: <yes|no>
<If changes requested, show feedback summary>

---

### Context Loaded

- CLAUDE.md (always)
- PM_PLAYBOOK.md (always)
- <doc> (<reason>)

---

### Relevant Policies

<Inline snippets from loaded docs that apply to this issue>

---

### Development Guardrails

1. Branch: `<type>/<short-desc>`
2. PR body: `Fixes #<num>`
3. **Post-implementation checklist (MANDATORY — in order, do not skip):**
   a. Commit changes with `<type>(<scope>): <description>`
   b. Codex Implementation Review — address all BLOCKING and SUGGESTION findings, commit fixes
   c. Run `pnpm validate` — fix failures, return to (b) if code changed
   d. Create PR (or push to existing) with `Fixes #<num>`
   e. Run `/pm-review` self-check (ANALYSIS_ONLY action) — address findings, return to (b) if code changed
   f. Move to Review: `./tools/scripts/project-move.sh <num> Review`
4. After merge: `./tools/scripts/project-move.sh <num> Done`
```

### Compact Format (CLOSED mode)

```markdown
## Issue #<num>: <title>

**Completed** via PR #<pr_num> on <date>

Files changed: <count>
Acceptance criteria: <X/Y met>
```

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
   ./tools/scripts/project-move.sh <num> Active
   ```

1.5. **Background environment setup** (before plan mode):

Kick off pnpm install in the background so the environment bootstraps while you plan.

Call the Bash tool with these exact parameters:

- command: "pnpm install"
- run_in_background: true
- description: "Background environment setup for issue #<num>"

The Bash tool returns a result that includes a task_id. Store this task_id for
checking after plan mode exits.

Behavior: The command starts in a separate process and returns control to you
immediately (within seconds). You do not wait for pnpm install to finish.

**If the Bash call fails or does not return a task_id:** Warn the user
("Background setup failed to launch, you may need to run `pnpm install` manually")
and set task_id to null. Continue to step 2 (EnterPlanMode) regardless — setup
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

   If `codex_available` is true:

   AskUserQuestion: "Ready to plan. Launch Codex for independent Plan B?"
   - "Yes — launch Codex (Recommended)" — Run Phase 1, Step 1 of Sub-Playbook: Collaborative Planning (Codex writes Plan B to `.codex-work/plan-<issue_num>-<prefix>.md`). Then proceed to step 5.
   - "Skip — Claude-only plan" — Proceed to step 5, skip step 6.

   If `codex_available` is false:
   Display: "Codex not available — skipping collaborative planning."

5. In plan mode, create Plan A that includes:
   - Acceptance criteria as checkboxes
   - Non-goals as DO NOT constraints
   - Inline policy snippets from loaded docs
   - Development guardrails (including port isolation via shell exports)
   - Implementation approach
   - **Scope boundary check** (see below)

6. **Collaborative Planning: Refinement (after Plan A is written):**

   If collaborative planning was launched in step 4:
   Run Phases 2-3 of Sub-Playbook: Collaborative Planning
   (Questions with recommendations, then Iterative Refinement until convergence)
   Update the plan file with any revisions made during refinement.

   If skipped in step 4: skip this step.

7. Present the final plan to user for approval via ExitPlanMode

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

#### After ExitPlanMode (START)

Before beginning implementation, check the background pnpm install result.

**If task_id is null** (step 1.5 failed to launch): Skip the TaskOutput call.
Report "Background setup was not launched. Run `pnpm install` manually if needed."
Proceed to implementation.

**If task_id exists:** Call the TaskOutput tool with these exact parameters:

- task_id: the value stored from step 1.5
- block: false
- timeout: 5000

Interpret the result and always report to the user:

- Completed with exit code 0: Report "Environment ready." Proceed to implementation.
- Completed with non-zero exit code: Report "Background setup failed." Show the
  first 20 lines of output. Suggest the user run pnpm install manually. Do NOT block
  implementation.
- Still running: Report "Setup is still running in the background. You can start
  working. Check back with TaskOutput if needed before running tests."

**Post-Implementation:** After implementation is complete, follow **Sub-Playbook: Post-Implementation Sequence** (Steps 1-6). Do NOT skip directly to `pnpm validate` or `project-move.sh Review`.

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

- command: "pnpm install"
- run_in_background: true
- description: "Background environment setup for issue #<num>"

Store the returned task_id for checking after plan mode exits. If the call fails
or returns no task_id, set task_id to null, warn the user, and continue.

4. **Call EnterPlanMode tool** - Re-enter plan mode to re-ground in requirements

5. **Launch Codex Plan B (inside plan mode, BEFORE writing Plan A):**

   Same pattern as START mode step 4. If `codex_available` is true, AskUserQuestion to launch Codex for independent Plan B or skip. Codex writes Plan B before Claude writes Plan A.

6. In plan mode, write Plan A showing:
   - Acceptance criteria with current status (done/remaining)
   - Non-goals as DO NOT constraints
   - Inline policy snippets
   - Development guardrails (including port isolation via shell exports if in worktree)
   - What work has been done (from PR if exists)
   - What remains to be done
   - **Scope drift check** (see below)

7. **Collaborative Planning: Refinement (after Plan A is written):**

   Same as START mode step 6. If collaborative planning was launched in step 5, run Phases 2-3 of Sub-Playbook: Collaborative Planning. If skipped, skip this step.

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

**Post-Implementation:** After implementation is complete, follow **Sub-Playbook: Post-Implementation Sequence** (Steps 1-6). Do NOT skip directly to `pnpm validate` or `project-move.sh Review`.

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
2. If yes: `./tools/scripts/project-move.sh <num> Active`

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
2. If yes: `./tools/scripts/project-move.sh <num> Done`

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

1. **Move to Active:** `./tools/scripts/project-move.sh <num> Active`
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

3. Fetch review comments via `mcp__github__get_pull_request_reviews`
4. Display feedback summary
5. Display guardrails
6. After feedback is addressed, follow **Sub-Playbook: Post-Implementation Sequence** (Steps 1-6).
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

1. Execute: `./tools/scripts/project-add.sh <num> normal`
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
Execute: `./tools/scripts/project-move.sh <num> Active`

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
Execute: `./tools/scripts/project-move.sh <num> Done`

---

## Allowed Mutations

**This skill can execute:**

- `./tools/scripts/project-add.sh <num> <priority>` - Add issue to project
- `./tools/scripts/project-move.sh <num> <state>` - Change workflow state
- `./tools/scripts/worktree-detect.sh <num>` - Detect worktree status
- `./tools/scripts/worktree-setup.sh <num> <branch>` - Create worktree with port isolation
- `./tools/scripts/tmux-session.sh start <num>` - Start issue in tmux window (portfolio mode)
- `mcp__github__create_issue` - Create new issues
- `mcp__github__update_issue` - Update issues (including close with state=closed)
- `mcp__github__add_issue_comment` - Post comments
- Git operations: status, checkout, pull, fetch, rebase, worktree
- `codex --version` - Check Codex CLI availability
- `./tools/scripts/codex-mcp-overrides.sh` - Emit `-c` flags to inject MCP servers into codex exec
- `codex exec $(./tools/scripts/codex-mcp-overrides.sh) -s workspace-write ... "Write an implementation plan for issue #<num>. Save to .codex-work/plan-<num>-<prefix>.md"` - Codex independent plan writing (collaborative planning Phase 1)
- `codex exec $(./tools/scripts/codex-mcp-overrides.sh) -s read-only ... "Review my updated plan for issue #<num> at <path>. I incorporated [X, Y] from your plan..."` - Codex iterative review (collaborative planning Phase 3, fresh session each round)
- `echo "Implementation review for issue #<num>." | codex exec $(./tools/scripts/codex-mcp-overrides.sh) -s read-only ... review --base main` - Codex implementation review (minimal issue pointer via stdin)
- `codex exec $(./tools/scripts/codex-mcp-overrides.sh) -s read-only ... review --uncommitted` - Codex implementation review (pre-commit, no prompt)
- `codex exec $(./tools/scripts/codex-mcp-overrides.sh) -s read-only ... resume "$CODEX_SESSION_ID"` - Resume Codex implementation review session (dialogue)
- `/pm-review <pr-or-issue-number>` - Self-review before Review transition (ANALYSIS_ONLY action)

**Print-only (user must run):**

- `gh pr merge` - Merge PR
- `gh issue reopen` - Reopen closed issue
- `gh pr create` - Create PR
- `cd <worktree-path> && claude` - Switch to worktree
- `eval "$(./tools/scripts/worktree-setup.sh <num> --print-env)"` - Apply port isolation
- `pnpm install && pnpm dev` - Initialize and start worktree dev server

**Execution scope note:** The `allowed-tools` frontmatter restricts tools during skill execution (mode detection, briefing, plan mode entry). After ExitPlanMode, the skill has ended and Claude Code resumes normal operation with standard tool permissions. The Post-Implementation Sequence runs in this normal context.

---

## Why This Design

### Why two modes?

- **Create Mode** handles the common case of "I want to do something but haven't formalized it yet"
- **Execute Mode** handles working on existing, well-defined issues
- The router is tiny (10 lines) and deterministic

### Why `/issue` instead of `/start-issue`?

The command handles the **full issue lifecycle**, not just starting:

- CREATE: Transform freeform description into structured issue
- START: Move to Active, begin work
- CONTINUE: Resume in-progress work
- REVIEW: Check PR status, run review
- APPROVED: Show merge instructions
- REWORK: Address feedback
- CLOSED: Acknowledge completion
- MISMATCH: Fix state inconsistencies

A `/start-issue` command would only handle one mode. `/issue` is the single entry point for all issue interactions.

### Why mode detection instead of always entering plan mode?

Different modes need different actions:

- START needs plan mode (beginning work)
- CONTINUE needs plan mode (re-grounding when resuming)
- REVIEW needs the reviewer skill
- APPROVED needs merge instructions
- REWORK needs feedback display + guardrails

START and CONTINUE both enter plan mode because that's when re-grounding is most needed. The other modes have specific purposes that don't benefit from full plan output.

### Why duplicate scan before creation?

Fragmented issues are a real problem. Multiple partial issues on the same topic waste effort and lose context. The scan catches this early.

### Why offer (not gate) on readiness?

Blocking on missing sections creates friction. Some issues are clear enough without full structure. The offer lets users upgrade when it helps without forcing it.

### Why merge with safety rails?

Consolidating issues is valuable but risky. The guardrails (max 3 closes, default to existing, confirmation required) prevent accidents while enabling the workflow.

### Why mismatch detection?

Project state and reality can diverge:

- PR merged but issue not marked Done
- Issue in Review but no PR exists
- Multiple PRs linked to same issue

The skill detects these and offers fixes, rather than failing or ignoring them.

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
   - Read: `/Users/.../cond-306/path/to/file.ts` (not `path/to/file.ts`)
   - Edit: Use full absolute path
   - Bash: `cd /path/to/worktree && command` or use absolute paths in commands

2. **Never assume you're in the worktree** - verify with `pwd` if uncertain

3. **Track which worktree you're in** - the path tells you the issue number (e.g., `cond-306` = issue #306)

4. **Don't mix worktrees** - if you need to work on a different issue, that issue has its own worktree

### The Scope Discipline Lesson (PR #266)

A developer worked on Issue #60 (Demo Wallet). During implementation, they discovered algod needed upgrading to support `allowUnnamedResources`. Instead of:

1. Creating Issue #283 for the algod upgrade
2. Establishing a blocker relationship
3. Implementing the upgrade in a separate PR first

They bundled both into PR #266. Result:

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

---

## Appendix J: Git Worktrees & Port Isolation

### Why Worktrees?

Git worktrees enable parallel development by creating separate working directories, each with its own branch. Benefits:

- **Parallel work**: Run multiple Claude Code sessions, each on a different issue
- **Clean state**: Each worktree has fresh `node_modules/` and build artifacts
- **No context switching**: Don't lose uncommitted work when switching issues
- **Isolated dev stacks**: Run `pnpm dev` in multiple worktrees simultaneously

### Worktree Location

Worktrees are created as sibling directories to the main repo:

```
~/Development/
├── conductor/    # Main repo
├── cond-294/                  # Worktree for issue #294
├── cond-295/                  # Worktree for issue #295
└── cond-301/                  # Worktree for issue #301
```

### Port Isolation

Each worktree gets a unique port offset based on `(issue_number % 79) * 100 + 3200`.

| Service                  | Base Port | Issue #291 | Issue #294 |
| ------------------------ | --------- | ---------- | ---------- |
| Vite dev server          | 5173      | 13773      | 14073      |
| Kong HTTP (Supabase API) | 54321     | 62921      | 63221      |
| Kong HTTPS               | 54443     | 63043      | 63343      |
| Supabase Studio          | 54323     | 62923      | 63223      |
| Postgres                 | 5432      | 14032      | 14332      |
| Pooler                   | 6543      | 15143      | 15443      |
| Algod                    | 4001      | 12601      | 12901      |
| KMD                      | 4002      | 12602      | 12902      |

Port offsets are set via shell exports (no env files):

```bash
# In the worktree, before running pnpm dev:
eval "$(./tools/scripts/worktree-setup.sh 294 --print-env)"
pnpm dev
```

This prints and exports:

```bash
export COMPOSE_PROJECT_NAME=cond-294
export VITE_PORT=14073
export KONG_HTTP_PORT=63221
# ... etc
```

### Worktree Lifecycle

**Creation:** Automatic when running `/issue <num>` in START mode from main repo.

**Cleanup:** Manual. When done with an issue:

```bash
# From main repo
git worktree remove ../cond-294
# Or delete the directory and prune
rm -rf ../cond-294
git worktree prune
```

### Collision Risk

Port collisions occur when `issue_a % 79 == issue_b % 79`:

- Issues 294 and 373 would collide (both % 79 = 57)
- Issues 291 and 294 do NOT collide (54 vs 57)

If you need to work on colliding issues simultaneously, override the offset:

```bash
WORKTREE_PORT_OFFSET=3200 ./tools/scripts/worktree-setup.sh 294 feat/my-feature
```

Override must be in range 3200–11000 to avoid macOS system port collisions (below) and port overflow (above).

### Troubleshooting

**"Worktree already exists" when it doesn't:**

```bash
git worktree prune  # Clean up stale metadata
```

**Port conflict errors:**

```bash
# Check what's using the port
lsof -i :<port>
# Kill the process or use a different worktree
```

**Worktree detection fails:**

```bash
# Verify worktree list
git worktree list
# Should show all active worktrees with their branches
```

### tmux Portfolio Manager

The portfolio manager enables running multiple Claude Code sessions in parallel, each working on a separate issue. It uses tmux windows for process isolation and a hook-based notification system to alert you when a session needs attention.

#### Architecture

```
tmux-session.sh (orchestrator)
├── Creates/manages tmux windows per issue
├── Tracks state in ~/.cond/portfolio/<num>/
└── Provides list/focus/stop commands

portfolio-notify.sh (hook handler)
├── Called by Claude Code hooks automatically
├── Updates issue status files
├── Sends tmux bell + macOS notification on attention events
└── No-op when COND_ISSUE_NUM not set (safe for non-portfolio sessions)

.claude/settings.json hooks
├── PreToolUse:AskUserQuestion → needs-input
├── Notification:permission_prompt → needs-permission
├── PostToolUse:AskUserQuestion → running
└── Stop → idle
```

#### Quick Start

```bash
# 1. Start your day (the only command you type)
make claude

# 2. Inside Claude, start issues — they spawn as background windows
/issue 345
/issue 294

# 3. Watch tmux status bar for '!' when a worker needs input
# Switch with: Ctrl-b + <window-number>

# 4. When you focus a window, Claude is waiting — just interact
/issue 345   # (re-run to load context if fresh window)

# 5. Return to main window
Ctrl-b + 0   (or whichever number is 'main')
```

#### How It Works Under the Hood

The `/issue` skill calls `tmux-session.sh start` internally when it detects `$TMUX`.
You never need to call `tmux-session.sh` directly — Claude handles all orchestration.

#### User Entry Point

| Command       | Description                                   |
| ------------- | --------------------------------------------- |
| `make claude` | Start your day: creates tmux session + Claude |

#### Internal Commands (called by Claude, not by users)

| Command                                | Description                            |
| -------------------------------------- | -------------------------------------- |
| `tmux-session.sh init-and-run`         | Entry point used by `make claude`      |
| `tmux-session.sh start <num> [branch]` | Create worktree + window, start Claude |
| `tmux-session.sh list`                 | Show all issues with status and age    |
| `tmux-session.sh focus <num>`          | Switch to issue's tmux window          |
| `tmux-session.sh stop <num>`           | Gracefully stop issue, close window    |
| `tmux-session.sh stop-all`             | Stop all active workers                |
| `tmux-session.sh status [num]`         | Detailed status for one or all issues  |

#### Issue Lifecycle States

| State         | Meaning                          | Set By                          |
| ------------- | -------------------------------- | ------------------------------- |
| `starting`    | Window created, Claude launching | `tmux-session.sh start`         |
| `running`     | Claude actively working          | PostToolUse hook                |
| `needs-input` | Claude asked a question          | PreToolUse:AskUserQuestion hook |
| `idle`        | Claude finished turn, waiting    | Stop hook                       |
| `complete`    | Issue work done                  | `tmux-session.sh stop`          |
| `crashed`     | Window gone unexpectedly         | Detected by `list` command      |

#### Notification Flow

1. Claude calls `AskUserQuestion` in a portfolio window
2. `PreToolUse` hook fires → `portfolio-notify.sh needs-input`
3. Status file updated to `needs-input`
4. tmux bell triggers an alert indicator on the window in the status bar
5. macOS notification appears (if available)
6. User notices, switches to that window (`Ctrl-b + N`)
7. User responds to Claude's question
8. `PostToolUse` hook fires → `portfolio-notify.sh running`
9. Status resets to `running`

#### When to Use Portfolio Manager vs Direct Worktrees

| Scenario                                 | Use                                     |
| ---------------------------------------- | --------------------------------------- |
| Working on one issue at a time           | `claude` directly (no tmux needed)      |
| Running 2+ issues in parallel            | `make claude` then `/issue` for each    |
| Need to monitor multiple Claude sessions | `make claude` (status bar shows alerts) |
| CI/automated workflows                   | Direct worktree (no tmux)               |

#### Portfolio Troubleshooting

**"Portfolio session not found"**
Run `make claude` to start. It handles session creation automatically.

**Window shows '!' but Claude isn't asking anything**
The bell indicator may persist after the question is answered. It clears when you visit the window.

**"No worktree at ... Provide a branch name"**
The worktree doesn't exist yet. Provide a branch: `tmux-session.sh start 345 feat/my-feature`

**tmux not installed**
Install with: `brew install tmux`

**Hooks fire in main session (not just portfolio)**
This is by design. `portfolio-notify.sh` is a no-op when `COND_ISSUE_NUM` is not set, so it silently exits in non-portfolio sessions.

---

## Appendix K: Priority Reasoning Guidelines

### Priority Definitions

| Priority     | Meaning                     | When to Use                                               |
| ------------ | --------------------------- | --------------------------------------------------------- |
| **Critical** | Drop everything and address | Production outage, security vulnerability, data loss risk |
| **High**     | Address before normal work  | High user/developer impact, blocking planned work         |
| **Normal**   | Standard priority           | Most features, bugs, and improvements                     |

### Factor Evaluation Guide

#### Urgency (Is this time-sensitive?)

| Rating   | Signals                                                            |
| -------- | ------------------------------------------------------------------ |
| **High** | Blocking other active work; production impact; time-boxed deadline |
| **Med**  | Compounds over time; affects upcoming sprint work; user-reported   |
| **Low**  | No deadline pressure; can wait for natural prioritization          |

#### Impact (How many people are affected? How severe?)

| Rating   | Signals                                                            |
| -------- | ------------------------------------------------------------------ |
| **High** | Affects all users/developers; core workflow broken; data integrity |
| **Med**  | Affects subset of users; degraded experience; workaround exists    |
| **Low**  | Edge case; cosmetic; single user affected                          |

#### Dependencies (Does other work depend on this?)

| Rating   | Signals                                                        |
| -------- | -------------------------------------------------------------- |
| **High** | Multiple issues blocked by this; prerequisite for planned epic |
| **Med**  | One issue depends on this; enables future work                 |
| **Low**  | Standalone; no other work waiting on this                      |

#### Effort (How much work is involved?)

| Rating   | Signals                                                   |
| -------- | --------------------------------------------------------- |
| **High** | Multi-day; cross-package changes; requires research/spike |
| **Med**  | Half-day to full day; few files; well-understood approach |
| **Low**  | Quick win; single file; mechanical change                 |

**Note on Effort:** High effort does NOT lower priority — it informs scheduling. A high-impact, high-effort issue is still high priority; it just takes longer. Low effort + high impact = prioritize (quick win).

### Priority Rules

| Condition                                        | Priority     |
| ------------------------------------------------ | ------------ |
| Blocking other work right now                    | **Critical** |
| Impact=High OR (Urgency=High AND Impact>=Medium) | **High**     |
| Everything else                                  | **Normal**   |

### Key Principle

**Claude can propose priorities; humans decide.** The reasoning table makes Claude's thinking visible so the user can agree, adjust, or override. Never skip the confirmation step.

### Worked Examples

#### Example 1: CLAUDE.md optimization

```
| Factor           | Rating | Explanation                                        |
| ---------------- | ------ | -------------------------------------------------- |
| **Urgency**      | Med    | Not blocking, but compounds every session          |
| **Impact**       | High   | Affects every development session for every dev    |
| **Dependencies** | Low    | No other work depends on this                      |
| **Effort**       | Med    | Analysis + restructuring of instruction file       |

Rule match: Impact=High → **High**
Recommended priority: High
```

#### Example 2: Production login failure

```
| Factor           | Rating | Explanation                                        |
| ---------------- | ------ | -------------------------------------------------- |
| **Urgency**      | High   | Users cannot access the platform right now          |
| **Impact**       | High   | All users affected; core functionality broken       |
| **Dependencies** | High   | Blocks all user-facing work and testing             |
| **Effort**       | Low    | Likely config or deployment issue; quick to fix     |

Rule match: Blocking other work right now → **Critical**
Recommended priority: Critical
```

#### Example 3: Add tooltip to settings page

```
| Factor           | Rating | Explanation                                        |
| ---------------- | ------ | -------------------------------------------------- |
| **Urgency**      | Low    | No deadline; cosmetic improvement                  |
| **Impact**       | Low    | Minor UX improvement; few users visit settings     |
| **Dependencies** | Low    | Standalone; nothing depends on this                |
| **Effort**       | Low    | Single component change                            |

Rule match: Everything else → **Normal**
Recommended priority: Normal
```

### Plan Files

**Default location:** Claude Code stores plan files in `~/.claude/plans/` (global). File names are randomly generated (e.g., `abundant-tumbling-zebra.md`) — this is observed behavior, not a documented guarantee.

**Project override:** This repo sets `plansDirectory` in `.claude/settings.json` to `.claude/plans`, which makes plan files project-local. Each worktree resolves this relative path against its own root directory, giving automatic per-worktree isolation.

**How isolation works:**

| Worktree              | Resolved plan directory             |
| --------------------- | ----------------------------------- |
| `/Users/dev/cond-305/` | `/Users/dev/cond-305/.claude/plans/` |
| `/Users/dev/cond-270/` | `/Users/dev/cond-270/.claude/plans/` |
| Main repo             | `<repo-root>/.claude/plans/`        |

Plans in one worktree cannot affect plans in another — they are in entirely separate directories.

**Finding plans for an issue:**

```bash
# Find all plan files mentioning issue #305 (local project only)
./tools/scripts/find-plan.sh 305

# Find only the most recent match
./tools/scripts/find-plan.sh 305 --latest

# Also search ~/.claude/plans/ for legacy/global plans
./tools/scripts/find-plan.sh 305 --include-global
```

By default, the script only searches `.claude/plans/` in the current project. Use `--include-global` to also search `~/.claude/plans/` (legacy location) — note that global plans may belong to other repositories with the same issue number.

**Note:** `.claude/plans/` is gitignored. Plan files are session-specific working files and are not shared between developers.

---

## Appendix L: Codex Integration Reference

### Command Syntax

#### Collaborative Planning Invocations

```bash
# Collaborative planning: Plan B writing (Phase 1) — fresh session, workspace-write
set -o pipefail
PLAN_B_PREFIX=$(uuidgen | tr -d '-' | head -c 8)
codex exec $(./tools/scripts/codex-mcp-overrides.sh) --json -s workspace-write --skip-git-repo-check \
  -o /tmp/codex-collab-output-<num>.txt \
  "Write an implementation plan for issue #<num>. Save to .codex-work/plan-<num>-${PLAN_B_PREFIX}.md" \
  2>/tmp/codex-collab-stderr-<num>.txt \
  | tee /tmp/codex-collab-events-<num>.jsonl

# Collaborative planning: Iterative review (Phase 3) — fresh session each round, read-only
set -o pipefail
codex exec $(./tools/scripts/codex-mcp-overrides.sh) --json -s read-only --skip-git-repo-check \
  -o /tmp/codex-collab-review-<num>.txt \
  "Review my updated plan for issue #<num> at <plan_a_path>. I incorporated [X, Y] from your plan. I didn't take [Z] because [reason]. Read the plan file and either agree or suggest specific changes." 2>/dev/null \
  | tee /tmp/codex-collab-events-<num>.jsonl
```

#### Implementation Review Invocations

```bash
# Implementation review (initial) — minimal issue pointer via stdin (--base doesn't accept inline prompt)
echo "Implementation review for issue #<num>." | \
  codex exec $(./tools/scripts/codex-mcp-overrides.sh) --json -s read-only --skip-git-repo-check \
  -o /tmp/codex-impl-review-<num>.txt \
  review --base main 2>/dev/null \
  | tee /tmp/codex-impl-events-<num>.jsonl

# Alternative: quick review without custom prompt
# codex exec $(./tools/scripts/codex-mcp-overrides.sh) --json -s read-only --skip-git-repo-check \
#   -o /tmp/codex-impl-review-<num>.txt \
#   review --uncommitted 2>/dev/null \
#   | tee /tmp/codex-impl-events-<num>.jsonl

# Session resume (implementation review follow-up iterations) — dialogue, use session ID, NOT --last
echo "This is Claude (Anthropic). <respond to Codex — answer questions or explain revisions>" | \
  codex exec $(./tools/scripts/codex-mcp-overrides.sh) --json -s read-only --skip-git-repo-check \
  -o /tmp/codex-impl-review-<num>.txt \
  resume "$CODEX_SESSION_ID" 2>/dev/null \
  | tee /tmp/codex-impl-events-<num>.jsonl
```

**Critical syntax rule:** `-o`, `-s`, `--json`, and other `exec`-level flags MUST appear before any subcommand (`review`, `resume`). Placing them after the subcommand causes "unexpected argument" errors.

### Sandbox Mode Reference

| Phase                      | Sandbox              | Session                  | Rationale                                     |
| -------------------------- | -------------------- | ------------------------ | --------------------------------------------- |
| Plan B writing (Phase 1)   | `-s workspace-write` | Fresh                    | Codex must create plan file in `.codex-work/` |
| Iterative review (Phase 3) | `-s read-only`       | Fresh each round         | Codex reads plan file only                    |
| Implementation review      | `-s read-only`       | Resume-based (unchanged) | Per existing pattern                          |

**Why session IDs for implementation review, not `--last`:** Multiple worktrees may run Codex reviews concurrently. `resume --last` resumes the globally most recent session, which could belong to a different worktree. `resume "$CODEX_SESSION_ID"` is concurrency-safe.

**Why fresh sessions for collaborative planning:** Each iteration of collaborative planning uses a fresh `codex exec` invocation. Context is passed in the prompt (what was incorporated, what wasn't, pointer to plan file). No `resume` sessions. This avoids context exhaustion across iterations.

### Pipeline Exit Detection

All collaborative planning pipelines MUST use `set -o pipefail` before `codex exec | tee`:

```bash
set -o pipefail
codex exec ... 2>/dev/null | tee /tmp/codex-collab-events-<num>.jsonl
# Check exit: ${PIPESTATUS[0]} for codex exit code
```

Without `set -o pipefail`, the pipeline reports `tee`'s exit code (always 0), masking Codex failures.

### Plan B Filename Generation

```bash
PLAN_B_PREFIX=$(uuidgen | tr -d '-' | head -c 8)
```

Generated BEFORE `codex exec`. Produces an 8-character hex prefix for collision avoidance. Full path: `.codex-work/plan-<issue_num>-${PLAN_B_PREFIX}.md`.

### Availability Check

```bash
codex --version 2>/dev/null
```

Exit 0 → available. Non-zero → unavailable. Checked once in Step 1e, stored as `codex_available`.

### Review Subcommand Flags

`codex exec ... review` supports (implementation review only):

- `--base <branch>`: Diff committed changes against the given branch (does NOT accept inline `[PROMPT]`)
- `--uncommitted`: Include staged, unstaged, and untracked changes in the diff (does NOT accept inline `[PROMPT]`)

**Constraint:** `--uncommitted`, `--base`, and `[PROMPT]` are mutually exclusive in Codex CLI v0.101.0. None of these flags can be combined with a `[PROMPT]` argument. To pass a minimal issue pointer with `--base`, pipe via stdin: `echo "Implementation review for issue #<num>." | codex exec ... review --base main`. Use `--uncommitted` only for quick reviews without custom instructions.

**Stdin best-effort caveat:** Stdin prompt consumption by `review --base` is best-effort — if Codex does not consume the piped issue pointer, it falls back to its default review prompt. The minimal prompt is short enough to avoid context exhaustion but delivery is not guaranteed. Codex still reads AGENTS.md and browses the codebase regardless.

### Output Parsing

#### Collaborative Planning

Codex responses in collaborative planning are natural language. Look for:

- **Agreement** — Codex says the plan looks good, no changes needed → convergence
- **Suggestions** — Codex proposes specific changes → incorporate good ones, iterate
- **Questions** — Codex asks about ambiguities → answer in next iteration prompt

#### Implementation Review (unchanged)

- **BLOCKING** — must fix before proceeding
- **SUGGESTION** — improvement that MUST be addressed or explicitly justified by Claude. "It's just a suggestion" is not valid justification. Valid skip reasons: conflicts with non-goal, requires out-of-scope work, Codex misunderstood context.
- **APPROVED** — look for "APPROVED" with no BLOCKING findings in the response
- If response contains neither BLOCKING nor APPROVED, treat as unparseable (see Error Handling)

### Temporary File Paths

#### Collaborative Planning

- Collaborative output (Plan B): `/tmp/codex-collab-output-<issue_num>.txt`
- Collaborative events (Plan B): `/tmp/codex-collab-events-<issue_num>.jsonl`
- Collaborative stderr (Plan B): `/tmp/codex-collab-stderr-<issue_num>.txt`
- Iterative review output: `/tmp/codex-collab-review-<issue_num>.txt`
- Plan B file: `.codex-work/plan-<issue_num>-<PLAN_B_PREFIX>.md`

#### Implementation Review (unchanged)

- Implementation review output: `/tmp/codex-impl-review-<issue_num>.txt`
- Implementation review JSONL events: `/tmp/codex-impl-events-<issue_num>.jsonl`

### Session ID Capture (Implementation Review Only)

The first JSONL event from `--json` is always `thread.started`:

```json
{ "type": "thread.started", "thread_id": "019c6c7e-93ba-7422-8119-0f78d223b635" }
```

Extract with: `head -1 <events-file>.jsonl | jq -r '.thread_id'`

Store as `CODEX_SESSION_ID` and use for all `resume` calls in the implementation review loop. Collaborative planning uses fresh sessions (no session ID capture needed).

### Claude Self-Identification

When resuming Codex implementation review sessions, Claude MUST identify itself: "This is Claude (Anthropic)." This prevents confusion about which AI is speaking. Not needed for collaborative planning (fresh sessions with context in prompt).

### Error Handling

**Key principle:** On Codex failure, NEVER auto-skip. Surface the error and require explicit user choice. The `2>/dev/null` suppresses stderr only during normal operation — on non-zero exit, stderr is captured separately for the error display.

**Stderr capture pattern (collaborative planning):**

Stderr is captured to a file on the _original_ invocation — never via rerun. This prevents a write-capable rerun from mutating state.

```bash
# Stderr redirected to file in the original command (see Phase 1 Step 1):
#   2>/tmp/codex-collab-stderr-<num>.txt
# On failure, read it:
CODEX_STDERR=$(cat /tmp/codex-collab-stderr-<num>.txt)
```

**Stderr capture pattern (implementation review):**

```bash
CODEX_STDERR=$(codex exec ... 2>&1 1>/tmp/codex-output.txt)
EXIT_CODE=$?
if [ $EXIT_CODE -ne 0 ]; then
  # Display CODEX_STDERR to user, ask for decision
fi
```

| Scenario                                                | Behavior                                                                                                  |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `codex --version` fails                                 | Set `codex_available = false`, skip loops with notice                                                     |
| Collaborative planning: `codex exec` non-zero exit      | Capture stderr. AskUserQuestion: Retry / Continue with Claude-only plan / Show error                      |
| Collaborative planning: 0-byte output or missing Plan B | Context exhaustion or write failure. AskUserQuestion: Retry / Continue with Claude-only plan / Show error |
| Implementation review: `codex exec` non-zero exit       | Capture stderr. AskUserQuestion: Retry / Override / Show full error                                       |
| Implementation review: Exit 0 but 0-byte output         | Context exhaustion. AskUserQuestion: Retry / Override                                                     |
| Implementation review: `resume <session_id>` fails      | Display error. AskUserQuestion: Start fresh session / Override                                            |
| Implementation review: Response unparseable             | Display raw output. AskUserQuestion: Continue / Override                                                  |

### MCP Server Configuration

Codex gets access to project MCP servers via runtime `-c` flag injection. The helper script `./tools/scripts/codex-mcp-overrides.sh` emits `-c` flags that are consumed by `codex exec` via command substitution.

#### How It Works

```bash
# The script outputs -c flags to stdout, summary to stderr
codex exec $(./tools/scripts/codex-mcp-overrides.sh) --json -s read-only ...
```

The script checks for `codex` availability, then emits `-c mcp_servers.<name>=<config>` flags for each server. If `codex` is not found, the script exits 0 with empty stdout (the command substitution expands to nothing, and `codex exec` works without MCP).

#### Injected Servers

| Server       | Transport | Auth                                                 | Skip Condition         |
| ------------ | --------- | ---------------------------------------------------- | ---------------------- |
| context7     | HTTP      | None                                                 | Never skipped          |
| svelte       | stdio     | None                                                 | Never skipped          |
| shadcn       | stdio     | None                                                 | Never skipped          |
| supabase-dev | stdio     | `SUPABASE_ACCESS_TOKEN` + `SUPABASE_DEV_PROJECT_REF` | Either env var missing |

**Intentionally excluded:** github (already in Codex global config), figma (low review value), supabase-local (needs running instance), supabase-prod (safety).

#### Skip Behavior

Per repo no-fallback policy, every skip produces an explicit stderr message:

```
codex-mcp-overrides: skipping supabase-dev (SUPABASE_ACCESS_TOKEN not set)
codex-mcp-overrides: codex not found, no MCP overrides emitted
```

Stderr goes to the terminal (visible to Claude/user). Stdout contains only `-c` flags.

#### Auth-Required Servers

For supabase-dev, ensure env vars are exported before running Codex:

```bash
eval "$(make env-export)"
```

#### MCP Is Optional

MCP server access is an enhancement — reviews work without it. If the overrides script outputs nothing (codex unavailable, or all servers skipped), the `codex exec` command runs normally without MCP.
