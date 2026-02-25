#!/usr/bin/env bash
# Claude Code PreToolUse hook for the Bash tool.
# Inspects commands before execution and denies forbidden patterns
# with helpful redirect messages.
#
# Fail-open: any parse error or unexpected input → allow (exit 0, no output).
# Only deny on confirmed pattern matches.

# ---------- helpers ----------

deny() {
    jq -n --arg reason "$1" \
        '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":$reason}}'
    exit 0
}

# ---------- read & extract ----------

input=$(cat) || exit 0
command=$(printf '%s' "$input" | jq -r '.tool_input.command // empty' 2>/dev/null) || exit 0
[[ -z "$command" ]] && exit 0

# ---------- blocked patterns (POSIX ERE) ----------

DOCKER_RE='^docker[[:space:]]+(compose|build|run)'
DOCKER_COMPOSE_RE='^docker-compose'
DOCKER_MSG='Use `make` targets instead. Run `make help` for available targets.'

PKG_ADD_RE='^pnpm[[:space:]]+add([[:space:]]|$)'
NPM_INSTALL_RE='^npm[[:space:]]+(install|i)[[:space:]]+.'
YARN_ADD_RE='^yarn[[:space:]]+add([[:space:]]|$)'
PKG_MSG='Do not add dependencies via CLI. Edit package.json, then run `make install`. See CLAUDE.md.'

BARE_INSTALL_RE='^(pnpm|npm|yarn)[[:space:]]+(install|i|ci)([[:space:]]|$)'
BARE_INSTALL_MSG='Do not run install commands on the host. Use `make install` which runs inside the dev container with correct platform binaries.'

CD_INFRA_RE='^cd[[:space:]]+(\.\/)?infra([/[:space:]]|$)'
CD_INFRA_MSG='Do not cd into infra/. Use `make` targets which handle paths correctly.'

PIP_RE='^pip3?[[:space:]]+install([[:space:]]|$)'
PIP_MSG='Do not manually install Python packages. Use `make` targets or the dev container.'

# ---------- normalize & check ----------

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
# The secondary sed pass below provides defense-in-depth for nested blocked commands.
subcmds=$(split_top_level "$command")
# shellcheck disable=SC2181  # exit code checked intentionally for clarity
if [[ $? -ne 0 ]]; then
    : # Parse anomaly — proceed with partial output (fail-open design)
fi

# Also split with sed to catch blocked commands inside $() and backticks.
# The nesting-aware splitter keeps $() content intact (by design), but blocked
# commands inside $() are still executed and must be denied. The command guard's
# blocked patterns are specific enough that sed over-splitting doesn't cause
# false denials (unlike the secret guard where metachar checks would fire).
subcmds_sed=$(printf '%s' "$command" | sed $'s/&&/\\\n/g; s/||/\\\n/g; s/;/\\\n/g; s/|/\\\n/g')

# Heredoc detection: matches <<EOF, <<'EOF', <<"EOF", <<\EOF, <<-EOF, <<- 'EOF', << EOF
# Requires whitespace or start-of-string before << to exclude quoted literals ("<<EOF").
# Restricts quote chars to '"\  to exclude here-strings (<<<EOF where < is not a quote).
_HEREDOC_RE='(^|[[:space:]])<<(-?)[[:space:]]*['"'"'"\"\\]*([A-Za-z_][A-Za-z0-9_]*)'

# Process nesting-aware and sed splits in separate passes so heredoc state
# from one pass doesn't suppress checks in the other.
for _pass in primary secondary; do
    _heredoc_delim=""
    _heredoc_strip_tabs=""

    if [[ "$_pass" == "primary" ]]; then
        _loop_subcmds="$subcmds"
    else
        _loop_subcmds="$subcmds_sed"
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

    # Iterative normalization loop
    prev=""
    while [[ "$subcmd" != "$prev" ]]; do
        prev="$subcmd"

        # 1a. Strip leading whitespace
        subcmd="${subcmd#"${subcmd%%[![:space:]]*}"}"

        # 1b. Strip trailing whitespace
        subcmd="${subcmd%"${subcmd##*[![:space:]]}"}"

        # 2. Strip subshell / command-substitution wrappers
        if [[ "$subcmd" == '$('*')' ]]; then
            subcmd="${subcmd#\$\(}"
            subcmd="${subcmd%\)}"
        elif [[ "$subcmd" == '('*')' ]]; then
            subcmd="${subcmd#\(}"
            subcmd="${subcmd%\)}"
        fi

        # 3. Strip absolute path prefix (e.g. /usr/bin/docker → docker)
        if [[ "$subcmd" =~ ^/ ]]; then
            subcmd=$(printf '%s' "$subcmd" | sed 's|^/[^ ]*/||')
        fi

        # 4. Strip leading env assignments (VAR=value patterns)
        while [[ "$subcmd" =~ ^[A-Za-z_][A-Za-z0-9_]*=([^[:space:]]*|\"[^\"]*\"|\'[^\']*\')[[:space:]]+ ]]; do
            subcmd="${subcmd#*"${BASH_REMATCH[0]}"}"
        done

        # 5. Strip one wrapper prefix with its options: command, env, sudo
        #    Handles: env -i, sudo -u root, command --, etc.
        if [[ "$subcmd" =~ ^(command|env|sudo)[[:space:]]+ ]]; then
            subcmd="${subcmd#"${BASH_REMATCH[0]}"}"
            # Strip flags, end-of-options markers, and likely flag arguments
            _wrapper_done=0
            while [[ -n "$subcmd" && "$_wrapper_done" -eq 0 ]]; do
                subcmd="${subcmd#"${subcmd%%[![:space:]]*}"}"
                [[ -z "$subcmd" ]] && break
                _token="${subcmd%%[[:space:]]*}"
                if [[ "$_token" == -- ]]; then
                    # End-of-options marker: strip and stop
                    subcmd="${subcmd#--}"
                    _wrapper_done=1
                elif [[ "$_token" == -* ]]; then
                    # A flag: strip it
                    subcmd="${subcmd#"$_token"}"
                    subcmd="${subcmd#"${subcmd%%[![:space:]]*}"}"
                    [[ -z "$subcmd" ]] && break
                    # Check if next token is a flag argument (not a flag, not a path)
                    _next="${subcmd%%[[:space:]]*}"
                    if [[ "$_next" != -* && "$_next" != */* ]]; then
                        # Only strip if not a known command name
                        case "$_next" in
                            docker|docker-compose|pnpm|npm|yarn|cd|pip|pip3) _wrapper_done=1 ;;
                            *) subcmd="${subcmd#"$_next"}" ;;
                        esac
                    fi
                else
                    # Not a flag — this is the actual command
                    _wrapper_done=1
                fi
            done
        fi

        # 6. Strip case-pattern prefix (e.g. "x) " or "start) " or "x-y) ")
        #    When sed splitting fragments case statements, the fragment
        #    "x) docker compose up" has a case pattern prefix that prevents
        #    matching blocked patterns. Strip it to expose the real command.
        #    Includes hyphens for patterns like "x-y)". Excludes /, ., ~ to
        #    avoid stripping paths.
        if [[ "$subcmd" =~ ^[-A-Za-z0-9_*?\|]+\)[[:space:]]+ ]]; then
            subcmd="${subcmd#"${BASH_REMATCH[0]}"}"
        fi

        # 7. Normalize package manager flags before subcommand
        #    Strips flags (and their values for value-taking flags) so the
        #    existing BARE_INSTALL_RE sees the real subcommand.
        if [[ "$subcmd" =~ ^(pnpm|npm|yarn)[[:space:]]+ ]]; then
            _pm_prefix="${BASH_REMATCH[0]}"
            _pm_rest="${subcmd:${#_pm_prefix}}"
            _pm_done=0
            while [[ -n "$_pm_rest" && "$_pm_done" -eq 0 ]]; do
                _pm_rest="${_pm_rest#"${_pm_rest%%[![:space:]]*}"}"
                [[ -z "$_pm_rest" ]] && break
                _token="${_pm_rest%%[[:space:]]*}"
                if [[ "$_token" == -* ]]; then
                    # A flag: strip it
                    _pm_rest="${_pm_rest#"$_token"}"
                    _pm_rest="${_pm_rest#"${_pm_rest%%[![:space:]]*}"}"
                    [[ -z "$_pm_rest" ]] && break
                    # If --key=value syntax, the value is already consumed with the flag
                    if [[ "$_token" != *=* ]]; then
                        _next="${_pm_rest%%[[:space:]]*}"
                        case "$_token" in
                            # Known value flags: always consume next token
                            # (even if it looks like a subcommand, e.g. --filter install)
                            --filter|-F|--filter-prod|-C|--dir|--store-dir|\
                            --virtual-store-dir|--global-dir|--lockfile-dir|\
                            --modules-dir|--reporter|--loglevel|\
                            --prefix|--registry|--cache|--userconfig|\
                            --cwd|--mutex|--network-timeout)
                                _pm_rest="${_pm_rest#"$_next"}" ;;
                            *)
                                # Unknown flag: consume next token as value
                                # UNLESS it's a known subcommand (safe to leave)
                                case "$_next" in
                                    install|i|ci|add|remove|rm|uninstall|\
                                    update|up|upgrade|link|ln|unlink|\
                                    run|test|t|exec|dlx|create|init|\
                                    publish|pack|list|ls|why|outdated|\
                                    audit|bin|root|store|help|doctor|\
                                    rebuild|rb|prune|fetch|dedupe|patch|setup)
                                        ;; # Leave it — it's the real subcommand
                                    *)
                                        _pm_rest="${_pm_rest#"$_next"}" ;; # Consume as flag value
                                esac ;;
                        esac
                    fi
                else
                    _pm_done=1  # Not a flag — this is the subcommand
                fi
            done
            subcmd="${_pm_prefix}${_pm_rest}"
        fi
    done

    [[ -z "$subcmd" ]] && continue

    # Check against blocked patterns
    if echo "$subcmd" | grep -qE "$DOCKER_RE"; then
        deny "$DOCKER_MSG"
    fi
    if echo "$subcmd" | grep -qE "$DOCKER_COMPOSE_RE"; then
        deny "$DOCKER_MSG"
    fi
    if echo "$subcmd" | grep -qE "$PKG_ADD_RE"; then
        deny "$PKG_MSG"
    fi
    if echo "$subcmd" | grep -qE "$NPM_INSTALL_RE"; then
        deny "$PKG_MSG"
    fi
    if echo "$subcmd" | grep -qE "$YARN_ADD_RE"; then
        deny "$PKG_MSG"
    fi
    if echo "$subcmd" | grep -qE "$BARE_INSTALL_RE"; then
        deny "$BARE_INSTALL_MSG"
    fi
    if echo "$subcmd" | grep -qE "$CD_INFRA_RE"; then
        deny "$CD_INFRA_MSG"
    fi
    if echo "$subcmd" | grep -qE "$PIP_RE"; then
        deny "$PIP_MSG"
    fi

done <<< "$_loop_subcmds"
done  # end for _pass

# No match — allow
exit 0
