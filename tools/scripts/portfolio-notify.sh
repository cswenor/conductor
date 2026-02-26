#!/usr/bin/env bash
set -euo pipefail

# portfolio-notify.sh - Hook-driven notification handler for portfolio manager
#
# Called by Claude Code hooks to update issue status and send alerts.
# This script is a NO-OP when <PREFIX>_ISSUE_NUM is not set (i.e., when running
# outside of a portfolio-managed tmux window).
#
# Usage: portfolio-notify.sh <event-type>
#
# Event types:
#   needs-input       - Claude asked user a question (PreToolUse:AskUserQuestion)
#   needs-permission  - Claude needs permission (Notification:permission_prompt)
#   running           - User responded, Claude working again (PostToolUse:AskUserQuestion)
#   idle              - Claude finished responding (Stop hook)
#   complete          - Issue work done (manual / SessionEnd)
#
# Environment:
#   <PREFIX>_ISSUE_NUM - Issue number (set by tmux-session.sh when creating window)
#   TMUX_PANE          - tmux pane identifier (set by tmux automatically)
#
# The script ONLY acts when <PREFIX>_ISSUE_NUM is set. This env var is set by
# tmux-session.sh when creating a portfolio window. No fallbacks — if the
# var isn't set, this is not a portfolio session and we exit silently.

# --- Resolve prefix from config ---

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

_resolve_prefix() {
  local search_dir="$SCRIPT_DIR"
  while [ "$search_dir" != "/" ]; do
    if [ -f "$search_dir/.claude-pm-toolkit.json" ]; then
      local val
      val=$(jq -r '.prefix_lower // empty' "$search_dir/.claude-pm-toolkit.json" 2>/dev/null)
      if [ -n "$val" ]; then
        echo "$val"
        return
      fi
    fi
    search_dir="$(dirname "$search_dir")"
  done
  echo "wt"  # fallback if no config found
}

PREFIX=$(_resolve_prefix)
PREFIX_UPPER=$(echo "$PREFIX" | tr '[:lower:]' '[:upper:]')

# --- Guard: no-op outside portfolio sessions ---

# Use bash indirect expansion to read ${PREFIX_UPPER}_ISSUE_NUM
_issue_var="${PREFIX_UPPER}_ISSUE_NUM"
ISSUE_NUM="${!_issue_var:-}"

# If <PREFIX>_ISSUE_NUM is not set, this is not a portfolio-managed session — silent no-op
if [ -z "$ISSUE_NUM" ]; then
  exit 0
fi

EVENT_TYPE="${1:-}"

if [ -z "$EVENT_TYPE" ]; then
  echo "Usage: portfolio-notify.sh <event-type>" >&2
  echo "Event types: needs-input | needs-permission | running | idle | complete" >&2
  exit 1
fi

# --- State directory ---

STATE_DIR="$HOME/.$PREFIX/portfolio/$ISSUE_NUM"

# If state directory doesn't exist, this issue isn't portfolio-managed — no-op
if [ ! -d "$STATE_DIR" ]; then
  exit 0
fi

# --- Update status ---

echo "$EVENT_TYPE" > "$STATE_DIR/status"
date -u +"%Y-%m-%dT%H:%M:%SZ" > "$STATE_DIR/last-event"

# --- Event stream logging (best-effort, non-blocking) ---

if [ -x "$SCRIPT_DIR/pm-event-log.sh" ]; then
  "$SCRIPT_DIR/pm-event-log.sh" "$EVENT_TYPE" --issue "$ISSUE_NUM" 2>/dev/null &
fi

# --- Send alerts for attention-requiring events ---

case "$EVENT_TYPE" in
  needs-input|needs-permission)
    # Ring tmux bell on the issue's pane to trigger window alert flag
    if [ -n "${TMUX_PANE:-}" ]; then
      # Set the bell flag directly on the target pane's window
      tmux set-option -t "$TMUX_PANE" -w monitor-bell on 2>/dev/null || true
      # Send BEL character to trigger the bell
      printf '\a' 2>/dev/null || true
    fi

    # Desktop notification (optional, non-blocking)
    LABEL="needs input"
    if [ "$EVENT_TYPE" = "needs-permission" ]; then
      LABEL="needs permission"
    fi

    if command -v osascript &>/dev/null; then
      # macOS
      osascript -e "display notification \"Issue #$ISSUE_NUM $LABEL\" with title \"Claude Code\" sound name \"Blow\"" 2>/dev/null &
    elif command -v notify-send &>/dev/null; then
      # Linux (libnotify / GNOME / KDE)
      notify-send -u normal -a "Claude Code" "Claude Code" "Issue #$ISSUE_NUM $LABEL" 2>/dev/null &
    fi
    ;;

  running|idle|complete)
    # Passive status update only — no alert
    ;;

  *)
    echo "Unknown event type: $EVENT_TYPE" >&2
    exit 1
    ;;
esac
