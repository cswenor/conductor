#!/usr/bin/env bash
# Claude Code PostToolUse hook for Read AND Bash tools.
# Detects secret patterns in tool output and warns Claude not to repeat them.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG="$SCRIPT_DIR/../config/secret-patterns.json"

warn() {
    jq -n --arg ctx "$1" \
        '{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":$ctx}}'
    exit 0
}

# Read and parse input JSON
input=$(cat) || {
    warn "Secret detection: failed to read hook input. Tool output may contain secrets — do not repeat any token-like values."
}

tool_name=$(printf '%s' "$input" | jq -r '.tool_name // empty' 2>/dev/null) || {
    warn "Secret detection: failed to parse hook input. Tool output may contain secrets — do not repeat any token-like values."
}

# Extract tool output based on tool type
output_text=""
case "$tool_name" in
    Read)
        output_text=$(printf '%s' "$input" | jq -r '.tool_response.file.content // empty' 2>/dev/null) || true
        ;;
    Bash)
        output_text=$(printf '%s' "$input" | jq -r '.tool_response.stdout // empty' 2>/dev/null) || true
        # Also check stderr
        stderr_text=$(printf '%s' "$input" | jq -r '.tool_response.stderr // empty' 2>/dev/null) || true
        if [[ -n "$stderr_text" ]]; then
            output_text="${output_text}${stderr_text}"
        fi
        ;;
    *)
        # Unknown tool type — nothing to scan
        exit 0
        ;;
esac

if [[ -z "$output_text" ]]; then
    exit 0
fi

# Validate config exists and is parseable
if [[ ! -f "$CONFIG" ]]; then
    warn "Secret detection config is missing. Tool output may contain secrets — do not repeat any token-like values."
fi

if ! jq empty "$CONFIG" 2>/dev/null; then
    warn "Secret detection config is invalid JSON. Tool output may contain secrets — do not repeat any token-like values."
fi

# Validate required schema (fail-closed on schema drift)
if ! jq -e '.secret_token_patterns | type == "array"' "$CONFIG" >/dev/null 2>&1; then
    warn "Secret detection config missing or invalid 'secret_token_patterns' array. Tool output may contain secrets — do not repeat any token-like values."
fi

# Scan output against secret token patterns
_detected=""
_pattern_count=$(jq '.secret_token_patterns | length' "$CONFIG" 2>/dev/null) || {
    warn "Secret detection: failed to read patterns from config. Tool output may contain secrets — do not repeat any token-like values."
}

for (( _i=0; _i<_pattern_count; _i++ )); do
    _name=$(jq -r ".secret_token_patterns[$_i].name" "$CONFIG" 2>/dev/null) || continue
    _pattern=$(jq -r ".secret_token_patterns[$_i].pattern" "$CONFIG" 2>/dev/null) || continue
    _min_unique=$(jq -r ".secret_token_patterns[$_i].min_unique_chars // 0" "$CONFIG" 2>/dev/null) || _min_unique=0

    [[ -z "$_pattern" ]] && continue

    # Validate regex: grep returns 2 for invalid regex
    echo "" | grep -qE "$_pattern" 2>/dev/null
    _grep_exit=$?
    if [[ "$_grep_exit" -eq 2 ]]; then
        warn "Secret detection: invalid regex pattern '$_name'. Tool output may contain secrets."
    fi

    # Check for matches
    _matches=$(echo "$output_text" | grep -oE "$_pattern" 2>/dev/null) || continue
    [[ -z "$_matches" ]] && continue

    # Apply additional filters for patterns that need them
    if [[ "$_min_unique" -gt 0 ]]; then
        _has_real_match=0
        while IFS= read -r _match; do
            [[ -z "$_match" ]] && continue

            # Strip trailing = padding for analysis
            _stripped="${_match%%=*}"
            [[ -z "$_stripped" ]] && continue

            # Stage 1: Check min unique chars
            _unique_count=$(echo "$_stripped" | fold -w1 | sort -u | wc -l | tr -d ' ')
            if [[ "$_unique_count" -lt "$_min_unique" ]]; then
                continue
            fi

            # Stage 2: Hex exclusion — skip if purely hex chars
            if echo "$_stripped" | grep -qE '^[0-9A-Fa-f]+$' 2>/dev/null; then
                continue
            fi

            # Stage 3: Integrity hash context exclusion
            # Check if the match appears after sha256-, sha384-, or sha512- in the output
            # Use grep -F (fixed string) because the match may contain +, / etc.
            _is_integrity=0
            for _sha_prefix in sha256 sha384 sha512; do
                if echo "$output_text" | grep -qF "${_sha_prefix}-${_match}" 2>/dev/null; then
                    _is_integrity=1
                    break
                fi
            done
            if [[ "$_is_integrity" -eq 1 ]]; then
                continue
            fi

            _has_real_match=1
            break
        done <<< "$_matches"

        if [[ "$_has_real_match" -eq 0 ]]; then
            continue
        fi
    fi

    if [[ -z "$_detected" ]]; then
        _detected="$_name"
    else
        _detected="$_detected, $_name"
    fi
done

if [[ -n "$_detected" ]]; then
    warn "WARNING: Possible secrets detected in tool output ($_detected). DO NOT repeat, display, or include these values in your response. Summarize the file content without including the actual secret values."
fi

# No secrets detected
exit 0
