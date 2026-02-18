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

# Split command on separators (&&, ||, ;, |, newlines) into sub-commands.
# Uses sed with literal newline for macOS compatibility.
subcmds=$(printf '%s' "$command" | sed $'s/&&/\\\n/g; s/||/\\\n/g; s/;/\\\n/g; s/|/\\\n/g')

while IFS= read -r subcmd; do
    [[ -z "$subcmd" ]] && continue

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

        # 6. Normalize package manager flags before subcommand
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

done <<< "$subcmds"

# No match — allow
exit 0
