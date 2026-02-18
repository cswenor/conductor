#!/bin/bash
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

ISSUE_NUM="${1:-}"
if [ -z "$ISSUE_NUM" ]; then
  echo "Usage: worktree-detect.sh <issue-number>" >&2
  exit 1
fi

# Find worktree for this issue from git's authoritative list
# Use awk instead of grep to avoid exit 1 on no match (which trips set -e)
# Match either:
#   - exact suffix /cnd-<num> (e.g., /Users/dev/cnd-294)
#   - basename cnd-<num> (in case worktree is nested differently)
WORKTREE_PATH=$(git worktree list --porcelain | awk -v issue="$ISSUE_NUM" '
  /^worktree / {
    path = substr($0, 10)  # Remove "worktree " prefix
    # Check if path ends with /cnd-<issue> or IS cnd-<issue>
    if (path ~ "/cnd-" issue "$" || path == "cnd-" issue) {
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
