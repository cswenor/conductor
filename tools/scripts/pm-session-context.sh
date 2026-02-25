#!/usr/bin/env bash
set -euo pipefail

# pm-session-context.sh — SessionStart hook for claude-pm-toolkit
#
# Injects relevant project context at the start of every Claude Code session.
# Returns additionalContext with: worktree info, active issue context,
# recent decisions, recent outcomes, and project board summary.
#
# This hook is fast (<2s) — uses only local data, no API calls.

show_help() {
  cat <<'HELPEOF'
pm-session-context.sh — SessionStart hook for claude-pm-toolkit

USAGE (called automatically by Claude Code SessionStart hook)
  echo '{"source":"startup","cwd":"/path/to/repo"}' | pm-session-context.sh

OUTPUT
  JSON with hookSpecificOutput.additionalContext for Claude's context.

WHAT IT LOADS
  1. Current worktree/issue detection
  2. Project board summary from last cached state
  3. Recent decisions from .claude/memory/decisions.jsonl
  4. Recent outcomes from .claude/memory/outcomes.jsonl
  5. Active issue context (if in a worktree)

ENVIRONMENT
  HOV_ISSUE_NUM    If set, used as current issue number
  CLAUDE_ENV_FILE  If set, exports HOV_ISSUE_NUM for the session

HELPEOF
}

for arg in "$@"; do
  case "$arg" in
    --help|-h) show_help; exit 0 ;;
  esac
done

# Read stdin (SessionStart hook input)
INPUT=$(cat 2>/dev/null || echo '{}')
CWD=$(echo "$INPUT" | jq -r '.cwd // empty' 2>/dev/null || echo "")
SOURCE=$(echo "$INPUT" | jq -r '.source // "startup"' 2>/dev/null || echo "startup")

# Use CWD from hook input, fall back to pwd
REPO_ROOT="${CWD:-$(pwd)}"

# Resolve to git root if possible
if command -v git &>/dev/null; then
  GIT_ROOT=$(cd "$REPO_ROOT" && git rev-parse --show-toplevel 2>/dev/null || echo "")
  [[ -n "$GIT_ROOT" ]] && REPO_ROOT="$GIT_ROOT"
fi

MEMORY_DIR="$REPO_ROOT/.claude/memory"
DECISIONS_FILE="$MEMORY_DIR/decisions.jsonl"
OUTCOMES_FILE="$MEMORY_DIR/outcomes.jsonl"
METADATA_FILE="$REPO_ROOT/.claude-pm-toolkit.json"

# ---------------------------------------------------------------------------
# 1. Detect worktree and issue context
# ---------------------------------------------------------------------------
ISSUE_NUM="${HOV_ISSUE_NUM:-}"
WORKTREE_INFO=""
PREFIX_LOWER=""

if [[ -f "$METADATA_FILE" ]]; then
  PREFIX_LOWER=$(jq -r '.prefix_lower // ""' "$METADATA_FILE" 2>/dev/null || echo "")
fi

# Try to detect issue from worktree directory name (e.g., hov-42, mp-123)
if [[ -z "$ISSUE_NUM" ]] && [[ -n "$PREFIX_LOWER" ]]; then
  BASENAME=$(basename "$REPO_ROOT")
  if [[ "$BASENAME" =~ ^${PREFIX_LOWER}-([0-9]+)$ ]]; then
    ISSUE_NUM="${BASH_REMATCH[1]}"
    WORKTREE_INFO="In worktree for issue #$ISSUE_NUM ($BASENAME)"
  fi
fi

# Try git worktree branch detection
if [[ -z "$ISSUE_NUM" ]] && command -v git &>/dev/null; then
  BRANCH=$(cd "$REPO_ROOT" && git branch --show-current 2>/dev/null || echo "")
  if [[ "$BRANCH" =~ [/-]([0-9]+) ]]; then
    # Only use if it looks like an issue number (1-9999)
    MAYBE_NUM="${BASH_REMATCH[1]}"
    if [[ "$MAYBE_NUM" -gt 0 ]] && [[ "$MAYBE_NUM" -lt 10000 ]]; then
      ISSUE_NUM="$MAYBE_NUM"
      [[ -z "$WORKTREE_INFO" ]] && WORKTREE_INFO="On branch $BRANCH (issue #$ISSUE_NUM)"
    fi
  fi
fi

# Export issue number for the session if detected
if [[ -n "$ISSUE_NUM" ]] && [[ -n "${CLAUDE_ENV_FILE:-}" ]]; then
  echo "export ${PREFIX_LOWER^^}_ISSUE_NUM=$ISSUE_NUM" >> "$CLAUDE_ENV_FILE"
fi

# ---------------------------------------------------------------------------
# 2. Read recent decisions (last 5)
# ---------------------------------------------------------------------------
DECISIONS_CONTEXT=""
if [[ -f "$DECISIONS_FILE" ]]; then
  # If we have an issue number, filter for that issue's area or number
  if [[ -n "$ISSUE_NUM" ]]; then
    RECENT_DECISIONS=$(tail -20 "$DECISIONS_FILE" | jq -rs "
      [.[] | select(.issue_number == $ISSUE_NUM or .area != null)]
      | sort_by(.timestamp) | reverse | .[0:5]
      | .[] | \"- [\(.area // \"general\")] \(.decision) (issue #\(.issue_number))\"
    " 2>/dev/null || echo "")
  else
    RECENT_DECISIONS=$(tail -10 "$DECISIONS_FILE" | jq -rs '
      sort_by(.timestamp) | reverse | .[0:5]
      | .[] | "- [\(.area // "general")] \(.decision) (issue #\(.issue_number))"
    ' 2>/dev/null || echo "")
  fi

  if [[ -n "$RECENT_DECISIONS" ]]; then
    DECISIONS_CONTEXT="
Recent decisions:
$RECENT_DECISIONS"
  fi
fi

# ---------------------------------------------------------------------------
# 3. Read recent outcomes (last 5)
# ---------------------------------------------------------------------------
OUTCOMES_CONTEXT=""
if [[ -f "$OUTCOMES_FILE" ]]; then
  RECENT_OUTCOMES=$(tail -10 "$OUTCOMES_FILE" | jq -rs '
    sort_by(.timestamp) | reverse | .[0:5]
    | .[] | "- #\(.issue_number) [\(.result)] \(.approach_summary // "no summary")\(if .rework_reasons and (.rework_reasons | length > 0) then " (rework: \(.rework_reasons | join(", ")))" else "" end)"
  ' 2>/dev/null || echo "")

  if [[ -n "$RECENT_OUTCOMES" ]]; then
    OUTCOMES_CONTEXT="
Recent outcomes:
$RECENT_OUTCOMES"
  fi
fi

# ---------------------------------------------------------------------------
# 4. Read cached board state (from pm board --json or manual cache)
# ---------------------------------------------------------------------------
BOARD_CONTEXT=""
BOARD_CACHE="$MEMORY_DIR/board-cache.json"
if [[ -f "$BOARD_CACHE" ]]; then
  # Only use if cache is less than 1 hour old
  CACHE_AGE=0
  if [[ "$(uname)" == "Darwin" ]]; then
    CACHE_MOD=$(stat -f %m "$BOARD_CACHE" 2>/dev/null || echo "0")
  else
    CACHE_MOD=$(stat -c %Y "$BOARD_CACHE" 2>/dev/null || echo "0")
  fi
  NOW=$(date +%s)
  CACHE_AGE=$((NOW - CACHE_MOD))

  if [[ $CACHE_AGE -lt 3600 ]]; then
    BOARD_SUMMARY=$(jq -r '
      "Board: " +
      (if .active then (.active | tostring) + " active" else "" end) + ", " +
      (if .review then (.review | tostring) + " in review" else "" end) + ", " +
      (if .rework then (.rework | tostring) + " rework" else "" end) + ", " +
      (if .done then (.done | tostring) + " done" else "" end)
    ' "$BOARD_CACHE" 2>/dev/null || echo "")

    if [[ -n "$BOARD_SUMMARY" ]]; then
      BOARD_CONTEXT="
$BOARD_SUMMARY"
    fi
  fi
fi

# ---------------------------------------------------------------------------
# 5. Build context string
# ---------------------------------------------------------------------------
CONTEXT_PARTS=""

# Project identity
if [[ -f "$METADATA_FILE" ]]; then
  DISPLAY_NAME=$(jq -r '.display_name // "unknown"' "$METADATA_FILE" 2>/dev/null || echo "")
  OWNER=$(jq -r '.owner // "unknown"' "$METADATA_FILE" 2>/dev/null || echo "")
  [[ -n "$DISPLAY_NAME" ]] && CONTEXT_PARTS="Project: $DISPLAY_NAME ($OWNER)"
fi

# PM Intelligence recommendation
if [[ -n "$ISSUE_NUM" ]]; then
  INTEL_HINT="
Tip: Run mcp__pm_intelligence__recover_context({ issueNumber: $ISSUE_NUM }) to reload full context for issue #$ISSUE_NUM."
else
  INTEL_HINT="
Tip: Run /start for a session briefing with risk radar and recommended work, or mcp__pm_intelligence__optimize_session() to plan this session."
fi
CONTEXT_PARTS="${CONTEXT_PARTS:+$CONTEXT_PARTS
}$INTEL_HINT"

# Worktree context
if [[ -n "$WORKTREE_INFO" ]]; then
  CONTEXT_PARTS="${CONTEXT_PARTS:+$CONTEXT_PARTS
}$WORKTREE_INFO"
fi

# Board state
if [[ -n "$BOARD_CONTEXT" ]]; then
  CONTEXT_PARTS="${CONTEXT_PARTS:+$CONTEXT_PARTS
}$BOARD_CONTEXT"
fi

# Decisions
if [[ -n "$DECISIONS_CONTEXT" ]]; then
  CONTEXT_PARTS="${CONTEXT_PARTS:+$CONTEXT_PARTS
}$DECISIONS_CONTEXT"
fi

# Outcomes
if [[ -n "$OUTCOMES_CONTEXT" ]]; then
  CONTEXT_PARTS="${CONTEXT_PARTS:+$CONTEXT_PARTS
}$OUTCOMES_CONTEXT"
fi

# ---------------------------------------------------------------------------
# 6. Log session start event (best-effort, non-blocking)
# ---------------------------------------------------------------------------
if [[ -x "$SCRIPT_DIR/pm-event-log.sh" ]]; then
  "$SCRIPT_DIR/pm-event-log.sh" session_start \
    ${ISSUE_NUM:+--issue "$ISSUE_NUM"} \
    --data "{\"source\":\"$SOURCE\"}" 2>/dev/null &
fi

# ---------------------------------------------------------------------------
# 7. Output JSON with additionalContext
# ---------------------------------------------------------------------------
if [[ -n "$CONTEXT_PARTS" ]]; then
  jq -n \
    --arg ctx "$CONTEXT_PARTS" \
    '{
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: $ctx
      }
    }'
fi

exit 0
