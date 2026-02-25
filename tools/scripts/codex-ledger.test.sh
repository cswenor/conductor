#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LEDGER="$SCRIPT_DIR/codex-ledger.sh"

pass=0
fail=0

# Use a unique issue number per test to avoid cross-contamination
TEST_NUM=90000

assert_ok() {
  local desc="$1"; shift
  local out
  if out=$("$@" 2>&1); then
    pass=$((pass + 1))
  else
    echo "FAIL (expected success): $desc"
    echo "  command: $*"
    echo "  output:  $out"
    fail=$((fail + 1))
  fi
}

assert_fail() {
  local desc="$1"; shift
  local out
  if out=$("$@" 2>&1); then
    echo "FAIL (expected failure): $desc"
    echo "  command: $*"
    echo "  output:  $out"
    fail=$((fail + 1))
  else
    pass=$((pass + 1))
  fi
}

assert_output_contains() {
  local desc="$1" expected="$2"; shift 2
  local out
  if out=$("$@" 2>&1); then
    if echo "$out" | grep -qF "$expected"; then
      pass=$((pass + 1))
    else
      echo "FAIL (output missing expected string): $desc"
      echo "  expected to contain: $expected"
      echo "  actual output: $out"
      fail=$((fail + 1))
    fi
  else
    echo "FAIL (command failed): $desc"
    echo "  command: $*"
    echo "  output:  $out"
    fail=$((fail + 1))
  fi
}

assert_json_eq() {
  local desc="$1" jq_expr="$2" expected="$3" file="$4"
  local actual
  actual=$(jq -r "$jq_expr" "$file" 2>/dev/null)
  if [[ "$actual" == "$expected" ]]; then
    pass=$((pass + 1))
  else
    echo "FAIL (JSON mismatch): $desc"
    echo "  expression: $jq_expr"
    echo "  expected:   $expected"
    echo "  actual:     $actual"
    fail=$((fail + 1))
  fi
}

cleanup() {
  rm -f /tmp/plan-ledger-9*.json /tmp/review-ledger-9*.json
}
trap cleanup EXIT

echo "==> Running codex-ledger tests..."

# ============================================================
# init tests
# ============================================================
N=$((TEST_NUM + 1))

assert_ok "init creates plan ledger" \
  "$LEDGER" init "$N" plan

assert_json_eq "init: correct issue_number" \
  '.issue_number' "$N" "/tmp/plan-ledger-${N}.json"

assert_json_eq "init: correct ledger_type" \
  '.ledger_type' 'plan' "/tmp/plan-ledger-${N}.json"

assert_json_eq "init: entries is empty array" \
  '.entries | length' '0' "/tmp/plan-ledger-${N}.json"

assert_json_eq "init: has created_at" \
  '.created_at | length > 0' 'true' "/tmp/plan-ledger-${N}.json"

# init refuses to overwrite existing ledger without --force
"$LEDGER" add "$N" plan '{"iteration":1,"type":"proposal","summary":"Before overwrite"}' >/dev/null 2>&1
assert_fail "init fails when ledger already exists" \
  "$LEDGER" init "$N" plan

# init --force overwrites existing ledger (even with open entries)
assert_ok "init --force overwrites existing ledger" \
  "$LEDGER" init "$N" plan --force

assert_json_eq "init --force: entries reset to empty" \
  '.entries | length' '0' "/tmp/plan-ledger-${N}.json"

# init also refuses overwrite when all entries resolved
"$LEDGER" add "$N" plan '{"iteration":1,"type":"proposal","summary":"Will resolve"}' >/dev/null 2>&1
"$LEDGER" transition "$N" plan P1 accepted "Good" >/dev/null 2>&1
assert_fail "init fails on resolved ledger without --force" \
  "$LEDGER" init "$N" plan

# init --force works on resolved ledger too
assert_ok "init --force overwrites resolved ledger" \
  "$LEDGER" init "$N" plan --force

assert_json_eq "init --force (resolved): entries reset to empty" \
  '.entries | length' '0' "/tmp/plan-ledger-${N}.json"

# init review ledger
N=$((TEST_NUM + 2))
assert_ok "init creates review ledger" \
  "$LEDGER" init "$N" review

assert_json_eq "init review: correct type" \
  '.ledger_type' 'review' "/tmp/review-ledger-${N}.json"

# init rejects invalid type
assert_fail "init rejects invalid type" \
  "$LEDGER" init "$N" "badtype"

# ============================================================
# add tests
# ============================================================
N=$((TEST_NUM + 10))
"$LEDGER" init "$N" plan >/dev/null

assert_ok "add appends plan entry" \
  "$LEDGER" add "$N" plan '{"iteration":1,"type":"proposal","summary":"Use atomic writes"}'

assert_json_eq "add: entry count is 1" \
  '.entries | length' '1' "/tmp/plan-ledger-${N}.json"

assert_json_eq "add: auto-assigned ID is P1" \
  '.entries[0].id' 'P1' "/tmp/plan-ledger-${N}.json"

assert_json_eq "add: status is open" \
  '.entries[0].status' 'open' "/tmp/plan-ledger-${N}.json"

assert_json_eq "add: evidence normalized to null" \
  '.entries[0].evidence' 'null' "/tmp/plan-ledger-${N}.json"

assert_json_eq "add: history is empty array" \
  '.entries[0].history | length' '0' "/tmp/plan-ledger-${N}.json"

# Duplicate ID rejection
assert_fail "add rejects duplicate ID" \
  "$LEDGER" add "$N" plan '{"id":"P1","iteration":2,"type":"proposal","summary":"Duplicate"}'

# Second entry gets P2
assert_ok "add auto-assigns P2 for second entry" \
  "$LEDGER" add "$N" plan '{"iteration":1,"type":"proposal","summary":"Second proposal"}'

assert_json_eq "add: second entry ID is P2" \
  '.entries[1].id' 'P2' "/tmp/plan-ledger-${N}.json"

# Non-open status on add
assert_fail "add rejects non-open status" \
  "$LEDGER" add "$N" plan '{"iteration":1,"type":"proposal","summary":"Bad","status":"accepted"}'

# Missing required field: summary
assert_fail "add rejects missing summary" \
  "$LEDGER" add "$N" plan '{"iteration":1,"type":"proposal"}'

# Missing required field: iteration
assert_fail "add rejects missing iteration" \
  "$LEDGER" add "$N" plan '{"type":"proposal","summary":"No iter"}'

# Invalid JSON
assert_fail "add rejects invalid JSON" \
  "$LEDGER" add "$N" plan 'not-json'

# Plan-specific: missing type
assert_fail "add rejects plan entry without type" \
  "$LEDGER" add "$N" plan '{"iteration":1,"summary":"No type"}'

# Plan-specific: wrong type value
assert_fail "add rejects plan entry with wrong type" \
  "$LEDGER" add "$N" plan '{"iteration":1,"type":"finding","summary":"Wrong type"}'

# Review-specific validation
N=$((TEST_NUM + 11))
"$LEDGER" init "$N" review >/dev/null

assert_ok "add appends review entry" \
  "$LEDGER" add "$N" review '{"iteration":1,"severity":"BLOCKING","summary":"Missing validation","file":"src/handler.ts","line":45}'

assert_json_eq "add review: ID is F1" \
  '.entries[0].id' 'F1' "/tmp/review-ledger-${N}.json"

# Review: missing severity
assert_fail "add rejects review without severity" \
  "$LEDGER" add "$N" review '{"iteration":1,"summary":"No sev","file":"a.ts","line":1}'

# Review: invalid severity
assert_fail "add rejects review with invalid severity" \
  "$LEDGER" add "$N" review '{"iteration":1,"severity":"WARNING","summary":"Bad sev","file":"a.ts","line":1}'

# Review: missing file
assert_fail "add rejects review without file" \
  "$LEDGER" add "$N" review '{"iteration":1,"severity":"BLOCKING","summary":"No file","line":1}'

# Review: missing line
assert_fail "add rejects review without line" \
  "$LEDGER" add "$N" review '{"iteration":1,"severity":"BLOCKING","summary":"No line","file":"a.ts"}'

# Evidence field normalized to null when omitted
assert_json_eq "add: evidence field exists and is null" \
  '.entries[0].evidence' 'null' "/tmp/review-ledger-${N}.json"

# ============================================================
# transition tests
# ============================================================
N=$((TEST_NUM + 20))
"$LEDGER" init "$N" plan >/dev/null
"$LEDGER" add "$N" plan '{"iteration":1,"type":"proposal","summary":"Transition test"}' >/dev/null

assert_ok "transition: open → accepted" \
  "$LEDGER" transition "$N" plan P1 accepted "Good idea, incorporated"

assert_json_eq "transition: status updated" \
  '.entries[0].status' 'accepted' "/tmp/plan-ledger-${N}.json"

assert_json_eq "transition: evidence stored" \
  '.entries[0].evidence' 'Good idea, incorporated' "/tmp/plan-ledger-${N}.json"

assert_json_eq "transition: history has 1 entry" \
  '.entries[0].history | length' '1' "/tmp/plan-ledger-${N}.json"

assert_json_eq "transition: history[0].from = open" \
  '.entries[0].history[0].from' 'open' "/tmp/plan-ledger-${N}.json"

assert_json_eq "transition: history[0].to = accepted" \
  '.entries[0].history[0].to' 'accepted' "/tmp/plan-ledger-${N}.json"

assert_json_eq "transition: history[0] has evidence" \
  '.entries[0].history[0].evidence' 'Good idea, incorporated' "/tmp/plan-ledger-${N}.json"

assert_json_eq "transition: history[0] has timestamp" \
  '.entries[0].history[0].timestamp | length > 0' 'true' "/tmp/plan-ledger-${N}.json"

# Terminal → any: rejected
assert_fail "transition rejects terminal → open" \
  "$LEDGER" transition "$N" plan P1 open "Revert"

# Plan: open → rejected
N=$((TEST_NUM + 21))
"$LEDGER" init "$N" plan >/dev/null
"$LEDGER" add "$N" plan '{"iteration":1,"type":"proposal","summary":"Reject test"}' >/dev/null

assert_ok "transition: open → rejected" \
  "$LEDGER" transition "$N" plan P1 rejected "Conflicts with non-goal"

# Review transitions
N=$((TEST_NUM + 22))
"$LEDGER" init "$N" review >/dev/null
"$LEDGER" add "$N" review '{"iteration":1,"severity":"BLOCKING","summary":"Fix test","file":"a.ts","line":1}' >/dev/null
"$LEDGER" add "$N" review '{"iteration":1,"severity":"SUGGESTION","summary":"Justify test","file":"b.ts","line":2}' >/dev/null
"$LEDGER" add "$N" review '{"iteration":1,"severity":"SUGGESTION","summary":"Withdraw test","file":"c.ts","line":3}' >/dev/null

assert_ok "review transition: open → fixed" \
  "$LEDGER" transition "$N" review F1 fixed "Added validation at a.ts:10"

assert_ok "review transition: open → justified" \
  "$LEDGER" transition "$N" review F2 justified "validateInput() at b.ts:5 already covers this"

assert_ok "review transition: open → withdrawn" \
  "$LEDGER" transition "$N" review F3 withdrawn "Codex accepted rebuttal"

# Verify all terminal statuses reject further transitions
assert_fail "fixed → open rejected" \
  "$LEDGER" transition "$N" review F1 open "Revert"

assert_fail "justified → fixed rejected" \
  "$LEDGER" transition "$N" review F2 fixed "Change mind"

assert_fail "withdrawn → justified rejected" \
  "$LEDGER" transition "$N" review F3 justified "Change mind"

# Invalid target status
N=$((TEST_NUM + 23))
"$LEDGER" init "$N" review >/dev/null
"$LEDGER" add "$N" review '{"iteration":1,"severity":"BLOCKING","summary":"Bad target","file":"a.ts","line":1}' >/dev/null

assert_fail "review transition: invalid target 'accepted'" \
  "$LEDGER" transition "$N" review F1 accepted "Wrong status"

# Missing entry ID
assert_fail "transition: missing entry" \
  "$LEDGER" transition "$N" review F99 fixed "Doesn't exist"

# Empty evidence
assert_fail "transition: empty evidence rejected" \
  "$LEDGER" transition "$N" review F1 fixed ""

# Whitespace-only evidence
assert_fail "transition: whitespace evidence rejected" \
  "$LEDGER" transition "$N" review F1 fixed "   "

# ============================================================
# Multi-transition history test
# ============================================================
N=$((TEST_NUM + 30))
"$LEDGER" init "$N" review >/dev/null
"$LEDGER" add "$N" review '{"iteration":1,"severity":"BLOCKING","summary":"Multi-history","file":"a.ts","line":1}' >/dev/null
"$LEDGER" add "$N" review '{"iteration":1,"severity":"SUGGESTION","summary":"Another finding","file":"b.ts","line":2}' >/dev/null

"$LEDGER" transition "$N" review F1 fixed "First fix" >/dev/null
"$LEDGER" transition "$N" review F2 justified "Already handled" >/dev/null

assert_json_eq "multi-transition: F1 has 1 history entry" \
  '.entries[0].history | length' '1' "/tmp/review-ledger-${N}.json"

assert_json_eq "multi-transition: F2 has 1 history entry" \
  '.entries[1].history | length' '1' "/tmp/review-ledger-${N}.json"

assert_json_eq "multi-transition: F1 history from=open" \
  '.entries[0].history[0].from' 'open' "/tmp/review-ledger-${N}.json"

assert_json_eq "multi-transition: F2 history to=justified" \
  '.entries[1].history[0].to' 'justified' "/tmp/review-ledger-${N}.json"

# ============================================================
# Cross-iteration ID allocation
# ============================================================
N=$((TEST_NUM + 40))
"$LEDGER" init "$N" review >/dev/null
"$LEDGER" add "$N" review '{"iteration":1,"severity":"BLOCKING","summary":"Iter 1 finding","file":"a.ts","line":1}' >/dev/null
"$LEDGER" add "$N" review '{"iteration":1,"severity":"SUGGESTION","summary":"Iter 1 suggestion","file":"b.ts","line":2}' >/dev/null

# Transition iter 1 entries
"$LEDGER" transition "$N" review F1 fixed "Fixed in iter 1" >/dev/null
"$LEDGER" transition "$N" review F2 justified "Already handled" >/dev/null

# Add iter 2 entries — IDs should be F3, F4 (not F1, F2)
"$LEDGER" add "$N" review '{"iteration":2,"severity":"BLOCKING","summary":"Iter 2 new finding","file":"c.ts","line":3}' >/dev/null
"$LEDGER" add "$N" review '{"iteration":2,"severity":"SUGGESTION","summary":"Iter 2 new suggestion","file":"d.ts","line":4}' >/dev/null

assert_json_eq "cross-iter: third entry is F3" \
  '.entries[2].id' 'F3' "/tmp/review-ledger-${N}.json"

assert_json_eq "cross-iter: fourth entry is F4" \
  '.entries[3].id' 'F4' "/tmp/review-ledger-${N}.json"

assert_json_eq "cross-iter: F3 is iteration 2" \
  '.entries[2].iteration' '2' "/tmp/review-ledger-${N}.json"

assert_json_eq "cross-iter: total entries = 4" \
  '.entries | length' '4' "/tmp/review-ledger-${N}.json"

# ============================================================
# summary tests
# ============================================================
N=$((TEST_NUM + 50))
"$LEDGER" init "$N" review >/dev/null
"$LEDGER" add "$N" review '{"iteration":1,"severity":"BLOCKING","summary":"S1","file":"a.ts","line":1}' >/dev/null
"$LEDGER" add "$N" review '{"iteration":1,"severity":"SUGGESTION","summary":"S2","file":"b.ts","line":2}' >/dev/null
"$LEDGER" add "$N" review '{"iteration":1,"severity":"BLOCKING","summary":"S3","file":"c.ts","line":3}' >/dev/null

"$LEDGER" transition "$N" review F1 fixed "Fixed" >/dev/null

summary_out=$("$LEDGER" summary "$N" review)
summary_open=$(echo "$summary_out" | jq '.open')
summary_fixed=$(echo "$summary_out" | jq '.fixed')
summary_justified=$(echo "$summary_out" | jq '.justified')
summary_withdrawn=$(echo "$summary_out" | jq '.withdrawn')

if [[ "$summary_open" == "2" && "$summary_fixed" == "1" && "$summary_justified" == "0" && "$summary_withdrawn" == "0" ]]; then
  pass=$((pass + 1))
else
  echo "FAIL: summary counts incorrect"
  echo "  expected: open=2, fixed=1, justified=0, withdrawn=0"
  echo "  actual:   open=$summary_open, fixed=$summary_fixed, justified=$summary_justified, withdrawn=$summary_withdrawn"
  fail=$((fail + 1))
fi

# Plan summary
N=$((TEST_NUM + 51))
"$LEDGER" init "$N" plan >/dev/null
"$LEDGER" add "$N" plan '{"iteration":1,"type":"proposal","summary":"SP1"}' >/dev/null
"$LEDGER" add "$N" plan '{"iteration":1,"type":"proposal","summary":"SP2"}' >/dev/null
"$LEDGER" transition "$N" plan P1 accepted "Good" >/dev/null
"$LEDGER" transition "$N" plan P2 rejected "Bad" >/dev/null

plan_summary=$("$LEDGER" summary "$N" plan)
ps_open=$(echo "$plan_summary" | jq '.open')
ps_accepted=$(echo "$plan_summary" | jq '.accepted')
ps_rejected=$(echo "$plan_summary" | jq '.rejected')

if [[ "$ps_open" == "0" && "$ps_accepted" == "1" && "$ps_rejected" == "1" ]]; then
  pass=$((pass + 1))
else
  echo "FAIL: plan summary counts incorrect"
  echo "  expected: open=0, accepted=1, rejected=1"
  echo "  actual:   open=$ps_open, accepted=$ps_accepted, rejected=$ps_rejected"
  fail=$((fail + 1))
fi

# ============================================================
# assert-zero-open tests
# ============================================================
N=$((TEST_NUM + 60))
"$LEDGER" init "$N" plan >/dev/null
"$LEDGER" add "$N" plan '{"iteration":1,"type":"proposal","summary":"Open entry"}' >/dev/null

# Should fail with open entries
assert_fail "assert-zero-open fails with open entries" \
  "$LEDGER" assert-zero-open "$N" plan

# Resolve the entry
"$LEDGER" transition "$N" plan P1 accepted "Accepted" >/dev/null

assert_ok "assert-zero-open succeeds when all resolved" \
  "$LEDGER" assert-zero-open "$N" plan

# Withdrawn counts as resolved
N=$((TEST_NUM + 61))
"$LEDGER" init "$N" review >/dev/null
"$LEDGER" add "$N" review '{"iteration":1,"severity":"BLOCKING","summary":"Withdrawn test","file":"a.ts","line":1}' >/dev/null

assert_fail "assert-zero-open fails before withdrawal" \
  "$LEDGER" assert-zero-open "$N" review

"$LEDGER" transition "$N" review F1 withdrawn "Codex accepted rebuttal" >/dev/null

assert_ok "assert-zero-open succeeds after withdrawal" \
  "$LEDGER" assert-zero-open "$N" review

# ============================================================
# prompt-context tests
# ============================================================
N=$((TEST_NUM + 70))
"$LEDGER" init "$N" plan >/dev/null
"$LEDGER" add "$N" plan '{"iteration":1,"type":"proposal","summary":"Context test"}' >/dev/null

assert_output_contains "prompt-context plan: mentions ledger path" \
  "/tmp/plan-ledger-${N}.json" \
  "$LEDGER" prompt-context "$N" plan

assert_output_contains "prompt-context plan: mentions open count" \
  "1 open" \
  "$LEDGER" prompt-context "$N" plan

assert_output_contains "prompt-context plan: mentions settled instruction" \
  "do not re-raise" \
  "$LEDGER" prompt-context "$N" plan

N=$((TEST_NUM + 71))
"$LEDGER" init "$N" review >/dev/null
"$LEDGER" add "$N" review '{"iteration":1,"severity":"BLOCKING","summary":"Review context","file":"a.ts","line":1}' >/dev/null
"$LEDGER" transition "$N" review F1 fixed "Fixed it" >/dev/null

assert_output_contains "prompt-context review: mentions fixed count" \
  "1 fixed" \
  "$LEDGER" prompt-context "$N" review

assert_output_contains "prompt-context review: mentions verification instruction" \
  "verify the fix via git diff" \
  "$LEDGER" prompt-context "$N" review

# ============================================================
# Edge cases
# ============================================================

# Ledger not initialized
N=$((TEST_NUM + 80))
assert_fail "add on non-existent ledger fails" \
  "$LEDGER" add "$N" plan '{"iteration":1,"type":"proposal","summary":"No ledger"}'

assert_fail "summary on non-existent ledger fails" \
  "$LEDGER" summary "$N" plan

assert_fail "assert-zero-open on non-existent ledger fails" \
  "$LEDGER" assert-zero-open "$N" plan

# Explicit ID provided
N=$((TEST_NUM + 81))
"$LEDGER" init "$N" plan >/dev/null
assert_ok "add with explicit ID" \
  "$LEDGER" add "$N" plan '{"id":"P42","iteration":1,"type":"proposal","summary":"Explicit ID"}'

assert_json_eq "explicit ID preserved" \
  '.entries[0].id' 'P42' "/tmp/plan-ledger-${N}.json"

# Auto-assignment after explicit ID
assert_ok "add auto-assigns after explicit ID" \
  "$LEDGER" add "$N" plan '{"iteration":1,"type":"proposal","summary":"After P42"}'

assert_json_eq "auto-assign after P42 = P43" \
  '.entries[1].id' 'P43' "/tmp/plan-ledger-${N}.json"

# Malformed explicit ID validation
N=$((TEST_NUM + 82))
"$LEDGER" init "$N" plan >/dev/null

assert_fail "add rejects non-numeric ID suffix (Pfoo)" \
  "$LEDGER" add "$N" plan '{"id":"Pfoo","iteration":1,"type":"proposal","summary":"Bad ID"}'

assert_fail "add rejects zero ID (P0)" \
  "$LEDGER" add "$N" plan '{"id":"P0","iteration":1,"type":"proposal","summary":"Zero ID"}'

assert_fail "add rejects wrong prefix (F1 in plan ledger)" \
  "$LEDGER" add "$N" plan '{"id":"F1","iteration":1,"type":"proposal","summary":"Wrong prefix"}'

assert_fail "add rejects bare number ID" \
  "$LEDGER" add "$N" plan '{"id":"42","iteration":1,"type":"proposal","summary":"Bare num"}'

N=$((TEST_NUM + 83))
"$LEDGER" init "$N" review >/dev/null

assert_fail "add rejects wrong prefix (P1 in review ledger)" \
  "$LEDGER" add "$N" review '{"id":"P1","iteration":1,"severity":"BLOCKING","summary":"Wrong prefix","file":"a.ts","line":1}'

assert_fail "add rejects non-numeric review ID (Fbar)" \
  "$LEDGER" add "$N" review '{"id":"Fbar","iteration":1,"severity":"BLOCKING","summary":"Bad ID","file":"a.ts","line":1}'

assert_ok "add accepts valid explicit review ID (F10)" \
  "$LEDGER" add "$N" review '{"id":"F10","iteration":1,"severity":"BLOCKING","summary":"Valid explicit","file":"a.ts","line":1}'

# Auto-assign continues correctly after valid explicit ID
assert_ok "auto-assign after F10 = F11" \
  "$LEDGER" add "$N" review '{"iteration":1,"severity":"SUGGESTION","summary":"After F10","file":"b.ts","line":2}'

assert_json_eq "auto-assign after F10 is F11" \
  '.entries[1].id' 'F11' "/tmp/review-ledger-${N}.json"

# ============================================================
# Results
# ============================================================
echo ""
echo "==> codex-ledger tests: $pass passed, $fail failed"
if [[ "$fail" -gt 0 ]]; then
  exit 1
fi
