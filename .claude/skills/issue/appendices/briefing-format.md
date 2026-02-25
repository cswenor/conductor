# Appendix H: Briefing Packet Format

## Standard Format (non-CLOSED modes)

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
<If any tiers were skipped due to budget>
- ⏭️ Skipped: <tier> (<reason — e.g., "heavy issue, 25 comments">)

---

### Relevant Policies

<Inline snippets from loaded docs that apply to this issue>

---

### Development Guardrails

1. Branch: `<type>/<short-desc>`
2. PR body: `Fixes #<num>`
3. **Post-implementation checklist (MANDATORY — in order, do not skip):**
   a. Commit changes with `<type>(<scope>): <description>`
   b. Parallel quality gates: run Codex review (background) + `make test` (foreground) concurrently
   c. Both must pass on the same commit — if fixing one invalidates the other, iterate
   d. Create PR (or push to existing) with `Fixes #<num>`
   e. Run `/pm-review` self-check (ANALYSIS_ONLY action) — address findings, return to (b) if code changed
   f. Move to Review: `pm move <num> Review`
4. After merge: `pm move <num> Done`
```

## Compact Format (CLOSED mode)

```markdown
## Issue #<num>: <title>

**Completed** via PR #<pr_num> on <date>

Files changed: <count>
Acceptance criteria: <X/Y met>
```
