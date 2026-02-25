# Why This Design

## Why two modes?

- **Create Mode** handles the common case of "I want to do something but haven't formalized it yet"
- **Execute Mode** handles working on existing, well-defined issues
- The router is tiny (10 lines) and deterministic

## Why `/issue` instead of `/start-issue`?

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

## Why mode detection instead of always entering plan mode?

Different modes need different actions:

- START needs plan mode (beginning work)
- CONTINUE needs plan mode (re-grounding when resuming)
- REVIEW needs the reviewer skill
- APPROVED needs merge instructions
- REWORK needs feedback display + guardrails

START and CONTINUE both enter plan mode because that's when re-grounding is most needed. The other modes have specific purposes that don't benefit from full plan output.

## Why duplicate scan before creation?

Fragmented issues are a real problem. Multiple partial issues on the same topic waste effort and lose context. The scan catches this early.

## Why offer (not gate) on readiness?

Blocking on missing sections creates friction. Some issues are clear enough without full structure. The offer lets users upgrade when it helps without forcing it.

## Why merge with safety rails?

Consolidating issues is valuable but risky. The guardrails (max 3 closes, default to existing, confirmation required) prevent accidents while enabling the workflow.

## Why mismatch detection?

Project state and reality can diverge:

- PR merged but issue not marked Done
- Issue in Review but no PR exists
- Multiple PRs linked to same issue

The skill detects these and offers fixes, rather than failing or ignoring them.

## Why parallel quality gates?

Tests and Codex review are independent — test results don't affect what Codex reviews and vice versa. Running them sequentially doubles wall-clock time (30-120s each). Running in parallel saves the minimum of both durations. The convergence requirement (both pass on same commit) prevents the edge case where fixing one gate invalidates the other.

## Why evidence-based review with weighted categories?

Behavioral instructions ("be thorough", "be skeptical") drift under token pressure — the agent starts rubber-stamping after a few iterations. Structural requirements (mandatory file:line citations, weighted severity categories) make findings objectively verifiable. If a finding lacks a citation, it's automatically downgraded. This is the "structure over behavior" principle applied to code review.

## Why risk-proportional depth?

Running a full adversarial review loop on a typo fix wastes 60-90 seconds. The cost of review should match the risk of the change. Trivial changes (1 file, ≤20 lines) skip Codex entirely. Small changes (≤3 files, ≤100 lines) get a single pass. Only standard changes get the full loop with resume and iteration.

## Why artifact cleanup?

Leftover Plan B files confuse Claude during implementation — it interprets them as unfinished work or late-arriving background results. Deleting temporary artifacts when they're no longer needed (structural cleanup) is more reliable than telling Claude to ignore them (behavioral instruction).
