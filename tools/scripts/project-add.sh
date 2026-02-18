#!/bin/bash
set -euo pipefail

# project-add.sh - Add an issue to the Conductor project board
#
# Usage: project-add.sh <issue-number> <priority>
#
# This script is idempotent: safe to run multiple times on the same issue.
# It will:
#   1. Add the issue to Project #1 (if not already present)
#   2. Set Workflow to Backlog
#   3. Set Priority based on argument
#   4. Set Area based on the issue's area:* label
#
# Prerequisites:
#   - gh CLI authenticated with project permissions
#   - Issue must have exactly one area:* label

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/pm.config.sh"

ISSUE_NUM="${1:-}"
PRIORITY="${2:-}"

if [ -z "$ISSUE_NUM" ] || [ -z "$PRIORITY" ]; then
  echo "Usage: project-add.sh <issue-number> <priority>"
  echo "Priority: critical | high | normal"
  exit 1
fi

# Check gh CLI auth
if ! gh auth status &>/dev/null; then
  echo "Error: gh CLI not authenticated. Run: gh auth login" >&2
  exit 1
fi

# Check for project scope (required for project mutations)
if ! gh auth status 2>&1 | grep -q "'project'"; then
  echo "Error: gh CLI token missing 'project' scope (required for project board writes)" >&2
  echo "Run: gh auth refresh -s project --hostname github.com" >&2
  exit 1
fi

if ! command -v jq &>/dev/null; then
  echo "Error: jq not installed. Run: brew install jq" >&2
  exit 1
fi

# --- Get repo from pm.config.sh helper ---
REPO_NAME=$(pm_get_repo)
if [ $? -ne 0 ]; then
  echo "Error: Not in a git repository or no origin remote" && exit 1
fi

# --- Validate priority ---
case "$PRIORITY" in
  critical) PRIORITY_ID="$PM_PRIORITY_CRITICAL" ;;
  high)     PRIORITY_ID="$PM_PRIORITY_HIGH" ;;
  normal)   PRIORITY_ID="$PM_PRIORITY_NORMAL" ;;
  *) echo "Error: Invalid priority '$PRIORITY' (use critical|high|normal)" && exit 1 ;;
esac

# --- Get and validate area label (exactly one required) ---
AREA_LABELS=$(gh issue view "$ISSUE_NUM" --json labels --jq '[.labels[].name | select(startswith("area:"))] | join(",")')
AREA_COUNT=$(echo "$AREA_LABELS" | tr ',' '\n' | grep -c . || echo 0)

if [ "$AREA_COUNT" -eq 0 ]; then
  echo "Error: No area:* label found on issue #$ISSUE_NUM" && exit 1
elif [ "$AREA_COUNT" -gt 1 ]; then
  echo "Error: Multiple area:* labels found on issue #$ISSUE_NUM: $AREA_LABELS" && exit 1
fi

AREA_LABEL="$AREA_LABELS"
case "$AREA_LABEL" in
  area:frontend)   AREA_ID="$PM_AREA_FRONTEND" ;;
  area:backend)    AREA_ID="$PM_AREA_BACKEND" ;;
  area:contracts)  AREA_ID="$PM_AREA_CONTRACTS" ;;
  area:infra)      AREA_ID="$PM_AREA_INFRA" ;;
  area:design)     AREA_ID="$PM_AREA_DESIGN" ;;
  area:docs)       AREA_ID="$PM_AREA_DOCS" ;;
  area:pm)         AREA_ID="$PM_AREA_PM" ;;
  *) echo "Warning: Unknown area label '$AREA_LABEL' — skipping area field" ;;
esac

# --- Check if already in project (idempotent) ---
ITEM_ID=$(pm_get_item_id "$ISSUE_NUM" 2>/dev/null || echo "")

if [ -z "$ITEM_ID" ]; then
  # Not in project yet - add it
  ISSUE_URL="https://github.com/$PM_OWNER/$REPO_NAME/issues/$ISSUE_NUM"
  gh project item-add "$PM_PROJECT_NUMBER" --owner "$PM_OWNER" --url "$ISSUE_URL"

  # Retry loop for item ID (propagation delay)
  for i in {1..5}; do
    ITEM_ID=$(pm_get_item_id "$ISSUE_NUM" 2>/dev/null || echo "")
    if [ -n "$ITEM_ID" ]; then break; fi
    echo "Waiting for project item... (attempt $i/5)"
    sleep 1
  done

  if [ -z "$ITEM_ID" ]; then
    echo "Error: Failed to get item ID for issue #$ISSUE_NUM after 5 attempts" && exit 1
  fi
  echo "Added issue #$ISSUE_NUM to project"
else
  echo "Issue #$ISSUE_NUM already in project (item: $ITEM_ID)"
fi

# --- Set fields ---
gh project item-edit --project-id "$PM_PROJECT_ID" --id "$ITEM_ID" \
  --field-id "$PM_FIELD_WORKFLOW" --single-select-option-id "$PM_WORKFLOW_BACKLOG"
gh project item-edit --project-id "$PM_PROJECT_ID" --id "$ITEM_ID" \
  --field-id "$PM_FIELD_PRIORITY" --single-select-option-id "$PRIORITY_ID"

if [ -n "$AREA_ID" ]; then
  gh project item-edit --project-id "$PM_PROJECT_ID" --id "$ITEM_ID" \
    --field-id "$PM_FIELD_AREA" --single-select-option-id "$AREA_ID"
  echo "Issue #$ISSUE_NUM: Workflow=Backlog, Priority=$PRIORITY, Area=${AREA_LABEL#area:}"
else
  echo "Issue #$ISSUE_NUM: Workflow=Backlog, Priority=$PRIORITY (area skipped — no matching option)"
fi
