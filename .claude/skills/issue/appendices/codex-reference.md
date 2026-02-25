# Appendix L: Codex Integration Reference

## Command Syntax

### Collaborative Planning Invocations

```bash
# Collaborative planning: Plan B writing (Phase 1) — fresh session, workspace-write
set -o pipefail
PLAN_B_PREFIX=$(uuidgen | tr -d '-' | head -c 8)
codex exec $(./tools/scripts/codex-mcp-overrides.sh) --json -s workspace-write --skip-git-repo-check \
  -o /tmp/codex-collab-output-<num>.txt \
  "Write an implementation plan for issue #<num>. Save to .codex-work/plan-<num>-${PLAN_B_PREFIX}.md" \
  2>/tmp/codex-collab-stderr-<num>.txt \
  | tee /tmp/codex-collab-events-<num>.jsonl

# Collaborative planning: Iterative review (Phase 3) — fresh session each round, read-only
set -o pipefail
codex exec $(./tools/scripts/codex-mcp-overrides.sh) --json -s read-only --skip-git-repo-check \
  -o /tmp/codex-collab-review-<num>.txt \
  "Review my updated plan for issue #<num> at <plan_a_path>. I incorporated [X, Y] from your plan. I didn't take [Z] because [reason]. Read the plan file and either agree or suggest specific changes." 2>/dev/null \
  | tee /tmp/codex-collab-events-<num>.jsonl
```

### Implementation Review Invocations

```bash
# Implementation review (initial) — exec with workspace-write so Codex can write tests/scripts
set -o pipefail
ITER=1
codex exec $(./tools/scripts/codex-mcp-overrides.sh) --json -s workspace-write --skip-git-repo-check \
  -o /tmp/codex-impl-review-<num>-${ITER}.txt \
  "You are an adversarial code reviewer for issue #<num>. The branch is based on main. Review the implementation against the issue's acceptance criteria. Use git diff, git log, and file reads as needed. You CAN write and run test scripts to verify claims. Output findings as JSON: {\"verdict\": ..., \"findings\": [...], \"summary\": ...}. End with APPROVED if no blocking findings, or CHANGES_NEEDED." \
  2>/tmp/codex-impl-stderr-<num>-${ITER}.txt \
  | tee /tmp/codex-impl-events-<num>-${ITER}.jsonl

# Session resume (follow-up iterations) — dialogue, use session ID, NOT --last
set -o pipefail
ITER=$((ITER + 1))
echo "This is Claude (Anthropic). <respond to Codex — answer questions or explain revisions. Review ledger at /tmp/codex-review-ledger-<num>.json. Re-run git diff to see updated code.>" | \
  codex exec $(./tools/scripts/codex-mcp-overrides.sh) --json -s workspace-write --skip-git-repo-check \
  -o /tmp/codex-impl-review-<num>-${ITER}.txt \
  resume "$CODEX_SESSION_ID" \
  2>/tmp/codex-impl-stderr-<num>-${ITER}.txt \
  | tee /tmp/codex-impl-events-<num>-${ITER}.jsonl
```

**Critical syntax rule:** `-o`, `-s`, `--json`, and other `exec`-level flags MUST appear before any subcommand (`resume`). Placing them after the subcommand causes "unexpected argument" errors.

## Sandbox Mode Reference

| Phase                      | Sandbox              | Session                  | Rationale                                     |
| -------------------------- | -------------------- | ------------------------ | --------------------------------------------- |
| Plan B writing (Phase 1)   | `-s workspace-write` | Fresh                    | Codex must create plan file in `.codex-work/` |
| Iterative review (Phase 3) | `-s read-only`       | Fresh each round         | Codex reads plan file only                    |
| Implementation review      | `-s workspace-write` | Resume-based             | Codex can write tests/scripts to prove findings |

**Why `exec` instead of `review` for implementation review:**
1. **Full codebase access:** Codex can read any file, run `git diff`, `git log`, check tests — not limited to a pre-generated patch
2. **Better context:** Codex sees the full function around a change, not just `+`/`-` lines in a diff
3. **Reliable output:** The `review` subcommand has 0-byte `-o` output issues, flag mutual-exclusion, and unreliable stdin
4. **Richer prompt:** `exec` accepts a structured review prompt; `review` does not accept `[PROMPT]` with `--base`

**Why session IDs for implementation review, not `--last`:** Multiple worktrees may run Codex reviews concurrently. `resume --last` resumes the globally most recent session, which could belong to a different worktree. `resume "$CODEX_SESSION_ID"` is concurrency-safe.

**Why fresh sessions for collaborative planning:** Each iteration of collaborative planning uses a fresh `codex exec` invocation. Context is passed in the prompt (what was incorporated, what wasn't, pointer to plan file). No `resume` sessions. This avoids context exhaustion across iterations.

## Pipeline Exit Detection

All collaborative planning pipelines MUST use `set -o pipefail` before `codex exec | tee`:

```bash
set -o pipefail
codex exec ... 2>/dev/null | tee /tmp/codex-collab-events-<num>.jsonl
# Check exit: ${PIPESTATUS[0]} for codex exit code
```

Without `set -o pipefail`, the pipeline reports `tee`'s exit code (always 0), masking Codex failures.

## Plan B Filename Generation

```bash
PLAN_B_PREFIX=$(uuidgen | tr -d '-' | head -c 8)
```

Generated BEFORE `codex exec`. Produces an 8-character hex prefix for collision avoidance. Full path: `.codex-work/plan-<issue_num>-${PLAN_B_PREFIX}.md`.

## Availability Check

```bash
codex --version 2>/dev/null
```

Exit 0 → available. Non-zero → unavailable. Checked once in Step 1e, stored as `codex_available`.

## Review Approach: exec with Full Codebase Access

**Implementation review uses `exec` with a structured prompt** instead of the `review` subcommand. Codex has full filesystem access in `-s workspace-write` mode — it runs its own `git diff`, reads full files for context, checks tests, inspects configs, and can write verification scripts to prove findings. No pre-generated diff is needed.

**Why not `review --base main`:**
1. **Limited context:** `review` only gives Codex the diff — it can't read the full function around a change or check related files
2. **Reliability issues:** 0-byte `-o` output files, flag mutual-exclusion (`--base`/`--uncommitted`/`[PROMPT]`), unreliable stdin
3. **No custom prompt:** Can't add adversarial framing, evidence requirements, or structured output format

**The `exec` approach is better in every dimension:** Codex decides what context it needs, the prompt can include adversarial framing and evidence requirements (file:line citations), and output capture is reliable.

## Output Parsing

### Collaborative Planning

Codex responses in collaborative planning are natural language. Look for:

- **Agreement** — Codex says the plan looks good, no changes needed → convergence
- **Suggestions** — Codex proposes specific changes → incorporate good ones, iterate
- **Questions** — Codex asks about ambiguities → answer in next iteration prompt

### Implementation Review

**Primary: JSON schema parsing.** Codex is prompted to output structured JSON:

```json
{
  "verdict": "APPROVED" | "CHANGES_NEEDED",
  "findings": [
    {
      "id": "F1",
      "category": "security" | "correctness" | "performance" | "style",
      "severity": "high" | "medium" | "low",
      "file": "src/auth.ts",
      "line": 45,
      "description": "What's wrong",
      "suggestion": "How to fix (optional)"
    }
  ],
  "summary": "Brief overall assessment"
}
```

**Blocking thresholds (applied by Claude after parsing):**

| Category | Weight | Blocking Rule | Rationale |
|----------|--------|---------------|-----------|
| **Security** | 0.45 | 1 HIGH finding blocks | Security issues have outsized blast radius |
| **Correctness** | 0.35 | 2 HIGH findings block | Logic errors need accumulation to warrant blocking |
| **Performance** | 0.15 | Advisory only | Performance is rarely a merge blocker |
| **Style** | 0.05 | Never blocks | Style is cosmetic; never gates a merge |

**Evidence enforcement:** If `file` or `line` is null/missing in a finding, Claude automatically downgrades it to advisory. No interpretation needed — it's a field check.

**Fallback: Prose parsing.** If Codex outputs natural language instead of JSON (it may ignore the schema instruction), Claude falls back to regex-based parsing: look for file:line patterns, keyword-match categories, detect APPROVED/CHANGES_NEEDED. Log a warning: "Codex did not output structured JSON — falling back to prose parsing." Prose mode is degraded but functional.

**Review Ledger integration:** After parsing (JSON or prose), Claude adds each finding to the Review Ledger at `/tmp/codex-review-ledger-<issue_num>.json`. The ledger is the source of truth for convergence, not Codex's verdict field. See Sub-Playbook: Codex Implementation Review → Review Ledger for schema and statuses.

## Temporary File Paths

### Collaborative Planning

- Collaborative output (Plan B): `/tmp/codex-collab-output-<issue_num>.txt`
- Collaborative events (Plan B): `/tmp/codex-collab-events-<issue_num>.jsonl`
- Collaborative stderr (Plan B): `/tmp/codex-collab-stderr-<issue_num>.txt`
- Iterative review output (per iteration): `/tmp/codex-collab-review-<issue_num>-<COLLAB_ITER>.txt`
- Iterative review events (per iteration): `/tmp/codex-collab-events-<issue_num>-<COLLAB_ITER>.jsonl`
- Iterative review stderr (per iteration): `/tmp/codex-collab-stderr-<issue_num>-<COLLAB_ITER>.txt`
- **Plan Ledger:** `/tmp/codex-plan-ledger-<issue_num>.json`
- Plan B file: `.codex-work/plan-<issue_num>-<PLAN_B_PREFIX>.md`

### Implementation Review

- Review output (per iteration): `/tmp/codex-impl-review-<issue_num>-<ITER>.txt`
- JSONL events (per iteration): `/tmp/codex-impl-events-<issue_num>-<ITER>.jsonl`
- Stderr (per iteration): `/tmp/codex-impl-stderr-<issue_num>-<ITER>.txt`
- **Review Ledger:** `/tmp/codex-review-ledger-<issue_num>.json`

## Session ID Capture (Implementation Review Only)

The first JSONL event from `--json` is always `thread.started`:

```json
{ "type": "thread.started", "thread_id": "019c6c7e-93ba-7422-8119-0f78d223b635" }
```

Extract with: `head -1 <events-file>.jsonl | jq -r '.thread_id'`

Store as `CODEX_SESSION_ID` and use for all `resume` calls in the implementation review loop. Collaborative planning uses fresh sessions (no session ID capture needed).

## Claude Self-Identification

When resuming Codex implementation review sessions, Claude MUST identify itself: "This is Claude (Anthropic)." This prevents confusion about which AI is speaking. Not needed for collaborative planning (fresh sessions with context in prompt).

## Error Handling

**Key principle:** On Codex failure, NEVER auto-skip. Surface the error and require explicit user choice. The `2>/dev/null` suppresses stderr only during normal operation — on non-zero exit, stderr is captured separately for the error display.

**Stderr capture pattern (collaborative planning):**

Stderr is captured to a file on the _original_ invocation — never via rerun. This prevents a write-capable rerun from mutating state.

```bash
# Stderr redirected to file in the original command (see Phase 1 Step 1):
#   2>/tmp/codex-collab-stderr-<num>.txt
# On failure, read it:
CODEX_STDERR=$(cat /tmp/codex-collab-stderr-<num>.txt)
```

**Stderr capture pattern (implementation review):**

Stderr is captured to a per-iteration file on every invocation (initial and resume). This replaces the previous `2>/dev/null` pattern that discarded error information.

```bash
# Initial review: stderr goes to /tmp/codex-impl-stderr-<num>-1.txt
# Resume: stderr goes to /tmp/codex-impl-stderr-<num>-2.txt, etc.
# On failure, read it:
CODEX_STDERR=$(cat /tmp/codex-impl-stderr-<num>-${ITER}.txt)
```

| Scenario                                                | Behavior                                                                                                  |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `codex --version` fails                                 | Set `codex_available = false`, skip loops with notice                                                     |
| Collaborative planning: `codex exec` non-zero exit      | Capture stderr. AskUserQuestion: Retry / Continue with Claude-only plan / Show error                      |
| Collaborative planning: 0-byte output or missing Plan B | Context exhaustion or write failure. AskUserQuestion: Retry / Continue with Claude-only plan / Show error |
| Implementation review: `codex exec` non-zero exit       | Capture stderr. AskUserQuestion: Retry / Override / Show full error                                       |
| Implementation review: Exit 0 but 0-byte output         | Context exhaustion. AskUserQuestion: Retry / Override                                                     |
| Implementation review: `resume <session_id>` fails      | Display error. AskUserQuestion: Start fresh session / Override                                            |
| Implementation review: Response unparseable             | Display raw output. AskUserQuestion: Continue / Override                                                  |

## MCP Server Configuration

Codex gets access to project MCP servers via runtime `-c` flag injection. The helper script `./tools/scripts/codex-mcp-overrides.sh` emits `-c` flags that are consumed by `codex exec` via command substitution.

### How It Works

```bash
# The script outputs -c flags to stdout, summary to stderr
codex exec $(./tools/scripts/codex-mcp-overrides.sh) --json -s read-only ...
```

The script checks for `codex` availability, then emits `-c mcp_servers.<name>=<config>` flags for each server. If `codex` is not found, the script exits 0 with empty stdout (the command substitution expands to nothing, and `codex exec` works without MCP).

### Injected Servers

The servers injected by `codex-mcp-overrides.sh` depend on your project's `.mcp.json` configuration. The script reads from `.mcp.json` and emits `-c` flags for each server that has its required auth credentials available.

Common patterns:

| Server Type            | Transport | Auth                              | Skip Condition             |
| ---------------------- | --------- | --------------------------------- | -------------------------- |
| Documentation (e.g., context7) | HTTP | None                           | Never skipped              |
| Framework tools        | stdio     | None                              | Never skipped              |
| Cloud services         | stdio     | Service-specific env vars         | Env vars missing           |

**Intentionally excluded from injection:** Servers already in Codex global config, servers needing a running local instance, and production servers (safety).

### Skip Behavior

Per no-fallback policy, every skip produces an explicit stderr message:

```
codex-mcp-overrides: skipping <server> (<ENV_VAR> not set)
codex-mcp-overrides: codex not found, no MCP overrides emitted
```

Stderr goes to the terminal (visible to Claude/user). Stdout contains only `-c` flags.

### Auth-Required Servers

For servers requiring credentials, ensure env vars are exported before running Codex:

```bash
# Export project environment variables
eval "$(make env-export)"  # or source your .env file
```

### MCP Is Optional

MCP server access is an enhancement — reviews work without it. If the overrides script outputs nothing (codex unavailable, or all servers skipped), the `codex exec` command runs normally without MCP.
