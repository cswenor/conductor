#!/usr/bin/env bash
set -euo pipefail

# pm-event-log.sh — Structured event logging for PM toolkit hooks
#
# Appends JSON events to .claude/memory/events.jsonl for analytics,
# replay, and debugging. Each event captures: timestamp, event type,
# issue context, session ID, and optional metadata.
#
# Usage:
#   pm-event-log.sh <event-type> [--issue NUM] [--session ID] [--tool NAME] [--data JSON]
#
# Called automatically by hooks. Can also be called directly for custom events.
#
# Event types:
#   session_start     SessionStart hook fired
#   session_end       Stop hook fired (no more turns)
#   tool_use          Tool was used (captured from PostToolUse)
#   needs_input       AskUserQuestion triggered
#   needs_permission  Permission prompt triggered
#   state_change      Issue workflow state changed
#   decision          Decision recorded
#   outcome           Outcome recorded
#   error             Error occurred in a hook or script
#
# The event log is git-tracked (shared knowledge) and append-only.
# Board cache is NOT logged here (it has its own file).

show_help() {
  cat <<'HELPEOF'
pm-event-log.sh — Structured event logging for PM toolkit

USAGE
  pm-event-log.sh <event-type> [options]

EVENT TYPES
  session_start, session_end, tool_use, needs_input,
  needs_permission, state_change, decision, outcome, error

OPTIONS
  --issue NUM       Issue number (from env or explicit)
  --session ID      Session ID
  --tool NAME       Tool name (for tool_use events)
  --from STATE      Previous state (for state_change)
  --to STATE        New state (for state_change)
  --data JSON       Arbitrary JSON metadata
  --message TEXT    Human-readable message

EXAMPLES
  pm-event-log.sh session_start --issue 42
  pm-event-log.sh tool_use --tool Bash --issue 42
  pm-event-log.sh state_change --issue 42 --from Active --to Review
  pm-event-log.sh error --message "Rebase failed" --issue 42
HELPEOF
}

[[ "${1:-}" == "--help" || "${1:-}" == "-h" ]] && { show_help; exit 0; }
[[ $# -lt 1 ]] && { show_help; exit 1; }

EVENT_TYPE="$1"
shift

# --- Parse options ---

ISSUE_NUM=""
SESSION_ID=""
TOOL_NAME=""
FROM_STATE=""
TO_STATE=""
DATA_JSON=""
MESSAGE=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --issue) ISSUE_NUM="$2"; shift 2 ;;
    --session) SESSION_ID="$2"; shift 2 ;;
    --tool) TOOL_NAME="$2"; shift 2 ;;
    --from) FROM_STATE="$2"; shift 2 ;;
    --to) TO_STATE="$2"; shift 2 ;;
    --data) DATA_JSON="$2"; shift 2 ;;
    --message) MESSAGE="$2"; shift 2 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

# --- Auto-detect context ---

# Issue from environment (portfolio session)
if [[ -z "$ISSUE_NUM" ]]; then
  # Try common prefix patterns
  for var_name in HOV_ISSUE_NUM MP_ISSUE_NUM; do
    val="${!var_name:-}"
    if [[ -n "$val" ]]; then
      ISSUE_NUM="$val"
      break
    fi
  done
fi

# Worktree-based detection
if [[ -z "$ISSUE_NUM" ]]; then
  CURRENT_DIR=$(pwd)
  DIRNAME=$(basename "$CURRENT_DIR")
  if [[ "$DIRNAME" =~ ^[a-z]+-([0-9]+)$ ]]; then
    ISSUE_NUM="${BASH_REMATCH[1]}"
  fi
fi

# Session ID from environment
if [[ -z "$SESSION_ID" ]]; then
  SESSION_ID="${CLAUDE_SESSION_ID:-}"
fi

# --- Find repo root and write ---

REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null || echo "")
if [[ -z "$REPO_ROOT" ]]; then
  # Not in a git repo — silently skip (hook safety)
  exit 0
fi

MEMORY_DIR="$REPO_ROOT/.claude/memory"
mkdir -p "$MEMORY_DIR"

TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

# Build the JSON event using jq
jq -cn \
  --arg ts "$TIMESTAMP" \
  --arg event "$EVENT_TYPE" \
  --argjson issue "${ISSUE_NUM:-null}" \
  --arg session "$SESSION_ID" \
  --arg tool "$TOOL_NAME" \
  --arg from "$FROM_STATE" \
  --arg to "$TO_STATE" \
  --arg msg "$MESSAGE" \
  --argjson data "${DATA_JSON:-null}" \
  '{
    timestamp: $ts,
    event: $event,
    issue_number: (if $issue then $issue else null end),
    session_id: (if $session != "" then $session else null end),
    tool: (if $tool != "" then $tool else null end),
    from_state: (if $from != "" then $from else null end),
    to_state: (if $to != "" then $to else null end),
    message: (if $msg != "" then $msg else null end),
    data: $data
  } | with_entries(select(.value != null))' >> "$MEMORY_DIR/events.jsonl"
