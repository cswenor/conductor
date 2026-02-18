#!/bin/bash
set -euo pipefail

# worktree-setup.sh - Create a worktree with port isolation for parallel development
#
# Creates a git worktree at ../cond-<issue-number>/ with:
# - Feature branch checked out (creates if needed)
# - Prints shell exports for port isolation (no env files created)
#
# Port offset formula: (issue_number % 79) * 100 + 3200
# Floor 3200 clears macOS system ports (max 7100).
# Ceiling 11000 keeps 54443 + offset < 65535. 79 unique slots.
# Example: #210 → 8400, #291 → 8600, #294 → 8900
#
# Usage: worktree-setup.sh <issue-number> <branch-name>
#        worktree-setup.sh <issue-number> <branch-name> --print-env
#
# Options:
#   --print-env  Only print the export statements (for eval)
#
# Environment:
#   WORKTREE_PORT_OFFSET - Override the calculated port offset (optional)

ISSUE_NUM="${1:-}"
BRANCH_NAME="${2:-}"
PRINT_ENV_ONLY=false

# Check for --print-env flag
for arg in "$@"; do
  if [ "$arg" = "--print-env" ]; then
    PRINT_ENV_ONLY=true
  fi
done

if [ -z "$ISSUE_NUM" ]; then
  echo "Usage: worktree-setup.sh <issue-number> <branch-name>" >&2
  echo "       worktree-setup.sh <issue-number> --print-env" >&2
  echo "" >&2
  echo "Example:" >&2
  echo "  worktree-setup.sh 294 feat/worktree-support" >&2
  echo "  eval \"\$(./tools/scripts/worktree-setup.sh 294 --print-env)\"" >&2
  exit 1
fi

# Calculate port offset: (issue_number % 79) * 100 + 3200
# See issue #436 for constraint derivation.
OFFSET=${WORKTREE_PORT_OFFSET:-$(( (ISSUE_NUM % 79) * 100 + 3200 ))}

# Calculate offset ports
# POSTGRES_PORT stays at 5432 — it controls the internal listening port
# used by all supabase services via Docker DNS. POOLER_HOST_PORT and
# POOLER_TRANSACTION_HOST_PORT offset the HOST side of supavisor mappings.
POOLER_HOST_PORT=$((5432 + OFFSET))
POOLER_TRANSACTION_HOST_PORT=$((6543 + OFFSET))
VITE_PORT=$((5173 + OFFSET))
KONG_HTTP_PORT=$((54321 + OFFSET))
KONG_HTTPS_PORT=$((54443 + OFFSET))
STUDIO_PORT=$((54323 + OFFSET))
ALGOD_PORT=$((4001 + OFFSET))
KMD_PORT=$((4002 + OFFSET))
ANALYTICS_PORT=$((4000 + OFFSET))
ALGOD_ALGORAND_PORT=$((4011 + OFFSET))
KMD_ALGORAND_PORT=$((4012 + OFFSET))

# If --print-env, just output the exports (suitable for eval)
if [ "$PRINT_ENV_ONLY" = true ]; then
  cat << EOF
export COMPOSE_PROJECT_NAME=cond-$ISSUE_NUM
export VITE_PORT=$VITE_PORT
export KONG_HTTP_PORT=$KONG_HTTP_PORT
export KONG_HTTPS_PORT=$KONG_HTTPS_PORT
export STUDIO_PORT=$STUDIO_PORT
export POOLER_HOST_PORT=$POOLER_HOST_PORT
export POOLER_TRANSACTION_HOST_PORT=$POOLER_TRANSACTION_HOST_PORT
export ALGOD_PORT=$ALGOD_PORT
export KMD_PORT=$KMD_PORT
export ANALYTICS_PORT=$ANALYTICS_PORT
export ALGOD_ALGORAND_PORT=$ALGOD_ALGORAND_PORT
export KMD_ALGORAND_PORT=$KMD_ALGORAND_PORT
export PUBLIC_SUPABASE_URL=http://localhost:$KONG_HTTP_PORT
export SITE_URL=http://localhost:$VITE_PORT
export API_EXTERNAL_URL=http://localhost:$KONG_HTTP_PORT
export SUPABASE_PUBLIC_URL=http://localhost:$KONG_HTTP_PORT
export PUBLIC_ALGOD_SERVER=http://localhost:$ALGOD_PORT
export PUBLIC_VOI_NODE_URL=http://localhost:$ALGOD_PORT
EOF
  exit 0
fi

# Full worktree creation mode requires branch name
if [ -z "$BRANCH_NAME" ]; then
  echo "Usage: worktree-setup.sh <issue-number> <branch-name>" >&2
  echo "" >&2
  echo "Or for env exports only:" >&2
  echo "  worktree-setup.sh <issue-number> --print-env" >&2
  exit 1
fi

# Get the repo root (main worktree)
REPO_ROOT=$(git rev-parse --git-common-dir | xargs dirname)
REPO_ROOT=$(realpath "$REPO_ROOT")

# Worktree location: sibling directory to main repo
# Note: Can't use `realpath -m` because -m is GNU-only (not available on macOS)
# Instead, resolve the parent directory (which exists) and append the worktree name
WORKTREE_PATH="$(cd "$REPO_ROOT/.." && pwd)/cond-$ISSUE_NUM"

# Check if worktree already exists
if git worktree list --porcelain | grep -q "worktree $WORKTREE_PATH"; then
  echo "Worktree already exists at: $WORKTREE_PATH"
  echo ""
  echo "To set up port isolation, run in the worktree:"
  echo "  eval \"\$(./tools/scripts/worktree-setup.sh $ISSUE_NUM --print-env)\""
  exit 0
fi

echo "Creating worktree for issue #$ISSUE_NUM..."
echo "  Location: $WORKTREE_PATH"
echo "  Branch: $BRANCH_NAME"
echo "  Port offset: $OFFSET"
echo ""

# Check if branch exists
if git show-ref --verify --quiet "refs/heads/$BRANCH_NAME"; then
  echo "Branch '$BRANCH_NAME' exists, creating worktree..."
  git worktree add "$WORKTREE_PATH" "$BRANCH_NAME"
else
  echo "Branch '$BRANCH_NAME' does not exist, creating with worktree..."
  git worktree add -b "$BRANCH_NAME" "$WORKTREE_PATH"
fi

echo ""
echo "Worktree created successfully!"
echo ""
echo "Port mapping for issue #$ISSUE_NUM (offset: $OFFSET):"
echo "  Vite dev server:      $VITE_PORT (base: 5173)"
echo "  Kong HTTP (Supabase): $KONG_HTTP_PORT (base: 54321)"
echo "  Kong HTTPS:           $KONG_HTTPS_PORT (base: 54443)"
echo "  Supabase Studio:      $STUDIO_PORT (base: 54323)"
echo "  Algod (VOI):          $ALGOD_PORT (base: 4001)"
echo "  KMD (VOI):            $KMD_PORT (base: 4002)"
echo "  Analytics:            $ANALYTICS_PORT (base: 4000)"
echo "  Algod (Algorand):     $ALGOD_ALGORAND_PORT (base: 4011)"
echo "  KMD (Algorand):       $KMD_ALGORAND_PORT (base: 4012)"
echo ""
echo "Next steps:"
echo "  cd $WORKTREE_PATH && claude"
echo ""
echo "Then in the worktree, run full setup:"
echo "  pnpm install"
