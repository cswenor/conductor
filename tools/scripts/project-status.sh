#!/bin/bash
set -euo pipefail

# project-status.sh - Show current workflow state and labels for an issue
# Usage: project-status.sh <issue-number>

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/pm.config.sh"

ISSUE_NUM="${1:-}"

if [ -z "$ISSUE_NUM" ]; then
  echo "Usage: project-status.sh <issue-number>"
  exit 1
fi

# Check gh CLI auth (but don't require Active ID for status checks)
if ! gh auth status &>/dev/null; then
  echo "Error: gh CLI not authenticated. Run: gh auth login" >&2
  exit 1
fi

if ! command -v jq &>/dev/null; then
  echo "Error: jq not installed." >&2
  echo "  macOS:  brew install jq" >&2
  echo "  Ubuntu: sudo apt-get install jq" >&2
  exit 1
fi

REPO=$(pm_get_repo) || {
  echo "Error: Not in a git repository or no origin remote" >&2
  exit 1
}

# Get issue info + project item state in one query
RESULT=$(gh api graphql -f query='
  query($owner: String!, $repo: String!, $issue: Int!) {
    repository(owner: $owner, name: $repo) {
      issue(number: $issue) {
        title
        state
        assignees(first: 5) { nodes { login } }
        labels(first: 10) { nodes { name } }
        projectItems(first: 5) {
          nodes {
            project { number title }
            fieldValueByName(name: "Workflow") {
              ... on ProjectV2ItemFieldSingleSelectValue { name }
            }
          }
        }
      }
    }
  }
' -f owner="$PM_OWNER" -f repo="$REPO" -F issue="$ISSUE_NUM" 2>&1) || {
  echo "Error: Failed to fetch issue #$ISSUE_NUM"
  echo "$RESULT"
  exit 1
}

# Check if issue exists
ISSUE_EXISTS=$(echo "$RESULT" | jq -r '.data.repository.issue')
if [ "$ISSUE_EXISTS" = "null" ]; then
  echo "Error: Issue #$ISSUE_NUM not found"
  exit 1
fi

# Extract and display info
echo "$RESULT" | jq -r --argjson pnum "$PM_PROJECT_NUMBER" '.data.repository.issue | {
  title,
  state,
  assignees: [.assignees.nodes[].login],
  labels: [.labels.nodes[].name],
  workflow: ([.projectItems.nodes[] | select(.project.number == $pnum) | .fieldValueByName.name] | if length > 0 then .[0] else "Not in project" end)
}'
