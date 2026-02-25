# Sub-Playbook: Collaborative Planning

## Goal

Independent plan generation by both Claude and Codex, followed by iterative refinement on Claude's plan until convergence. Eliminates anchoring bias by having Codex write its own plan before seeing Claude's.

## Prerequisites

- `codex_available` is true
- Inside plan mode, BEFORE Claude writes Plan A
- Issue context loaded (issue body, acceptance criteria, non-goals)

## Overview

Three phases:

1. **Independent Plan Writing** — Codex writes Plan B first, then Claude writes Plan A (ordering-based independence)
2. **Questions with Recommendations** — Both agents surface spec ambiguities with recommendations
3. **Iterative Refinement** — Claude incorporates Codex ideas, then iterates with Codex on Claude's plan until convergence

## Phase 1: Independent Plan Writing

**Key property:** Codex writes Plan B BEFORE Claude writes Plan A. Plan A does not exist on disk when Codex runs — ordering-based independence.

### Step 1: Launch Codex Plan B

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

### Step 2: Claude Writes Plan A

After Codex completes successfully, Claude writes Plan A to the standard plan file (`.claude/plans/`). Claude writes Plan A WITHOUT reading Plan B first — this preserves independence.

### Step 3: Read Plan B and Extract Questions

After both plans exist, Claude reads Plan B from `.codex-work/plan-<issue_num>-${PLAN_B_PREFIX}.md` and the `-o` output file. Extract any questions Codex surfaced about spec ambiguity.

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
  "issue": <issue_num>,
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
    },
    {
      "id": "P3",
      "source": "codex",
      "iteration": 2,
      "proposal": "Split migration into two steps",
      "section": "Implementation",
      "status": "open",
      "reason": null
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
4. Claude prompts Codex (fresh session, `-s read-only`), including the ledger:

```bash
set -o pipefail
COLLAB_ITER=1  # Increment each iteration
codex exec $(./tools/scripts/codex-mcp-overrides.sh) --json -s read-only --skip-git-repo-check \
  -o /tmp/codex-collab-review-<issue_num>-${COLLAB_ITER}.txt \
  "Review my updated plan for issue #<issue_num> at <plan_a_path>. The decision ledger at /tmp/codex-plan-ledger-<issue_num>.json shows what has already been proposed, accepted, and rejected. Do NOT re-propose rejected items. If you have NEW suggestions, propose them. If all your concerns are addressed, respond with CONVERGED. Otherwise list your specific change proposals." \
  2>/tmp/codex-collab-stderr-<issue_num>-${COLLAB_ITER}.txt \
  | tee /tmp/codex-collab-events-<issue_num>-${COLLAB_ITER}.jsonl
```

5. Read Codex's response from `-o` output
6. Parse new proposals from Codex's response, add them to the ledger as `open`
7. Check for failures (same pattern as Phase 1 Step 1.3)

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
# Remove Plan B file (no longer needed — its ideas are incorporated into Plan A)
rm -f .codex-work/plan-<issue_num>-*.md
# Remove temp files (all per-iteration outputs, stderr, and events)
rm -f /tmp/codex-collab-output-<issue_num>.txt
rm -f /tmp/codex-collab-events-<issue_num>*.jsonl
rm -f /tmp/codex-collab-review-<issue_num>*.txt
rm -f /tmp/codex-collab-stderr-<issue_num>*.txt
# Remove plan ledger (decisions are captured in Plan A)
rm -f /tmp/codex-plan-ledger-<issue_num>.json
```

**Why cleanup matters:** Leftover Plan B files in `.codex-work/` confuse Claude during implementation — it may interpret them as late-arriving background work or unfinished planning. Structural cleanup (delete files when done) is more reliable than behavioral instructions ("ignore these files").

### User Override

User can override at any iteration display (Step 2) by choosing to accept or switch plans. Override terminates the loop immediately. Artifact cleanup (Step 5) still runs after override.

## Key Properties

| Property                        | Detail                                                                                                                 |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| **Fresh sessions**              | Each Codex call is a new `codex exec` invocation. Context passed in the prompt. No `resume` sessions.                  |
| **No user arbitration**         | Agents iterate until Codex agrees. User only sees the final result via ExitPlanMode. User CAN override at checkpoints. |
| **Ordering-based independence** | Codex writes Plan B first. Plan A doesn't exist when Codex runs.                                                       |
| **One canonical plan**          | Claude's plan evolves. No separate "merged plan."                                                                      |
| **Sandbox modes**               | `-s workspace-write` for Plan B creation. `-s read-only` for plan iterations.                                          |
| **Plan Ledger**                 | JSON file tracking proposals across iterations. Prevents re-litigation of settled decisions.                            |
| **Plan B location**             | `.codex-work/plan-<issue_num>-<prefix>.md` — gitignored, outside `find-plan.sh` scope.                                 |
