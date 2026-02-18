#!/usr/bin/env bash
# project-archive-done.sh - Archive project items that have been Done for too long
#
# Environment variables:
#   COND_ARCHIVE_DAYS    - Archive items Done for more than N days (default: 7)
#   COND_ARCHIVE_DRY_RUN - If "true", list items but don't archive (default: false)
#   GH_TOKEN        - GitHub token (required)
#
# Usage:
#   ./tools/scripts/project-archive-done.sh
#   COND_ARCHIVE_DAYS=7 COND_ARCHIVE_DRY_RUN=true ./tools/scripts/project-archive-done.sh

set -euo pipefail

# Load centralized PM config
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/pm.config.sh"

# Configuration (from pm.config.sh)
OWNER="$PM_OWNER"
PROJECT_NUMBER="$PM_PROJECT_NUMBER"
DONE_OPTION_ID="$PM_WORKFLOW_DONE"

COND_ARCHIVE_DAYS="${COND_ARCHIVE_DAYS:-7}"
COND_ARCHIVE_DRY_RUN="${COND_ARCHIVE_DRY_RUN:-false}"

log() { echo "[archive-done] $*"; }
err() { echo "[archive-done] ERROR: $*" >&2; }

# Calculate cutoff date (items closed before this date will be archived)
if [[ "$(uname)" == "Darwin" ]]; then
  CUTOFF_DATE=$(date -v-"${COND_ARCHIVE_DAYS}"d +%Y-%m-%d)
else
  CUTOFF_DATE=$(date -d "-${COND_ARCHIVE_DAYS} days" +%Y-%m-%d)
fi

log "Archiving items Done before: $CUTOFF_DATE ($COND_ARCHIVE_DAYS days ago)"
log "Dry run: $COND_ARCHIVE_DRY_RUN"

# Get project ID
PROJECT_ID=$(gh api graphql -f query='
  query($owner: String!, $number: Int!) {
    organization(login: $owner) {
      projectV2(number: $number) {
        id
      }
    }
  }
' -f owner="$OWNER" -F number="$PROJECT_NUMBER" --jq '.data.organization.projectV2.id')

if [[ -z "$PROJECT_ID" ]]; then
  err "Could not find project $PROJECT_NUMBER for $OWNER"
  exit 1
fi

log "Project ID: $PROJECT_ID"

# Query all project items using cursor-based pagination
ALL_ITEMS="[]"
HAS_NEXT=true
CURSOR=""
PAGE=0

while [[ "$HAS_NEXT" == "true" ]]; do
  PAGE=$((PAGE + 1))

  if [[ -n "$CURSOR" ]]; then
    CURSOR_ARG="-f cursor=$CURSOR"
  else
    CURSOR_ARG="-f cursor="
  fi

  # shellcheck disable=SC2086
  PAGE_JSON=$(gh api graphql -f query='
    query($projectId: ID!, $cursor: String) {
      node(id: $projectId) {
        ... on ProjectV2 {
          items(first: 100, after: $cursor) {
            pageInfo {
              hasNextPage
              endCursor
            }
            nodes {
              id
              fieldValueByName(name: "Workflow") {
                ... on ProjectV2ItemFieldSingleSelectValue {
                  optionId
                  name
                }
              }
              content {
                ... on Issue {
                  number
                  title
                  closedAt
                  state
                }
                ... on PullRequest {
                  number
                  title
                  closedAt
                  state
                }
              }
            }
          }
        }
      }
    }
  ' -f projectId="$PROJECT_ID" $CURSOR_ARG)

  PAGE_NODES=$(echo "$PAGE_JSON" | jq '.data.node.items.nodes')
  PAGE_COUNT=$(echo "$PAGE_NODES" | jq 'length')
  ALL_ITEMS=$(echo "$ALL_ITEMS" "$PAGE_NODES" | jq -s '.[0] + .[1]')

  HAS_NEXT=$(echo "$PAGE_JSON" | jq -r '.data.node.items.pageInfo.hasNextPage')
  CURSOR=$(echo "$PAGE_JSON" | jq -r '.data.node.items.pageInfo.endCursor')

  log "Page $PAGE: fetched $PAGE_COUNT items (hasNextPage: $HAS_NEXT)"
done

TOTAL_FETCHED=$(echo "$ALL_ITEMS" | jq 'length')
log "Total items fetched: $TOTAL_FETCHED"

# Filter to Done items with closedAt date and format as newline-delimited JSON
DONE_ITEMS=$(echo "$ALL_ITEMS" | jq -c '
  .[]
  | select(.fieldValueByName.optionId == "'"$DONE_OPTION_ID"'")
  | select(.content.closedAt != null)
  | {
      itemId: .id,
      number: .content.number,
      title: .content.title,
      closedAt: .content.closedAt
    }
')

if [[ -z "$DONE_ITEMS" ]]; then
  log "No Done items found with closedAt dates"
  exit 0
fi

# Count items
total_items=$(echo "$DONE_ITEMS" | wc -l | tr -d ' ')
log "Found $total_items Done items to evaluate"

# Process each item
archived_count=0
skipped_count=0

while IFS= read -r item; do
  [[ -z "$item" ]] && continue

  item_id=$(echo "$item" | jq -r '.itemId')
  number=$(echo "$item" | jq -r '.number')
  title=$(echo "$item" | jq -r '.title')
  closed_at=$(echo "$item" | jq -r '.closedAt')

  # Extract just the date part for comparison
  closed_date="${closed_at:0:10}"

  # Compare dates (string comparison works for ISO format)
  if [[ "$closed_date" < "$CUTOFF_DATE" ]]; then
    if [[ "$COND_ARCHIVE_DRY_RUN" != "true" ]]; then
      log "Archiving #$number: $title (closed: $closed_date)"

      gh api graphql -f query='
        mutation($projectId: ID!, $itemId: ID!) {
          archiveProjectV2Item(input: {projectId: $projectId, itemId: $itemId}) {
            item { id }
          }
        }
      ' -f projectId="$PROJECT_ID" -f itemId="$item_id" > /dev/null

      archived_count=$((archived_count + 1))
    else
      log "Would archive #$number: $title (closed: $closed_date)"
      archived_count=$((archived_count + 1))
    fi
  else
    log "Skipping #$number: $title (closed: $closed_date - within $COND_ARCHIVE_DAYS days)"
    skipped_count=$((skipped_count + 1))
  fi
done <<< "$DONE_ITEMS"

log "Complete. Archived: $archived_count, Skipped: $skipped_count"
