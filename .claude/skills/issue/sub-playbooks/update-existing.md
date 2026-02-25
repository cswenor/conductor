# Sub-Playbook: Update Existing

## Goal

Add new information to existing issue instead of creating duplicate.

## Inputs

- Target issue number
- New information from conversation

## Flow

### Step 1: Load Target Issue

Fetch full issue body via `mcp__github__get_issue`.

### Step 2: AI Synthesis

Determine what to add:

- New acceptance criteria
- Additional context to problem statement
- Reproduction steps (if bug)
- Missing labels

**AI instruction:** Determine what new information should be added. Do not duplicate existing content.

### Step 3: Show Diff Preview

Display additions using Appendix C template.

### Step 4: Confirm

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

### Step 5: Apply

On confirm:

1. Update via `mcp__github__update_issue`
2. Add comment if substantial context was added
3. Offer handoff to Execute Mode
