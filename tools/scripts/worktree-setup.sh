#!/usr/bin/env bash
set -euo pipefail

# worktree-setup.sh - Create a worktree with port isolation for parallel development
#
# Creates a git worktree at ../$PREFIX-<issue-number>/ with:
# - Feature branch checked out (creates if needed)
# - Symlinks .env* and .mcp.json from main repo (gitignored files)
# - Prints shell exports for port isolation (no env files created)
#
# Port offset formula: (issue_number % 79) * 100 + 3200
# Floor 3200 clears macOS system ports (max 7100).
# Ceiling 11000 keeps highest base port + offset < 65535. 79 unique slots.
#
# Port services are defined in worktree-ports.conf (same directory).
# URL exports are defined in worktree-urls.conf (same directory).
#
# Usage: worktree-setup.sh <issue-number> <branch-name>
#        worktree-setup.sh <issue-number> --print-env
#
# Options:
#   --print-env  Only print the export statements (for eval)
#
# Environment:
#   WORKTREE_PORT_OFFSET - Override the calculated port offset (optional)

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORTS_CONF="$SCRIPT_DIR/worktree-ports.conf"
URLS_CONF="$SCRIPT_DIR/worktree-urls.conf"

# Resolve prefix from config (supports both source repo and installed repos)
_resolve_prefix() {
  local search_dir="$SCRIPT_DIR"
  # Walk up from script dir to find .claude-pm-toolkit.json
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

show_help() {
  cat <<'HELPEOF'
worktree-setup.sh - Create a worktree with port isolation for parallel development

USAGE
  worktree-setup.sh <issue-number> <branch-name>
  worktree-setup.sh <issue-number> --print-env

OPTIONS
  --print-env  Only print shell export statements (for eval)
  --no-env     Skip symlinking .env* and .mcp.json files from main repo

ENVIRONMENT
  WORKTREE_PORT_OFFSET  Override the calculated port offset (optional)
                        Must be in range 3200-11000

PORT ISOLATION
  Each worktree gets a unique port offset: (issue_number % 79) * 100 + 3200
  This gives 79 unique slots covering ports 3200-11000.
  All services (Vite, Supabase, Postgres, Algod, etc.) are offset by this value.

EXAMPLES
  worktree-setup.sh 294 feat/worktree-support      # Create worktree
  eval "$(./tools/scripts/worktree-setup.sh 294 --print-env)"  # Apply ports

NOTES
  Worktree is created at ../<prefix>-<issue-number>/ (sibling to main repo).
  Port services are defined in worktree-ports.conf.
  URL exports are defined in worktree-urls.conf.
HELPEOF
}

ISSUE_NUM="${1:-}"
BRANCH_NAME="${2:-}"
PRINT_ENV_ONLY=false
SKIP_ENV_SYMLINK=false

# Check for flags
for arg in "$@"; do
  case "$arg" in
    --help|-h) show_help; exit 0 ;;
    --print-env) PRINT_ENV_ONLY=true ;;
    --no-env) SKIP_ENV_SYMLINK=true ;;
  esac
done

if [ -z "$ISSUE_NUM" ]; then
  echo "Usage: worktree-setup.sh <issue-number> <branch-name>" >&2
  echo "       worktree-setup.sh <issue-number> --print-env" >&2
  echo "Run worktree-setup.sh --help for details" >&2
  exit 1
fi

# Validate issue number is numeric
if ! [[ "$ISSUE_NUM" =~ ^[0-9]+$ ]]; then
  echo "Error: issue number must be numeric (got: $ISSUE_NUM)" >&2
  exit 1
fi

# Calculate port offset: (issue_number % 79) * 100 + 3200
OFFSET=${WORKTREE_PORT_OFFSET:-$(( (ISSUE_NUM % 79) * 100 + 3200 ))}

# Validate offset is in safe range (3200-11000)
# Floor 3200 clears macOS system ports. Ceiling 11000 keeps highest base+offset < 65535.
if [[ "$OFFSET" -lt 3200 ]] || [[ "$OFFSET" -gt 11000 ]]; then
  echo "Error: port offset must be in range 3200-11000 (got: $OFFSET)" >&2
  if [[ -n "${WORKTREE_PORT_OFFSET:-}" ]]; then
    echo "Fix: adjust WORKTREE_PORT_OFFSET to a value in range" >&2
  fi
  exit 1
fi

# Read port services from config file
declare -a PORT_NAMES=()
declare -a PORT_VALUES=()
declare -a PORT_BASES=()
declare -a PORT_ENV_VARS=()

if [ -f "$PORTS_CONF" ]; then
  while IFS= read -r line; do
    # Skip comments and blank lines
    [[ "$line" =~ ^[[:space:]]*# ]] && continue
    [[ -z "${line// /}" ]] && continue

    # Parse: SERVICE_NAME BASE_PORT ENV_VAR
    read -r svc_name base_port env_var <<< "$line"
    if [ -n "$svc_name" ] && [ -n "$base_port" ] && [ -n "$env_var" ]; then
      calculated=$(( base_port + OFFSET ))
      PORT_NAMES+=("$svc_name")
      PORT_BASES+=("$base_port")
      PORT_ENV_VARS+=("$env_var")
      PORT_VALUES+=("$calculated")
      # Export for URL template expansion
      export "$env_var=$calculated"
    fi
  done < "$PORTS_CONF"
fi

# If --print-env, output the exports (suitable for eval)
if [ "$PRINT_ENV_ONLY" = true ]; then
  echo "export COMPOSE_PROJECT_NAME=$PREFIX-$ISSUE_NUM"

  # Port exports
  for i in "${!PORT_ENV_VARS[@]}"; do
    echo "export ${PORT_ENV_VARS[$i]}=${PORT_VALUES[$i]}"
  done

  # URL exports from config
  if [ -f "$URLS_CONF" ]; then
    while IFS= read -r line; do
      [[ "$line" =~ ^[[:space:]]*# ]] && continue
      [[ -z "${line// /}" ]] && continue

      read -r env_var url_template <<< "$line"
      if [ -n "$env_var" ] && [ -n "$url_template" ]; then
        # Expand ${VAR} references using already-exported port vars
        expanded=$(eval echo "$url_template" 2>/dev/null || echo "$url_template")
        echo "export $env_var=$expanded"
      fi
    done < "$URLS_CONF"
  fi

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

# Ensure we're in a git repo
if ! git rev-parse --git-dir &>/dev/null; then
  echo "Error: not in a git repository" >&2
  exit 1
fi

# Get the repo root (main worktree)
GIT_COMMON_DIR=$(git rev-parse --git-common-dir)
REPO_ROOT=$(realpath "$(dirname "$GIT_COMMON_DIR")")

# Worktree location: sibling directory to main repo
# Note: Can't use `realpath -m` because -m is GNU-only (not available on macOS)
# Instead, resolve the parent directory (which exists) and append the worktree name
WORKTREE_PATH="$(cd "$REPO_ROOT/.." && pwd)/$PREFIX-$ISSUE_NUM"

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

# --- Symlink gitignored config files from main repo ---
if [ "$SKIP_ENV_SYMLINK" = false ]; then
  ENV_COUNT=0

  # Symlink .env* files (credentials, local config)
  for env_file in "$REPO_ROOT"/.env*; do
    [ -f "$env_file" ] || continue  # skip if glob didn't match
    basename_f=$(basename "$env_file")
    target="$WORKTREE_PATH/$basename_f"
    if [ -e "$target" ]; then
      # Don't overwrite git-tracked files (e.g., .env.example)
      continue
    fi
    ln -s "$env_file" "$target"
    ENV_COUNT=$((ENV_COUNT + 1))
  done

  # Symlink .mcp.json (MCP server config, typically gitignored/untracked)
  if [ -f "$REPO_ROOT/.mcp.json" ] && [ ! -e "$WORKTREE_PATH/.mcp.json" ]; then
    ln -s "$REPO_ROOT/.mcp.json" "$WORKTREE_PATH/.mcp.json"
    ENV_COUNT=$((ENV_COUNT + 1))
  fi

  if [ "$ENV_COUNT" -gt 0 ]; then
    echo "Symlinked $ENV_COUNT config file(s) from main repo"
    # List what was linked
    for link in "$WORKTREE_PATH"/.env* "$WORKTREE_PATH/.mcp.json"; do
      [ -L "$link" ] || continue
      echo "  $(basename "$link") -> $(readlink "$link")"
    done
    echo ""
  fi
fi

# Display port mapping from config
if [ ${#PORT_NAMES[@]} -gt 0 ]; then
  echo "Port mapping for issue #$ISSUE_NUM (offset: $OFFSET):"
  for i in "${!PORT_NAMES[@]}"; do
    # Format service name (replace underscores with spaces)
    display_name=$(echo "${PORT_NAMES[$i]}" | tr '_' ' ')
    printf "  %-24s %s (base: %s)\n" "$display_name:" "${PORT_VALUES[$i]}" "${PORT_BASES[$i]}"
  done
  echo ""
fi

echo "Next steps:"
echo "  cd $WORKTREE_PATH && claude"
echo ""
echo "Then in the worktree, run full setup:"
# Read setup command from config
SETUP_CMD=$(jq -r '.setup_command // "make setup"' "$(git rev-parse --show-toplevel 2>/dev/null || echo .)/.claude-pm-toolkit.json" 2>/dev/null || echo "make setup")
echo "  $SETUP_CMD"
