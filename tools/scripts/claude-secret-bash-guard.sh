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

# Nesting-aware command splitter.
# Splits on &&, ||, |, ; only at the top level (depth 0, outside backticks).
# Tracks $() and () nesting via a depth counter, and respects quoting.
# Returns non-zero on parse anomalies (unclosed quotes/substitutions).
split_top_level() {
    local cmd="$1"
    local len=${#cmd}
    local depth=0 in_backtick=0 in_single_quote=0 in_double_quote=0 in_case=0
    local buf="" i=0 c two
    local -a dq_stack=()
    local _kw_prev _kw_after

    while (( i < len )); do
        c="${cmd:i:1}"

        # Inside single quotes: everything is literal until closing '
        if (( in_single_quote )); then
            [[ "$c" == "'" ]] && in_single_quote=0
            buf+="$c"; i=$(( i + 1 )); continue
        fi

        # Backslash escape (outside single quotes): consume two characters
        if [[ "$c" == '\' ]]; then
            buf+="${cmd:i:2}"; i=$(( i + 2 )); continue
        fi

        # Single quote open (only outside double quotes — inside double quotes, ' is literal)
        if [[ "$c" == "'" ]] && (( ! in_double_quote )); then
            in_single_quote=1; buf+="$c"; i=$(( i + 1 )); continue
        fi

        # Double quote toggle
        if [[ "$c" == '"' ]]; then
            in_double_quote=$(( 1 - in_double_quote ))
            buf+="$c"; i=$(( i + 1 )); continue
        fi

        # Backtick toggle (works inside double quotes too)
        if [[ "$c" == '`' ]]; then
            in_backtick=$(( 1 - in_backtick ))
            buf+="$c"; i=$(( i + 1 )); continue
        fi

        # Inside backticks: opaque until closing backtick
        if (( in_backtick )); then
            buf+="$c"; i=$(( i + 1 )); continue
        fi

        # $( — command substitution open (works inside double quotes)
        # Push in_double_quote onto stack and reset — $() starts a new quoting context
        if [[ "$c" == '$' && "${cmd:i+1:1}" == '(' ]]; then
            dq_stack[depth]=$in_double_quote
            depth=$(( depth + 1 )); in_double_quote=0
            buf+='$('; i=$(( i + 2 )); continue
        fi

        # Inside double quotes: ( and ) are literal (don't affect depth)
        if (( in_double_quote )); then
            buf+="$c"; i=$(( i + 1 )); continue
        fi

        # case/esac keyword detection (depth > 0, outside quotes/backticks).
        # Prevents case-pattern ) from being mistaken for $() close.
        # Conservative: false 'case' detection keeps depth high → safe (over-split).
        if (( depth > 0 )); then
            if [[ "$c" == 'c' && "${cmd:i:5}" == 'case '* ]]; then
                _kw_prev=""; (( i > 0 )) && _kw_prev="${cmd:i-1:1}"
                if [[ -z "$_kw_prev" || "$_kw_prev" =~ [[:space:]\;\&\|\(\)] ]]; then
                    in_case=$(( in_case + 1 ))
                fi
            elif [[ "$c" == 'e' && in_case -gt 0 && "${cmd:i:4}" == "esac" ]]; then
                _kw_after=""; (( i + 4 < len )) && _kw_after="${cmd:i+4:1}"
                if [[ -z "$_kw_after" || "$_kw_after" =~ [[:space:]\;\)\&\|] ]]; then
                    _kw_prev=""; (( i > 0 )) && _kw_prev="${cmd:i-1:1}"
                    if [[ -z "$_kw_prev" || "$_kw_prev" =~ [[:space:]\;\&\|\(\)] ]]; then
                        in_case=$(( in_case - 1 ))
                    fi
                fi
            fi
        fi

        # ( — subshell/grouping open (push quote state for independent context)
        if [[ "$c" == '(' ]]; then
            dq_stack[depth]=$in_double_quote
            depth=$(( depth + 1 )); in_double_quote=0
            buf+="$c"; i=$(( i + 1 )); continue
        fi

        # ) — close paren (restore pushed quote state)
        # Inside a case block, ) is a pattern delimiter, not a closing paren.
        if [[ "$c" == ')' ]]; then
            if (( in_case > 0 && depth > 0 )); then
                buf+="$c"; i=$(( i + 1 )); continue
            fi
            if (( depth > 0 )); then
                depth=$(( depth - 1 ))
                in_double_quote=${dq_stack[depth]:-0}
            fi
            buf+="$c"; i=$(( i + 1 )); continue
        fi

        # At depth 0: check for top-level separators
        if (( depth == 0 )); then
            two="${cmd:i:2}"
            if [[ "$two" == '&&' ]]; then printf '%s\n' "$buf"; buf=""; i=$(( i + 2 )); continue; fi
            if [[ "$two" == '||' ]]; then printf '%s\n' "$buf"; buf=""; i=$(( i + 2 )); continue; fi
            if [[ "$c" == ';' ]]; then printf '%s\n' "$buf"; buf=""; i=$(( i + 1 )); continue; fi
            if [[ "$c" == '|' ]]; then printf '%s\n' "$buf"; buf=""; i=$(( i + 1 )); continue; fi
        fi

        buf+="$c"; i=$(( i + 1 ))
    done

    printf '%s\n' "$buf"
    if (( depth != 0 || in_backtick != 0 || in_single_quote != 0 || in_double_quote != 0 )); then
        return 1
    fi
    return 0
}

# Split command into sub-commands using nesting-aware splitter.
# On parse failure (unclosed quotes/substitutions), the partial output is still
# nesting-aware for the parts that parsed correctly — better than naive sed splitting.
# The secondary Python pass below provides defense-in-depth for nested sensitive reads.
subcmds=$(split_top_level "$command")
# shellcheck disable=SC2181  # exit code checked intentionally for clarity
if [[ $? -ne 0 ]]; then
    : # Parse anomaly — proceed with partial output (fail-closed design catches issues downstream)
fi

# Secondary pass to catch sensitive reads inside $() and backticks.
# The nesting-aware splitter keeps $() content intact (by design), but a command like
# SECRET=$(cat ~/.ssh/id_rsa) hides the inner 'cat' from path checking. This pass
# splits on ALL separators PLUS $(), ), and backtick boundaries, surfacing nested
# commands as independent fragments. Full metachar + path checking runs on both passes.
# The only difference: shlex-failure deny is skipped for secondary fragments since
# splitting inside quotes can produce unclosed-quote fragments that aren't real commands.
#
# Quote-aware: uses Python to track single/double quote state so that $(), ), and `
# inside single quotes are NOT split (they're literal text, not shell syntax). This
# prevents false positives where literal text like echo '$(cat sensitive_path)' would
# produce synthetic fragments matching sensitive paths.
#
# DQ context resets on $( and backtick boundaries (dq_stack push/pop) so that single
# quotes inside command substitutions are properly recognized. dq_stack entries are
# tagged with context type: ("s", in_dq) for $() and ("b", in_dq) for backtick.
# This ensures ) only closes $() contexts (tag "s"), not backtick contexts (tag "b")
# or bare paren contexts (tag "p"). Without tagging, ) inside backticks or after
# bare ( would prematurely pop the wrong stack entry and create synthetic fragments.
# Bare ( subshells push ("p", in_dq) onto dq_stack so that their ) doesn't
# incorrectly close a $() context. "p" entries don't create segment boundaries —
# they just prevent mismatched pops.
#
# Segment boundaries: $( and opening backtick always create a boundary (isolate inner
# content). ) only creates a boundary when the top dq_stack entry is tagged "s"
# (closing a real $() context); otherwise ) stays in the current buffer. Closing
# backtick always creates a boundary.
#
# Operators (&&, ||, ;, |) are ONLY split when inside $() or backtick context
# (dq_stack non-empty). At the top level (dq_stack empty), operators may appear
# inside quoted strings — splitting them would create false fragments. The primary
# pass already handles top-level operator splitting correctly via split_top_level().
# Falls back to sed if python3 fails.
_secondary_subcmds=$(python3 -c '
import sys
SQ = chr(39)
cmd = sys.argv[1]
segs = []
buf = []
in_sq = in_dq = in_bt = False
in_case = 0
dq_stack = []
i = 0
n = len(cmd)
while i < n:
    c = cmd[i]
    if in_sq:
        if c == SQ: in_sq = False
        buf.append(c); i += 1; continue
    if c == "\\" and i + 1 < n:
        buf.append(cmd[i:i+2]); i += 2; continue
    if c == SQ and not in_dq:
        in_sq = True; buf.append(c); i += 1; continue
    if c == "\"":
        in_dq = not in_dq; buf.append(c); i += 1; continue
    if c == "#" and not in_dq and not in_bt and not dq_stack:
        # In bash, # starts a comment only at the beginning of a word (after
        # whitespace, operators, or at the start of the string). Mid-word #
        # is literal: e.g. "echo a#foo" outputs "a#foo", # is NOT a comment.
        # Operator chars (;, &, |, (, )) also start new words in bash.
        if i == 0 or cmd[i-1] in (" ", "\t", "\n", ";", "&", "|", "(", ")"):
            nl = cmd.find("\n", i)
            if nl == -1:
                buf.append(cmd[i:]); break
            buf.append(cmd[i:nl]); i = nl + 1; continue
    # case/esac keyword detection (inside substitution, outside quotes).
    # Prevents case-pattern ) from prematurely closing $() context.
    if dq_stack and not in_dq and not in_bt:
        if c == "c" and cmd[i:i+5].startswith("case") and (i + 4 >= n or cmd[i+4] in (" ", "\t", "\n")):
            if i == 0 or cmd[i-1] in (" ", "\t", "\n", ";", "&", "|", "(", ")"):
                in_case += 1
        elif c == "e" and in_case > 0 and cmd[i:i+4] == "esac":
            a = i + 4
            if a >= n or cmd[a] in (" ", "\t", "\n", ";", ")", "&", "|"):
                if i == 0 or cmd[i-1] in (" ", "\t", "\n", ";", "&", "|", "(", ")"):
                    in_case -= 1
    if c == "$" and i + 1 < n and cmd[i+1] == "(":
        segs.append("".join(buf)); buf = []
        dq_stack.append(("s", in_dq)); in_dq = False
        i += 2; continue
    if c == "(" and not in_dq:
        dq_stack.append(("p", in_dq)); in_dq = False
        buf.append(c); i += 1; continue
    if c == ")":
        if in_case > 0 and dq_stack:
            buf.append(c); i += 1; continue
        if dq_stack and dq_stack[-1][0] == "s":
            segs.append("".join(buf)); buf = []
            in_dq = dq_stack.pop()[1]
        elif dq_stack and dq_stack[-1][0] == "p":
            in_dq = dq_stack.pop()[1]
            buf.append(c)
        else:
            buf.append(c)
        i += 1; continue
    if c == "`":
        segs.append("".join(buf)); buf = []
        if not in_bt:
            dq_stack.append(("b", in_dq)); in_dq = False; in_bt = True
        else:
            if dq_stack and dq_stack[-1][0] == "b":
                in_dq = dq_stack.pop()[1]
            in_bt = False
        i += 1; continue
    # Only split on operators when inside $() or backtick context (dq_stack
    # non-empty).  At the top level, operators inside quoted strings would
    # create false fragments — the primary pass already handles top-level
    # operator splitting correctly.
    if dq_stack:
        if c == "&" and i + 1 < n and cmd[i+1] == "&":
            segs.append("".join(buf)); buf = []; i += 2; continue
        if c == "|" and i + 1 < n and cmd[i+1] == "|":
            segs.append("".join(buf)); buf = []; i += 2; continue
        if c == ";":
            segs.append("".join(buf)); buf = []; i += 1; continue
        if c == "|":
            segs.append("".join(buf)); buf = []; i += 1; continue
    buf.append(c); i += 1
segs.append("".join(buf))
sys.stdout.write("\n".join(segs) + "\n")
' "$command" 2>/dev/null) || \
    deny "Secret guard: python3 required for secondary command analysis but failed or is unavailable."

# Heredoc detection: matches <<EOF, <<'EOF', <<"EOF", <<\EOF, <<-EOF, <<- 'EOF', << EOF
# Requires whitespace or start-of-string before << to exclude quoted literals ("<<EOF").
# Restricts quote chars to '"\  to exclude here-strings (<<<EOF where < is not a quote).
_HEREDOC_RE='(^|[[:space:]])<<(-?)[[:space:]]*['"'"'"\"\\]*([A-Za-z_][A-Za-z0-9_]*)'
_heredoc_delim=""
_heredoc_strip_tabs=""

for _pass in primary secondary; do
    # Reset heredoc state between passes to prevent primary-pass heredoc
    # from suppressing fragment checks in the secondary pass.
    _heredoc_delim=""
    _heredoc_strip_tabs=""

    if [[ "$_pass" == "primary" ]]; then
        _loop_subcmds="$subcmds"
    else
        _loop_subcmds="$_secondary_subcmds"
    fi

while IFS= read -r subcmd; do
    [[ -z "$subcmd" ]] && continue

    # If inside a heredoc body, check for closing delimiter then skip
    if [[ -n "$_heredoc_delim" ]]; then
        _hd_check="$subcmd"
        # For <<- heredocs, strip leading tabs before comparing
        [[ "$_heredoc_strip_tabs" == "1" ]] && _hd_check="${_hd_check#"${_hd_check%%[^	]*}"}"
        [[ "$_hd_check" == "$_heredoc_delim" ]] && _heredoc_delim=""
        continue
    fi

    # Detect heredoc start — track delimiter so body lines are skipped.
    # Guard against false matches inside quoted strings: count " and ' before <<.
    # Odd count = inside quotes. Only activate if $( after last quote (cmd substitution).
    # Final gate: delimiter must appear as a standalone line in the original command,
    # proving a heredoc body actually exists (prevents false activation on
    # `cat <<EOF && docker compose up` where && splits remove the body).
    if [[ "$subcmd" =~ $_HEREDOC_RE ]]; then
        _before_heredoc="${subcmd%%<<*}"
        _dq_count=$(printf '%s' "$_before_heredoc" | tr -cd '"' | wc -c | tr -d ' ')
        _sq_count=$(printf '%s' "$_before_heredoc" | tr -cd "'" | wc -c | tr -d ' ')
        _is_real_heredoc=1
        if (( _sq_count % 2 != 0 )); then
            _is_real_heredoc=0
        elif (( _dq_count % 2 != 0 )); then
            _after_last_dq="${_before_heredoc##*\"}"
            [[ "$_after_last_dq" != *'$('* ]] && _is_real_heredoc=0
        fi
        if [[ "$_is_real_heredoc" -eq 1 ]]; then
            _heredoc_strip_tabs=""
            [[ "${BASH_REMATCH[2]}" == "-" ]] && _heredoc_strip_tabs="1"
            _delim_candidate="${BASH_REMATCH[3]}"
            # Only activate if delimiter appears as a standalone line in the
            # original command (proves heredoc body exists in the input).
            if printf '%s\n' "$command" | grep -qx "[[:blank:]]*${_delim_candidate}"; then
                _heredoc_delim="$_delim_candidate"
            fi
        fi
    fi

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
    _FILE_READ_CMD_RE='^[[:space:]]*(cat|head|tail|less|more|bat|strings)[[:space:]]'
    _parsed_args=$(python3 -c '
import shlex, sys, json
try:
    args = shlex.split(sys.argv[1])
    json.dump(args, sys.stdout)
except ValueError:
    sys.exit(1)
' "$subcmd" 2>/dev/null)
    if [[ $? -ne 0 ]]; then
        # shlex.split failed — deny if raw text looks like a file-read command.
        # Primary pass: deny any file-read command (real commands with complex syntax).
        # Secondary pass: also require a sensitive path indicator, because the
        # secondary splitter creates quote-broken fragments where a file-read command
        # name may appear as literal text inside quotes (not an actual command).
        if echo "$subcmd" | grep -qE "$_FILE_READ_CMD_RE"; then
            if [[ "$_pass" == "primary" ]]; then
                deny "Secret guard: failed to parse file-read command arguments. Use the Read tool instead."
            else
                # Secondary pass: only deny if raw text also contains sensitive path indicators
                _SENSITIVE_HINT_RE='(\.ssh/|\.aws/credentials|\.env\.(secrets|local-secrets|team-secrets)|\.codex/config\.toml|\.pm/state\.db|\.npmrc|\.netrc|\.claude\.json|_rsa([[:space:]]|$)|\.pem([[:space:]]|$)|\.key([[:space:]]|$)|\.p12([[:space:]]|$)|credentials\.json|gh/hosts\.yml)'
                if echo "$subcmd" | grep -qE "$_SENSITIVE_HINT_RE"; then
                    deny "Secret guard: failed to parse file-read command arguments. Use the Read tool instead."
                fi
            fi
        fi
        # Not a file-read command, no sensitive path, or complex shell syntax — allow through
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

    # For 'case' commands, locate the 'in' keyword to skip the discriminant.
    # Syntax: case WORD in pattern) cmd ;; esac — WORD and 'in' are structural,
    # not file paths. Only check args after 'in' (the patterns and commands).
    _case_skip_until=0
    if [[ "$_cmd_name" == "case" ]]; then
        _case_skip_until=0
        for (( _si=1; _si<_arg_count; _si++ )); do
            _skip_arg=$(echo "$_parsed_args" | python3 -c "import json,sys; print(json.load(sys.stdin)[$_si])" 2>/dev/null) || break
            if [[ "$_skip_arg" == "in" ]]; then
                _case_skip_until=$(( _si + 1 ))
                break
            fi
        done
    fi

    if [[ "$_check_args" -ge 1 ]]; then
        for (( _i=1; _i<_arg_count; _i++ )); do
            # Skip case discriminant and 'in' keyword
            [[ "$_cmd_name" == "case" && _i -lt _case_skip_until ]] && continue
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
            # Both passes check metachar: the enhanced secondary sed splits on $(, ),
            # and backtick boundaries, so residue like ')' is separated into its own
            # fragment and won't false-trigger here.
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

done <<< "$_loop_subcmds"

done  # for _pass in primary secondary

# No sensitive file-read commands found — allow
exit 0
