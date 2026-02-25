# Sub-Playbook: Discovered Work

## Goal

Handle work discovered during implementation that is outside the current issue's scope. Prevents scope mixing by creating separate issues with proper blocker relationships.

## When to Trigger

During START or CONTINUE mode, if you discover:

- Infrastructure changes needed (Docker, CI, tooling)
- A bug that must be fixed first
- A prerequisite feature not in the current issue
- Refactoring required to enable the feature
- Dependency upgrades blocking progress

**Key question:** "Is this work in the current issue's acceptance criteria?"

- If YES → continue, it's in scope
- If NO → trigger this sub-playbook

## Why This Matters

**The scope mixing lesson:** A developer working on a feature discovered an infrastructure dependency needed upgrading. They bundled both into one PR. Result:

- 3 reviews requesting changes due to scope mixing
- Can't merge infra fix without also merging incomplete feature
- Can't rollback infra without losing feature work
- Both issues stuck in Rework

**The fix:** Create separate issues, establish blocker relationship, implement in order.

## Flow

### Step 1: Recognize Discovered Work

When you realize work is needed that's not in the current issue's acceptance criteria, STOP and announce:

```markdown
## ⚠️ Discovered Work Outside Current Scope

**Current issue:** #<num> - <title>
**Discovered work:** <brief description>

This is NOT in the current issue's acceptance criteria. Following scope discipline, I need to create a separate issue.
```

### Step 2: Classify the Discovered Work

Determine the type and relationship:

| Type             | Examples                                        | Relationship                       |
| ---------------- | ----------------------------------------------- | ---------------------------------- |
| **Blocker**      | Infra upgrade required, bug preventing progress | Current issue blocked by new issue |
| **Prerequisite** | Feature A needs Feature B first                 | Current issue blocked by new issue |
| **Related**      | Found bug while working, not blocking           | Cross-reference, no blocker        |
| **Follow-up**    | Nice-to-have discovered during work             | Cross-reference, implement later   |

### Step 3: Create the New Issue

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

### Step 4: Establish Blocker Relationship (if applicable)

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

### Step 5: Decide Next Steps

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
