# Sub-Playbook: Collaborative Planning

## Goal

Independent plan generation by both Claude and Codex, followed by iterative refinement on Claude's plan until convergence. Eliminates anchoring bias by having Codex write its own plan before seeing Claude's.

## Prerequisites

- `codex_available` is true
- BEFORE EnterPlanMode (Phase 1 requires Bash for directory setup)
- Issue context loaded (issue body, acceptance criteria, non-goals)

## Tool Choice: MCP vs CLI

All Codex interactions use the **MCP tools** (`mcp__codex__codex` and `mcp__codex__codex-reply`), NOT `codex exec` via Bash. Benefits:

- No shell quoting issues (spaces in paths, special characters in prompts)
- No dependency on `codex-mcp-overrides.sh`
- Works inside plan mode (MCP tools aren't restricted like Bash)
- Structured parameters instead of CLI flag parsing

## Overview

Three phases:

1. **Independent Plan Writing** — Codex writes Plan B first, then Claude writes Plan A (ordering-based independence)
2. **Questions with Recommendations** — Both agents surface spec ambiguities with recommendations
3. **Iterative Refinement** — Claude incorporates Codex ideas, then iterates with Codex on Claude's plan until convergence

## Phase 1: Independent Plan Writing

**Key property:** Codex writes Plan B BEFORE Claude writes Plan A. Plan A does not exist on disk when Codex runs — ordering-based independence.

### Step 1: Launch Codex Plan B

This runs BEFORE EnterPlanMode. Claude has loaded context (issue, docs, codebase) but has NOT yet written anything to the plan file.

1. Ensure `.codex-work/` directory exists (requires Bash, so do this before plan mode):

```bash
mkdir -p .codex-work
```

2. Launch Codex via MCP tool (`workspace-write` sandbox):

```
mcp__codex__codex({
  prompt: "Write an implementation plan for issue #<issue_num>. Read the issue at https://github.com/<owner>/<repo>/issues/<issue_num> or via gh CLI. Analyze the codebase, then save your plan to .codex-work/plan-<issue_num>.md",
  sandbox: "workspace-write",
  cwd: "<repo_root>"
})
```

The MCP tool returns the Codex response and a `threadId`. Store the `threadId` for potential follow-up.

3. Check for failures:
   - MCP tool returns an error
   - Plan B file (`.codex-work/plan-<issue_num>.md`) is missing or empty after Codex completes

On failure: AskUserQuestion with options:

- "Retry" — re-run Codex Plan B
- "Continue with Claude-only plan" — skip collaborative planning
- "Show error" — display full error output

Do NOT auto-fall back on failure.

### Step 2: Claude Writes Plan A

After Codex completes successfully and EnterPlanMode is called, Claude writes Plan A to the standard plan file (`.claude/plans/`). Claude writes Plan A WITHOUT reading Plan B first — this preserves independence.

### Step 3: Read Plan B and Extract Questions

After both plans exist, Claude reads Plan B from `.codex-work/plan-<issue_num>.md`. Extract any questions Codex surfaced about spec ambiguity.

**Independence guarantee (START mode):** Ordering-based. Codex writes Plan B first — Plan A does not exist on disk. After Codex finishes, Claude writes Plan A without reading Plan B. Neither agent sees the other's plan before writing their own.

**Independence in CONTINUE mode:** The AC "Neither agent sees the other's plan before writing their own" refers to the current iteration's plans. Prior session plan artifacts in `.claude/plans/` are previous context, not "the other agent's current plan." The ordering guarantee still applies: Codex writes its Plan B before Claude writes this iteration's Plan A.

## Phase 2: Questions with Recommendations

1. Extract questions from Codex's Plan B (look for questions, ambiguities, or recommendations)
2. Claude surfaces its own questions about spec ambiguities
3. Present all questions to user via AskUserQuestion, with each agent's recommendation and rationale
4. User answers are included in the next iteration prompt to Codex
5. Claude updates Plan A with answers
6. If neither agent has questions, skip to Phase 3

## Phase 3: Iterative Refinement on Claude's Plan

This is the core loop. Claude reads Codex's plan, incorporates good ideas, then iterates with Codex on Claude's plan. A **Plan Ledger** on disk tracks all proposals and decisions, preventing re-litigation.

### Plan Ledger

The Plan Ledger is a JSON file at `/tmp/codex-plan-ledger-<issue_num>.json` that tracks every proposal across iterations. Claude creates it before the first iteration and updates it after each.

```json
{
  "issue": "<issue_num>",
  "iterations": 0,
  "items": [
    {
      "id": "P1",
      "source": "codex",
      "iteration": 1,
      "proposal": "Use adapter pattern for chain abstraction",
      "section": "Architecture",
      "status": "accepted",
      "reason": "Aligns with existing blockchain/ abstraction layer"
    },
    {
      "id": "P2",
      "source": "codex",
      "iteration": 1,
      "proposal": "Add Redis caching layer",
      "section": "Performance",
      "status": "rejected",
      "reason": "Out of scope — no caching in acceptance criteria"
    }
  ]
}
```

**Statuses:** `open` (unresolved), `accepted` (incorporated into Plan A), `rejected` (with reason).

**Why a ledger:** Without it, iteration 3's Codex session might re-propose something rejected in iteration 1 (it's a fresh session with no memory). The ledger is included in the prompt so Codex can see what's already been decided. This eliminates the single biggest source of non-convergence: re-litigation of settled decisions.

### Step 1: Incorporate and Prompt Codex

1. Claude reads both plans and incorporates good ideas from Plan B into Plan A
2. Claude updates the plan file on disk
3. Claude updates the Plan Ledger — marking items as `accepted` or `rejected` with reasons
4. Claude prompts Codex (fresh session, `read-only` sandbox) via MCP tool:

```
mcp__codex__codex({
  prompt: "Review my updated plan for issue #<issue_num> at <plan_a_path>. The decision ledger at /tmp/codex-plan-ledger-<issue_num>.json shows what has already been proposed, accepted, and rejected. Do NOT re-propose rejected items. If you have NEW suggestions, propose them. If all your concerns are addressed, respond with CONVERGED. Otherwise list your specific change proposals.",
  sandbox: "read-only",
  cwd: "<repo_root>"
})
```

5. Parse Codex's response for new proposals or CONVERGED signal
6. Add new proposals to the ledger as `open`

### Step 2: Per-Iteration Display

```markdown
### Collaborative Planning — Iteration N

**Ledger:** X items total (Y accepted, Z rejected, W open)

**New proposals from Codex:**
- P4: [proposal] → [accepted/rejected/open]

**Resolved this iteration:**
- P3: [proposal] → accepted (reason) / rejected (reason)

**Codex response:** CONVERGED / [new proposals]
```

### Step 3: Evaluate Convergence

Convergence is determined by the **Plan Ledger**, not subjective judgment:

- **CONVERGED:** Codex responds with "CONVERGED" AND the ledger has zero items with status `open`.
- **NOT CONVERGED:** Codex proposed new items (added to ledger as `open`), OR existing `open` items remain unresolved.

**Decision:**
- If CONVERGED → Clean up artifacts (Step 5), then proceed to ExitPlanMode.
- If NOT CONVERGED → Claude resolves `open` items (accept or reject with reason), updates Plan A, then launches a NEW fresh Codex session (repeat from Step 1).

### Step 4: 3-Iteration Checkpoint

After 3 iterations without convergence, display the ledger summary and AskUserQuestion:

```
question: "Collaborative planning has iterated 3 times. Ledger: X accepted, Y rejected, Z still open. How to proceed?"
header: "Plan Review"
options:
  - label: "Continue iterating (Recommended)"
    description: "Keep refining until ledger has no open items"
  - label: "Accept Claude's current plan"
    description: "Stop iterating and use Claude's plan as-is"
  - label: "Use Codex's plan instead"
    description: "Replace Claude's plan with Codex's Plan B"
  - label: "Show full ledger"
    description: "Display the complete decision ledger"
```

On "Use Codex's plan instead": Copy Plan B content to the plan file, replacing Plan A.
On "Accept Claude's current plan": Stop iterating, proceed to ExitPlanMode.
On "Show full ledger": Display the JSON ledger formatted as a table, then re-prompt.

### Step 5: Artifact Cleanup

After convergence (or user override), clean up Plan B artifacts to prevent confusion in later phases:

```bash
rm -f .codex-work/plan-<issue_num>*.md
rm -f /tmp/codex-plan-ledger-<issue_num>.json
```

**Why cleanup matters:** Leftover Plan B files in `.codex-work/` confuse Claude during implementation — it may interpret them as late-arriving background work or unfinished planning. Structural cleanup (delete files when done) is more reliable than behavioral instructions ("ignore these files").

### User Override

User can override at any iteration display (Step 2) by choosing to accept or switch plans. Override terminates the loop immediately. Artifact cleanup (Step 5) still runs after override.

## Key Properties

| Property                        | Detail                                                                                                                 |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| **MCP tools**                   | All Codex calls use `mcp__codex__codex` / `mcp__codex__codex-reply`. No `codex exec` via Bash.                         |
| **Fresh sessions**              | Each Codex call is a new `mcp__codex__codex` invocation. Context passed in the prompt.                                 |
| **No user arbitration**         | Agents iterate until Codex agrees. User only sees the final result via ExitPlanMode. User CAN override at checkpoints. |
| **Ordering-based independence** | Codex writes Plan B first. Plan A doesn't exist when Codex runs.                                                       |
| **One canonical plan**          | Claude's plan evolves. No separate "merged plan."                                                                      |
| **Sandbox modes**               | `workspace-write` for Plan B creation. `read-only` for plan iterations.                                                |
| **Plan Ledger**                 | JSON file tracking proposals across iterations. Prevents re-litigation of settled decisions.                            |
| **Plan B location**             | `.codex-work/plan-<issue_num>.md` — gitignored, outside `find-plan.sh` scope.                                          |
