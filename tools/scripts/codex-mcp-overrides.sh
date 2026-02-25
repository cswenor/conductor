#!/usr/bin/env bash
# codex-mcp-overrides.sh - Emit -c flags to inject MCP servers into codex exec
#
# Usage (command substitution in codex exec):
#   codex exec $(./tools/scripts/codex-mcp-overrides.sh) -s read-only ...
#
# Reads .mcp.json from the repository root and emits -c flags for each
# MCP server whose required environment variables are available.
#
# Outputs nothing if:
#   - codex is not installed
#   - .mcp.json doesn't exist or is invalid
#   - No servers have their required auth configured

# Fail silently — any output to stdout becomes codex flags
# Diagnostics go to stderr only
diag() { echo "codex-mcp-overrides: $*" >&2; }

# Check codex is available
if ! command -v codex &>/dev/null; then
  diag "codex not found, no MCP overrides emitted"
  exit 0
fi

# Find .mcp.json (walk up from cwd to find repo root)
MCP_JSON=""
dir="$(pwd)"
while [[ "$dir" != "/" ]]; do
  if [[ -f "$dir/.mcp.json" ]]; then
    MCP_JSON="$dir/.mcp.json"
    break
  fi
  dir="$(dirname "$dir")"
done

if [[ -z "$MCP_JSON" ]]; then
  diag ".mcp.json not found"
  exit 0
fi

# Parse .mcp.json and emit -c flags for servers with available auth
# The .mcp.json format has mcpServers.<name>.{command, args, env}
# We check if all env vars referenced in the server config are set
if ! command -v jq &>/dev/null; then
  diag "jq not found, cannot parse .mcp.json"
  exit 0
fi

# Get list of server names
server_names=$(jq -r '.mcpServers // {} | keys[]' "$MCP_JSON" 2>/dev/null) || {
  diag "failed to parse .mcp.json"
  exit 0
}

while IFS= read -r server_name; do
  [ -z "$server_name" ] && continue
  # Extract env vars referenced by this server
  env_vars=$(jq -r --arg name "$server_name" \
    '.mcpServers[$name].env // {} | keys[]' "$MCP_JSON" 2>/dev/null) || continue

  # Check if all required env vars are set
  all_set=true
  missing_var=""
  while IFS= read -r var_name; do
    [ -z "$var_name" ] && continue
    # Get the value template — if it references an env var (${VAR} pattern), check it
    val_template=$(jq -r --arg name "$server_name" --arg var "$var_name" \
      '.mcpServers[$name].env[$var]' "$MCP_JSON" 2>/dev/null) || continue

    # Extract referenced env var name from ${VAR} pattern
    if [[ "$val_template" =~ ^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$ ]]; then
      ref_var="${BASH_REMATCH[1]}"
      if [[ -z "${!ref_var:-}" ]]; then
        all_set=false
        missing_var="$ref_var"
        break
      fi
    fi
  done <<< "$env_vars"

  if ! $all_set; then
    diag "skipping $server_name ($missing_var not set)"
    continue
  fi

  # Build the codex -c flag value: server_name=command args...
  command_val=$(jq -r --arg name "$server_name" \
    '.mcpServers[$name].command // empty' "$MCP_JSON" 2>/dev/null) || continue
  [[ -z "$command_val" ]] && continue

  args_val=$(jq -r --arg name "$server_name" \
    '.mcpServers[$name].args // [] | join(" ")' "$MCP_JSON" 2>/dev/null) || args_val=""

  # Emit the -c flag
  if [[ -n "$args_val" ]]; then
    echo "-c"
    echo "${server_name}=${command_val} ${args_val}"
  else
    echo "-c"
    echo "${server_name}=${command_val}"
  fi
done <<< "$server_names"
