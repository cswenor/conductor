#!/usr/bin/env bash
# pm-stop-guard.sh — Stop hook that checks if work is incomplete.
#
# When Claude finishes a turn, this hook checks whether there's an active
# issue with incomplete work and reminds Claude to follow the post-implementation
# sequence. It does NOT block — it adds context so Claude knows what's left.
#
# Checks:
#   1. Is there an active issue? (from env var or worktree detection)
#   2. Is the issue in Active state? (work in progress, not yet Review)
#   3. Are there uncommitted changes? (code written but not committed)
#   4. Has a PR been created? (committed but PR not opened)
#   5. Has the issue been moved to Review? (PR exists but workflow not updated)
#
# Output: JSON with additionalContext reminding Claude of remaining steps.

set -euo pipefail

# ---------- helpers ----------

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
METADATA_FILE="$(cd "$SCRIPT_DIR/../.." && pwd)/.claude-pm-toolkit.json"

# ---------- detect issue ----------

ISSUE_NUM=""
PREFIX_LOWER=""

if [[ -f "$METADATA_FILE" ]]; then
  PREFIX_LOWER=$(jq -r '.prefix_lower // ""' "$METADATA_FILE" 2>/dev/null || echo "")
fi

# Try env var first
if [[ -n "$PREFIX_LOWER" ]]; then
  VAR_NAME="$(printf '%s' "$PREFIX_LOWER" | tr '[:lower:]' '[:upper:]')_ISSUE_NUM"
  ISSUE_NUM="${!VAR_NAME:-}"
fi

# Try worktree directory name
if [[ -z "$ISSUE_NUM" ]] && [[ -n "$PREFIX_LOWER" ]]; then
  BASENAME=$(basename "$(pwd)")
  if [[ "$BASENAME" =~ ^${PREFIX_LOWER}-([0-9]+)$ ]]; then
    ISSUE_NUM="${BASH_REMATCH[1]}"
  fi
fi

# Try git branch
if [[ -z "$ISSUE_NUM" ]] && command -v git &>/dev/null; then
  BRANCH=$(git branch --show-current 2>/dev/null || echo "")
  if [[ "$BRANCH" =~ [/-]([0-9]+) ]]; then
    MAYBE_NUM="${BASH_REMATCH[1]}"
    if [[ "$MAYBE_NUM" -gt 0 ]] && [[ "$MAYBE_NUM" -lt 10000 ]]; then
      ISSUE_NUM="$MAYBE_NUM"
    fi
  fi
fi

# No active issue detected → no reminder needed
[[ -z "$ISSUE_NUM" ]] && exit 0

# ---------- gather state ----------

REMINDERS=()

# Check 1: Uncommitted changes
if command -v git &>/dev/null; then
  DIRTY=$(git status --porcelain 2>/dev/null | head -5 || echo "")
  if [[ -n "$DIRTY" ]]; then
    FILE_COUNT=$(git status --porcelain 2>/dev/null | wc -l | tr -d ' ')
    REMINDERS+=("UNCOMMITTED: ${FILE_COUNT} file(s) with uncommitted changes")
  fi
fi

# Check 2: Committed but not pushed
if command -v git &>/dev/null; then
  BRANCH=$(git branch --show-current 2>/dev/null || echo "")
  if [[ -n "$BRANCH" ]]; then
    UNPUSHED=$(git log "origin/${BRANCH}..HEAD" --oneline 2>/dev/null | wc -l | tr -d ' ' || echo "0")
    if [[ "$UNPUSHED" -gt 0 ]]; then
      REMINDERS+=("UNPUSHED: ${UNPUSHED} commit(s) not pushed to remote")
    fi
  fi
fi

# Check 3: Issue workflow state (fast — uses local event stream if available)
REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null || echo "")
if [[ -n "$REPO_ROOT" ]] && [[ -f "$REPO_ROOT/.claude/memory/events.jsonl" ]]; then
  # Get the last state_change event for this issue
  LAST_STATE=$(tail -50 "$REPO_ROOT/.claude/memory/events.jsonl" 2>/dev/null | \
    jq -r "select(.event == \"state_change\" and .issue_number == ${ISSUE_NUM}) | .to_state" 2>/dev/null | \
    tail -1 || echo "")

  if [[ "$LAST_STATE" == "Active" ]]; then
    REMINDERS+=("WORKFLOW: Issue #${ISSUE_NUM} is still in Active (not yet moved to Review)")
  fi
fi

# Check 4: No PR exists (check via gh if available, non-blocking)
if command -v gh &>/dev/null && [[ -n "$BRANCH" ]] && [[ "$BRANCH" != "main" ]] && [[ "$BRANCH" != "master" ]]; then
  PR_COUNT=$(gh pr list --head "$BRANCH" --json number --jq length 2>/dev/null || echo "")
  if [[ "$PR_COUNT" == "0" ]]; then
    REMINDERS+=("NO PR: No pull request found for branch '${BRANCH}'")
  fi
fi

# ---------- output reminder if needed ----------

if [[ ${#REMINDERS[@]} -gt 0 ]]; then
  REMINDER_TEXT="Issue #${ISSUE_NUM} — Incomplete work detected:"
  for r in "${REMINDERS[@]}"; do
    REMINDER_TEXT="${REMINDER_TEXT}
  - ${r}"
  done
  REMINDER_TEXT="${REMINDER_TEXT}
Post-implementation checklist: commit → tests → PR → review transition
Tip: Run mcp__pm_intelligence__record_outcome() to record this session's work for future learning."

  jq -n --arg ctx "$REMINDER_TEXT" \
    '{"stopReason":$ctx}'
fi

exit 0
