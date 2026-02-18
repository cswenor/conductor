#!/bin/bash
# pm.config.sh - Centralized PM project configuration
# Source this file in other scripts: source "$(dirname "$0")/pm.config.sh"

# Organization (explicit - don't derive from repo remote)
PM_OWNER="cswenor"

# Project identifiers
PM_PROJECT_NUMBER="1"
PM_PROJECT_ID="PVT_kwHOAAnhG84BPhU0"

# Field IDs
PM_FIELD_WORKFLOW="PVTSSF_lAHOAAnhG84BPhU0zg9598I"
PM_FIELD_PRIORITY="PVTSSF_lAHOAAnhG84BPhU0zg959-E"
PM_FIELD_AREA="PVTSSF_lAHOAAnhG84BPhU0zg959-I"
PM_FIELD_ISSUE_TYPE="PVTSSF_lAHOAAnhG84BPhU0zg959-Y"
PM_FIELD_RISK="PVTSSF_lAHOAAnhG84BPhU0zg959-4"
PM_FIELD_ESTIMATE="PVTSSF_lAHOAAnhG84BPhU0zg95-AM"

# Workflow option IDs
PM_WORKFLOW_BACKLOG="f0ea54fa"
PM_WORKFLOW_READY="61b7278c"
PM_WORKFLOW_ACTIVE="59245cf0"
PM_WORKFLOW_REVIEW="36f9fb60"
PM_WORKFLOW_REWORK="a852892c"
PM_WORKFLOW_DONE="f5abf09b"

# Priority option IDs
PM_PRIORITY_CRITICAL="7e5d65ca"
PM_PRIORITY_HIGH="80da3751"
PM_PRIORITY_NORMAL="48ef9c20"

# Area option IDs
PM_AREA_FRONTEND="62d7c51d"
PM_AREA_BACKEND="0187f63d"
PM_AREA_CONTRACTS=""
PM_AREA_INFRA="4d1c0272"
PM_AREA_DESIGN=""
PM_AREA_DOCS="84ace731"
PM_AREA_PM=""

# Issue Type option IDs
PM_TYPE_BUG="c936f7f1"
PM_TYPE_FEATURE="882f1f34"
PM_TYPE_SPIKE="696fcc39"
PM_TYPE_EPIC="be954f37"
PM_TYPE_CHORE="376b15d2"

# Risk option IDs
PM_RISK_LOW="f0b417b8"
PM_RISK_MED="219c30ce"
PM_RISK_HIGH="78b84f2a"

# Estimate option IDs
PM_ESTIMATE_S="6e1bd34e"
PM_ESTIMATE_M="24cc28be"
PM_ESTIMATE_L="c7eb2f52"

# Validate config before use
pm_validate_config() {
  local missing=()

  # Check required IDs
  [ -z "$PM_PROJECT_ID" ] && missing+=("PM_PROJECT_ID")
  [ -z "$PM_FIELD_WORKFLOW" ] && missing+=("PM_FIELD_WORKFLOW")
  [ "$PM_WORKFLOW_ACTIVE" = "<NEW_ID>" ] && missing+=("PM_WORKFLOW_ACTIVE (run Step 1: create Active option in GitHub UI first)")

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
    echo "Error: jq not installed. Run: brew install jq" >&2
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
