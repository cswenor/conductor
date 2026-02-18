# PM Playbook

This document defines how we manage work at Conductor using GitHub as the source of truth.

> **For Claude Code:** This document contains all field IDs and commands needed to manage issues and projects programmatically. If you've lost context, this is your reference.

---

## Table of Contents

1. [Philosophy](#philosophy)
2. [Issue Types](#issue-types)
3. [Label Taxonomy](#label-taxonomy)
4. [GitHub Project Fields](#github-project-fields)
5. [Field IDs Reference](#field-ids-reference)
6. [Tiered PR Workflow](#tiered-pr-workflow)
7. [Issue Lifecycle](#issue-lifecycle)
8. [Post-Merge Checklist](#post-merge-checklist)
9. [Issue Documentation Policy](#issue-documentation-policy)
10. [PR Rules](#pr-rules)
11. [Kanban Flow](#kanban-flow)
12. [Weekly Reporting](#weekly-reporting)
13. [Roles](#roles)
14. [Quick Reference](#quick-reference)
15. [Command Reference](#command-reference)

---

## Philosophy

### Non-negotiable Principles

1. **GitHub is the database.** Issues and Projects are the system of record. PRs and commits are proof of work.
2. **Tiered traceability.** Features/bugs/refactors require issues. Chores/docs/CI do not.
3. **Issues must be PR-sized.** Split anything that would take more than a few days or has too many acceptance criteria.
4. **Every PR links appropriately.** Use `Fixes #ID` for closing issues, descriptive body for non-issue PRs.
5. **Workflow lives in Project fields.** Not in labels. Labels are for taxonomy only.
6. **Claude can propose priorities; humans decide.** AI assists, humans approve.
7. **No fallback code.** All operations succeed or fail explicitly.

---

## Issue Types

| Type        | When to Use                                       | Template      | Issue Required for PR? |
| ----------- | ------------------------------------------------- | ------------- | ---------------------- |
| **Epic**    | Multi-feature initiative spanning multiple issues | `epic.yml`    | Yes                    |
| **Feature** | Single deliverable with clear scope               | `feature.yml` | Yes                    |
| **Bug**     | Something is broken                               | `bug.yml`     | Yes                    |
| **Spike**   | Need research before committing to approach       | `spike.yml`   | Yes                    |
| **Chore**   | Maintenance, cleanup, dependencies                | (no template) | No                     |

### Issue Quality Bar

Every issue MUST include:

- **Problem / Goal** - What are we solving?
- **Why Now** - Why is this the right time?
- **Non-goals** - What is explicitly out of scope?
- **Assumptions** - What must be true for this to succeed?
- **Acceptance Criteria** - Checkboxes for "done"
- **Definition of Done** - Final checklist

---

## Label Taxonomy

Labels are for **taxonomy and workflow flags only**. Workflow state, Priority, Risk, and Estimate live in GitHub Project fields.

### Type Labels (required for Tier 1)

| Label          | Description               |
| -------------- | ------------------------- |
| `type:epic`    | Multi-issue initiative    |
| `type:feature` | New functionality         |
| `type:bug`     | Something is broken       |
| `type:spike`   | Research or investigation |
| `type:chore`   | Maintenance task          |

### Area Labels (required for Tier 1)

| Label             | Description                                        |
| ----------------- | -------------------------------------------------- |
| `area:frontend`   | Frontend web app                                   |
| `area:backend`    | Backend services                                   |
| `area:contracts`  | Smart contracts                                    |
| `area:infra`      | Tooling, CI/CD, project management, dev experience |

> **Note:** These are default areas. Configure your project's areas during `install.sh` setup (or enter `new` to create a project board with custom area options). Add more area labels as needed for your project.

### Spec Readiness Labels

| Label          | Description                        |
| -------------- | ---------------------------------- |
| `spec:missing` | Authorized but needs clarification |
| `spec:ready`   | Has clear acceptance criteria      |

### Workflow Flags

| Label               | Description                                                                    |
| ------------------- | ------------------------------------------------------------------------------ |
| `needs:triage`      | Needs triage and prioritization                                                |
| `needs:design`      | Needs design work                                                              |
| `needs:security`    | Needs security review                                                          |
| `blocked:external`  | Blocked by external dependency                                                 |
| `blocked:review`    | Blocked awaiting review                                                        |
| `postmortem:needed` | Requires detailed retrospective (outages, security issues, significant rework) |

---

## GitHub Project Fields

Workflow, Priority, Risk, and other data live in the GitHub Project, not labels.

**Project Number:** 2
**Project ID:** `PVT_kwHOAAnhG84BPhvY`
**Organization:** cswenor

### Workflow (Single Select) — AI-First Model

Issues have 6 states representing **permissions and progress**:

```
Backlog → Ready → Active → Review → Done
                             ↓
                          Rework ←→ Review
```

| Workflow    | Meaning                  | AI Behavior                                   |
| ----------- | ------------------------ | --------------------------------------------- |
| **Backlog** | Not authorized           | May analyze, NOT execute                      |
| **Ready**   | Authorized, waiting      | May pick up and move to Active                |
| **Active**  | Work in progress         | Currently implementing (MUST be here to code) |
| **Review**  | PR open, awaiting review | Work complete, waiting for human review       |
| **Rework**  | Changes requested        | Address feedback, then back to Review         |
| **Done**    | Merged and verified      | No action needed                              |

**WIP Limits:**

- **AI: One Active issue at a time** (hard rule)
- **Review and Rework do NOT count toward WIP limit** (waiting on action)
- AI can have 1 Active + unlimited in Review/Rework
- **Humans: Keep Active small** (soft guidance, aim for 1-2)

If you have items stuck in Active, resolve blockers before pulling new work.

### Active Entry Criteria

An issue may only be moved to Active when:

- Has an owner (assignee set - AI or human)
- Has a branch name: either branch exists OR comment with `Branch: <type>/<desc>`
- Has acceptance criteria: issue body contains `## Acceptance Criteria` header with checklist
- No `blocked:*` labels present

These are mechanically checkable - scripts can validate before allowing transition.

### Active Exit Criteria

An issue leaves Active via:

- **→ Review:** PR opened with `Fixes #<issue>` and CI passing
- **→ Ready:** Work abandoned with reason comment (available for re-pickup)
- **→ Backlog:** Deprioritized or blocked indefinitely

### Review Entry Criteria (Active → Review)

Move to Review when:

- Implementation is complete
- PR is opened with `Fixes #<issue>`
- All tests passing (CI green)

**Trigger:** Manual via `./tools/scripts/project-move.sh <num> Review` immediately after opening PR.

### Review Exit Criteria

An issue leaves Review via:

- **→ Done:** PR approved and merged, then run post-merge checklist
- **→ Active:** Reviewer requests changes (rework needed)

### Blocked Pattern

Use `blocked:*` labels (not a workflow column) to reflect reality while keeping 4 states:

- `blocked:review` - waiting on code review
- `blocked:external` - waiting on external dependency
- `blocked:spec` - needs clarification

Issues can be Active + blocked (work started but stuck).

### Emergency Hotfix Bypass

Hotfixes can start immediately but must:

1. Move to Active within 15 minutes OR before PR is opened (whichever comes first)
2. Include `hotfix` in branch name
3. Document bypass reason in PR description

### Spec Readiness Labels

Spec readiness is tracked via labels, not workflow states:

| Label          | Meaning                            |
| -------------- | ---------------------------------- |
| `spec:missing` | Authorized but needs clarification |
| `spec:ready`   | Has clear acceptance criteria      |

An issue can be `Ready` + `spec:missing` = "you can start, but clarify scope first"

### Priority (Single Select)

| Priority     | Meaning                     |
| ------------ | --------------------------- |
| **Critical** | Drop everything and address |
| **High**     | Address this week           |
| **Normal**   | Standard priority           |

### Area (Single Select)

| Area           | Description                                        |
| -------------- | -------------------------------------------------- |
| **Frontend**   | Web app UI                                         |
| **Backend**    | Server/API code                                    |
| **Contracts**  | Smart contracts                                    |
| **Infra**      | Tooling, CI/CD, project management, dev experience |
| **Compliance** | Legal/regulatory                                   |
| **Growth**     | Marketing                                          |
| **Data**       | Analytics                                          |

> Not all projects need all area options. Only create the ones relevant to your project. The toolkit handles missing options gracefully — scripts will warn but not fail.

### Other Fields

| Field          | Type          | Options                          |
| -------------- | ------------- | -------------------------------- |
| **Issue Type** | Single Select | Epic, Feature, Bug, Chore, Spike |
| **Risk**       | Single Select | Low, Med, High                   |
| **Estimate**   | Single Select | S, M, L                          |

### Owner

**Owner = Issue Assignee.** We use GitHub's native Assignee field instead of a custom Project field.

- Assign exactly one person per issue
- The assignee is accountable for moving the issue to Done
- Reassign if ownership transfers

---

## Field IDs Reference

> **For Claude Code:** Use these IDs with `gh project item-edit` commands.

### Project Identifiers

| Item               | Value                  |
| ------------------ | ---------------------- |
| **Project Number** | `2`   |
| **Project ID**     | `PVT_kwHOAAnhG84BPhvY` |
| **Organization**   | `cswenor`         |

### Field IDs

| Field          | Field ID                         |
| -------------- | -------------------------------- |
| **Workflow**   | `PVTSSF_lAHOAAnhG84BPhvYzg96Qy0` |
| **Priority**   | `PVTSSF_lAHOAAnhG84BPhvYzg96Q0Q` |
| **Area**       | `PVTSSF_lAHOAAnhG84BPhvYzg96Q0U` |
| **Issue Type** | `PVTSSF_lAHOAAnhG84BPhvYzg96Q0Y` |
| **Risk**       | `PVTSSF_lAHOAAnhG84BPhvYzg96Q1I` |
| **Estimate**   | `PVTSSF_lAHOAAnhG84BPhvYzg96Q1M` |

### Workflow Option IDs

| Option  | Option ID  |
| ------- | ---------- |
| Backlog | `74b600d5` |
| Ready   | `962c258c` |
| Active  | `5ced14d4` |
| Review  | `a33df598` |
| Rework  | `0ce2c21a` |
| Done    | `4440bd88` |

### Priority Option IDs

| Option   | Option ID  |
| -------- | ---------- |
| Critical | `e2f43add` |
| High     | `5ea07c7d` |
| Normal   | `2a42a8e5` |

### Area Option IDs

| Option     | Option ID  |
| ---------- | ---------- |
| Frontend   | `TODO: add Frontend option to Area field` |
| Backend    | `TODO: add Backend option to Area field` |
| Contracts  | `TODO: add Contracts option to Area field` |
| Infra      | `TODO: add Infra option to Area field` |
| Design     | `TODO: add Design option to Area field` |
| Docs       | `TODO: add Docs option to Area field` |
| PM         | `TODO: add PM option to Area field` |

### Issue Type Option IDs

| Option  | Option ID  |
| ------- | ---------- |
| Bug     | `57d21deb` |
| Feature | `5a2162ad` |
| Spike   | `e5f6ed28` |
| Epic    | `f329a2d3` |
| Chore   | `ce3bef94` |

### Risk Option IDs

| Option | Option ID  |
| ------ | ---------- |
| Low    | `614b5103` |
| Med    | `8d3abc19` |
| High   | `e07efa9c` |

### Estimate Option IDs

| Option | Option ID  |
| ------ | ---------- |
| S      | `a2fd8d62` |
| M      | `502e48be` |
| L      | `a6e5563a` |

---

## Tiered PR Workflow

PRs follow a tiered traceability model based on change type.

### Tier 1: Features, Bug Fixes & Refactors (Issue Required)

These changes affect code behavior or structure and need planning/traceability.

| PR Title Prefix | Issue Required? | PR Body Must Include |
| --------------- | --------------- | -------------------- |
| `feat:`         | **YES**         | `Fixes #123`         |
| `fix:`          | **YES**         | `Fixes #123`         |
| `refactor:`     | **YES**         | `Fixes #123`         |

**Before writing code:**

1. Search for existing issue: `gh issue list --search "keywords"`
2. If none exists, create one with appropriate template
3. Add to project and set required fields (Priority, Area)
4. Tell the user the issue number before proceeding
5. Create PR with `Fixes #<issue-number>` in body

### Tier 2: Chores, Docs, CI (No Issue Required)

These are mechanical changes with low risk. The PR itself provides traceability.

| PR Title Prefix | Issue Required? | PR Body Must Include    |
| --------------- | --------------- | ----------------------- |
| `chore:`        | No              | Descriptive explanation |
| `docs:`         | No              | Descriptive explanation |
| `ci:`           | No              | Descriptive explanation |

**Examples of Tier 2 work:**

- Dependency updates
- Documentation fixes
- CI/CD configuration
- Code formatting
- Generated files (weekly reports, type definitions)

**Just create a PR with good description:**

```bash
gh pr create --title "chore: update dependencies" --body "## Summary
- Updated X to version Y
- Ran tests, all passing

## Why
- Security patch / performance improvement / etc."
```

---

## Issue Lifecycle

```
┌─────────────────────────────────────────────────────────────────────────────────────────────────────┐
│                                        ISSUE LIFECYCLE                                               │
├─────────────────────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                                      │
│  ┌──────────┐   ┌─────────┐   ┌─────────┐   ┌─────────┐   ┌─────────┐   ┌────────┐                 │
│  │ Backlog  │──▶│  Ready  │──▶│ Active  │──▶│ Review  │──▶│ Rework  │──▶│  Done  │                 │
│  └──────────┘   └─────────┘   └─────────┘   └─────────┘   └─────────┘   └────────┘                 │
│       │              │             │              │              │            ▲                      │
│       │              │             │              │              │            │                      │
│       │              │             │              ├──────────────┴────────────┘ (PR merged)         │
│       │              │             │              │                                                  │
│       │              │             │              └──────▶ Rework (changes requested)               │
│       │              │             │                          │                                      │
│       │              │             │                          └──▶ Review (fixes submitted)         │
│       │              │             │                                                                 │
│       │              ◀─────────────┘ (work abandoned)                                               │
│       │                                                                                              │
│       ◀─────────────────────────── (deprioritized/blocked indefinitely)                             │
│                                                                                                      │
│  MANDATORY STOP: Before writing code, move issue to Active                                          │
│  WIP LIMIT: AI may have only ONE issue in Active at a time (Review/Rework don't count)              │
│                                                                                                      │
└─────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

### What "Spec Ready" Means (for `spec:ready` label)

An issue should have the `spec:ready` label when:

- [ ] Problem is clearly stated
- [ ] Non-goals are explicit
- [ ] Acceptance criteria are specific and testable
- [ ] Technical approach is outlined
- [ ] Dependencies are identified
- [ ] Definition of Done is complete

Issues without `spec:ready` may still be in `Ready` workflow state, but the assignee should clarify scope before starting significant work.

---

## Post-Merge Checklist

**After merging a PR that closes an issue, you MUST:**

### 1. Update the Project Workflow field to "Done"

```bash
./tools/scripts/project-move.sh <ISSUE_NUMBER> Done
```

### 2. Verify the issue is closed

Should auto-close if PR used `Fixes #`. If not:

```bash
gh issue close <ISSUE_NUMBER>
```

### 3. Archive if appropriate

Done items older than 2 weeks can be archived.

**Why this matters:** The Project board views filter by Workflow. Missing Workflow causes items to appear in wrong views.

---

## Issue Documentation Policy

Document work proportionally to its risk and impact.

### Plan Comments (on the issue)

**Required for:** `type:epic`, `needs:spec`, or Risk=High issues

**Not required for:** Normal features/bugs (issue body + acceptance criteria is the plan)

When required, use this format:

```markdown
## Implementation Plan

<details>
<summary>Expand</summary>

### Approach

[Brief description]

### Key Files

- `path/file.ts` - [change]

### Risks

- [Risk and mitigation]

</details>
```

### Completion Comments (on the issue)

**Required for:**

- User-facing changes
- Interface/contract changes
- Core workflow changes
- Risk=High issues

**Not required for:** Chores, docs, CI, internal refactors, obvious bug fixes

When required, use this format:

```markdown
## Shipped

**What changed:**

- [Bullet 1]

**How to verify:**

- [Step 1]

**Follow-ups:** (if any)

- [Item]
```

### Retrospectives

**Required only when:** `postmortem:needed` label is present

**Used for:** Outages, security issues, significant rework, learning opportunities

Do not add a "mistakes" section to every issue. Real issues deserve focused retrospectives, not performative honesty on routine work.

---

## PR Rules

1. **Tier 1 PRs must link to an issue**
   - Use `Fixes #123` to auto-close on merge
   - Use `Refs #123` for related but not closing
   - Use `Part of #123` for epic child issues

2. **Tier 2 PRs need descriptive bodies**
   - Explain what and why in the PR description
   - No issue link required

3. **Commits should reference issue numbers (when applicable)**
   - `feat(web): add wallet connect button (#123)`

4. **Keep PRs focused**
   - One logical change per PR
   - If scope grows, split into new issues

5. **Update issue Workflow on merge**
   - Move Workflow to "Done" when PR merges (if not auto-updated)

---

## Kanban Flow

We use continuous flow (Kanban), not fixed sprints.

### Prioritization

- **Critical**: Drop current work and address
- **High**: Address this week
- **Normal**: Standard backlog priority

### Pulling Work

1. Check for Critical items first
2. Look for items with Workflow = "Ready"
3. Pick highest priority item you can own
4. Assign yourself to the issue
5. **Move issue to Active** (`./tools/scripts/project-move.sh <num> Active`)
6. Create branch and start work

**WIP Limits:**

- AI: Maximum ONE Active issue at a time
- Humans: Keep Active small (aim for 1-2)

Blocked labels (`blocked:review`, `blocked:external`, `blocked:spec`) indicate blockers without changing workflow state.

---

## Weekly Reporting

Reports use a two-layer architecture stored in `reports/weekly/`:

### Layer 1: Canonical Report (Automated)

The canonical report runs automatically via GitHub Action every Friday. It produces:

- `YYYY-MM-DD.json` - Structured data snapshot
- `YYYY-MM-DD.md` - Deterministic markdown tables

This layer has **zero AI cost** and **always runs**, even if no one is around.

```bash
pnpm report:weekly           # Generate canonical report manually
```

### Layer 2: AI Narrative (On-Demand)

The AI narrative provides analysis and insights on top of the canonical data.

```bash
/weekly                                    # Analyze latest report
/weekly --from 2026-01-19                  # Analyze specific report
/weekly --from 2026-01-01 --to 2026-01-26  # Analyze date range
```

This produces `YYYY-MM-DD.ai.md` with:

- Executive summary with health assessment
- What shipped with business context
- Velocity trends and comparisons
- Risks and concerns
- Actionable recommendations

### Report Sections (Canonical)

1. **Highlights** - Top 3 accomplishments (placeholder for manual entry)
2. **Shipped** - Merged PRs and closed issues, grouped by Area
3. **In Progress** - Current work with assignee and link
4. **Blocked** - Blockers with assignee and next action
5. **Decisions Needed** - Items requiring input
6. **Next Up** - Top 5 items ready to start
7. **Metrics** - Open issues, in progress, blocked counts

### Guarantees

| What                 | Behavior                                   |
| -------------------- | ------------------------------------------ |
| Weekly JSON + MD     | Always runs via GitHub Action              |
| AI narrative         | Optional, only when user invokes           |
| Historical integrity | Guaranteed - absence doesn't break history |

---

## Roles

### Product Manager

- Owns the backlog and prioritization
- Ensures issues meet quality bar
- Writes or reviews specs
- Runs weekly reporting

### Tech Lead

- Reviews technical specs
- Assigns appropriate Area labels
- Identifies dependencies and risks
- Reviews PRs for architecture

### Individual Contributor

- Picks up work from Ready column
- Updates issue Workflow as work progresses
- Links PRs to issues
- Flags blockers immediately

---

## Quick Reference

### Creating a Tier 1 Issue

1. Choose the right template (Epic/Feature/Bug/Spike)
2. Fill in ALL required sections
3. Add `type:*` and `area:*` labels
4. Add to Project with appropriate fields (Priority, Area)

### Creating a Tier 2 PR (no issue)

1. Create branch and make changes
2. Open PR with descriptive title (`chore:`, `docs:`, `ci:`)
3. Write clear summary in PR body

### Starting Work (MANDATORY STOP STEP)

**For Tier 1 changes (feat/fix/refactor), complete ALL steps BEFORE writing code:**

1. **Ensure clean state:** `git status --porcelain` must be empty
2. **Sync with default branch:** `git checkout main && git pull`
3. **Search for existing issue:** `gh issue list --search "keywords"`
4. **Create issue if none exists** (see Tier 1 section above for template)
5. **Add to project:** `./tools/scripts/project-add.sh <ISSUE_NUMBER> <priority>`
6. **Move to Active:** `./tools/scripts/project-move.sh <ISSUE_NUMBER> Active`
7. **Create branch:** `git checkout -b <type>/<short-desc>`
8. **Begin implementation**

**CRITICAL:** Do NOT skip steps 3-6. The issue must exist, be in the project, and be Active BEFORE any code is written.

### Before Opening a PR

1. **Verify ALL acceptance criteria are met** - Re-read the issue
2. **Check off acceptance criteria** - Update issue body: `- [ ]` → `- [x]`
3. **Add completion comment** to the issue (What changed, How to verify, Follow-ups)
4. Include `Fixes #ID` in PR description (Tier 1 only)
5. Request appropriate reviewers (see CODEOWNERS)

### After Opening a PR

1. **Ensure PR body includes `Fixes #<issue>`** (canonical linkage)
2. **Move issue to Review:** `./tools/scripts/project-move.sh <num> Review`
3. Request reviewers if not auto-assigned

### When Blocked

1. Add appropriate `blocked:*` label to PR or issue
2. Comment with: what's blocking, who owns unblocking, next action
3. Notify relevant parties

### Completing Work (Post-Merge)

1. Merge PR (auto-closes issue if using `Fixes`)
2. **Move to Done:** `./tools/scripts/project-move.sh <num> Done`
3. **Check off "Code merged"** in Definition of Done
4. Verify issue is closed

### When Changes Requested

1. **Move to Rework:** `./tools/scripts/project-move.sh <num> Rework`
2. Address reviewer feedback
3. Push updates to PR
4. **Move back to Review:** `./tools/scripts/project-move.sh <num> Review` when ready for re-review

### Workflow Transitions

| Transition      | Trigger                          | Who      | Command                        |
| --------------- | -------------------------------- | -------- | ------------------------------ |
| → Backlog       | Issue created + project-add      | AI/Human | `project-add.sh <num> <pri>`   |
| Backlog → Ready | Work authorized                  | AI/Human | `project-move.sh <num> Ready`  |
| Ready → Active  | **STOP**: Work begins            | AI/Human | `project-move.sh <num> Active` |
| Active → Review | PR opened                        | AI/Human | `project-move.sh <num> Review` |
| Review → Rework | Changes requested                | AI/Human | `project-move.sh <num> Rework` |
| Rework → Review | Feedback addressed, re-requested | AI/Human | `project-move.sh <num> Review` |
| Review → Done   | PR merged + post-merge checklist | AI/Human | `project-move.sh <num> Done`   |
| Active → Ready  | Work abandoned (with reason)     | AI/Human | `project-move.sh <num> Ready`  |

**Note:** Review → Done is NOT automated. The post-merge checklist requires running the command manually.

---

## Command Reference

### Adding Issues to Project (Recommended)

```bash
# Use the helper script (idempotent - safe to run multiple times)
./tools/scripts/project-add.sh <ISSUE_NUMBER> <priority>
# priority: critical | high | normal
# Area is derived from the issue's area:* label

# Example:
./tools/scripts/project-add.sh 42 high
```

### Moving Issues Between States

```bash
# Move an issue to a workflow state
./tools/scripts/project-move.sh <ISSUE_NUMBER> <state>
# state: Backlog | Ready | Active | Review | Done

# Examples:
./tools/scripts/project-move.sh 42 Ready    # Authorize work
./tools/scripts/project-move.sh 42 Active   # Begin implementation (MANDATORY before coding)
./tools/scripts/project-move.sh 42 Review   # PR opened, ready for review
./tools/scripts/project-move.sh 42 Done     # Mark complete (after PR merge)
```

### Checking Issue Status

```bash
# Show current workflow state and labels for an issue
./tools/scripts/project-status.sh <ISSUE_NUMBER>

# Example output:
# {
#   "title": "feat: add logout button",
#   "state": "OPEN",
#   "assignees": ["username"],
#   "labels": ["type:feature", "area:frontend"],
#   "workflow": "Active"
# }
```

### Issue Management

```bash
# Search for existing issues
gh issue list --search "keywords"

# Create a feature issue
gh issue create --title "feat: description" \
  --label "type:feature" --label "area:frontend" \
  --body "## Problem / Goal
<description>

## Non-goals
- <out of scope>

## Acceptance Criteria
- [ ] <criterion>

## Definition of Done
- [ ] Code merged
- [ ] Tests passing"

# Add issue to project (low-level, prefer helper script above)
gh project item-add 2 --owner cswenor --url <issue-url>

# Get item ID for an issue
gh project item-list 2 --owner cswenor --format json | jq -r '.items[] | select(.content.number == <ISSUE_NUMBER>) | .id'
```

### Setting Project Fields

```bash
# Set Workflow
gh project item-edit --project-id PVT_kwHOAAnhG84BPhvY --id <ITEM_ID> \
  --field-id PVTSSF_lAHOAAnhG84BPhvYzg96Qy0 \
  --single-select-option-id <workflow-option-id>

# Set Priority
gh project item-edit --project-id PVT_kwHOAAnhG84BPhvY --id <ITEM_ID> \
  --field-id PVTSSF_lAHOAAnhG84BPhvYzg96Q0Q \
  --single-select-option-id <priority-option-id>

# Set Area
gh project item-edit --project-id PVT_kwHOAAnhG84BPhvY --id <ITEM_ID> \
  --field-id PVTSSF_lAHOAAnhG84BPhvYzg96Q0U \
  --single-select-option-id <area-option-id>
```

### PR Management

```bash
# Create PR for Tier 1 (with issue)
gh pr create --title "feat: description" --body "Fixes #123

## Summary
- What changed

## Test plan
- How to verify"

# Create PR for Tier 2 (no issue)
gh pr create --title "chore: description" --body "## Summary
- What changed

## Why
- Reason for change"
```

### View Current Project State

```bash
# List all project items with key fields
gh project item-list 2 --owner cswenor --format json | jq '.items[] | {number: .content.number, title: .title, workflow: .workflow, priority: .priority, area: .area}'

# Check specific issue's project fields
gh project item-list 2 --owner cswenor --format json | jq '.items[] | select(.content.number == <ISSUE_NUMBER>)'
```

---

## Setup

The GitHub Project board and field IDs are configured during toolkit installation.

To set up a new project or reconfigure an existing one, run:

```bash
# Fresh install (enter 'new' for project number to create a board)
cd /path/to/claude-pm-toolkit
./install.sh /path/to/your/repo

# Update existing installation (re-discovers field IDs)
./install.sh --update /path/to/your/repo
```

The installer will:

1. Create the GitHub Project with all required fields (if 'new')
2. Auto-discover field IDs via GraphQL
3. Configure all scripts with the correct IDs
