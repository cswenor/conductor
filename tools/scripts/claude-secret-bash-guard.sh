#!/usr/bin/env bash
# Claude Code PreToolUse hook for Bash tool (secret path checking).
# Catches file-reading commands targeting sensitive paths and denies them,
# redirecting to the Read tool which has its own secret detection hooks.
#
# This is SEPARATE from claude-command-guard.sh — it has fail-closed parse
# logic (deny on errors) instead of the command guard's fail-open design.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

deny() {
    jq -n --arg reason "$1" \
        '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":$reason}}'
    exit 0
}

# ---------- read & extract (FAIL-CLOSED) ----------

input=$(cat) || deny "Secret guard: failed to read hook input"
command=$(printf '%s' "$input" | jq -r '.tool_input.command // empty' 2>/dev/null) \
    || deny "Secret guard: failed to parse hook input JSON"
[[ -z "$command" ]] && deny "Secret guard: empty command in hook input"

# ---------- normalize & check ----------

# Known limitations — these bypass the PreToolUse guard but are caught by the
# PostToolUse pattern scanner (claude-secret-detect.sh) which scans ALL Bash
# output regardless of how it was produced:
#
# - Redirections: < ~/.codex/config.toml — not a command argument
# - Arbitrary code: python3 -c "open('file').read()" — not a file-read command
# - Shell sourcing: source ~/.codex/config.toml — not in the checked command list
#
# Previously bypassed but now denied by the shell metacharacter check:
# - Shell substitutions: cat "$(echo path)" — contains $
# - Bash default-value expansion: cat ${HOME:-/tmp}/path — contains $, {
# - Brace expansion: cat ~/.codex/{config.toml} — contains {

# Split command on separators (&&, ||, ;, |, newlines) into sub-commands.
subcmds=$(printf '%s' "$command" | sed $'s/&&/\\\n/g; s/||/\\\n/g; s/;/\\\n/g; s/|/\\\n/g')

while IFS= read -r subcmd; do
    [[ -z "$subcmd" ]] && continue

    # Iterative normalization loop (same approach as claude-command-guard.sh)
    prev=""
    while [[ "$subcmd" != "$prev" ]]; do
        prev="$subcmd"

        # Strip leading/trailing whitespace
        subcmd="${subcmd#"${subcmd%%[![:space:]]*}"}"
        subcmd="${subcmd%"${subcmd##*[![:space:]]}"}"

        # Strip subshell / command-substitution wrappers
        if [[ "$subcmd" == '$('*')' ]]; then
            subcmd="${subcmd#\$\(}"
            subcmd="${subcmd%\)}"
        elif [[ "$subcmd" == '('*')' ]]; then
            subcmd="${subcmd#\(}"
            subcmd="${subcmd%\)}"
        fi

        # Strip absolute path prefix
        if [[ "$subcmd" =~ ^/ ]]; then
            subcmd=$(printf '%s' "$subcmd" | sed 's|^/[^ ]*/||')
        fi

        # Strip leading env assignments
        while [[ "$subcmd" =~ ^[A-Za-z_][A-Za-z0-9_]*=([^[:space:]]*|\"[^\"]*\"|\'[^\']*\')[[:space:]]+ ]]; do
            subcmd="${subcmd#*"${BASH_REMATCH[0]}"}"
        done

        # Strip shell keyword prefixes (appear after ; splitting)
        # Includes ! (pipeline negation) which is a single-char keyword
        if [[ "$subcmd" =~ ^(if|then|do|else|elif|while|until|for|!)[[:space:]]+ ]]; then
            subcmd="${subcmd#"${BASH_REMATCH[0]}"}"
        fi

        # Strip wrapper prefixes (command, env, sudo, time, nice, nohup, exec)
        if [[ "$subcmd" =~ ^(command|env|sudo|time|nice|nohup|exec)[[:space:]]+ ]]; then
            subcmd="${subcmd#"${BASH_REMATCH[0]}"}"
            _wrapper_done=0
            while [[ -n "$subcmd" && "$_wrapper_done" -eq 0 ]]; do
                subcmd="${subcmd#"${subcmd%%[![:space:]]*}"}"
                [[ -z "$subcmd" ]] && break
                _token="${subcmd%%[[:space:]]*}"
                if [[ "$_token" == -- ]]; then
                    subcmd="${subcmd#--}"
                    _wrapper_done=1
                elif [[ "$_token" == -* ]]; then
                    subcmd="${subcmd#"$_token"}"
                    subcmd="${subcmd#"${subcmd%%[![:space:]]*}"}"
                    [[ -z "$subcmd" ]] && break
                    _next="${subcmd%%[[:space:]]*}"
                    if [[ "$_next" != -* && "$_next" != */* ]]; then
                        case "$_next" in
                            cat|head|tail|less|more|bat|strings) _wrapper_done=1 ;;
                            *) subcmd="${subcmd#"$_next"}" ;;
                        esac
                    fi
                else
                    _wrapper_done=1
                fi
            done
        fi
    done

    [[ -z "$subcmd" ]] && continue

    # Parse arguments safely using python3 shlex.split (no shell execution).
    # This tokenizes BEFORE checking the command name, so quoted forms like
    # "cat", \cat, '/bin/cat' are properly resolved to the bare command name.
    #
    # If shlex.split fails (e.g., heredocs, complex shell syntax), we fall back
    # to a regex check on raw text. Only deny if it looks like a file-read command;
    # non-file-read commands with complex syntax are allowed through.
    _FILE_READ_CMD_RE='^(cat|head|tail|less|more|bat|strings)[[:space:]]'
    _parsed_args=$(python3 -c '
import shlex, sys, json
try:
    args = shlex.split(sys.argv[1])
    json.dump(args, sys.stdout)
except ValueError:
    sys.exit(1)
' "$subcmd" 2>/dev/null)
    if [[ $? -ne 0 ]]; then
        # shlex.split failed — deny only if raw text looks like a file-read command
        if echo "$subcmd" | grep -qE "$_FILE_READ_CMD_RE"; then
            deny "Secret guard: failed to parse file-read command arguments. Use the Read tool instead."
        fi
        # Not a file-read command — allow through (complex shell syntax like heredocs)
        continue
    fi

    _arg_count=$(echo "$_parsed_args" | python3 -c 'import json,sys; print(len(json.load(sys.stdin)))' 2>/dev/null) \
        || deny "Secret guard: failed to extract argument count from parsed command."

    [[ "$_arg_count" -eq 0 ]] && continue

    # Extract the command name (first token after shlex tokenization).
    # This resolves "cat" → cat, \cat → cat, '/usr/bin/cat' → /usr/bin/cat
    _cmd_name=$(echo "$_parsed_args" | python3 -c 'import json,sys,os; print(os.path.basename(json.load(sys.stdin)[0]))' 2>/dev/null) \
        || deny "Secret guard: failed to extract command name from parsed arguments."

    # Determine whether to check arguments for sensitive paths.
    # _check_args levels:
    #   0 = skip (not a file-read command)
    #   1 = full check: metacharacter deny + path helper (file-read commands, metachar cmd names)
    #   2 = path-only check: path helper only (compound keywords where structural
    #       tokens like y) are expected and should not trigger metachar deny)
    _check_args=0
    case "$_cmd_name" in
        cat|head|tail|less|more|bat|strings)
            _check_args=1
            ;;
        case|select|coproc)
            # Shell compound keywords that can embed commands — check paths
            # and deny expansion syntax ($, `) but allow structural tokens like y)
            _check_args=2
            ;;
        *)
            # shellcheck disable=SC2016
            if [[ "$_cmd_name" =~ [\$\`\{\*\?\[\(\)] ]]; then
                _check_args=1
            fi
            ;;
    esac

    if [[ "$_check_args" -ge 1 ]]; then
        for (( _i=1; _i<_arg_count; _i++ )); do
            _arg=$(echo "$_parsed_args" | python3 -c "import json,sys; print(json.load(sys.stdin)[$_i])" 2>/dev/null) \
                || deny "Secret guard: failed to extract argument $_i from parsed command."

            # Skip flags
            [[ "$_arg" == -* ]] && continue

            # Deny paths with unresolvable shell metacharacters (fail-closed).
            # Level 1 (file-read commands): deny all metachar args.
            # Level 2 (compound keywords): deny if arg has expansion syntax
            # ($, `) which could resolve to anything, OR has other metachar
            # combined with path chars (/ or ~). Structural tokens like y)
            # in case patterns are allowed (no $, no `, no /, no ~).
            # shellcheck disable=SC2016
            if [[ "$_arg" =~ [\$\`\{\*\?\[\(\)] ]]; then
                if [[ "$_check_args" -eq 1 ]]; then
                    deny "Path contains shell expansion syntax that cannot be safely resolved. Use the Read tool instead."
                elif [[ "$_arg" == *'$'* || "$_arg" == *'`'* || "$_arg" == */* || "$_arg" == *~* ]]; then
                    deny "Path contains shell expansion syntax that cannot be safely resolved. Use the Read tool instead."
                fi
            fi

            # Check path against sensitive paths
            _helper_output=$("$SCRIPT_DIR/claude-secret-check-path.sh" "$_arg" 2>&1)
            _helper_exit=$?

            if [[ $_helper_exit -eq 1 ]]; then
                # Exit 1 = safe, continue checking other args
                continue
            fi

            # ANY other exit code (0=sensitive, 2=error, 127=not found, etc.) → deny
            deny "${_helper_output:-Secret guard: unexpected helper exit code $_helper_exit}. Use the Read tool instead for file access."
        done
    fi

done <<< "$subcmds"

# No sensitive file-read commands found — allow
exit 0
