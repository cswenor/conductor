# Sub-Playbook: Post-Implementation Sequence

## Goal

Enforced ordered sequence from completed implementation to Review transition. Prevents steps from being skipped.

## Prerequisites

- Implementation complete
- On a feature branch (not main)

## Execution Model

**After ExitPlanMode (START/CONTINUE):** The skill has completed. Claude Code resumes normal operation with its standard tool permissions (Bash, Edit, Write, etc.). The skill's `allowed-tools` frontmatter only restricts tools during skill execution — it does not apply after the skill ends. Claude Code follows this sequence as behavioral guidance.

**During REWORK mode:** The skill presents feedback and instructs Claude Code to follow this sequence. Claude Code executes each step with its normal capabilities. This is the same pattern used today — REWORK already instructs `make test` which is not in the skill's `allowed-tools` but is executed by Claude Code.

## Sequence (MANDATORY — execute in order, do not skip steps)

### Step 1: Commit

Commit all implementation changes:

```
git add <specific files>
git commit -m "<type>(<scope>): <description>"
```

### Step 2: Parallel Quality Gates (Tests + Codex Review)

**⚠️ STOP — do not skip this step.**

Tests and Codex review are independent checks. Run them concurrently for efficiency:

```
┌─ Codex Implementation Review (background) ─┐
│  Reads committed diff, reviews adversarially │
├─────────────────────────────────────────────┤
│                                             │
│  ┌─ Tests (foreground) ──────────────┐      │
│  │  make test                 │      │
│  └───────────────────────────────────┘      │
│                                             │
└─ Both must pass before proceeding ──────────┘
```

**Execution order:**

1. **Launch Codex review in background** (if `codex_available` is true):
   Run **Sub-Playbook: Codex Implementation Review** Step 0 (compute diff) and Step 1 (initial review) using background execution. Store the task_id.

2. **Run tests in foreground:**
   `make test`
   Fix any failures immediately. If fixes require code changes, commit the fixes.

3. **Check Codex review result:**
   After tests pass, check the Codex review result via TaskOutput.
   - If Codex APPROVED → both gates passed, proceed to Step 3.
   - If Codex raised findings → address them (per Sub-Playbook Steps 3-6), commit fixes.
   - If test fixes changed code → re-run Codex review on the updated diff.
   - If Codex fixes changed code → re-run tests.

**Convergence:** Both gates must pass on the SAME commit. If fixing one gate's findings invalidates the other, iterate until both pass simultaneously.

If `codex_available` is false:
Display: "Codex not available — running tests only."
Run `make test`, fix failures, proceed.

**Why parallel:** In practice, Codex review takes 30-90 seconds and tests take 30-120 seconds. Running sequentially doubles wall-clock time. Running in parallel saves the minimum of both durations. The gates are independent — test results don't affect Codex review and vice versa.

### Step 3: Create or Update PR

If no PR exists yet: create PR with `Fixes #<issue_num>` in body.
If PR already exists: push changes.

**Note:** Tests run before PR creation per CLAUDE.md "Before Creating PR" checklist.

### Step 4: Self-Review with /pm-review

Run `/pm-review <pr-or-issue-number>` as a self-check. When invoking /pm-review in this context, select the **ANALYSIS_ONLY** action — do NOT select APPROVE_ONLY, POST_REVIEW_COMMENTS, MERGE_AND_CHECKLIST, or any other mutating action. This step is diagnostic only. State transitions happen in Step 5.

**⚠️ Constraint:** When /pm-review prompts for PM-process fixes, select **SKIP_PM_FIXES**. When prompted for a verdict action, select **ANALYSIS_ONLY**. Even if /pm-review's output includes automatic PM-fix actions (workflow moves, label changes, comment posting), Claude MUST NOT execute them during this step. Read the analysis output, discard any mutation recommendations, and act only on the diagnostic findings. Structural enforcement of a non-mutating /pm-review mode is a follow-up enhancement.

If /pm-review identifies **code/implementation issues** (missing AC, scope drift, policy violations in the diff):

1. Address the feedback
2. If code changed, commit fixes and return to Step 2
3. Re-run /pm-review until code findings are resolved

**PM-process findings** (workflow state, labels, project fields, missing issue comments) are NOT code issues — do not loop on them. Step 5 handles the Review transition, and post-merge checklist handles Done.

If user overrides: proceed to Step 5 with acknowledgment.

### Step 5: Transition to Review

`pm move <num> Review`

Verify with `pm status <num>` that workflow is now "Review".

## Precedence Note

This sequence deliberately extends CLAUDE.md's generic "After Opening PR → move to Review" (CLAUDE.md §"After Opening PR") and PM_PLAYBOOK.md's Review entry criteria (PM_PLAYBOOK.md §"Review") by inserting a /pm-review quality gate (Step 4) between PR creation (Step 3) and Review transition (Step 5). The purpose is to catch issues BEFORE signaling "ready for human review" — if we moved to Review first, a human reviewer might begin reviewing while /pm-review is still running. This precedence applies ONLY to /issue-managed work; non-skill workflows still follow the generic CLAUDE.md rule.
