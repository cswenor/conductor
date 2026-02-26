#!/usr/bin/env bash
set -euo pipefail

# worktree-detect.sh - Detect worktree status for an issue
#
# Exit codes:
#   0 - In correct worktree for this issue -> proceed normally
#   1 - In main repo, no worktree exists -> will create
#   2 - Worktree exists elsewhere -> print absolute path, direct user there
#   3 - In a different worktree -> direct user to correct one
#   4 - Worktree metadata exists but directory is broken/missing
#
# Usage: worktree-detect.sh <issue-number>

show_help() {
  cat <<'HELPEOF'
worktree-detect.sh - Detect worktree status for an issue

USAGE
  worktree-detect.sh <issue-number>

EXIT CODES
  0 - In correct worktree for this issue (prints "in_correct_worktree")
  1 - In main repo, no worktree exists (prints "no_worktree")
  2 - Worktree exists elsewhere (prints absolute path)
  3 - In a different worktree (prints "in_different_worktree")
  4 - Broken worktree - metadata exists but directory missing (prints "broken:<path>")

EXAMPLES
  worktree-detect.sh 294
  if worktree-detect.sh 294; then echo "Ready to work"; fi
HELPEOF
}

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

ISSUE_NUM="${1:-}"

if [ "$ISSUE_NUM" = "--help" ] || [ "$ISSUE_NUM" = "-h" ]; then
  show_help
  exit 0
fi

if [ -z "$ISSUE_NUM" ]; then
  echo "Usage: worktree-detect.sh <issue-number>" >&2
  echo "Run worktree-detect.sh --help for details" >&2
  exit 1
fi

# Ensure we're in a git repo
if ! git rev-parse --git-dir &>/dev/null; then
  echo "Error: not in a git repository" >&2
  exit 1
fi

# Find worktree for this issue from git's authoritative list
# Use awk instead of grep to avoid exit 1 on no match (which trips set -e)
# Match either:
#   - exact suffix /$PREFIX-<num> (e.g., /Users/dev/$PREFIX-294)
#   - basename $PREFIX-<num> (in case worktree is nested differently)
WORKTREE_PATH=$(git worktree list --porcelain | awk -v issue="$ISSUE_NUM" -v pfx="$PREFIX" '
  /^worktree / {
    path = substr($0, 10)  # Remove "worktree " prefix
    # Check if path ends with /<prefix>-<issue> or IS <prefix>-<issue>
    if (path ~ "/" pfx "-" issue "$" || path == pfx "-" issue) {
      print path
      exit
    }
  }
')

# Get current repo root (absolute path)
CURRENT_ROOT=$(realpath "$(git rev-parse --show-toplevel)")

# If worktree exists in git's list
if [ -n "$WORKTREE_PATH" ]; then
  # Check if directory actually exists (might be stale metadata)
  if [ ! -d "$WORKTREE_PATH" ]; then
    echo "broken:$WORKTREE_PATH"
    exit 4  # Worktree metadata exists but directory is gone
  fi

  EXPECTED_PATH=$(realpath "$WORKTREE_PATH")

  # Check if we're IN that worktree
  if [ "$CURRENT_ROOT" = "$EXPECTED_PATH" ]; then
    echo "in_correct_worktree"
    exit 0
  fi

  # Worktree exists but we're not in it
  echo "$EXPECTED_PATH"
  exit 2
fi

# No worktree for this issue - check if we're in main repo or different worktree
MAIN_GIT=$(git rev-parse --git-common-dir 2>/dev/null)
THIS_GIT=$(git rev-parse --git-dir 2>/dev/null)

if [ "$MAIN_GIT" != "$THIS_GIT" ]; then
  echo "in_different_worktree"
  exit 3  # In a worktree, but not one for this issue
fi

echo "no_worktree"
exit 1  # In main repo, no worktree exists
