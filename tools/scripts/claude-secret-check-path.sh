#!/usr/bin/env bash
# Shared helper: check if a file path is sensitive.
#
# Exit codes:
#   0 = sensitive path (prints reason to stdout)
#   1 = safe path (no output)
#   2 = operational error (prints error to stdout)

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG="$SCRIPT_DIR/../config/secret-patterns.json"

file_path="${1:-}"

if [[ -z "$file_path" ]]; then
    echo "Secret path check: no file path provided"
    exit 2
fi

if [[ ! -f "$CONFIG" ]]; then
    echo "Secret path check: config missing at $CONFIG"
    exit 2
fi

# Require python3 for portable path canonicalization
if ! command -v python3 &>/dev/null; then
    echo "Secret path check: python3 required but not found"
    exit 2
fi

# Require jq for config parsing
if ! command -v jq &>/dev/null; then
    echo "Secret path check: jq required but not found"
    exit 2
fi

# Validate config is parseable JSON with required schema
if ! jq empty "$CONFIG" 2>/dev/null; then
    echo "Secret path check: config is not valid JSON"
    exit 2
fi
# Validate required arrays exist (fail-closed on schema drift)
for _required_key in sensitive_exact_paths sensitive_path_globs sensitive_path_patterns; do
    if ! jq -e ".$_required_key | type == \"array\"" "$CONFIG" >/dev/null 2>&1; then
        echo "Secret path check: config missing or invalid '$_required_key' array"
        exit 2
    fi
done

# Canonicalize input path: expanduser → expandvars → realpath
canonical=$(python3 -c '
import os, sys
try:
    print(os.path.realpath(os.path.expandvars(os.path.expanduser(sys.argv[1]))))
except Exception as e:
    print(f"Secret path check: canonicalization failed: {e}", file=sys.stderr)
    sys.exit(1)
' "$file_path" 2>/dev/null) || {
    echo "Secret path check: failed to canonicalize path '$file_path'"
    exit 2
}

# --- Check 1: Exact paths ---
while IFS= read -r configured_path; do
    [[ -z "$configured_path" ]] && continue
    # Canonicalize configured path with same chain
    configured_canonical=$(python3 -c '
import os, sys
try:
    print(os.path.realpath(os.path.expandvars(os.path.expanduser(sys.argv[1]))))
except Exception as e:
    sys.exit(1)
' "$configured_path" 2>/dev/null) || continue
    if [[ "$canonical" == "$configured_canonical" ]]; then
        echo "Sensitive file: matches exact path '$configured_path'"
        exit 0
    fi
done < <(jq -r '.sensitive_exact_paths[]' "$CONFIG" 2>/dev/null)

# --- Check 2: Glob patterns ---
while IFS= read -r glob; do
    [[ -z "$glob" ]] && continue
    # shellcheck disable=SC2053
    if [[ "$canonical" == $glob ]]; then
        echo "Sensitive file: matches glob pattern '$glob'"
        exit 0
    fi
done < <(jq -r '.sensitive_path_globs[]' "$CONFIG" 2>/dev/null)

# --- Check 3: Regex patterns ---
while IFS= read -r pattern; do
    [[ -z "$pattern" ]] && continue
    # Validate regex: grep returns 2 for invalid regex
    echo "" | grep -qE "$pattern" 2>/dev/null
    _grep_exit=$?
    if [[ "$_grep_exit" -eq 2 ]]; then
        echo "Secret path check: invalid regex pattern '$pattern'"
        exit 2
    fi
    if echo "$canonical" | grep -qE "$pattern" 2>/dev/null; then
        echo "Sensitive file: matches pattern '$pattern'"
        exit 0
    fi
done < <(jq -r '.sensitive_path_patterns[]' "$CONFIG" 2>/dev/null)

# Not sensitive
exit 1
