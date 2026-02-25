#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GUARD="$SCRIPT_DIR/claude-command-guard.sh"

pass=0
fail=0

assert_deny() {
    local desc="$1" cmd="$2"
    local out
    out=$(jq -nc --arg cmd "$cmd" '{"tool_input":{"command":$cmd}}' | "$GUARD" 2>/dev/null)
    if echo "$out" | grep -q '"deny"'; then
        pass=$((pass + 1))
    else
        echo "FAIL (expected deny):  $desc"
        echo "  command: $cmd"
        echo "  output:  $out"
        fail=$((fail + 1))
    fi
}

assert_allow() {
    local desc="$1" cmd="$2"
    local out
    out=$(jq -nc --arg cmd "$cmd" '{"tool_input":{"command":$cmd}}' | "$GUARD" 2>/dev/null)
    if [[ -z "$out" ]]; then
        pass=$((pass + 1))
    else
        echo "FAIL (expected allow): $desc"
        echo "  command: $cmd"
        echo "  output:  $out"
        fail=$((fail + 1))
    fi
}

assert_allow_raw() {
    local desc="$1" raw_input="$2"
    local out
    out=$(printf '%s' "$raw_input" | "$GUARD" 2>/dev/null)
    if [[ -z "$out" ]]; then
        pass=$((pass + 1))
    else
        echo "FAIL (expected allow): $desc"
        echo "  input:  $raw_input"
        echo "  output: $out"
        fail=$((fail + 1))
    fi
}

echo "==> Running claude-command-guard tests..."

# ---- Docker deny ----
assert_deny "docker compose up -d"          "docker compose up -d"
assert_deny "docker build ."                "docker build ."
assert_deny "docker run --rm alpine"        "docker run --rm alpine"
assert_deny "docker-compose up"             "docker-compose up"

# ---- Docker boundary (wrappers, env vars, chaining) ----
assert_deny "echo hi && docker compose up"           "echo hi && docker compose up"
assert_deny "COMPOSE_PROJECT=foo docker compose up"  "COMPOSE_PROJECT=foo docker compose up"
assert_deny "command docker compose up"              "command docker compose up"
assert_deny "env docker compose up"                  "env docker compose up"
assert_deny "sudo docker compose up"                 "sudo docker compose up"
assert_deny "/usr/bin/env docker compose up"         "/usr/bin/env docker compose up"
assert_deny "/usr/bin/docker compose up"             "/usr/bin/docker compose up"

# ---- Wrapper-option bypass (flags on wrappers) ----
assert_deny "env -i docker compose up"               "env -i docker compose up"
assert_deny "/usr/bin/env -i docker compose up"      "/usr/bin/env -i docker compose up"
assert_deny "sudo -u root docker compose up"         "sudo -u root docker compose up"
assert_deny "command -- docker compose up"           "command -- docker compose up"
assert_deny "sudo -E -u deploy docker compose up"   "sudo -E -u deploy docker compose up"

# ---- Docker allow ----
assert_allow "make up (uses docker internally)"  "make up"
assert_allow "docker --version"                  "docker --version"
assert_allow "docker ps"                         "docker ps"

# ---- Package manager deny ----
assert_deny "pnpm add express"               "pnpm add express"
assert_deny "npm install express"            "npm install express"
assert_deny "npm install --save-dev eslint"  "npm install --save-dev eslint"
assert_deny "npm i -D typescript"            "npm i -D typescript"
assert_deny "yarn add react"                 "yarn add react"

# ---- Bare install deny (host installs poison container node_modules) ----
assert_deny "pnpm install (bare)"            "pnpm install"
assert_deny "npm install (bare)"             "npm install"
assert_deny "npm ci"                         "npm ci"
assert_deny "yarn install"                   "yarn install"
assert_deny "CI=true pnpm install"           "CI=true pnpm install"
assert_deny "pnpm install --frozen-lockfile" "pnpm install --frozen-lockfile"

# ---- Flag-before-subcommand bypass deny ----
assert_deny "pnpm --filter <pkg> install"     "pnpm --filter @pm/server install"
assert_deny "pnpm -C <dir> install"           "pnpm -C /tmp install"
assert_deny "pnpm -r install"                 "pnpm -r install"
assert_deny "pnpm --frozen-lockfile install"  "pnpm --frozen-lockfile install"
assert_deny "pnpm --unknown-flag install"     "pnpm --unknown-flag install"

# ---- Value-flag with subcommand-like value ----
assert_deny "pnpm -C run install"             "pnpm -C run install"
assert_deny "pnpm --store-dir run install"    "pnpm --store-dir run install"
assert_deny "pnpm --filter run install"       "pnpm --filter run install"

# ---- Additional value-flag bypass (review feedback) ----
assert_deny "pnpm --global-dir <dir> install"           "pnpm --global-dir /tmp install"
assert_deny "pnpm --lockfile-dir <dir> install"          "pnpm --lockfile-dir /tmp install"
assert_deny "pnpm --modules-dir <dir> install"           "pnpm --modules-dir /tmp install"
assert_deny "pnpm --workspace-concurrency 1 install"     "pnpm --workspace-concurrency 1 install"
assert_deny "pnpm --child-concurrency 1 install"         "pnpm --child-concurrency 1 install"
assert_deny "pnpm --network-concurrency 1 install"       "pnpm --network-concurrency 1 install"
assert_deny "pnpm --aggregate-output true install"       "pnpm --aggregate-output true install"
assert_deny "pnpm --stream true install"                 "pnpm --stream true install"

# ---- Subshell wrapper deny ----
assert_deny "(pnpm install)"                  "(pnpm install)"
assert_deny "(pnpm install) chained &&"       "(pnpm install) && true"
assert_deny "(pnpm install) chained ||"       "(pnpm install) || true"
assert_deny '\$(pnpm install)'                '$(pnpm install)'
assert_deny '\$(pnpm install) chained &&'     '$(pnpm install) && true'
assert_deny '\$(pnpm install) chained ||'     '$(pnpm install) || true'

# ---- Package manager allow ----
assert_allow "pnpm test"                     "pnpm test"
assert_allow "pnpm build"                    "pnpm build"
assert_allow "pnpm lint"                     "pnpm lint"
assert_allow "pnpm run install (script name)"  "pnpm run install"
assert_allow "pnpm help install"               "pnpm help install"
assert_allow "make install"                    "make install"

# ---- cd infra deny ----
assert_deny "cd infra"             "cd infra"
assert_deny "cd infra/"            "cd infra/"
assert_deny "cd infra && ls"       "cd infra && ls"
assert_deny "cd ./infra"           "cd ./infra"
assert_deny "cd ./infra/"          "cd ./infra/"

# ---- cd infra allow ----
assert_allow "cd packages/web"     "cd packages/web"
assert_allow "cd infrastructure"   "cd infrastructure"

# ---- pip deny ----
assert_deny "pip install requests"   "pip install requests"
assert_deny "pip3 install flask"     "pip3 install flask"

# ---- pip allow ----
assert_allow "pip --version"         "pip --version"

# ---- Fail-open (malformed input) ----
assert_allow_raw "malformed JSON"        "not json at all"
assert_allow_raw "empty object"          "{}"
assert_allow_raw "missing command"       '{"tool_input":{}}'
assert_allow_raw "empty string"          ""

# ---- General allow ----
assert_allow "make dev"        "make dev"
assert_allow "git status"      "git status"
assert_allow "ls -la"          "ls -la"
assert_allow "pnpm build"      "pnpm build"

# ---- Heredoc handling ----
# git commit with heredoc — body text must not be treated as commands
_heredoc_commit=$(printf 'git commit -m "$(cat <<'\''EOF'\''\nfix(infra): switch Codex review gate (#539)\n\nCo-Authored-By: Claude <noreply@anthropic.com>\nEOF\n)"')
assert_allow "git commit with heredoc" "$_heredoc_commit"

# heredoc body containing blocked pattern text (docker compose)
_heredoc_docker=$(printf 'git commit -m "$(cat <<'\''EOF'\''\nfix: update docker compose docs\nEOF\n)"')
assert_allow "heredoc body with docker compose text" "$_heredoc_docker"

# heredoc body containing pnpm install text
_heredoc_pnpm=$(printf 'git commit -m "$(cat <<'\''EOF'\''\nchore: run pnpm install in container\nEOF\n)"')
assert_allow "heredoc body with pnpm install text" "$_heredoc_pnpm"

# heredoc with <<- tab-stripping variant
_heredoc_dash=$(printf 'git commit -m "$(cat <<-'\''EOF'\''\n\tdocker compose up -d\n\tEOF\n)"')
assert_allow "heredoc with <<- tab stripping" "$_heredoc_dash"

# Non-heredoc commands after heredoc still checked
_heredoc_then_docker=$(printf 'git commit -m "$(cat <<'\''EOF'\''\ndesc\nEOF\n)" && docker compose up')
assert_deny "command after heredoc still checked" "$_heredoc_then_docker"

# Here-string (<<<) must NOT activate heredoc skip mode
assert_deny "here-string does not bypass guard" 'echo <<<EOF && docker compose up'

# Quoted "<<EOF" must NOT activate heredoc skip mode
assert_deny "quoted <<EOF does not bypass guard" 'echo "<<EOF" && docker compose up'

# Quoted text with space before << must NOT activate heredoc skip mode
assert_deny "quoted text with <<EOF does not bypass guard" 'echo "x <<EOF" && docker compose up'

# Single-quoted text with <<EOF must NOT activate heredoc skip mode
assert_deny "single-quoted <<EOF does not bypass guard" "echo 'x <<EOF' && docker compose up"

# Chained command on heredoc opener line (no actual body in input)
assert_deny "chained cmd after <<EOF without body" 'cat <<EOF && docker compose up'

# ---- Nesting-aware splitter tests ----

# $() with internal pipes → allow
assert_allow "\$() with internal pipes" "RESULT=\$(echo hello | tr h H) && pnpm test"

# Backtick with internal pipes → allow
assert_allow "backtick with internal pipes" "RESULT=\`echo hello | tr h H\` && pnpm test"

# Top-level pipe to blocked cmd → deny
assert_deny "top-level pipe to docker compose" "echo ok | docker compose up"

# && still splits to blocked cmd → deny
assert_deny "&& still splits to docker compose" "echo ok && docker compose up"

# ; still splits to blocked cmd → deny
assert_deny "; still splits to docker compose" "echo ok ; docker compose up"

# || still splits to blocked cmd → deny
assert_deny "|| still splits to docker compose" "false || docker compose up"

# ) in single-quoted string inside $() → allow
assert_allow "') inside \$()" "RESULT=\$(echo ')' && echo hello) && pnpm test"

# ) in double-quoted string inside $() → allow
assert_allow "\") inside \$()" "RESULT=\$(echo \")\" && echo hello) && pnpm test"

# Unclosed $( → allow (fail-open)
assert_allow "unclosed \$( fail-open" "echo \$(uuidgen"

# Unmatched backtick → allow (fail-open)
assert_allow "unmatched backtick fail-open" "echo \`uuidgen"

# $() inside double-quoted heredoc wrapper → allow (quoting context resets in $())
assert_allow "\$() inside double-quoted heredoc" "git commit -m \"\$(cat <<'EOF'
text with \$() references
EOF
)\""

# Nested $() inside double-quoted $() → allow
assert_allow "nested \$() in double-quoted wrapper" "echo \"\$(echo \$(uuidgen | head -c 8) done)\" && pnpm test"

# Heredoc with ( in body + blocked cmd → deny (sed fallback catches it)
assert_deny "heredoc with paren + blocked cmd" "python3 - <<'EOF'
(
EOF
; docker compose up"

# Heredoc with ( in body + allowed cmd → allow (sed fallback, no blocked pattern)
assert_allow "heredoc with paren + allowed cmd" "python3 - <<'EOF'
(
EOF
; echo done"

# Single quote inside double quotes is literal → deny blocked cmd after &&
assert_deny "' inside double quotes + blocked cmd" "echo \"it's\" && docker compose up"

# Single quote inside double quotes doesn't break splitting → allow
assert_allow "' inside double quotes + allowed cmd" "echo \"it's\" && pnpm test"

# Blocked command inside $() → deny (secondary sed pass catches it)
assert_deny "blocked cmd inside \$()" "RESULT=\$(echo ok | docker compose up)"

# Blocked command inside backticks → deny (secondary sed pass catches it)
assert_deny "blocked cmd inside backticks" "RESULT=\`echo ok | docker compose up\`"

# Allowed command inside $() → allow (no blocked pattern matches)
assert_allow "allowed cmd inside \$()" "RESULT=\$(echo hello | tr h H) && pnpm test"

# ---- Case pattern ) bypass tests ----

# case pattern ) inside $() must not prematurely close the substitution
assert_deny "case pattern ) closes \$() → bypass" \
    'SECRET="$(case x in x) echo ok && docker compose up ;; esac)"'

# Pipe inside case pattern inside $()
assert_deny "pipe inside case in \$()" \
    'SECRET="$(case x in x) echo ok | docker compose up ;; esac)"'

# Benign case inside $() — no blocked commands → allow
assert_allow "benign case in \$()" \
    'RESULT="$(case x in start) echo starting ;; stop) echo stopping ;; esac)"'

# Multiple case patterns → all ) are pattern delimiters
assert_deny "multi-pattern case bypass" \
    'SECRET="$(case x in a) echo safe ;; x) docker compose up ;; esac)"'

# esac properly restores ) handling outside case block
assert_deny "post-esac ) restores splitting" \
    'echo $(case x in x) echo ok ;; esac) && docker compose up'

# Case pattern with hyphen via pipe-split → strip prefix, deny blocked command
# The | in "a|x-y)" causes sed to split, producing fragment "x-y) docker compose up"
# which needs the hyphen-aware case-pattern regex to strip "x-y) "
assert_deny "case pattern with hyphen via pipe-split" \
    'SECRET="$(case x in a|x-y) docker compose up ;; esac)"'

# Case pattern with multiple hyphens via pipe-split
assert_deny "case pattern with multi-hyphen via pipe-split" \
    'SECRET="$(case x in a|foo-bar-baz) docker compose up ;; esac)"'

echo ""
echo "==> Results: $((pass + fail)) tests, $pass passed, $fail failed"

exit $((fail > 0 ? 1 : 0))
