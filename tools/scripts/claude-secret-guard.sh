#!/usr/bin/env bash
# Claude Code PreToolUse hook for Read tool.
# Prompts confirmation before reading known sensitive file paths.
#
# Permission decisions:
#   - Sensitive path detected → "ask" (user confirms)
#   - Safe path → allow (exit 0 silently)
#   - Operational error → "ask" with warning (preserves normal file reading)

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

ask() {
    jq -n --arg reason "$1" \
        '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"ask","permissionDecisionReason":$reason}}'
    exit 0
}

# Read and parse input JSON
input=$(cat) || {
    ask "Secret guard: failed to read hook input — secret detection may be degraded"
}

file_path=$(printf '%s' "$input" | jq -r '.tool_input.file_path // empty' 2>/dev/null) || {
    ask "Secret guard: failed to parse tool input — secret detection may be degraded"
}

if [[ -z "$file_path" ]]; then
    ask "Secret guard: empty file path in tool input — secret detection may be degraded"
fi

# Call shared path-checking helper
_helper_output=$("$SCRIPT_DIR/claude-secret-check-path.sh" "$file_path" 2>&1)
_helper_exit=$?

case $_helper_exit in
    0)
        # Sensitive path — ask user to confirm
        ask "$_helper_output"
        ;;
    1)
        # Safe path — allow silently
        exit 0
        ;;
    2)
        # Operational error — ask with warning (preserves file access per AC5)
        ask "Secret guard warning: $_helper_output — secret detection may be degraded"
        ;;
    *)
        # Unexpected exit code — ask with warning (fail-safe, not fail-closed for Read)
        ask "Secret guard warning: unexpected helper exit code $_helper_exit — secret detection may be degraded"
        ;;
esac
