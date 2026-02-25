# Sub-Playbook: Merge/Consolidate

## Goal

Combine fragmented issues into one canonical issue.

## Safety Rules

- **Default canonical = existing issue** (not new), unless user explicitly prefers new
- **Max 3 closes per action** - if more than 3, require additional confirmation

## Flow

### Step 1: Select Issues

User confirms which issues to merge (from candidates + can add more).

**If > 3 issues selected:** Warn and require explicit confirmation.

### Step 2: Select Canonical

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

### Step 3: AI Synthesis

Read all issue bodies and produce:

- Canonical title
- Merged body (preserving valuable content)
- Supersedes section listing merged issues

### Step 4: Show Merge Plan

Display using Appendix D template.

### Step 5: Confirm

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

### Step 6: Execute

On confirm:

1. Update canonical issue (or create new)
2. Close duplicates via `mcp__github__update_issue` with state=closed
3. Add comment to each closed issue: "Closed as duplicate of #X. Content preserved."
4. Offer handoff to Execute Mode
