#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PATH_HELPER="$SCRIPT_DIR/claude-secret-check-path.sh"
READ_GUARD="$SCRIPT_DIR/claude-secret-guard.sh"
DETECT_HOOK="$SCRIPT_DIR/claude-secret-detect.sh"
BASH_GUARD="$SCRIPT_DIR/claude-secret-bash-guard.sh"
FIXTURES_DIR="$SCRIPT_DIR/../test-fixtures"
CONFIG="$SCRIPT_DIR/../config/secret-patterns.json"
SETTINGS="$SCRIPT_DIR/../../.claude/settings.json"

pass=0
fail=0

# ============================================================
# Test helpers
# ============================================================

assert_path_sensitive() {
    local desc="$1" path="$2"
    local out exit_code
    out=$("$PATH_HELPER" "$path" 2>&1) && exit_code=0 || exit_code=$?
    if [[ "$exit_code" -eq 0 ]]; then
        pass=$((pass + 1))
    else
        echo "FAIL (expected sensitive, exit 0): $desc"
        echo "  path: $path"
        echo "  exit: $exit_code"
        echo "  output: $out"
        fail=$((fail + 1))
    fi
}

assert_path_safe() {
    local desc="$1" path="$2"
    local out exit_code
    out=$("$PATH_HELPER" "$path" 2>&1) && exit_code=0 || exit_code=$?
    if [[ "$exit_code" -eq 1 ]]; then
        pass=$((pass + 1))
    else
        echo "FAIL (expected safe, exit 1): $desc"
        echo "  path: $path"
        echo "  exit: $exit_code"
        echo "  output: $out"
        fail=$((fail + 1))
    fi
}

assert_path_error() {
    local desc="$1" path="$2"
    local out exit_code
    out=$("$PATH_HELPER" "$path" 2>&1) && exit_code=0 || exit_code=$?
    if [[ "$exit_code" -eq 2 ]]; then
        pass=$((pass + 1))
    else
        echo "FAIL (expected error, exit 2): $desc"
        echo "  path: $path"
        echo "  exit: $exit_code"
        echo "  output: $out"
        fail=$((fail + 1))
    fi
}

assert_read_guard_ask() {
    local desc="$1" json_input="$2"
    local out
    out=$(printf '%s' "$json_input" | "$READ_GUARD" 2>/dev/null)
    if echo "$out" | grep -q '"ask"'; then
        pass=$((pass + 1))
    else
        echo "FAIL (expected ask): $desc"
        echo "  output: $out"
        fail=$((fail + 1))
    fi
}

assert_read_guard_allow() {
    local desc="$1" json_input="$2"
    local out
    out=$(printf '%s' "$json_input" | "$READ_GUARD" 2>/dev/null)
    if [[ -z "$out" ]]; then
        pass=$((pass + 1))
    else
        echo "FAIL (expected allow/empty): $desc"
        echo "  output: $out"
        fail=$((fail + 1))
    fi
}

assert_detect_warns() {
    local desc="$1" json_input="$2" expected_name="$3"
    local out
    out=$(printf '%s' "$json_input" | "$DETECT_HOOK" 2>/dev/null)
    if echo "$out" | grep -q "additionalContext" && echo "$out" | grep -q "$expected_name"; then
        pass=$((pass + 1))
    else
        echo "FAIL (expected warning '$expected_name'): $desc"
        echo "  output: $out"
        fail=$((fail + 1))
    fi
}

assert_detect_silent() {
    local desc="$1" json_input="$2"
    local out
    out=$(printf '%s' "$json_input" | "$DETECT_HOOK" 2>/dev/null)
    if [[ -z "$out" ]]; then
        pass=$((pass + 1))
    else
        echo "FAIL (expected silent): $desc"
        echo "  output: $out"
        fail=$((fail + 1))
    fi
}

assert_detect_warns_generic() {
    local desc="$1" json_input="$2"
    local out
    out=$(printf '%s' "$json_input" | "$DETECT_HOOK" 2>/dev/null)
    if echo "$out" | grep -q "additionalContext"; then
        pass=$((pass + 1))
    else
        echo "FAIL (expected any warning): $desc"
        echo "  output: $out"
        fail=$((fail + 1))
    fi
}

assert_bash_guard_deny() {
    local desc="$1" cmd="$2"
    local out
    out=$(jq -nc --arg cmd "$cmd" '{"tool_input":{"command":$cmd}}' | "$BASH_GUARD" 2>/dev/null)
    if echo "$out" | grep -q '"deny"'; then
        pass=$((pass + 1))
    else
        echo "FAIL (expected deny): $desc"
        echo "  command: $cmd"
        echo "  output: $out"
        fail=$((fail + 1))
    fi
}

assert_bash_guard_allow() {
    local desc="$1" cmd="$2"
    local out
    out=$(jq -nc --arg cmd "$cmd" '{"tool_input":{"command":$cmd}}' | "$BASH_GUARD" 2>/dev/null)
    if [[ -z "$out" ]]; then
        pass=$((pass + 1))
    else
        echo "FAIL (expected allow): $desc"
        echo "  command: $cmd"
        echo "  output: $out"
        fail=$((fail + 1))
    fi
}

assert_bash_guard_deny_contains() {
    local desc="$1" cmd="$2" expected="$3"
    local out
    out=$(jq -nc --arg cmd "$cmd" '{"tool_input":{"command":$cmd}}' | "$BASH_GUARD" 2>/dev/null)
    if echo "$out" | grep -q '"deny"' && echo "$out" | grep -qi "$expected"; then
        pass=$((pass + 1))
    else
        echo "FAIL (expected deny containing '$expected'): $desc"
        echo "  command: $cmd"
        echo "  output: $out"
        fail=$((fail + 1))
    fi
}

# Build a PostToolUse Read payload with given content
make_read_payload() {
    local content="$1"
    jq -nc --arg content "$content" '{
        "tool_name": "Read",
        "tool_input": {"file_path": "test/file.txt"},
        "tool_response": {"type": "text", "file": {"filePath": "test/file.txt", "content": $content, "numLines": 1, "startLine": 1, "totalLines": 1}}
    }'
}

# Build a PostToolUse Bash payload with given stdout
make_bash_payload() {
    local stdout="$1"
    jq -nc --arg stdout "$stdout" '{
        "tool_name": "Bash",
        "tool_input": {"command": "test-command"},
        "tool_response": {"stdout": $stdout, "stderr": "", "interrupted": false}
    }'
}

echo "==> Running claude-secret-guard tests..."

# ============================================================
# Fixture-based contract tests
# ============================================================

echo ""
echo "--- Fixture contract tests ---"

# PreToolUse Read fixture: confirm tool_input.file_path extraction
_fixture_path=$(jq -r '.tool_input.file_path' "$FIXTURES_DIR/pretooluse-read.json" 2>/dev/null)
if [[ "$_fixture_path" == "src/lib/example.ts" ]]; then
    pass=$((pass + 1))
else
    echo "FAIL: PreToolUse Read fixture — tool_input.file_path extraction"
    echo "  expected: src/lib/example.ts"
    echo "  got: $_fixture_path"
    fail=$((fail + 1))
fi

# PostToolUse Read fixture: confirm tool_response.file.content extraction
_fixture_content=$(jq -r '.tool_response.file.content' "$FIXTURES_DIR/posttooluse-read.json" 2>/dev/null)
if [[ "$_fixture_content" == 'function hello() { return "world"; }' ]]; then
    pass=$((pass + 1))
else
    echo "FAIL: PostToolUse Read fixture — tool_response.file.content extraction"
    echo "  expected: function hello() { return \"world\"; }"
    echo "  got: $_fixture_content"
    fail=$((fail + 1))
fi

# PostToolUse Bash fixture: confirm tool_response.stdout extraction
_fixture_stdout=$(jq -r '.tool_response.stdout' "$FIXTURES_DIR/posttooluse-bash.json" 2>/dev/null)
if [[ "$_fixture_stdout" == "hello-world"* ]]; then
    pass=$((pass + 1))
else
    echo "FAIL: PostToolUse Bash fixture — tool_response.stdout extraction"
    echo "  expected starts with: hello-world"
    echo "  got: $_fixture_stdout"
    fail=$((fail + 1))
fi

# ============================================================
# Path checking tests (shared helper)
# ============================================================

echo ""
echo "--- Exact path tests ---"

assert_path_sensitive "~/.codex/config.toml"       "$HOME/.codex/config.toml"
assert_path_sensitive "~/.pm/state.db"               "$HOME/.pm/state.db"
assert_path_sensitive "~/.aws/credentials"          "$HOME/.aws/credentials"
assert_path_sensitive "~/.npmrc"                    "$HOME/.npmrc"
assert_path_sensitive "~/.netrc"                    "$HOME/.netrc"
assert_path_sensitive "~/.claude.json"              "$HOME/.claude.json"
assert_path_sensitive "~/.config/gh/hosts.yml"      "$HOME/.config/gh/hosts.yml"

echo ""
echo "--- Glob pattern tests ---"

assert_path_sensitive ".env.secrets"                "/any/path/.env.secrets"
assert_path_sensitive ".env.local-secrets"          "/any/path/.env.local-secrets"
assert_path_sensitive ".env.team-secrets"           "/any/path/.env.team-secrets"
assert_path_sensitive ".ssh/id_rsa"                 "/any/path/.ssh/id_rsa"
assert_path_sensitive ".ssh/id_ed25519"             "/any/path/.ssh/id_ed25519"

echo ""
echo "--- Regex pattern tests ---"

assert_path_sensitive "server.pem"                  "/path/to/server.pem"
assert_path_sensitive "private.key"                 "/path/to/private.key"
assert_path_sensitive "id_rsa"                      "/path/to/id_rsa"
assert_path_sensitive "cert.p12"                    "/path/to/cert.p12"
assert_path_sensitive "credentials.json"            "/path/to/credentials.json"

echo ""
echo "--- Safe path tests ---"

assert_path_safe "src/lib/index.ts"                "src/lib/index.ts"
assert_path_safe "README.md"                       "README.md"
assert_path_safe "package.json"                    "package.json"
assert_path_safe ".claude/settings.json"           ".claude/settings.json"

echo ""
echo "--- Canonicalization bypass tests ---"

# Relative traversal — create a symlink to test
_test_tmpdir=$(mktemp -d)
mkdir -p "$_test_tmpdir/.codex"
touch "$_test_tmpdir/.codex/config.toml"
_symlink_test="$_test_tmpdir/link-to-secret"
ln -s "$_test_tmpdir/.codex/config.toml" "$_symlink_test"

# Note: relative traversal tests use the exact path from config which expands ~ to $HOME
# We test that $HOME-prefixed form works
assert_path_sensitive "\$HOME/.codex/config.toml (env-var form)" "\$HOME/.codex/config.toml"
assert_path_sensitive "\${HOME}/.codex/config.toml (braced form)" "\${HOME}/.codex/config.toml"

# Symlink test — the helper resolves symlinks via realpath, but will only match if
# the resolved target matches a configured path. We test with a real symlink to $HOME path.
if [[ -f "$HOME/.codex/config.toml" ]]; then
    _symlink_home_test="$_test_tmpdir/link-to-home-codex"
    ln -s "$HOME/.codex/config.toml" "$_symlink_home_test"
    assert_path_sensitive "symlink to ~/.codex/config.toml" "$_symlink_home_test"
else
    # If the actual file doesn't exist, realpath won't resolve — skip gracefully
    echo "  SKIP: symlink test (no ~/.codex/config.toml on this system)"
    pass=$((pass + 1))
fi

rm -rf "$_test_tmpdir"

echo ""
echo "--- Error path tests ---"

# Config missing
_saved_config="$CONFIG.bak"
mv "$CONFIG" "$_saved_config"
_out=$("$PATH_HELPER" "/some/file" 2>&1) && _exit=0 || _exit=$?
if [[ "$_exit" -eq 2 ]] && echo "$_out" | grep -qi "config"; then
    pass=$((pass + 1))
else
    echo "FAIL: config missing → exit 2"
    echo "  exit: $_exit, output: $_out"
    fail=$((fail + 1))
fi
mv "$_saved_config" "$CONFIG"

# Invalid regex in config (inject a bad pattern temporarily)
_saved_config2="$CONFIG.bak2"
cp "$CONFIG" "$_saved_config2"
# Replace first regex pattern with an invalid one
python3 -c '
import json, sys
with open(sys.argv[1], "r") as f:
    cfg = json.load(f)
cfg["sensitive_path_patterns"] = ["(unclosed"]
with open(sys.argv[1], "w") as f:
    json.dump(cfg, f)
' "$CONFIG"
_out=$("$PATH_HELPER" "/path/to/something" 2>&1) && _exit=0 || _exit=$?
if [[ "$_exit" -eq 2 ]] && echo "$_out" | grep -qi "invalid\|regex\|pattern"; then
    pass=$((pass + 1))
else
    echo "FAIL: invalid regex → exit 2 with error"
    echo "  exit: $_exit, output: $_out"
    fail=$((fail + 1))
fi
mv "$_saved_config2" "$CONFIG"

# Schema drift: valid JSON but missing required arrays (e.g., {})
_saved_config3="$CONFIG.bak3"
cp "$CONFIG" "$_saved_config3"
echo '{}' > "$CONFIG"
_out=$("$PATH_HELPER" "/some/file" 2>&1) && _exit=0 || _exit=$?
if [[ "$_exit" -eq 2 ]] && echo "$_out" | grep -qi "missing\|invalid\|array"; then
    pass=$((pass + 1))
else
    echo "FAIL: schema drift (empty object) → exit 2"
    echo "  exit: $_exit, output: $_out"
    fail=$((fail + 1))
fi
mv "$_saved_config3" "$CONFIG"

# Schema drift: arrays exist but wrong type (e.g., string instead of array)
_saved_config4="$CONFIG.bak4"
cp "$CONFIG" "$_saved_config4"
echo '{"sensitive_exact_paths":"not-an-array","sensitive_path_globs":[],"sensitive_path_patterns":[]}' > "$CONFIG"
_out=$("$PATH_HELPER" "/some/file" 2>&1) && _exit=0 || _exit=$?
if [[ "$_exit" -eq 2 ]] && echo "$_out" | grep -qi "missing\|invalid\|array"; then
    pass=$((pass + 1))
else
    echo "FAIL: schema drift (string instead of array) → exit 2"
    echo "  exit: $_exit, output: $_out"
    fail=$((fail + 1))
fi
mv "$_saved_config4" "$CONFIG"

# ============================================================
# Hook wiring assertion tests
# ============================================================

echo ""
echo "--- Hook wiring tests ---"

# Read PreToolUse entry
if jq -e '.hooks.PreToolUse[] | select(.matcher == "Read") | .hooks[] | select(.command | contains("claude-secret-guard.sh"))' "$SETTINGS" >/dev/null 2>&1; then
    pass=$((pass + 1))
else
    echo "FAIL: settings.json missing Read PreToolUse → claude-secret-guard.sh"
    fail=$((fail + 1))
fi

# Read PostToolUse entry
if jq -e '.hooks.PostToolUse[] | select(.matcher == "Read") | .hooks[] | select(.command | contains("claude-secret-detect.sh"))' "$SETTINGS" >/dev/null 2>&1; then
    pass=$((pass + 1))
else
    echo "FAIL: settings.json missing Read PostToolUse → claude-secret-detect.sh"
    fail=$((fail + 1))
fi

# Bash PostToolUse entry
if jq -e '.hooks.PostToolUse[] | select(.matcher == "Bash") | .hooks[] | select(.command | contains("claude-secret-detect.sh"))' "$SETTINGS" >/dev/null 2>&1; then
    pass=$((pass + 1))
else
    echo "FAIL: settings.json missing Bash PostToolUse → claude-secret-detect.sh"
    fail=$((fail + 1))
fi

# Bash PreToolUse matcher contains BOTH command-guard AND secret-bash-guard
_bash_pretooluse_hooks=$(jq -r '.hooks.PreToolUse[] | select(.matcher == "Bash") | .hooks[].command' "$SETTINGS" 2>/dev/null)
if echo "$_bash_pretooluse_hooks" | grep -q "claude-command-guard.sh" && \
   echo "$_bash_pretooluse_hooks" | grep -q "claude-secret-bash-guard.sh"; then
    pass=$((pass + 1))
else
    echo "FAIL: Bash PreToolUse hooks array should contain both claude-command-guard.sh AND claude-secret-bash-guard.sh"
    echo "  found: $_bash_pretooluse_hooks"
    fail=$((fail + 1))
fi

# ============================================================
# PreToolUse Read hook tests
# ============================================================

echo ""
echo "--- PreToolUse Read hook tests ---"

# Sensitive file → ask
_sensitive_input=$(jq -nc --arg fp "$HOME/.codex/config.toml" '{"tool_input":{"file_path":$fp}}')
assert_read_guard_ask "sensitive file → ask" "$_sensitive_input"

# Normal file → allow
_safe_input=$(jq -nc '{"tool_input":{"file_path":"README.md"}}')
assert_read_guard_allow "normal file → allow" "$_safe_input"

# Config missing → ask with warning
mv "$CONFIG" "$CONFIG.bak"
_safe_input2=$(jq -nc '{"tool_input":{"file_path":"README.md"}}')
_out=$(printf '%s' "$_safe_input2" | "$READ_GUARD" 2>/dev/null)
if echo "$_out" | grep -q '"ask"' && echo "$_out" | grep -qi "degraded\|warning\|config"; then
    pass=$((pass + 1))
else
    echo "FAIL: config missing → ask with warning"
    echo "  output: $_out"
    fail=$((fail + 1))
fi
mv "$CONFIG.bak" "$CONFIG"

# Malformed input JSON → ask with warning
_out=$(printf 'not-json' | "$READ_GUARD" 2>/dev/null)
if echo "$_out" | grep -q '"ask"'; then
    pass=$((pass + 1))
else
    echo "FAIL: malformed input → ask"
    echo "  output: $_out"
    fail=$((fail + 1))
fi

# ============================================================
# PostToolUse Read hook tests (one per configured pattern)
# ============================================================

echo ""
echo "--- PostToolUse Read pattern detection tests ---"

# Build token strings at runtime to avoid tripping gitleaks
_ghp_prefix="ghp_"
_ghp_suffix=$(python3 -c "print('A' * 36)")
_ghp_token="${_ghp_prefix}${_ghp_suffix}"
assert_detect_warns "GitHub PAT (classic)" "$(make_read_payload "token = ${_ghp_token}")" "GitHub PAT (classic)"

_ghpat_prefix="github_pat_"
_ghpat_suffix=$(python3 -c "print('B' * 22)")
_ghpat_token="${_ghpat_prefix}${_ghpat_suffix}"
assert_detect_warns "GitHub PAT (fine-grained)" "$(make_read_payload "token = ${_ghpat_token}")" "GitHub PAT (fine-grained)"

_gho_prefix="gho_"
_gho_suffix=$(python3 -c "print('C' * 36)")
_gho_token="${_gho_prefix}${_gho_suffix}"
assert_detect_warns "GitHub OAuth" "$(make_read_payload "token = ${_gho_token}")" "GitHub OAuth"

_ghs_prefix="ghs_"
_ghs_suffix=$(python3 -c "print('D' * 36)")
_ghs_token="${_ghs_prefix}${_ghs_suffix}"
assert_detect_warns "GitHub App Token" "$(make_read_payload "token = ${_ghs_token}")" "GitHub App Token"

_ghr_prefix="ghr_"
_ghr_suffix=$(python3 -c "print('E' * 36)")
_ghr_token="${_ghr_prefix}${_ghr_suffix}"
assert_detect_warns "GitHub Refresh" "$(make_read_payload "token = ${_ghr_token}")" "GitHub Refresh"

_sbp_prefix="sbp_"
_sbp_suffix=$(python3 -c "print('F' * 40)")
_sbp_token="${_sbp_prefix}${_sbp_suffix}"
assert_detect_warns "Supabase PAT" "$(make_read_payload "token = ${_sbp_token}")" "Supabase PAT"

_sk_prefix="sk-"
_sk_suffix=$(python3 -c "print('G' * 28)")
_sk_token="${_sk_prefix}${_sk_suffix}"
assert_detect_warns "OpenAI/Anthropic Key" "$(make_read_payload "key = ${_sk_token}")" "OpenAI/Anthropic Key"

_bearer_prefix="Bearer "
_bearer_suffix=$(python3 -c "print('H' * 38)")
_bearer_token="${_bearer_prefix}${_bearer_suffix}"
assert_detect_warns "Bearer Token" "$(make_read_payload "Authorization: ${_bearer_token}")" "Bearer Token"

_st_prefix="st."
_st_suffix=$(python3 -c "print('I' * 28)")
_st_token="${_st_prefix}${_st_suffix}"
assert_detect_warns "Infisical Token" "$(make_read_payload "INFISICAL_TOKEN=${_st_token}")" "Infisical Token"

_akia_prefix="AKIA"
_akia_suffix=$(python3 -c "print('J' * 16)")
_akia_token="${_akia_prefix}${_akia_suffix}"
assert_detect_warns "AWS Access Key" "$(make_read_payload "aws_access_key_id = ${_akia_token}")" "AWS Access Key"

_asia_prefix="ASIA"
_asia_suffix=$(python3 -c "print('K' * 16)")
_asia_token="${_asia_prefix}${_asia_suffix}"
assert_detect_warns "AWS Temporary Key" "$(make_read_payload "aws_access_key_id = ${_asia_token}")" "AWS Temporary Key"

# Clean file → no output
assert_detect_silent "clean file content" "$(make_read_payload "function hello() { return 42; }")"

# Config missing → warning
mv "$CONFIG" "$CONFIG.bak"
assert_detect_warns_generic "detect: config missing → warning" "$(make_read_payload "some content")"
mv "$CONFIG.bak" "$CONFIG"

# Malformed input → warning
_out=$(printf 'not-json' | "$DETECT_HOOK" 2>/dev/null)
if echo "$_out" | grep -q "additionalContext"; then
    pass=$((pass + 1))
else
    echo "FAIL: detect: malformed input → warning"
    echo "  output: $_out"
    fail=$((fail + 1))
fi

# ============================================================
# PostToolUse Bash hook tests
# ============================================================

echo ""
echo "--- PostToolUse Bash pattern detection tests ---"

# Bash output with GitHub PAT
assert_detect_warns "Bash: GitHub PAT" "$(make_bash_payload "config: token=${_ghp_token}")" "GitHub PAT"

# Bash output with OpenAI key
assert_detect_warns "Bash: OpenAI key" "$(make_bash_payload "OPENAI_KEY=${_sk_token}")" "OpenAI/Anthropic Key"

# Clean Bash output
assert_detect_silent "Bash: clean ls output" "$(make_bash_payload "total 32\ndrwxr-xr-x  5 user staff 160 Feb 17 10:00 src\n")"

# Bypass vector regression: python3 outputting a token
assert_detect_warns "Bash: python3 bypass outputs token" "$(make_bash_payload "${_ghp_token}")" "GitHub PAT"

# Bash-specific failure: config missing
mv "$CONFIG" "$CONFIG.bak"
assert_detect_warns_generic "Bash detect: config missing → warning" "$(make_bash_payload "some output")"
mv "$CONFIG.bak" "$CONFIG"

# Bash-specific failure: malformed JSON
_out=$(printf 'garbage' | "$DETECT_HOOK" 2>/dev/null)
if echo "$_out" | grep -q "additionalContext"; then
    pass=$((pass + 1))
else
    echo "FAIL: Bash detect: malformed JSON → warning"
    echo "  output: $_out"
    fail=$((fail + 1))
fi

# Invalid regex test
_saved_config3="$CONFIG.bak3"
cp "$CONFIG" "$_saved_config3"
python3 -c '
import json, sys
with open(sys.argv[1], "r") as f:
    cfg = json.load(f)
cfg["secret_token_patterns"] = [{"name": "Bad Pattern", "pattern": "(unclosed"}]
with open(sys.argv[1], "w") as f:
    json.dump(cfg, f)
' "$CONFIG"
assert_detect_warns_generic "detect: invalid regex → warning" "$(make_read_payload "some text")"
mv "$_saved_config3" "$CONFIG"

# Schema drift: valid JSON but missing secret_token_patterns (e.g., {})
_saved_config4="$CONFIG.bak4"
cp "$CONFIG" "$_saved_config4"
echo '{}' > "$CONFIG"
assert_detect_warns_generic "detect: schema drift (empty object) → warning" "$(make_read_payload "some content with text")"
mv "$_saved_config4" "$CONFIG"

# Schema drift: secret_token_patterns is wrong type
_saved_config5="$CONFIG.bak5"
cp "$CONFIG" "$_saved_config5"
echo '{"secret_token_patterns":"not-an-array"}' > "$CONFIG"
assert_detect_warns_generic "detect: schema drift (string not array) → warning" "$(make_read_payload "some content with text")"
mv "$_saved_config5" "$CONFIG"

# ============================================================
# Bash command guard tests
# ============================================================

echo ""
echo "--- Bash secret guard tests ---"

assert_bash_guard_deny  "cat ~/.codex/config.toml"                  "cat $HOME/.codex/config.toml"
assert_bash_guard_deny  "head -20 ~/.pm/state.db"                   "head -20 $HOME/.pm/state.db"
assert_bash_guard_deny  "tail /path/to/.env.secrets"                "tail /path/to/.env.secrets"
assert_bash_guard_deny  "less ~/.aws/credentials"                   "less $HOME/.aws/credentials"
assert_bash_guard_deny  "more ~/.npmrc"                             "more $HOME/.npmrc"
assert_bash_guard_deny  "bat ~/.netrc"                              "bat $HOME/.netrc"
assert_bash_guard_deny  "strings /path/to/id_rsa"                  "strings /path/to/id_rsa"
assert_bash_guard_deny  "cat \$HOME/.codex/config.toml (env-var)"  'cat $HOME/.codex/config.toml'
assert_bash_guard_deny  "cat \${HOME}/.codex/config.toml (braced)" 'cat ${HOME}/.codex/config.toml'

assert_bash_guard_allow "cat README.md"                             "cat README.md"
assert_bash_guard_allow "head package.json"                         "head package.json"

# Malformed quoting → denied (fail-closed)
_out=$(jq -nc '{"tool_input":{"command":"cat \"unterminated"}}' | "$BASH_GUARD" 2>/dev/null)
if echo "$_out" | grep -q '"deny"'; then
    pass=$((pass + 1))
else
    echo "FAIL: malformed quoting → deny"
    echo "  output: $_out"
    fail=$((fail + 1))
fi

# Shell metacharacter deny tests — paths with unresolvable shell syntax are
# denied because we can't determine the final resolved path (fail-closed).
assert_bash_guard_deny "cat with \$() substitution syntax" 'cat $(echo /etc/passwd)'
assert_bash_guard_deny "cat with \${HOME:-default} expansion" 'cat ${HOME:-/tmp}/.codex/config.toml'
assert_bash_guard_deny "cat with brace expansion" 'cat ~/.codex/{config.toml}'
assert_bash_guard_deny "cat with backtick substitution" 'cat `echo /etc/passwd`'
assert_bash_guard_deny "cat with \$VAR unexpanded" 'cat $SOME_VAR/path'

# Glob wildcard metacharacter tests (P1 from Codex review iteration 2)
# *, ?, [ are shell glob expansion that the hook can't resolve to final paths
assert_bash_guard_deny "cat with glob wildcard *" 'cat ~/.codex/config.*'
assert_bash_guard_deny "cat with glob wildcard ?" 'cat ~/.codex/config.tom?'
assert_bash_guard_deny "cat with glob character class [" 'cat ~/.codex/config.[t]oml'

# Extglob metacharacter tests (P1 from Codex review iteration 3)
# Parens cover extglob operators like @(, +(, !( that expand to match files
assert_bash_guard_deny "cat with extglob @() pattern" 'cat ~/.codex/config.@(toml)'
assert_bash_guard_deny "cat with extglob +() pattern" 'cat ~/.codex/config.+(toml)'
assert_bash_guard_deny "cat with extglob !() pattern" 'cat ~/.codex/config.!(yaml)'

# Command-name shell expansion bypass tests
# If the command name itself contains metacharacters ($, `, {), it could resolve
# to a file-read command at runtime. Args must still be checked.
assert_bash_guard_deny "cmd substitution \$(printf cat) on sensitive path" "\$(printf cat) $HOME/.codex/config.toml"
assert_bash_guard_deny "param expansion \${CMD:-cat} on sensitive path" '${CMD:-cat} $HOME/.codex/config.toml'
assert_bash_guard_deny "backtick cmd name on sensitive path" '`cat` $HOME/.codex/config.toml'

# Wrapper/keyword prefix bypass tests (Codex review)
# Shell keywords and command wrappers are stripped during normalization
assert_bash_guard_deny "time cat on sensitive path" "time cat $HOME/.codex/config.toml"
assert_bash_guard_deny "nice cat on sensitive path" "nice cat $HOME/.codex/config.toml"
assert_bash_guard_deny "nohup cat on sensitive path" "nohup cat $HOME/.codex/config.toml"
assert_bash_guard_deny "exec cat on sensitive path" "exec cat $HOME/.codex/config.toml"
assert_bash_guard_deny "then cat on sensitive path (after ; split)" "then cat $HOME/.codex/config.toml"
assert_bash_guard_deny "do cat on sensitive path (after ; split)" "do cat $HOME/.codex/config.toml"
assert_bash_guard_deny "if cat on sensitive path (control-flow prefix)" "if cat $HOME/.codex/config.toml"
assert_bash_guard_deny "while cat on sensitive path (control-flow prefix)" "while cat $HOME/.codex/config.toml"
assert_bash_guard_deny "until cat on sensitive path (control-flow prefix)" "until cat $HOME/.codex/config.toml"
assert_bash_guard_deny "for cat on sensitive path (control-flow prefix)" "for cat $HOME/.codex/config.toml"
assert_bash_guard_deny "! cat on sensitive path (negation prefix)" "! cat $HOME/.codex/config.toml"
assert_bash_guard_deny "case with embedded cat on sensitive path" "case x in y) cat $HOME/.codex/config.toml"
assert_bash_guard_allow "benign case statement (no sensitive path)" "case x in y) echo ok"
assert_bash_guard_deny "select with sensitive path arg" "select f in $HOME/.codex/config.toml"
assert_bash_guard_deny "coproc with sensitive path arg" "coproc cat $HOME/.codex/config.toml"
assert_bash_guard_deny "case with shell expansion in path" 'case x in y) cat $(echo /home/.codex/config.toml)'
assert_bash_guard_deny "select with shell expansion in path" 'select f in $(echo /home/.codex/config.toml)'
assert_bash_guard_deny "case with variable arg (no path chars)" 'case x in y) cat $SECRET'
assert_bash_guard_deny "coproc NAME cat on sensitive path" "coproc MYCP cat $HOME/.codex/config.toml"

# Quoted/escaped command name bypass tests (P1 from Codex review)
# shlex.split resolves quotes before we check the command name
assert_bash_guard_deny "double-quoted cat on sensitive path" "\"cat\" $HOME/.codex/config.toml"
assert_bash_guard_deny "single-quoted cat on sensitive path" "'cat' $HOME/.codex/config.toml"
assert_bash_guard_deny "backslash-escaped cat on sensitive path" "\\cat $HOME/.codex/config.toml"
assert_bash_guard_deny "quoted /usr/bin/cat on sensitive path" "\"/usr/bin/cat\" $HOME/.codex/config.toml"

# Helper reason passthrough: deny message contains "sensitive" or similar
assert_bash_guard_deny_contains "cat sensitive → reason preserved" "cat $HOME/.codex/config.toml" "ensitive"

# Config missing → deny
mv "$CONFIG" "$CONFIG.bak"
assert_bash_guard_deny "bash guard: config missing → deny" "cat $HOME/.codex/config.toml"
mv "$CONFIG.bak" "$CONFIG"

# Malformed input JSON → deny
_out=$(printf 'garbage' | "$BASH_GUARD" 2>/dev/null)
if echo "$_out" | grep -q '"deny"'; then
    pass=$((pass + 1))
else
    echo "FAIL: bash guard: malformed JSON → deny"
    echo "  output: $_out"
    fail=$((fail + 1))
fi

# ============================================================
# Heredoc handling tests
# ============================================================

echo ""
echo "--- Heredoc handling tests ---"

# git commit with heredoc — parens in body must not trigger metachar deny
_heredoc_commit=$(printf 'git commit -m "$(cat <<'\''EOF'\''\nfix(infra): switch Codex review gate to JSONL evidence (#539)\n\nCo-Authored-By: Claude <noreply@anthropic.com>\nEOF\n)"')
assert_bash_guard_allow "git commit with heredoc (parens in body)" "$_heredoc_commit"

# heredoc body with shell metacharacters ($vars and parens)
_heredoc_metachar=$(printf 'echo "$(cat <<'\''EOF'\''\ntext with $vars and (parens) and {braces}\nEOF\n)"')
assert_bash_guard_allow "heredoc body with metacharacters" "$_heredoc_metachar"

# heredoc with <<- (tab-stripping variant)
_heredoc_dash=$(printf 'git commit -m "$(cat <<-'\''EOF'\''\n\tfix(infra): description (#540)\n\tEOF\n)"')
assert_bash_guard_allow "heredoc with <<- tab stripping" "$_heredoc_dash"

# heredoc with unquoted delimiter
_heredoc_unquoted=$(printf 'git commit -m "$(cat <<EOF\nfix(infra): description (#541)\nEOF\n)"')
assert_bash_guard_allow "heredoc with unquoted delimiter" "$_heredoc_unquoted"

# Non-heredoc commands before/after heredoc still checked
_heredoc_with_cat=$(printf 'git commit -m "$(cat <<'\''EOF'\''\nfix(infra): desc\nEOF\n)" && cat %s/.codex/config.toml' "$HOME")
assert_bash_guard_deny "command after heredoc still checked" "$_heredoc_with_cat"

# Here-string (<<<) must NOT activate heredoc skip mode
_herestring_bypass=$(printf 'echo <<<EOF && cat %s/.codex/config.toml' "$HOME")
assert_bash_guard_deny "here-string does not bypass guard" "$_herestring_bypass"

# Quoted "<<EOF" must NOT activate heredoc skip mode
_quoted_heredoc_bypass=$(printf 'echo "<<EOF" && cat %s/.codex/config.toml' "$HOME")
assert_bash_guard_deny "quoted <<EOF does not bypass guard" "$_quoted_heredoc_bypass"

# Quoted text with space before << must NOT activate heredoc skip mode
_quoted_space_bypass=$(printf 'echo "x <<EOF" && cat %s/.codex/config.toml' "$HOME")
assert_bash_guard_deny "quoted text with <<EOF does not bypass guard" "$_quoted_space_bypass"

# Single-quoted text with <<EOF must NOT activate heredoc skip mode
_sq_bypass=$(printf "echo 'x <<EOF' && cat %s/.codex/config.toml" "$HOME")
assert_bash_guard_deny "single-quoted <<EOF does not bypass guard" "$_sq_bypass"

# Chained command on heredoc opener line (no actual body in input)
_chain_bypass=$(printf 'cat <<EOF && cat %s/.codex/config.toml' "$HOME")
assert_bash_guard_deny "chained cmd after <<EOF without body" "$_chain_bypass"

# ============================================================
# Nesting-aware splitter tests (bash guard)
# ============================================================

echo ""
echo "--- Nesting-aware splitter tests ---"

# $() with internal pipes → allow (pipes inside command substitution stay intact)
assert_bash_guard_allow "\$() with internal pipes" "mkdir -p .codex-work && PLAN_B_PREFIX=\$(uuidgen | tr -d '-' | head -c 8) && echo done"

# Backtick with internal pipes → allow
assert_bash_guard_allow "backtick with internal pipes" "mkdir -p .codex-work && PLAN_B_PREFIX=\`uuidgen | tr -d '-' | head -c 8\` && echo done"

# Nested $() → allow
assert_bash_guard_allow "nested \$() with pipes" "echo \$(cmd1 \$(cmd2 | cmd3) | cmd4) && echo done"

# Top-level pipe to sensitive cmd → deny
assert_bash_guard_deny "top-level pipe to sensitive cmd" "echo ok | cat $HOME/.codex/config.toml"

# && still splits at top level → deny
assert_bash_guard_deny "&& still splits at top level" "echo ok && cat $HOME/.codex/config.toml"

# ; still splits at top level → deny
assert_bash_guard_deny "; still splits at top level" "echo ok ; cat $HOME/.codex/config.toml"

# || still splits at top level → deny
assert_bash_guard_deny "|| still splits at top level" "false || cat $HOME/.codex/config.toml"

# ) in single-quoted string inside $() → allow
assert_bash_guard_allow "') inside \$()" "echo \$(echo ')' && echo done) && echo ok"

# ) in double-quoted string inside $() → allow
assert_bash_guard_allow "\") inside \$()" "echo \$(echo \")\" && echo done) && echo ok"

# ) in single-quoted arg inside $() → allow
assert_bash_guard_allow "') as arg inside \$()" "VAR=\$(cmd ')') && echo ok"

# Unclosed $( → allow (sed fallback; echo is not a file-read cmd)
assert_bash_guard_allow "unclosed \$( sed fallback" "echo \$(uuidgen"

# Unmatched backtick → allow (sed fallback; echo is not a file-read cmd)
assert_bash_guard_allow "unmatched backtick sed fallback" "echo \`uuidgen"

# Split function error → allow (sed fallback splits on &&; neither is file-read)
assert_bash_guard_allow "split error sed fallback" "echo ok && echo \`broken"

# $() inside double-quoted heredoc wrapper → allow (quoting context resets in $())
assert_bash_guard_allow "\$() inside double-quoted heredoc" "git commit -m \"\$(cat <<'EOF'
text with \$() references
EOF
)\""

# Nested $() inside double-quoted $() → allow
assert_bash_guard_allow "nested \$() in double-quoted wrapper" "echo \"\$(echo \$(uuidgen | head -c 8) done)\" && echo ok"

# Heredoc with ( in body + sensitive cmd → deny (sed fallback catches it)
assert_bash_guard_deny "heredoc with paren + sensitive cmd" "python3 - <<'EOF'
(
EOF
; cat $HOME/.codex/config.toml"

# Heredoc with ( in body + benign cmd → allow (sed fallback, no sensitive pattern)
assert_bash_guard_allow "heredoc with paren + benign cmd" "python3 - <<'EOF'
(
EOF
; echo done"

# Single quote inside double quotes is literal → deny sensitive cmd after &&
assert_bash_guard_deny "' inside double quotes + sensitive cmd" "echo \"it's\" && cat $HOME/.codex/config.toml"

# Single quote inside double quotes doesn't break splitting → allow
assert_bash_guard_allow "' inside double quotes + allowed cmd" "echo \"it's\" && echo ok"

# --- Secondary sed pass: nested sensitive reads ---

# Sensitive read inside $() captured into variable → deny (secondary sed pass)
assert_bash_guard_deny "sensitive read inside \$()" "SECRET=\$(cat ~/.ssh/id_rsa) && echo ok"

# Sensitive read inside $() with pipe → deny (secondary sed pass surfaces cat)
assert_bash_guard_deny "sensitive read inside \$() with pipe" "SECRET=\$(echo ok | cat ~/.codex/config.toml | head -1) && echo done"

# Sensitive read inside backticks → deny (secondary sed pass)
assert_bash_guard_deny "sensitive read inside backticks" "SECRET=\`cat ~/.ssh/id_rsa\` && echo ok"

# Non-sensitive read inside $() → allow (path helper says safe)
assert_bash_guard_allow "non-sensitive read inside \$()" "RESULT=\$(cat /tmp/safe-file.txt) && echo ok"

# $() with internal pipes but no sensitive read → allow (original regression case)
assert_bash_guard_allow "\$() with pipes no sensitive read" "PLAN_B_PREFIX=\$(uuidgen | tr -d '-' | head -c 8) && echo done"

# --- Quote-aware secondary split: false positive prevention ---

# Literal $() inside single quotes → allow (not a real substitution)
assert_bash_guard_allow "literal \$() in single quotes" "echo '\$(cat ~/.ssh/id_rsa)'"

# Literal backticks inside single quotes → allow (not a real substitution)
assert_bash_guard_allow "literal backticks in single quotes" "echo '\`cat ~/.ssh/id_rsa\`'"

# Real $() inside double quotes with SQ path arg → deny (DQ $() is live)
assert_bash_guard_deny "real \$() in DQ with SQ path" "VAR=\"\$(cat '~/.ssh/id_rsa')\""

# Real $() in DQ with apostrophe before it → deny (apostrophe in DQ is literal)
assert_bash_guard_deny "apostrophe in DQ + real \$()" "echo \"it's \$(cat ~/.ssh/id_rsa)\""

# Multiple SQ regions with $() literal between → allow
assert_bash_guard_allow "multiple SQ regions with literal \$()" "echo 'hello' '\$(cat ~/.ssh/id_rsa)' 'world'"

# && inside DQ $() → deny (quoting context resets inside $())
assert_bash_guard_deny "&& inside DQ \$()" "SECRET=\"\$(echo ok && cat ~/.ssh/id_rsa)\""

# | inside DQ $() → deny (quoting context resets inside $())
assert_bash_guard_deny "pipe inside DQ \$()" "SECRET=\"\$(echo ok | cat ~/.ssh/id_rsa)\""

# Subshell inside $() → deny (bare `)` must not pop $( quote context)
assert_bash_guard_deny "subshell in DQ \$() with ;" "SECRET=\"\$( (echo ok); cat ~/.ssh/id_rsa )\""

# Backtick inside DQ → deny (backtick in DQ is live substitution, resets quote context)
assert_bash_guard_deny "backtick in DQ with ;" "SECRET=\"\`echo ok; cat ~/.ssh/id_rsa\`\""

# Case-pattern ) inside $() → deny (x) must not pop $( context)
assert_bash_guard_deny "case pattern in DQ \$()" "SECRET=\"\$(case x in x) cat ~/.ssh/id_rsa ;; esac)\""

# Operator inside DQ string (no substitution) → allow (literal text, not executed)
assert_bash_guard_allow "literal && in DQ string" "echo \"hello && world\""

# SQ literal inside DQ $() → allow (inner SQ makes $() literal, not executed)
assert_bash_guard_allow "SQ literal in DQ \$()" "echo \"\$(echo '\$(cat ~/.ssh/id_rsa)')\""

# SQ literal inside DQ backtick → allow (inner SQ makes content literal)
assert_bash_guard_allow "SQ literal in DQ backtick" "echo \"\`echo '\$(cat ~/.ssh/id_rsa)'\`\""

# --- Trailing-args-after-substitution secondary pass behavior ---

# ) closing a real $() context splits — trailing args become a separate fragment (deny)
# This is correct defense-in-depth: $( pushes dq_stack, ) pops and splits
assert_bash_guard_deny "trailing args after \$() are separate fragment" "echo \$(echo hi) cat ~/.ssh/id_rsa"

# Same with backticks — closing backtick creates segment boundary
assert_bash_guard_deny "trailing args after backtick are separate fragment" "echo \`echo hi\` cat ~/.ssh/id_rsa"

# ) WITHOUT preceding $() (dq_stack empty) is literal — stays in buffer, no split
assert_bash_guard_allow "literal ) in DQ does not split" 'echo "x) cat ~/.ssh/id_rsa"'

# But actual reads inside $() still caught
assert_bash_guard_deny "real read inside \$()" "echo \$(cat ~/.ssh/id_rsa)"

# And reads inside backticks still caught
assert_bash_guard_deny "real read inside backtick" "echo \`cat ~/.ssh/id_rsa\`"

# Nested && with cat inside $() and quote-shaping tokens — shlex-failure deny still applies
assert_bash_guard_deny "nested && cat in \$() with quotes" 'echo "$(true && cat ~/.ssh/id_rsa ")")"'

# Literal ) in double-quoted text should NOT create false positive
assert_bash_guard_allow "literal ) in DQ text" 'echo "x) cat /tmp/safe-file.txt"'

# Literal ) in unquoted text with non-sensitive path → allow
assert_bash_guard_allow "literal ) in plain text" 'echo x) cat /tmp/safe-file.txt'

# ) inside backtick context is literal — does not close backtick's dq_stack entry
assert_bash_guard_allow "literal ) in backtick" 'echo `echo ")"` cat /tmp/safe-file.txt'

# $() inside backtick — ) correctly closes $() not backtick
assert_bash_guard_deny "\$() inside backtick" 'echo `echo $(cat ~/.ssh/id_rsa)` done'

# Shell comments — # at top level starts comment, content is not executed
assert_bash_guard_allow "comment with sensitive cmd" 'echo ok # $(cat ~/.ssh/id_rsa)'
assert_bash_guard_allow "comment after semicolon" 'echo ok; echo done # cat ~/.ssh/id_rsa'

# But # inside quotes is NOT a comment
assert_bash_guard_deny "hash in DQ is not comment" 'echo "# $(cat ~/.ssh/id_rsa)"'

# Mid-word # is literal (not a comment) — inner $() still executes
assert_bash_guard_deny "mid-word hash is literal" 'echo a#$(cat ~/.ssh/id_rsa)'

# Quoted literal strings containing && and sensitive-looking text are NOT commands
assert_bash_guard_allow "quoted literal with && and cat" 'echo "hello && cat ~/.ssh/id_rsa"'
assert_bash_guard_allow "quoted literal with pipe and cat" 'echo "hello | cat ~/.ssh/id_rsa"'

# Quoted literal with $() and non-sensitive file name — NOT a real read command
assert_bash_guard_allow "quoted literal with subst and credentials word" 'echo "$(echo hi) cat credentials.txt"'

# # after operator chars (;, |) is a comment in bash
assert_bash_guard_allow "hash after semicolon no space" 'echo ok;# $(cat ~/.ssh/id_rsa)'
assert_bash_guard_allow "hash after pipe no space" 'echo ok |# $(cat ~/.ssh/id_rsa)'

# Multiline: comment on first line must not hide second line
assert_bash_guard_deny "multiline comment then sensitive read" $'echo ok # note\necho $(cat ~/.ssh/id_rsa)'

# Secondary pass shlex-failure: non-sensitive path in quote-broken fragment → allow
assert_bash_guard_allow "cat safe path in DQ after \$()" 'echo "$(echo hi) cat /tmp/safe-file.txt"'

# Secondary pass shlex-failure: sensitive path in quote-broken fragment → deny
assert_bash_guard_deny "cat sensitive path in DQ after \$()" 'echo "$(echo hi) cat ~/.ssh/id_rsa"'

# ============================================================
# Case pattern ) bypass regression tests
# ============================================================

echo ""
echo "--- Case pattern ) bypass tests ---"

# case pattern ) inside $() must not prematurely close the substitution
assert_bash_guard_deny "case pattern ) closes \$() → bypass" \
    'SECRET="$(case x in x) echo ok && cat ~/.ssh/id_rsa ;; esac)"'

# Nested double-quote + case pattern bypass
assert_bash_guard_deny "nested DQ case pattern bypass" \
    'echo $(echo "$(case x in x) echo ok && cat ~/.ssh/id_rsa ;; esac)")'

# Pipe inside case pattern inside $()
assert_bash_guard_deny "pipe inside case in \$()" \
    'SECRET="$(case x in x) echo ok | cat ~/.ssh/id_rsa ;; esac)"'

# Benign case inside $() — no sensitive paths → allow
assert_bash_guard_allow "benign case in \$()" \
    'RESULT="$(case x in start) echo starting ;; stop) echo stopping ;; esac)"'

# Multiple case patterns → all ) are pattern delimiters, not paren-close
assert_bash_guard_deny "multi-pattern case bypass" \
    'SECRET="$(case x in a) echo safe ;; x) cat ~/.ssh/id_rsa ;; esac)"'

# esac properly restores ) handling outside case block
assert_bash_guard_deny "post-esac ) restores splitting" \
    'echo $(case x in x) echo ok ;; esac) && cat ~/.ssh/id_rsa'

# ============================================================
# False positive regression tests (base64 three-stage filter)
# ============================================================

echo ""
echo "--- Base64 false positive regression tests ---"

# Algod dev token (1 unique char) → NOT flagged
_algod_token=$(python3 -c "print('a' * 64)")
assert_detect_silent "algod dev token (1 unique char)" "$(make_read_payload "token = $_algod_token")"

# Hex zero string (1 unique char) → NOT flagged
_hex_zeros=$(python3 -c "print('0' * 64)")
assert_detect_silent "hex zero string (1 unique char)" "$(make_read_payload "value = $_hex_zeros")"

# Realistic migration hex (3 unique chars, pure hex) → NOT flagged
_hex_migration1="0000000000000000000000000000000000000000000000000000000000000064"
assert_detect_silent "uint256 hex 0x64 (pure hex)" "$(make_read_payload "data = $_hex_migration1")"

# Realistic migration hex (4 unique chars, pure hex) → NOT flagged
_hex_migration2="00000000000000000000000000000000000000000000000000000000000001F4"
assert_detect_silent "uint256 hex 0x1F4 (pure hex)" "$(make_read_payload "data = $_hex_migration2")"

# Realistic migration hex (4 unique chars, pure hex) → NOT flagged
_hex_migration3="00000000000000000000000000000000000000000000000000000000000003E8"
assert_detect_silent "uint256 hex 0x3E8 (pure hex)" "$(make_read_payload "data = $_hex_migration3")"

# pnpm-lock integrity hash → NOT flagged
_integrity_hash=$(python3 -c "
chars='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
body=''.join([chars[i % len(chars)] for i in range(86)])
print(f'sha512-{body}==')
")
assert_detect_silent "pnpm-lock sha512 integrity hash" "$(make_read_payload "$_integrity_hash")"

# sha256 integrity hash → NOT flagged
_sha256_hash=$(python3 -c "
chars='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
body=''.join([chars[i % len(chars)] for i in range(64)])
print(f'sha256-{body}=')
")
assert_detect_silent "package-lock sha256 integrity hash" "$(make_read_payload "$_sha256_hash")"

echo ""
echo "--- Base64 true positive tests ---"

# Base64-encoded key with non-hex characters (68 chars) → flagged
_b64_key=$(python3 -c "print('aAbBcCdDgGhHiIjJkKlLmMnNoOpPqQrRsStTuUvVwWxXyYzZ0123456789+/ABCDef')")
assert_detect_warns "base64 key with non-hex chars" "$(make_read_payload "secret = $_b64_key")" "Generic Long Base64"

# Another true positive (64 chars exactly)
_b64_key2=$(python3 -c "print('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/AB')")
assert_detect_warns "base64 64-char diverse key" "$(make_read_payload "key = $_b64_key2")" "Generic Long Base64"

# ============================================================
# Summary
# ============================================================

echo ""
echo "==> Results: $((pass + fail)) tests, $pass passed, $fail failed"

exit $((fail > 0 ? 1 : 0))
