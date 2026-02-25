# Verification Checklist

> **This file is NOT loaded at runtime.** It exists for developer reference only — use it when testing or modifying the /issue skill to verify no regressions.

## Create Mode - New Issue

- [ ] `/issue` (no args) triggers Create Mode
- [ ] PM interview asks relevant questions (1-2 at a time)
- [ ] Duplicate scan runs before draft (at least 3 searches)
- [ ] Draft matches template structure
- [ ] Confirmation required before creation
- [ ] Priority reasoning shown with factor table after draft confirmation, before issue creation
- [ ] User given choice to accept or override recommended priority
- [ ] Selected priority (including overrides) is passed to pm add

## Create Mode - Update Existing

- [ ] Candidates shown with overlap explanation
- [ ] Diff preview shown
- [ ] Existing issue updated, not new created

## Create Mode - Merge

- [ ] Merge plan shown
- [ ] Canonical updated, duplicates closed with comment

## Execute Mode (MUST NOT DEGRADE)

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
- [ ] START mode: move to Active, run make setup in background, enter plan mode with full detail
- [ ] CONTINUE mode: git sync, run make setup in background, enter plan mode with full detail
- [ ] REVIEW mode: offers /pm-review or make changes
- [ ] APPROVED mode: shows merge instructions
- [ ] REWORK mode: moves to Active, syncs git, displays feedback and guardrails
- [ ] CLOSED mode: offers reopen instructions
- [ ] MISMATCH modes: detect and offer fixes for all 4 variants
- [ ] Handoff works from Create Mode to Execute Mode

## Discovered Work Handling

- [ ] When discovering work outside current scope, STOP before bundling
- [ ] Duplicate scan runs for discovered work (maybe issue already exists)
- [ ] Blocker relationship established when discovered work blocks current issue
- [ ] Comment posted on current issue explaining the blocker
- [ ] User offered choice: work on blocker first, continue anyway, or pause

## Worktree Support

- [ ] `/issue <num>` in START mode from main repo creates worktree at `../cnd-<num>/`
- [ ] Worktree setup prints shell exports for port offsets (via `--print-env`)
- [ ] If worktree already exists + tmux, spawns/focuses tmux window (not recreated)
- [ ] If worktree already exists + no tmux, user is directed there (not recreated)
- [ ] If already in correct worktree, proceeds normally without redirection
- [ ] If in wrong worktree + tmux, spawns worktree + window in background
- [ ] If in wrong worktree + no tmux, user is directed to correct location
- [ ] Broken worktree (stale metadata) is detected and fix offered
- [ ] Port isolation allows `make dev` in multiple worktrees simultaneously
- [ ] CONTINUE mode detects worktree and proceeds if in correct location

## Background Setup

- [ ] /issue <num> in START mode runs make setup in background before plan mode
- [ ] /issue <num> in CONTINUE mode runs make setup in background before plan mode
- [ ] Bash tool called with run_in_background: true (returns task_id within 2 seconds)
- [ ] TaskOutput called with block: false after ExitPlanMode to check result
- [ ] Completed setup: user told "Environment ready"
- [ ] Failed setup: user shown error output and told to run make setup manually
- [ ] Still-running setup: user informed, not blocked
- [ ] Background setup only runs in correct worktree (not during worktree creation handoff)

## Portfolio Manager (tmux)

- [ ] `tmux-session.sh init` creates session `cnd` with `main` window
- [ ] `tmux-session.sh start <num> <branch>` creates worktree + window + state
- [ ] `tmux-session.sh list` shows all tracked issues with status
- [ ] `tmux-session.sh focus <num>` switches to correct window
- [ ] `tmux-session.sh stop <num>` closes window and updates state
- [ ] Hooks fire and update `~/.cnd/portfolio/<num>/status`
- [ ] `portfolio-notify.sh` is a no-op when `CND_ISSUE_NUM` not set
- [ ] tmux bell triggers on `needs-input` events — window shows alert indicator in status bar
- [ ] `/issue <num>` in START mode + tmux spawns background window instead of stopping
- [ ] `/issue <num>` in START mode without tmux uses existing fallback behavior

## Codex Review Loops

### Collaborative Planning

- [ ] `codex --version` check in Step 1e (parallel)
- [ ] Graceful skip when codex unavailable (notice shown, not silent)
- [ ] Collaborative Planning fires inside plan mode, BEFORE ExitPlanMode, in START and CONTINUE
- [ ] Codex Plan B launches BEFORE Claude writes Plan A (ordering-based independence)
- [ ] Plan B written to `.codex-work/plan-<issue_num>-<prefix>.md` (gitignored)
- [ ] `-s workspace-write` ONLY for Plan B creation (Phase 1)
- [ ] `-s read-only` for collaborative planning iterative review (Phase 3)
- [ ] Plan Ledger tracks proposals across iterations (open/accepted/rejected)
- [ ] Convergence based on ledger (zero open items), not subjective "Codex agrees"
- [ ] No `--full-auto` in collaborative planning (would override read-only to workspace-write)
- [ ] Each Codex iteration is a fresh session — no resume
- [ ] `-o` flag always on `exec` level, BEFORE subcommands
- [ ] `set -o pipefail` on all `codex exec | tee` pipelines
- [ ] Claude prompts Codex with what was incorporated and what wasn't (with reasons)
- [ ] Convergence when Codex agrees — no user arbitration
- [ ] 3-iteration checkpoint with user choice (continue / accept Claude's / use Codex's / show output)
- [ ] On exec failure: error context surfaced, explicit user choice required (Retry/Claude-only/Show error)
- [ ] Never auto-skip on failure (no-fallback compliance)
- [ ] Stderr captured to file on original invocation (`2>/tmp/codex-collab-stderr-<num>.txt`), never via rerun
- [ ] Phase 3 iterations use per-iteration output files (`-<issue_num>-${COLLAB_ITER}.txt`)
- [ ] Phase 3 iterations capture stderr to per-iteration files (NOT `2>/dev/null`)
- [ ] No write-capable (`-s workspace-write`) rerun in error paths
- [ ] User can override at any iteration
- [ ] 0-byte output file detected as failure (context exhaustion)
- [ ] Structural convergence detection (Codex proposes no concrete file/section modifications)
- [ ] Artifact cleanup runs after convergence or user override (Plan B + temp files deleted)

### Behavioral Verification (START/CONTINUE flow)

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

### Implementation Review

- [ ] Implementation review fires as parallel quality gate (with tests) in Post-Implementation
- [ ] `-s workspace-write` on all implementation review invocations (Codex can write tests/scripts)
- [ ] Uses `exec` with structured review prompt (NOT `review --base main`)
- [ ] Codex explores codebase freely (no pre-generated patch file)
- [ ] `resume "$CODEX_SESSION_ID"` for follow-ups (NOT `--last`)
- [ ] Per-iteration summary with weighted finding categories (Security/Correctness/Performance/Style)
- [ ] Per-iteration output files (`-<issue_num>-${ITER}.txt`) prevent collision
- [ ] Stderr captured per iteration (NOT discarded with `2>/dev/null`)
- [ ] Evidence requirement: findings must cite file:line or downgrade to advisory
- [ ] Codex outputs findings as JSON schema (verdict, findings[], summary)
- [ ] Prose fallback with warning if JSON parsing fails
- [ ] Review Ledger tracks findings across iterations (open/fixed/justified/withdrawn)
- [ ] Termination based on ledger (zero open blockers), not Codex verdict
- [ ] Claude self-identifies when resuming sessions
- [ ] Resume prompt includes review ledger path
- [ ] Resume loop supports two-way dialogue (questions + revisions)
- [ ] SUGGESTION findings addressed or justified (not just BLOCKING)
- [ ] Ledger preserved for /pm-review self-check step
- [ ] 5-iteration hard cap with user choice prevents infinite loops
- [ ] Risk-proportional depth: trivial (skip), small (single-pass), standard (full loop)
- [ ] Revisions re-submitted to Codex (Claude cannot self-certify)

## Post-Implementation Sequence

- [ ] Sequence enforced: commit → parallel gates (Codex + tests) → PR → /pm-review → Review
- [ ] Codex review and tests run concurrently (parallel quality gates)
- [ ] Both gates must pass on the same commit before proceeding
- [ ] Tests run before PR creation (aligned with CLAUDE.md "Before Creating PR")
- [ ] No step can be skipped (each validates the previous)
- [ ] /pm-review runs as self-check after PR creation (PR or issue number)
- [ ] Only after /pm-review passes (or user override) does Claude move to Review
- [ ] START mode "After ExitPlanMode" references Post-Implementation Sequence
- [ ] CONTINUE mode "After ExitPlanMode" references Post-Implementation Sequence
- [ ] REWORK mode references Post-Implementation Sequence
- [ ] Code changes from one gate trigger re-run of the other gate
- [ ] Appendix H guardrails contain full explicit checklist (not indirect reference)
- [ ] Execution model documented (skill guidance vs Claude Code capabilities)
- [ ] Post-Implementation Sequence includes Precedence Note re: /pm-review gate
- [ ] Suggestion handling is in Continue path (not before user choice) in both sub-playbooks
- [ ] AC Traceability Table present in plan and used during /pm-review verification

## Regression Prevention

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
