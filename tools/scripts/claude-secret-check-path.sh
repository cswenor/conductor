#!/usr/bin/env bash
# Shared helper: check if a file path is sensitive.
#
# Exit codes:
#   0 = sensitive (caller should ask/deny)  — stdout: reason string
#   1 = safe (caller should allow)
#   2 = operational error                   — stdout: error description
#
# Called by:
#   claude-secret-guard.sh  (PreToolUse Read hook)
#   claude-secret-bash-guard.sh (PreToolUse Bash hook)

set -euo pipefail

if [[ $# -lt 1 ]]; then
    echo "Usage: claude-secret-check-path.sh <file_path>"
    exit 2
fi

FILE_PATH="$1"

# Resolve to absolute path for consistent matching
if [[ "$FILE_PATH" == ~* ]]; then
    FILE_PATH="${HOME}${FILE_PATH#\~}"
fi

# Normalize: remove trailing slashes, collapse double slashes
FILE_PATH=$(echo "$FILE_PATH" | sed 's|//*|/|g; s|/$||')

# ---------------------------------------------------------------------------
# Sensitive path patterns
# ---------------------------------------------------------------------------
# Each pattern is checked against the resolved file path.
# Add project-specific patterns to tools/config/secret-paths.conf (one per line).

SENSITIVE_PATTERNS=(
    # Environment and secret files
    '\.env$'
    '\.env\.'
    '/\.env$'
    '/\.env\.'

    # SSH keys
    '/\.ssh/'
    '\.pem$'
    '_rsa$'
    '_ed25519$'
    '_ecdsa$'
    '_dsa$'
    'id_rsa'
    'id_ed25519'

    # Cloud credentials
    '/\.aws/credentials'
    '/\.aws/config'
    '/\.gcloud/'
    '/\.config/gcloud/'
    '/\.azure/'

    # Package manager tokens
    '/\.npmrc$'
    '/\.yarnrc$'
    '/\.pypirc$'
    '/\.gem/credentials'

    # Docker secrets
    '/\.docker/config\.json'

    # GitHub tokens
    '/\.config/gh/hosts\.yml'

    # GPG keys
    '/\.gnupg/'

    # Kubernetes
    '/\.kube/config'

    # Terraform state (contains secrets)
    '\.tfstate$'
    '\.tfvars$'

    # Common secret file names
    'secrets\.json$'
    'secrets\.yml$'
    'secrets\.yaml$'
    'credentials\.json$'
    'service.account\.json$'
    'keyfile\.json$'

    # Codex config (may contain API keys)
    '/\.codex/'
)

# ---------------------------------------------------------------------------
# Check against built-in patterns
# ---------------------------------------------------------------------------
for pattern in "${SENSITIVE_PATTERNS[@]}"; do
    if echo "$FILE_PATH" | grep -qE "$pattern" 2>/dev/null; then
        echo "Sensitive file detected: $FILE_PATH (matches pattern: $pattern)"
        exit 0
    fi
done

# ---------------------------------------------------------------------------
# Check against project-specific patterns (if config exists)
# ---------------------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CUSTOM_PATTERNS="$SCRIPT_DIR/../config/secret-paths.conf"

if [[ -f "$CUSTOM_PATTERNS" ]]; then
    while IFS= read -r pattern; do
        # Skip comments and empty lines
        [[ -z "$pattern" || "$pattern" == \#* ]] && continue
        if echo "$FILE_PATH" | grep -qE "$pattern" 2>/dev/null; then
            echo "Sensitive file detected: $FILE_PATH (matches custom pattern: $pattern)"
            exit 0
        fi
    done < "$CUSTOM_PATTERNS"
fi

# Not sensitive
exit 1
