#!/usr/bin/env bash
# pm-commit-guard.sh — PreToolUse:Bash hook for conventional commit enforcement.
#
# Inspects `git commit` commands and validates the commit message follows
# the conventional commits format: <type>(<scope>): <description>
#
# When the message is malformed, uses `updatedInput` to auto-fix it when possible,
# or denies the command with a helpful message.
#
# Valid types: feat, fix, docs, refactor, test, chore, contracts, ci, perf, revert
# Valid scopes: any lowercase identifier (optional)
#
# Behavior:
#   - If command is not `git commit` → allow (exit 0, no output)
#   - If commit message follows convention → allow
#   - If message is close to valid (just missing type) → rewrite with updatedInput
#   - If message is not a commit or uses --amend without -m → allow (editing existing)

set -euo pipefail

# ---------- helpers ----------

deny() {
    jq -n --arg reason "$1" \
        '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":$reason}}'
    exit 0
}

rewrite() {
    # Use updatedInput to transparently fix the commit message
    local new_command="$1"
    jq -n --arg cmd "$new_command" \
        '{"hookSpecificOutput":{"hookEventName":"PreToolUse","updatedInput":{"command":$cmd}}}'
    exit 0
}

# ---------- read input ----------

input=$(cat 2>/dev/null) || exit 0
command=$(printf '%s' "$input" | jq -r '.tool_input.command // empty' 2>/dev/null) || exit 0
[[ -z "$command" ]] && exit 0

# ---------- detect git commit ----------

# Only care about commands that contain `git commit`
if ! printf '%s' "$command" | grep -qE '(^|&&|;|\|)\s*git\s+commit\b'; then
    exit 0
fi

# Extract the commit message from -m flag
# Handles: git commit -m "msg", git commit -m 'msg', git commit -am "msg"
# Also handles heredoc style: git commit -m "$(cat <<'EOF' ... )"
commit_msg=""

# Try to extract -m argument (handles quotes)
if printf '%s' "$command" | grep -qE 'git\s+commit\b.*\s+-[a-z]*m\s'; then
    # Extract the message — handle both single and double quotes
    # First try double-quoted
    commit_msg=$(printf '%s' "$command" | sed -n 's/.*git commit[^"]*-[a-z]*m[[:space:]]*"\([^"]*\)".*/\1/p' 2>/dev/null)

    # If that didn't work, try single-quoted
    if [[ -z "$commit_msg" ]]; then
        commit_msg=$(printf '%s' "$command" | sed -n "s/.*git commit[^']*-[a-z]*m[[:space:]]*'\([^']*\)'.*/\1/p" 2>/dev/null)
    fi

    # If heredoc style, try to extract the first line
    if [[ -z "$commit_msg" ]]; then
        commit_msg=$(printf '%s' "$command" | sed -n 's/.*-[a-z]*m[[:space:]]*"\$(cat <<.*//p' 2>/dev/null)
        # For heredoc, just allow — too complex to parse reliably
        if [[ -n "$commit_msg" ]]; then
            # Extract first content line from heredoc
            commit_msg=$(printf '%s' "$command" | grep -oP '(?<=EOF\n)\s*\K[^\n]+' 2>/dev/null || echo "")
        fi
    fi
fi

# If no -m flag found (interactive commit, --amend, etc.) → allow
[[ -z "$commit_msg" ]] && exit 0

# ---------- strip Co-Authored-By and trailing whitespace ----------

# Get just the first line (the subject) for validation
subject=$(printf '%s' "$commit_msg" | head -1 | sed 's/[[:space:]]*$//')

# ---------- validate conventional commit format ----------

VALID_TYPES="feat|fix|docs|refactor|test|chore|contracts|ci|perf|revert"

# Pattern: type(scope): description  OR  type: description
CONVENTIONAL_RE="^(${VALID_TYPES})(\([a-z0-9_-]+\))?: .+"

if printf '%s' "$subject" | grep -qE "$CONVENTIONAL_RE"; then
    # Valid conventional commit → allow
    exit 0
fi

# ---------- attempt auto-fix ----------

# Common patterns that can be fixed:

# 1. Missing type prefix — try to guess from keywords
guess_type() {
    local msg="$1"
    local lower_msg
    lower_msg=$(printf '%s' "$msg" | tr '[:upper:]' '[:lower:]')

    case "$lower_msg" in
        add*|implement*|create*|new*) echo "feat" ;;
        fix*|bug*|repair*|resolve*|patch*) echo "fix" ;;
        doc*|readme*|comment*) echo "docs" ;;
        refactor*|restructure*|reorganize*|clean*) echo "refactor" ;;
        test*) echo "test" ;;
        update*dep*|bump*|version*|format*|lint*) echo "chore" ;;
        ci*|workflow*|pipeline*|action*) echo "ci" ;;
        contract*|smart*contract*) echo "contracts" ;;
        perf*|optim*|speed*|fast*) echo "perf" ;;
        revert*) echo "revert" ;;
        *) echo "" ;;
    esac
}

# 2. Type without colon separator: "feat add thing" → "feat: add thing"
if printf '%s' "$subject" | grep -qE "^(${VALID_TYPES})[[:space:]]"; then
    fixed_subject=$(printf '%s' "$subject" | sed -E "s/^(${VALID_TYPES})[[:space:]]+/\1: /")
    if printf '%s' "$fixed_subject" | grep -qE "$CONVENTIONAL_RE"; then
        # Replace in original command
        # This is best-effort — may not handle all quoting styles
        new_command=$(printf '%s' "$command" | sed "s|${subject}|${fixed_subject}|")
        rewrite "$new_command"
    fi
fi

# 3. No type at all — try to guess
guessed_type=$(guess_type "$subject")
if [[ -n "$guessed_type" ]]; then
    # Suggest the fix but deny (don't auto-add type to arbitrary messages)
    deny "Commit message missing conventional prefix. Suggested fix: '${guessed_type}: ${subject}'. Valid types: ${VALID_TYPES//|/, }"
fi

# 4. Can't fix — deny with guidance
deny "Commit message '${subject}' does not follow conventional format. Required: <type>(<scope>): <description>. Valid types: ${VALID_TYPES//|/, }. Example: 'feat(web): add wallet connection flow'"
