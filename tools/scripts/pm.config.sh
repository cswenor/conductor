#!/bin/bash
# pm.config.sh - Centralized PM project configuration
# Source this file in other scripts: source "$(dirname "$0")/pm.config.sh"

# Organization (explicit - don't derive from repo remote)
PM_OWNER="cswenor"

# Project identifiers
PM_PROJECT_NUMBER="2"
PM_PROJECT_ID="PVT_kwHOAAnhG84BPhvY"

# Field IDs
PM_FIELD_WORKFLOW="PVTSSF_lAHOAAnhG84BPhvYzg96Qy0"
PM_FIELD_PRIORITY="PVTSSF_lAHOAAnhG84BPhvYzg96Q0Q"
PM_FIELD_AREA="PVTSSF_lAHOAAnhG84BPhvYzg96Q0U"
PM_FIELD_ISSUE_TYPE="PVTSSF_lAHOAAnhG84BPhvYzg96Q0Y"
PM_FIELD_RISK="PVTSSF_lAHOAAnhG84BPhvYzg96Q1I"
PM_FIELD_ESTIMATE="PVTSSF_lAHOAAnhG84BPhvYzg96Q1M"

# Workflow option IDs
PM_WORKFLOW_BACKLOG="74b600d5"
PM_WORKFLOW_READY="962c258c"
PM_WORKFLOW_ACTIVE="5ced14d4"
PM_WORKFLOW_REVIEW="a33df598"
PM_WORKFLOW_REWORK="0ce2c21a"
PM_WORKFLOW_DONE="4440bd88"

# Priority option IDs
PM_PRIORITY_CRITICAL="e2f43add"
PM_PRIORITY_HIGH="5ea07c7d"
PM_PRIORITY_NORMAL="2a42a8e5"

# Area option IDs
PM_AREA_FRONTEND=""
PM_AREA_BACKEND=""
PM_AREA_CONTRACTS=""
PM_AREA_INFRA=""
PM_AREA_DESIGN=""
PM_AREA_DOCS=""
PM_AREA_PM=""

# Issue Type option IDs
PM_TYPE_BUG="57d21deb"
PM_TYPE_FEATURE="5a2162ad"
PM_TYPE_SPIKE="e5f6ed28"
PM_TYPE_EPIC="f329a2d3"
PM_TYPE_CHORE="ce3bef94"

# Risk option IDs
PM_RISK_LOW="614b5103"
PM_RISK_MED="8d3abc19"
PM_RISK_HIGH="e07efa9c"

# Estimate option IDs
PM_ESTIMATE_S="a2fd8d62"
PM_ESTIMATE_M="502e48be"
PM_ESTIMATE_L="a6e5563a"

# Validate config before use
pm_validate_config() {
  local missing=()

  # Check required IDs
  [ -z "$PM_PROJECT_ID" ] && missing+=("PM_PROJECT_ID")
  [ -z "$PM_FIELD_WORKFLOW" ] && missing+=("PM_FIELD_WORKFLOW")
  [ -z "$PM_WORKFLOW_ACTIVE" ] && missing+=("PM_WORKFLOW_ACTIVE (re-run install.sh --update to discover field IDs)")

  # Check gh CLI auth
  if ! gh auth status &>/dev/null; then
    echo "Error: gh CLI not authenticated. Run: gh auth login" >&2
    return 1
  fi

  # Check for project scope (required for project mutations)
  if ! gh auth status 2>&1 | grep -q "'project'"; then
    echo "Error: gh CLI token missing 'project' scope (required for project board writes)" >&2
    echo "Run: gh auth refresh -s project --hostname github.com" >&2
    return 1
  fi

  # Check jq installed
  if ! command -v jq &>/dev/null; then
    echo "Error: jq not installed." >&2
    echo "  macOS:  brew install jq" >&2
    echo "  Ubuntu: sudo apt-get install jq" >&2
    echo "  Fedora: sudo dnf install jq" >&2
    return 1
  fi

  if [ ${#missing[@]} -gt 0 ]; then
    echo "Error: Missing config in pm.config.sh:" >&2
    printf '  - %s\n' "${missing[@]}" >&2
    return 1
  fi
}

# Helper: get repo name from git remote
pm_get_repo() {
  local url
  url=$(git remote get-url origin 2>/dev/null)
  if [ $? -ne 0 ]; then
    echo "Error: Not in a git repo or no origin remote" >&2
    return 1
  fi
  echo "$url" | sed -E 's#(git@github\.com:|https://github\.com/)##' | sed 's/\.git$//' | cut -d'/' -f2
}

# Helper: get project item ID for an issue (O(1) via issue's projectItems)
pm_get_item_id() {
  local issue_num="$1"
  local repo
  repo=$(pm_get_repo)
  if [ $? -ne 0 ]; then
    return 1
  fi

  local result
  result=$(gh api graphql -f query='
    query($owner: String!, $repo: String!, $issue: Int!) {
      repository(owner: $owner, name: $repo) {
        issue(number: $issue) {
          projectItems(first: 20) {
            nodes {
              id
              project { number }
            }
          }
        }
      }
    }
  ' -f owner="$PM_OWNER" -f repo="$repo" -F issue="$issue_num" 2>&1)

  if [ $? -ne 0 ]; then
    echo "Error: GraphQL query failed: $result" >&2
    return 1
  fi

  local item_id
  item_id=$(echo "$result" | jq -r ".data.repository.issue.projectItems.nodes[] | select(.project.number == $PM_PROJECT_NUMBER) | .id")

  if [ -z "$item_id" ]; then
    return 1  # Not found - caller handles error message
  fi

  echo "$item_id"
}
