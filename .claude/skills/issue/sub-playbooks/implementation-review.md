# Sub-Playbook: Codex Implementation Review

## Goal

Adversarial code review from Codex after implementation. Evidence-based: findings must cite specific code locations, not just opinions. Inspired by the "agents that prove, not guess" principle (Google ADK) and Block AI's adversarial cooperation model.

## Prerequisites

- `codex_available` is true
- Implementation complete, changes committed

## Tool Choice: MCP vs CLI

All Codex interactions use the **MCP tools** (`mcp__codex__codex` and `mcp__codex__codex-reply`), NOT `codex exec` via Bash. Benefits:

- No shell quoting issues (spaces in paths, special characters in prompts)
- No dependency on `codex-mcp-overrides.sh`
- Works from worktrees (MCP tool doesn't depend on local node_modules)
- Structured parameters instead of CLI flag parsing

## Risk-Proportional Depth

Before launching the full review loop, assess change size:

```bash
DIFF_STATS=$(git diff --stat main...HEAD)
FILES_CHANGED=$(git diff --name-only main...HEAD | wc -l | tr -d ' ')
LINES_CHANGED=$(git diff --shortstat main...HEAD | grep -oE '[0-9]+ insertion|[0-9]+ deletion' | grep -oE '[0-9]+' | paste -sd+ | bc)
```

| Change Size | Threshold | Review Depth |
|-------------|-----------|-------------|
| **Trivial** | ≤ 1 file AND ≤ 20 lines | Skip Codex review entirely (user can override) |
| **Small** | ≤ 3 files AND ≤ 100 lines | Single-pass review (no iteration loop) |
| **Standard** | Everything else | Full adversarial review loop |

For **Trivial** changes: AskUserQuestion "Change is trivial (N files, M lines). Skip Codex review?" with "Skip (Recommended)" / "Review anyway". This saves significant wall-clock time on typo fixes, doc updates, and config changes.

For **Small** changes: Run one Codex review pass. If APPROVED, proceed. If findings exist, fix and proceed (no re-submission loop). User can still override.

## Flow

### Step 1: Initial Review

Codex has full filesystem access in `workspace-write` sandbox. It can run `git diff`, read files, browse the codebase, **and write verification artifacts** — test scripts, reproduction cases, or validation helpers. **Do NOT pre-generate a diff or patch file** — Codex decides what context it needs and how to verify.

```
mcp__codex__codex({
  prompt: "You are an adversarial code reviewer for issue #<issue_num>. The branch is based on main. Review the implementation against the issue's acceptance criteria. Use git diff, git log, and file reads as needed. You CAN write and run test scripts to verify claims — prefer proving over guessing. Output your findings as JSON: {\"verdict\": \"APPROVED\"|\"CHANGES_NEEDED\", \"findings\": [{\"id\": \"F1\", \"category\": \"security\"|\"correctness\"|\"performance\"|\"style\", \"severity\": \"high\"|\"medium\"|\"low\", \"file\": \"path\", \"line\": N, \"description\": \"...\", \"suggestion\": \"...\"}], \"summary\": \"...\"}. Every finding MUST include file and line. End with APPROVED if no blocking findings, or CHANGES_NEEDED.",
  sandbox: "workspace-write",
  cwd: "<repo_root>"
})
```

**Why `workspace-write`:** The reviewer should be able to **prove** findings, not just claim them. Writing a quick test that demonstrates a null pointer, running a script that exposes a race condition, or creating a reproduction case — these are more valuable than prose opinions. This is the Google ADK "agents that prove, not guess" principle taken to its logical conclusion. The sandbox still prevents network access and system modifications.

**Thread ID capture:** The MCP tool response includes a `threadId`. Store it for the resume/reply flow in Step 5.

**Key properties:**
- `workspace-write` lets Codex read AND write (tests, scripts, verification artifacts)
- Codex has full codebase access — no pre-generated diff needed
- Any files Codex creates during review are visible to Claude for evaluation

### Step 2: Check for Failures

1. If MCP tool returns an error: Surface via AskUserQuestion with "Retry" / "Override" / "Show error".
2. If response is empty or truncated: context exhaustion. Surface via AskUserQuestion with "Retry" / "Override".

### Step 3: Parse Findings via JSON Schema

Codex is instructed (via the prompt in Step 1) to output findings as JSON. Claude parses the structured output deterministically — no regex, no prose interpretation.

**Finding schema (what Codex outputs):**

```json
{
  "verdict": "CHANGES_NEEDED",
  "findings": [
    {
      "id": "F1",
      "category": "security",
      "severity": "high",
      "file": "src/auth.ts",
      "line": 45,
      "description": "Unsanitized user input passed to query builder",
      "suggestion": "Use parameterized query via db.query(sql, [param])"
    }
  ],
  "summary": "1 security issue found in auth module"
}
```

**Schema fields:**
- `verdict`: `"APPROVED"` | `"CHANGES_NEEDED"`
- `findings[].id`: Stable identifier (F1, F2, ...) for ledger tracking
- `findings[].category`: `"security"` | `"correctness"` | `"performance"` | `"style"`
- `findings[].severity`: `"high"` | `"medium"` | `"low"`
- `findings[].file` + `findings[].line`: Evidence citation (REQUIRED for blocking/suggestion)
- `findings[].description`: What's wrong
- `findings[].suggestion`: How to fix it (optional)

**Blocking thresholds (applied by Claude after parsing):**

| Category | Weight | Blocking Threshold |
|----------|--------|--------------------|
| **Security** | 0.45 | 1 HIGH finding blocks |
| **Correctness** | 0.35 | 2 HIGH findings block |
| **Performance** | 0.15 | Never auto-blocks (advisory) |
| **Style** | 0.05 | Never blocks |

**Evidence enforcement:** If a finding has `file: null` or `line: null`, Claude automatically downgrades it to advisory regardless of category/severity. This is structural — no interpretation needed.

**If Codex outputs prose instead of JSON:** Fall back to prose parsing (regex for file:line, keyword matching for categories). Log a warning: "Codex did not output structured JSON — falling back to prose parsing." This is degraded mode, not a failure.

### Review Ledger

The Review Ledger is a JSON file at `/tmp/codex-review-ledger-<issue_num>.json` that tracks all findings across iterations, their current status, and how they were resolved. This is the source of truth for convergence — not Codex's verdict.

```json
{
  "issue": "<issue_num>",
  "iteration": 2,
  "findings": [
    {
      "id": "F1",
      "category": "security",
      "severity": "high",
      "file": "src/auth.ts",
      "line": 45,
      "description": "Unsanitized user input passed to query builder",
      "raised_iteration": 1,
      "status": "fixed",
      "resolution": "Switched to parameterized query in commit abc123"
    },
    {
      "id": "F2",
      "category": "correctness",
      "severity": "medium",
      "file": "lib/parse.ts",
      "line": 12,
      "description": "Missing null check on optional field",
      "raised_iteration": 1,
      "status": "justified",
      "resolution": "Field is validated at API boundary (middleware.ts:30), null is impossible here"
    }
  ]
}
```

**Statuses:** `open` (unresolved), `fixed` (code changed), `justified` (skipped with reason), `withdrawn` (Codex retracted in later iteration).

**Why a review ledger:**
1. **Prevents re-raising:** On resume, Codex sees the ledger and knows what's already fixed or justified
2. **Structural convergence:** Loop terminates when ledger has zero `open` items in blocking categories — not when Codex says "APPROVED"
3. **Audit trail:** The user can see exactly what was raised, how it was resolved, and when
4. **Prevents re-litigation:** "Justified" items with reasons don't get re-raised (same principle as the Plan Ledger)

**Claude updates the ledger** after each iteration:
- New findings from Codex → added as `open`
- Findings Claude fixed → status changes to `fixed` with commit reference
- Findings Claude justified → status changes to `justified` with explanation
- Findings Codex withdrew → status changes to `withdrawn`

Display format:

```markdown
### Codex Review — Iteration N

**Ledger:** X findings total (Y open, Z fixed, W justified)
**Blocking:** N open findings in blocking categories

| ID | Category | Severity | File:Line | Finding | Status | Resolution |
|----|----------|----------|-----------|---------|--------|------------|
| F1 | Security | HIGH | src/auth.ts:45 | Unsanitized input | fixed | Parameterized query (abc123) |
| F2 | Correctness | MED | lib/parse.ts:12 | Missing null check | justified | Validated at API boundary |
| F3 | Performance | LOW | src/query.ts:88 | N+1 query | open | — |

**This iteration:** 1 new finding (F3), 2 resolved (F1 fixed, F2 justified)
```

### Step 4: User Choice

Use AskUserQuestion:

```
question: "Codex raised findings on the implementation. How do you want to proceed?"
header: "Impl Review"
options:
  - label: "Continue — fix and re-submit (Recommended)"
    description: "Claude addresses feedback and re-submits for review"
  - label: "Override — proceed to tests"
    description: "Skip Codex findings and proceed to {{TEST_COMMAND}}"
  - label: "Show full Codex output"
    description: "Display the complete Codex review output"
```

### Step 5: Fix Loop

#### Suggestion Handling (part of Continue path)

When the user chooses "Continue" in Step 4, Claude MUST handle each SUGGESTION before fixing:

1. **Address it** — implement the suggestion and note what changed
2. **Justify skipping** — explain why the suggestion doesn't apply or would cause harm

"It's just a suggestion" is NOT valid justification. Valid reasons include:

- Conflicts with a non-goal
- Would require out-of-scope work (trigger Discovered Work sub-playbook)
- Codex misunderstood the context (cite specific misunderstanding)

Include the suggestion disposition in the per-iteration display (Step 3).

This step is skipped entirely when the user chooses "Override" — Override supersedes all finding handling.

After handling suggestions and addressing findings, Claude continues the Codex conversation using the stored thread ID:

```
mcp__codex__codex-reply({
  threadId: "<stored_thread_id>",
  prompt: "This is Claude (Anthropic). I've addressed your findings. The review ledger at /tmp/codex-review-ledger-<issue_num>.json shows current finding statuses. Re-run git diff to see updated code. You can write verification scripts if needed. Please re-review and update your verdict."
})
```

**Dialogue guidance:** This is a two-way conversation, not a one-way submission:

- If Codex asked questions → answer them
- If Codex raised findings → explain what was changed and why
- If Codex asked for clarification → provide it
- Do not include review-content instructions (e.g., "re-review the ENTIRE diff", "check for X") — Codex decides what to review

**Key properties:**
- Uses `mcp__codex__codex-reply` with `threadId` to continue the conversation
- Thread ID was captured from the initial `mcp__codex__codex` response
- Repeat Steps 2-4 for each iteration

### Step 6: Termination

Loop terminates when:

- **Review Ledger has zero `open` findings in blocking categories** (Security HIGH, or 2+ Correctness HIGH) AND all SUGGESTION-level findings are `fixed` or `justified`, OR
- User chooses "Override"
- **5-iteration hard cap:** If 5 iterations pass without convergence, force AskUserQuestion with "Accept current state" / "Override" / "Show full ledger". This prevents infinite loops.

**Why ledger-based termination:** Previous versions checked if "Codex says APPROVED" — a subjective signal that drifts. The ledger makes convergence structural: count open items in blocking categories. Zero open blockers = done. No interpretation needed.

**Anti-shortcut rule (Continue path only — does not apply to Override):** Claude MUST NOT self-certify its revisions are correct. Every revision MUST be re-submitted to Codex (which may add new findings to the ledger). The loop cannot terminate until the ledger shows zero open blockers AND Codex has reviewed the revised version. Claude fixing all findings in one pass, updating the ledger to "fixed", and declaring "done" without re-submission is the exact failure mode this loop prevents. This rule does not restrict the Override path — Override terminates the loop immediately regardless of ledger state.

**Ledger cleanup:** After termination, the review ledger is preserved at `/tmp/codex-review-ledger-<issue_num>.json` for the /pm-review self-check step (Post-Implementation Step 4). It is cleaned up after the full Post-Implementation Sequence completes.
