#!/bin/bash
set -euo pipefail

# find-plan.sh - Search plan files by issue number
#
# Searches the project-local .claude/plans/ directory for plan files mentioning
# an issue number. By default only searches the local project; use --include-global
# to also search ~/.claude/plans/ (legacy/global location).
#
# Usage: find-plan.sh <issue-number>
#        find-plan.sh <issue-number> --latest
#        find-plan.sh <issue-number> --include-global
#
# Options:
#   --latest           Return only the most recently modified match
#   --include-global   Also search ~/.claude/plans/ (may contain plans from other repos)
#
# Exit codes:
#   0 - Found matching plan file(s)
#   1 - No plan files found (or missing/invalid argument)

ISSUE_NUM="${1:-}"
LATEST_ONLY=false
INCLUDE_GLOBAL=false

for arg in "$@"; do
  case "$arg" in
    --latest) LATEST_ONLY=true ;;
    --include-global) INCLUDE_GLOBAL=true ;;
  esac
done

if [ -z "$ISSUE_NUM" ]; then
  echo "Usage: find-plan.sh <issue-number>" >&2
  echo "       find-plan.sh <issue-number> --latest" >&2
  echo "       find-plan.sh <issue-number> --include-global" >&2
  exit 1
fi

# Validate issue number is numeric
if ! [[ "$ISSUE_NUM" =~ ^[0-9]+$ ]]; then
  echo "Error: issue number must be numeric, got '$ISSUE_NUM'" >&2
  exit 1
fi

# Get project root (works in worktrees too)
PROJECT_ROOT=$(git rev-parse --show-toplevel 2>/dev/null || echo "")

# Collect search directories
SEARCH_DIRS=()

# Primary: project-local plans
if [ -n "$PROJECT_ROOT" ] && [ -d "$PROJECT_ROOT/.claude/plans" ]; then
  SEARCH_DIRS+=("$PROJECT_ROOT/.claude/plans")
fi

# Global plans only when explicitly requested
if [ "$INCLUDE_GLOBAL" = true ] && [ -d "$HOME/.claude/plans" ]; then
  SEARCH_DIRS+=("$HOME/.claude/plans")
fi

if [ ${#SEARCH_DIRS[@]} -eq 0 ]; then
  echo "No plan directories found." >&2
  exit 1
fi

# Cross-platform stat for modification time (seconds since epoch)
# macOS uses stat -f, Linux uses stat -c
get_mtime() {
  local file="$1"
  if stat -f "%m" "$file" 2>/dev/null; then
    return
  fi
  stat -c "%Y" "$file" 2>/dev/null
}

# Search for plan files containing the issue number as a distinct token
# Pattern: #<num> followed by a non-alphanumeric/non-underscore char or end-of-line
# Prevents #305 matching #3051 (digit suffix) or #305a (alpha suffix)
# Uses ERE (-E) with single-quote concatenation to avoid ${VAR} syntax (env scanner)
# Uses newline-delimited output (not -Z) for macOS compatibility (BSD grep ignores -Z with -E)
PATTERN='#'"$ISSUE_NUM"'([^0-9A-Za-z_]|$)'
MATCHES=()
for dir in "${SEARCH_DIRS[@]}"; do
  while IFS= read -r file; do
    [ -n "$file" ] && MATCHES+=("$file")
  done < <(grep -rEl "$PATTERN" "$dir" 2>/dev/null || true)
done

if [ ${#MATCHES[@]} -eq 0 ]; then
  echo "No plan files found for issue #$ISSUE_NUM" >&2
  exit 1
fi

# Sort by modification time (newest first)
sorted=()
while IFS= read -r line; do
  sorted+=("${line#* }")
done < <(
  for file in "${MATCHES[@]}"; do
    mtime=$(get_mtime "$file")
    echo "$mtime $file"
  done | sort -rn
)

if [ "$LATEST_ONLY" = true ]; then
  echo "${sorted[0]}"
else
  for file in "${sorted[@]}"; do
    echo "$file"
  done
fi
