#!/usr/bin/env bash
set -euo pipefail

# tmux-session.sh - Portfolio orchestrator for parallel Claude Code development
#
# Manages tmux windows for parallel issue work. Each issue gets its own tmux
# window with an isolated Claude Code session, worktree, and port offsets.
#
# Usage:
#   tmux-session.sh init-and-run            # Entry point: ensure session + start Claude (used by make claude)
#   tmux-session.sh init                    # Initialize portfolio session only
#   tmux-session.sh start <num> [branch]    # Start working on an issue
#   tmux-session.sh list                    # Show all tracked issues
#   tmux-session.sh focus <num>             # Switch to an issue's window
#   tmux-session.sh stop <num>              # Stop an issue worker
#   tmux-session.sh stop-all                # Stop all workers
#   tmux-session.sh status [num]            # Show detailed status
#
# State directory: ~/.$PREFIX/portfolio/<num>/
#   status      - "starting" | "running" | "needs-input" | "idle" | "complete" | "crashed"
#   tmux-target - "$PREFIX:$PREFIX-<num>"
#   worktree    - absolute path to worktree
#   pid         - Claude process PID (best-effort)
#   started     - ISO timestamp
#   last-event  - ISO timestamp of last hook event

# --- Constants ---

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Resolve prefix from config (supports both source repo and installed repos)
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

SESSION_NAME="$PREFIX"
PORTFOLIO_DIR="$HOME/.$PREFIX/portfolio"

# --- Helpers ---

die() {
  echo "ERROR: $*" >&2
  exit 1
}

require_tmux() {
  if ! command -v tmux &>/dev/null; then
    echo "tmux is not installed — it's the only dependency for parallel Claude sessions." >&2
    echo "" >&2
    echo "  brew install tmux" >&2
    echo "" >&2
    echo "Then retry: make claude" >&2
    exit 1
  fi
}

require_session() {
  tmux has-session -t "$SESSION_NAME" 2>/dev/null || die "Portfolio session '$SESSION_NAME' not found. Run: tmux-session.sh init"
}

require_issue_num() {
  local num="$1"
  [[ "$num" =~ ^[0-9]+$ ]] || die "Invalid issue number: '$num'. Must be a positive integer."
}

# Format seconds into human-readable age
format_age() {
  local seconds=$1
  if [ "$seconds" -lt 60 ]; then
    echo "${seconds}s ago"
  elif [ "$seconds" -lt 3600 ]; then
    echo "$(( seconds / 60 ))m ago"
  elif [ "$seconds" -lt 86400 ]; then
    echo "$(( seconds / 3600 ))h ago"
  else
    echo "$(( seconds / 86400 ))d ago"
  fi
}

# Get seconds since an ISO timestamp
seconds_since() {
  local ts="$1"
  local now
  now=$(date -u +%s)
  # macOS date -j -f for parsing ISO timestamps
  local past_ts
  if [[ "$OSTYPE" == "darwin"* ]]; then
    past_ts=$(date -j -f "%Y-%m-%dT%H:%M:%SZ" "$ts" +%s 2>/dev/null || echo "$now")
  else
    past_ts=$(date -d "$ts" +%s 2>/dev/null || echo "$now")
  fi
  echo $(( now - past_ts ))
}

# --- Shared helpers ---

apply_tmux_config() {
  # Bell monitoring for input detection
  tmux set-option -t "$SESSION_NAME" -g bell-action any 2>/dev/null || true
  tmux set-option -t "$SESSION_NAME" -g visual-bell off 2>/dev/null || true
  tmux set-option -t "$SESSION_NAME" -gw monitor-bell on 2>/dev/null || true

  # Status bar formatting
  tmux set-option -t "$SESSION_NAME" -g status-right "#{?client_prefix,#[reverse] PREFIX #[noreverse] ,} %H:%M" 2>/dev/null || true
  tmux set-option -t "$SESSION_NAME" -g window-status-bell-style "bg=red,fg=white,bold" 2>/dev/null || true
  tmux set-option -t "$SESSION_NAME" -g window-status-format " #W " 2>/dev/null || true
  tmux set-option -t "$SESSION_NAME" -g window-status-current-format " #W " 2>/dev/null || true

  # Key bindings for portfolio discovery
  # Prefix + L = list all issues  |  Prefix + M = jump to main window
  local script_path
  script_path="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/tmux-session.sh"
  tmux bind-key -T prefix L run-shell "$script_path list" 2>/dev/null || true
  tmux bind-key -T prefix M select-window -t "$SESSION_NAME:main" 2>/dev/null || true
}

# --- Subcommands ---

cmd_init_and_run() {
  # Entry point for `make claude`. Idempotent. Always leaves you in main Claude.
  #
  # If not in tmux:
  #   - create session if needed, start claude in main window, attach
  # If in tmux:
  #   - apply config, rename window to main, start claude if not running

  require_tmux
  mkdir -p "$PORTFOLIO_DIR"

  if [ -z "${TMUX:-}" ]; then
    # Not inside tmux
    if tmux has-session -t "$SESSION_NAME" 2>/dev/null; then
      # Session exists — attach to it
      exec tmux attach -t "$SESSION_NAME"
    fi

    # Create session with claude running in main window
    # Use the repo root so claude starts in the right place
    local repo_root
    repo_root=$(git rev-parse --show-toplevel 2>/dev/null || pwd)

    tmux new-session -d -s "$SESSION_NAME" -n "main" -c "$repo_root"
    apply_tmux_config
    # Welcome banner (visible in scrollback before Claude starts)
    tmux send-keys -t "$SESSION_NAME:main" \
      "echo '  Prefix+L = list issues  |  Prefix+M = main window  |  ! = needs input' && claude" C-m
    exec tmux attach -t "$SESSION_NAME"
  else
    # Already inside tmux — rename session first so config targets the right name
    local current_session
    current_session=$(tmux display-message -p '#S')
    if [ "$current_session" != "$SESSION_NAME" ]; then
      # If a "$PREFIX" session already exists, switch to it instead of renaming
      if tmux has-session -t "$SESSION_NAME" 2>/dev/null; then
        echo "Portfolio session '$SESSION_NAME' already exists. Switching..."
        exec tmux switch-client -t "$SESSION_NAME"
      fi
      tmux rename-session "$SESSION_NAME"
    fi

    # Rename current window to main
    tmux rename-window "main" 2>/dev/null || true

    # Apply config AFTER rename so it targets session "$PREFIX"
    apply_tmux_config

    # Check if claude is already running in this pane
    # Look for a claude process whose parent is the current shell
    local pane_pid
    pane_pid=$(tmux display-message -p '#{pane_pid}')
    if ! pgrep -P "$pane_pid" -f "claude" &>/dev/null; then
      echo "Starting Claude..."
      exec claude
    else
      echo "Claude is already running in this window."
    fi
  fi
}

cmd_init() {
  require_tmux

  # Create state directory
  mkdir -p "$PORTFOLIO_DIR"

  if [ -n "${TMUX:-}" ]; then
    # Already inside tmux — rename current window to "main"
    tmux rename-window "main"
    # Get session name and rename if needed
    local current_session
    current_session=$(tmux display-message -p '#S')
    if [ "$current_session" != "$SESSION_NAME" ]; then
      tmux rename-session "$SESSION_NAME"
    fi
  else
    # Not in tmux — create a new session
    if tmux has-session -t "$SESSION_NAME" 2>/dev/null; then
      echo "Session '$SESSION_NAME' already exists."
      echo "Attach with: tmux attach -t $SESSION_NAME"
      exit 0
    fi
    tmux new-session -d -s "$SESSION_NAME" -n "main"
    echo "Created tmux session '$SESSION_NAME'."
    echo "Attach with: tmux attach -t $SESSION_NAME"
  fi

  apply_tmux_config
  echo "Portfolio initialized. State directory: $PORTFOLIO_DIR"
}

cmd_start() {
  local issue_num="${1:-}"
  local branch="${2:-}"

  if [ -z "$issue_num" ]; then
    die "Usage: tmux-session.sh start <issue-number> [branch-name]"
  fi
  require_issue_num "$issue_num"

  require_tmux
  require_session

  local window_name="$PREFIX-$issue_num"
  local state_dir="$PORTFOLIO_DIR/$issue_num"

  # Check if window already exists
  if tmux list-windows -t "$SESSION_NAME" -F '#W' 2>/dev/null | grep -qx "$window_name"; then
    echo "Window '$window_name' already exists."
    echo "Focus with: tmux-session.sh focus $issue_num"
    exit 0
  fi

  # Determine repo root (works from any worktree)
  if ! git rev-parse --git-dir &>/dev/null; then
    die "Not in a git repository. Run from your project directory."
  fi
  local repo_root
  repo_root=$(git rev-parse --git-common-dir | xargs dirname)
  repo_root=$(realpath "$repo_root")

  # Determine worktree path
  local worktree_path
  worktree_path="$(cd "$repo_root/.." && pwd)/$PREFIX-$issue_num"

  # Create worktree if it doesn't exist (only if branch provided)
  if [ ! -d "$worktree_path" ]; then
    if [ -n "$branch" ]; then
      echo "Creating worktree for issue #$issue_num..."
      "$SCRIPT_DIR/worktree-setup.sh" "$issue_num" "$branch"
    else
      # Check if worktree exists in git's list but directory is missing
      if git worktree list --porcelain | grep -q "worktree $worktree_path"; then
        echo "Worktree metadata exists but directory missing. Pruning..."
        git worktree prune
      fi
      die "No worktree at $worktree_path. Provide a branch name to create one: tmux-session.sh start $issue_num <branch>"
    fi
  fi

  # Create state directory
  mkdir -p "$state_dir"

  # Write initial state
  echo "starting" > "$state_dir/status"
  echo "$SESSION_NAME:$window_name" > "$state_dir/tmux-target"
  echo "$worktree_path" > "$state_dir/worktree"
  date -u +"%Y-%m-%dT%H:%M:%SZ" > "$state_dir/started"
  date -u +"%Y-%m-%dT%H:%M:%SZ" > "$state_dir/last-event"

  # Create tmux window with environment and start Claude
  # The window:
  #   1. Sets ${PREFIX_UPPER}_ISSUE_NUM so hooks can identify the issue
  #   2. Changes to the worktree directory
  #   3. Evals port isolation exports
  #   4. Starts claude interactively
  tmux new-window -t "$SESSION_NAME" -n "$window_name" \
    "export ${PREFIX_UPPER}_ISSUE_NUM='${issue_num}'; cd '${worktree_path}' && eval \"\$(./tools/scripts/worktree-setup.sh '${issue_num}' --print-env)\" && claude; echo 'Claude exited. Press enter to close.'; read"

  # Best-effort PID capture (the shell running in tmux)
  # We write "pending" and let the first hook event confirm it's alive
  echo "pending" > "$state_dir/pid"

  echo "Issue #$issue_num started in window '$window_name'."
  echo "Watch your tmux status bar for '!' when it needs input."
  echo "Switch with: Ctrl-b + <window-number> or tmux-session.sh focus $issue_num"
}

cmd_list() {
  require_tmux

  if [ ! -d "$PORTFOLIO_DIR" ]; then
    echo "No portfolio state. Run: tmux-session.sh init"
    exit 0
  fi

  # Check if any issues exist
  local has_issues=false
  for dir in "$PORTFOLIO_DIR"/*/; do
    if [ -d "$dir" ]; then
      has_issues=true
      break
    fi
  done

  if [ "$has_issues" = false ]; then
    echo "No issues tracked. Start one with: tmux-session.sh start <num> <branch>"
    exit 0
  fi

  # Header
  printf "%-7s %-16s %-35s %s\n" "ISSUE" "STATUS" "BRANCH" "AGE"
  printf "%-7s %-16s %-35s %s\n" "-----" "------" "------" "---"

  for dir in "$PORTFOLIO_DIR"/*/; do
    [ -d "$dir" ] || continue

    local num
    num=$(basename "$dir")
    local status="unknown"
    local branch="?"
    local age="?"

    # Read status
    if [ -f "$dir/status" ]; then
      status=$(cat "$dir/status")
    fi

    # Check if tmux window still exists
    local window_name="$PREFIX-$num"
    if ! tmux list-windows -t "$SESSION_NAME" -F '#W' 2>/dev/null | grep -qx "$window_name"; then
      # Window gone — check if it was intentional
      if [ "$status" != "complete" ]; then
        status="crashed"
        echo "crashed" > "$dir/status"
      fi
    fi

    # Get branch from worktree
    if [ -f "$dir/worktree" ]; then
      local wt_path
      wt_path=$(cat "$dir/worktree")
      if [ -d "$wt_path" ]; then
        branch=$(git -C "$wt_path" rev-parse --abbrev-ref HEAD 2>/dev/null || echo "?")
      fi
    fi

    # Calculate age
    if [ -f "$dir/started" ]; then
      local started_ts
      started_ts=$(cat "$dir/started")
      local secs
      secs=$(seconds_since "$started_ts")
      age=$(format_age "$secs")
    fi

    printf "#%-6s %-16s %-35s %s\n" "$num" "$status" "$branch" "$age"
  done
}

cmd_focus() {
  local issue_num="${1:-}"

  if [ -z "$issue_num" ]; then
    die "Usage: tmux-session.sh focus <issue-number>"
  fi
  require_issue_num "$issue_num"

  require_tmux
  require_session

  local window_name="$PREFIX-$issue_num"

  if ! tmux list-windows -t "$SESSION_NAME" -F '#W' 2>/dev/null | grep -qx "$window_name"; then
    die "No window '$window_name' found. Is issue #$issue_num running?"
  fi

  tmux select-window -t "$SESSION_NAME:$window_name"
}

cmd_stop() {
  local issue_num="${1:-}"

  if [ -z "$issue_num" ]; then
    die "Usage: tmux-session.sh stop <issue-number>"
  fi
  require_issue_num "$issue_num"

  require_tmux

  local window_name="$PREFIX-$issue_num"
  local state_dir="$PORTFOLIO_DIR/$issue_num"

  # Send Ctrl-C to Claude, wait briefly, then kill the window
  if tmux list-windows -t "$SESSION_NAME" -F '#W' 2>/dev/null | grep -qx "$window_name"; then
    echo "Stopping issue #$issue_num..."
    # Send Ctrl-C to interrupt Claude
    tmux send-keys -t "$SESSION_NAME:$window_name" C-c 2>/dev/null || true
    sleep 1
    # Send "exit" to close Claude if it's at prompt
    tmux send-keys -t "$SESSION_NAME:$window_name" "exit" C-m 2>/dev/null || true
    sleep 1
    # Kill the window if still around
    tmux kill-window -t "$SESSION_NAME:$window_name" 2>/dev/null || true
    echo "Window '$window_name' closed."
  else
    echo "No window '$window_name' found (may have already exited)."
  fi

  # Update state
  if [ -d "$state_dir" ]; then
    echo "complete" > "$state_dir/status"
    date -u +"%Y-%m-%dT%H:%M:%SZ" > "$state_dir/last-event"
  fi

  echo "Issue #$issue_num stopped."
}

cmd_stop_all() {
  require_tmux

  if [ ! -d "$PORTFOLIO_DIR" ]; then
    echo "No portfolio state."
    exit 0
  fi

  local stopped=0
  for dir in "$PORTFOLIO_DIR"/*/; do
    [ -d "$dir" ] || continue
    local num
    num=$(basename "$dir")
    local status=""
    if [ -f "$dir/status" ]; then
      status=$(cat "$dir/status")
    fi
    # Only stop if not already complete
    if [ "$status" != "complete" ]; then
      cmd_stop "$num"
      stopped=$((stopped + 1))
    fi
  done

  if [ "$stopped" -eq 0 ]; then
    echo "No active issues to stop."
  else
    echo "Stopped $stopped issue(s)."
  fi
}

cmd_status() {
  local issue_num="${1:-}"

  if [ -z "$issue_num" ]; then
    # Show all — delegate to list
    cmd_list
    return
  fi
  require_issue_num "$issue_num"

  local state_dir="$PORTFOLIO_DIR/$issue_num"

  if [ ! -d "$state_dir" ]; then
    die "No state for issue #$issue_num. Is it being tracked?"
  fi

  echo "Issue #$issue_num"
  echo "==========="
  echo ""

  # Status
  local status="unknown"
  if [ -f "$state_dir/status" ]; then
    status=$(cat "$state_dir/status")
  fi
  echo "Status:       $status"

  # tmux target
  if [ -f "$state_dir/tmux-target" ]; then
    echo "tmux window:  $(cat "$state_dir/tmux-target")"
  fi

  # Worktree
  if [ -f "$state_dir/worktree" ]; then
    local wt_path
    wt_path=$(cat "$state_dir/worktree")
    echo "Worktree:     $wt_path"
    if [ -d "$wt_path" ]; then
      local branch
      branch=$(git -C "$wt_path" rev-parse --abbrev-ref HEAD 2>/dev/null || echo "?")
      echo "Branch:       $branch"
    else
      echo "Worktree:     MISSING"
    fi
  fi

  # Timestamps
  if [ -f "$state_dir/started" ]; then
    local started
    started=$(cat "$state_dir/started")
    local secs
    secs=$(seconds_since "$started")
    echo "Started:      $started ($(format_age "$secs"))"
  fi

  if [ -f "$state_dir/last-event" ]; then
    local last_event
    last_event=$(cat "$state_dir/last-event")
    local secs
    secs=$(seconds_since "$last_event")
    echo "Last event:   $last_event ($(format_age "$secs"))"
  fi

  # Window alive check
  local window_name="$PREFIX-$issue_num"
  if tmux list-windows -t "$SESSION_NAME" -F '#W' 2>/dev/null | grep -qx "$window_name"; then
    echo "Window:       alive"
  else
    echo "Window:       NOT FOUND"
  fi
}

cmd_help() {
  cat << 'EOF'
tmux-session.sh - Portfolio orchestrator for parallel Claude Code development

QUICK START:
  make claude                          # The only command you need

COMMANDS (called internally by Claude / make):
  init-and-run            Entry point: ensure session + start Claude
  init                    Initialize the portfolio tmux session only
  start <num> [branch]   Start an issue in a new tmux window
  list                   Show all tracked issues with status
  focus <num>            Switch to an issue's tmux window
  stop <num>             Gracefully stop an issue worker
  stop-all               Stop all active workers
  status [num]           Show detailed status (or all if no num)

DAILY WORKFLOW:
  1. make claude                       # Start your day
  2. /issue 345                        # Claude spawns background workers
  3. Watch status bar for '!'          # Switch to window when needed
  4. /issue 350                        # Start more issues from main

NOTIFICATIONS:
  When Claude needs input, the window shows '!' in the tmux status bar.
  Hooks in .claude/settings.json drive notifications automatically.

STATE:
  Issue state stored at: ~/.$PREFIX/portfolio/<num>/
  Status values: starting, running, needs-input, idle, complete, crashed
EOF
}

# --- Main ---

SUBCOMMAND="${1:-help}"
[ $# -gt 0 ] && shift

case "$SUBCOMMAND" in
  init-and-run) cmd_init_and_run ;;
  init)         cmd_init ;;
  start)        cmd_start "$@" ;;
  list)         cmd_list ;;
  focus)        cmd_focus "$@" ;;
  stop)         cmd_stop "$@" ;;
  stop-all)     cmd_stop_all ;;
  status)       cmd_status "$@" ;;
  help|--help|-h)  cmd_help ;;
  *)          die "Unknown command: $SUBCOMMAND. Run 'tmux-session.sh help' for usage." ;;
esac
