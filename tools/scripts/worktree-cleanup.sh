#!/usr/bin/env bash
set -euo pipefail

# worktree-cleanup.sh - Clean up a worktree for a completed issue
#
# Exit codes:
#   0 - Success: Cleanup completed OR no worktree exists (nothing to do)
#   1 - In target worktree: Must leave first before cleanup
#   2 - Uncommitted changes: Worktree has uncommitted work
#
# --check mode outputs (machine-parsable):
#   "no_worktree"              - No worktree found for this issue (exit 0)
#   "stale_metadata:<path>"    - Worktree metadata exists but directory missing (exit 0)
#   "can_cleanup:<path>"       - Not in worktree, can clean up from here (exit 0)
#   "has_plans:<count>"        - Plan files exist in worktree (informational, follows can_cleanup)
#   "in_target_worktree:<path>" - In the target worktree, must leave first (exit 1)
#   "has_uncommitted:<path>"   - Worktree has uncommitted changes (exit 2)
#
# Usage: worktree-cleanup.sh <issue-number>
#        worktree-cleanup.sh <issue-number> --check
#        worktree-cleanup.sh <issue-number> --force
#
# Options:
#   --check  Only check if cleanup is possible, don't actually clean up
#   --force  Remove worktree even with uncommitted changes (use with caution)

show_help() {
  cat <<'HELPEOF'
worktree-cleanup.sh - Clean up a worktree for a completed issue

USAGE
  worktree-cleanup.sh <issue-number>
  worktree-cleanup.sh <issue-number> --check
  worktree-cleanup.sh <issue-number> --force

OPTIONS
  --check  Only check if cleanup is possible, don't actually clean up
  --force  Remove worktree even with uncommitted changes (use with caution)

EXIT CODES
  0 - Success: Cleanup completed OR no worktree exists (nothing to do)
  1 - In target worktree: Must leave first before cleanup
  2 - Uncommitted changes: Worktree has uncommitted work

CHECK MODE OUTPUT (machine-parsable)
  "no_worktree"              - No worktree found for this issue (exit 0)
  "stale_metadata:<path>"    - Metadata exists but directory missing (exit 0)
  "can_cleanup:<path>"       - Not in worktree, can clean up (exit 0)
  "has_plans:<count>"        - Plan files exist (informational, follows can_cleanup)
  "in_target_worktree:<path>" - In the target worktree (exit 1)
  "has_uncommitted:<path>"   - Uncommitted changes present (exit 2)

EXAMPLES
  worktree-cleanup.sh 294              # Clean up issue #294 worktree
  worktree-cleanup.sh 294 --check      # Check if cleanup is possible
  worktree-cleanup.sh 294 --force      # Force cleanup despite uncommitted changes
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
CHECK_ONLY=false
FORCE=false

# Parse flags
for arg in "$@"; do
  case "$arg" in
    --help|-h) show_help; exit 0 ;;
    --check) CHECK_ONLY=true ;;
    --force) FORCE=true ;;
  esac
done

if [ -z "$ISSUE_NUM" ] || [ "$ISSUE_NUM" = "--help" ] || [ "$ISSUE_NUM" = "-h" ]; then
  echo "Usage: worktree-cleanup.sh <issue-number>" >&2
  echo "       worktree-cleanup.sh <issue-number> --check" >&2
  echo "       worktree-cleanup.sh <issue-number> --force" >&2
  echo "Run worktree-cleanup.sh --help for details" >&2
  exit 1
fi

# Find worktree for this issue from git's authoritative list
# Use awk instead of grep to avoid exit 1 on no match (which trips set -e)
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

# No worktree found for this issue
if [ -z "$WORKTREE_PATH" ]; then
  if [ "$CHECK_ONLY" = true ]; then
    echo "no_worktree"
  else
    echo "No worktree found for issue #$ISSUE_NUM"
  fi
  exit 0  # Nothing to clean up is success
fi

# Check if directory actually exists (might be stale metadata)
if [ ! -d "$WORKTREE_PATH" ]; then
  if [ "$CHECK_ONLY" = true ]; then
    echo "stale_metadata:$WORKTREE_PATH"
    exit 0  # Stale metadata is auto-fixable, not an error
  fi
  echo "Worktree metadata exists but directory is missing: $WORKTREE_PATH"
  echo "Pruning stale worktree entry..."
  git worktree prune
  echo "Pruned successfully."
  exit 0
fi

WORKTREE_PATH=$(realpath "$WORKTREE_PATH")

# Get current repo root (absolute path)
CURRENT_ROOT=$(realpath "$(git rev-parse --show-toplevel)")

# Check if we're IN the worktree we want to clean up
if [ "$CURRENT_ROOT" = "$WORKTREE_PATH" ]; then
  if [ "$CHECK_ONLY" = true ]; then
    echo "in_target_worktree:$WORKTREE_PATH"
    exit 1
  fi
  echo "ERROR: Cannot clean up worktree while inside it." >&2
  echo "" >&2
  echo "You are currently in: $WORKTREE_PATH" >&2
  echo "" >&2
  echo "To clean up this worktree:" >&2
  echo "  1. Switch to the main repo: cd $(git rev-parse --git-common-dir | xargs dirname)" >&2
  echo "  2. Run cleanup:            ./tools/scripts/worktree-cleanup.sh $ISSUE_NUM" >&2
  exit 1
fi

# Check for uncommitted changes in the worktree
# Use git -C to run commands in the worktree directory
UNCOMMITTED=$(git -C "$WORKTREE_PATH" status --porcelain 2>/dev/null || echo "")
if [ -n "$UNCOMMITTED" ]; then
  if [ "$FORCE" = true ]; then
    echo "WARNING: Worktree has uncommitted changes (proceeding due to --force)"
  else
    if [ "$CHECK_ONLY" = true ]; then
      echo "has_uncommitted:$WORKTREE_PATH"
      exit 2
    fi
    echo "ERROR: Worktree has uncommitted changes." >&2
    echo "" >&2
    echo "Worktree: $WORKTREE_PATH" >&2
    echo "" >&2
    echo "Uncommitted files:" >&2
    git -C "$WORKTREE_PATH" status --short >&2
    echo "" >&2
    echo "Options:" >&2
    echo "  1. Save your work: cd $WORKTREE_PATH && git stash" >&2
    echo "  2. Or commit:      cd $WORKTREE_PATH && git add -A && git commit -m 'WIP'" >&2
    echo "  3. Or force:       ./tools/scripts/worktree-cleanup.sh $ISSUE_NUM --force" >&2
    exit 2
  fi
fi

# Check for plan files in the worktree
PLAN_DIR="$WORKTREE_PATH/.claude/plans"
PLAN_COUNT=0
if [ -d "$PLAN_DIR" ]; then
  PLAN_COUNT=$(find "$PLAN_DIR" -type f 2>/dev/null | wc -l | tr -d ' ')
fi

# If check-only mode, report that cleanup is possible
if [ "$CHECK_ONLY" = true ]; then
  echo "can_cleanup:$WORKTREE_PATH"
  if [ "$PLAN_COUNT" -gt 0 ]; then
    echo "has_plans:$PLAN_COUNT"
  fi
  exit 0
fi

# Get the branch name before removing
BRANCH=$(git -C "$WORKTREE_PATH" rev-parse --abbrev-ref HEAD 2>/dev/null || echo "")

echo "Cleaning up worktree for issue #$ISSUE_NUM..."
echo "  Location: $WORKTREE_PATH"
if [ -n "$BRANCH" ]; then
  echo "  Branch: $BRANCH"
fi
echo ""

# Remove the worktree
echo "Removing worktree directory..."
if [ "$FORCE" = true ]; then
  git worktree remove --force "$WORKTREE_PATH"
else
  git worktree remove "$WORKTREE_PATH"
fi

# Prune any stale worktree metadata
echo "Pruning worktree metadata..."
git worktree prune

echo ""
echo "Worktree cleaned up successfully!"

# Report plan files that were in the worktree (now removed with the directory)
if [ "$PLAN_COUNT" -gt 0 ]; then
  echo ""
  echo "Note: $PLAN_COUNT plan file(s) were in $PLAN_DIR"
  echo "These were removed with the worktree directory."
fi

# Optionally delete the branch if it was merged
if [ -n "$BRANCH" ] && [ "$BRANCH" != "main" ] && [ "$BRANCH" != "master" ]; then
  # Check if branch is fully merged to main
  DEFAULT_BRANCH=$(git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's@^refs/remotes/origin/@@' || echo "")
  if [ -z "$DEFAULT_BRANCH" ]; then
    for candidate in main master; do
      if git rev-parse --verify "refs/heads/$candidate" &>/dev/null; then
        DEFAULT_BRANCH="$candidate"
        break
      fi
    done
  fi
  DEFAULT_BRANCH="${DEFAULT_BRANCH:-main}"
  if git branch --merged "$DEFAULT_BRANCH" 2>/dev/null | grep -q "^\s*$BRANCH\$"; then
    echo ""
    echo "Note: Branch '$BRANCH' is fully merged to $DEFAULT_BRANCH."
    echo "To delete it: git branch -d $BRANCH"
  fi
fi
