#!/usr/bin/env bash
set -euo pipefail

# codex-ledger.sh — Deterministic convergence ledger for Codex review loops
#
# Manages plan and review ledgers as JSON files in /tmp/.
# Claude owns all writes; Codex reads via -s read-only.
#
# Usage:
#   codex-ledger.sh init <issue_num> <type> [--force]
#   codex-ledger.sh add <issue_num> <type> '<json>'
#   codex-ledger.sh transition <issue_num> <type> <id> <new_status> <evidence>
#   codex-ledger.sh summary <issue_num> <type>
#   codex-ledger.sh assert-zero-open <issue_num> <type>
#   codex-ledger.sh prompt-context <issue_num> <type>

# --- Helpers ---

die() { echo "ERROR: $*" >&2; exit 1; }

ledger_path() {
  local issue_num="$1" type="$2"
  echo "/tmp/${type}-ledger-${issue_num}.json"
}

# Atomic write: write to temp file then mv (prevents partial writes)
atomic_write() {
  local dest="$1"
  local tmp
  tmp=$(mktemp "${dest}.XXXXXX")
  cat > "$tmp"
  mv -f "$tmp" "$dest"
}

read_ledger() {
  local path
  path=$(ledger_path "$1" "$2")
  [[ -f "$path" ]] || die "Ledger not found: $path (run init first)"
  cat "$path"
}

# --- Subcommands ---

cmd_init() {
  local issue_num="$1" type="$2" force="${3:-}"
  [[ "$type" == "plan" || "$type" == "review" ]] || die "Invalid ledger type: $type (must be 'plan' or 'review')"

  local path
  path=$(ledger_path "$issue_num" "$type")

  # Safety: refuse to overwrite an existing ledger unless --force
  if [[ -f "$path" && "$force" != "--force" ]]; then
    die "Ledger already exists at $path. Use 'init $issue_num $type --force' to discard and reinitialize."
  fi

  local now
  now=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

  jq -n \
    --argjson issue_num "$issue_num" \
    --arg type "$type" \
    --arg created_at "$now" \
    '{issue_number: $issue_num, ledger_type: $type, created_at: $created_at, entries: []}' \
    | atomic_write "$path"

  echo "Initialized $type ledger at $path"
}

cmd_add() {
  local issue_num="$1" type="$2" json_payload="$3"
  local path
  path=$(ledger_path "$issue_num" "$type")
  local ledger
  ledger=$(read_ledger "$issue_num" "$type")

  # Validate JSON payload
  echo "$json_payload" | jq empty 2>/dev/null || die "Invalid JSON payload"

  # --- Common field validation ---

  # status must be "open" on creation
  local status
  status=$(echo "$json_payload" | jq -r '.status // empty')
  if [[ -n "$status" && "$status" != "open" ]]; then
    die "Status must be 'open' on creation (got: $status)"
  fi

  # iteration is required and must be integer >= 1
  local iteration
  iteration=$(echo "$json_payload" | jq -r '.iteration // empty')
  [[ -n "$iteration" ]] || die "Missing required field: iteration"
  [[ "$iteration" =~ ^[0-9]+$ && "$iteration" -ge 1 ]] || die "iteration must be integer >= 1 (got: $iteration)"

  # summary is required and non-empty
  local summary
  summary=$(echo "$json_payload" | jq -r '.summary // empty')
  [[ -n "$summary" ]] || die "Missing required field: summary"

  # --- Type-specific validation ---

  if [[ "$type" == "plan" ]]; then
    local entry_type
    entry_type=$(echo "$json_payload" | jq -r '.type // empty')
    [[ -n "$entry_type" ]] || die "Missing required field for plan ledger: type"
    [[ "$entry_type" == "proposal" ]] || die "Invalid type for plan ledger: $entry_type (must be 'proposal')"
  elif [[ "$type" == "review" ]]; then
    local severity
    severity=$(echo "$json_payload" | jq -r '.severity // empty')
    [[ -n "$severity" ]] || die "Missing required field for review ledger: severity"
    [[ "$severity" == "BLOCKING" || "$severity" == "SUGGESTION" ]] || die "Invalid severity: $severity (must be 'BLOCKING' or 'SUGGESTION')"

    local file_field
    file_field=$(echo "$json_payload" | jq -r '.file // empty')
    [[ -n "$file_field" ]] || die "Missing required field for review ledger: file"

    local line_field
    line_field=$(echo "$json_payload" | jq -r 'if .line == null then "" else (.line | tostring) end')
    [[ -n "$line_field" ]] || die "Missing required field for review ledger: line"
    [[ "$line_field" =~ ^[0-9]+$ ]] || die "line must be integer >= 0 (got: $line_field)"
  fi

  # --- ID handling: auto-assign if omitted, validate if explicit ---
  local entry_id
  entry_id=$(echo "$json_payload" | jq -r '.id // empty')

  local prefix
  [[ "$type" == "plan" ]] && prefix="P" || prefix="F"

  if [[ -z "$entry_id" ]]; then
    # Auto-assign: P<n> for plan, F<n> for review
    local max_num
    max_num=$(echo "$ledger" | jq -r --arg pfx "$prefix" \
      '[.entries[].id | select(startswith($pfx)) | ltrimstr($pfx) | tonumber] | if length == 0 then 0 else max end')
    entry_id="${prefix}$(( max_num + 1 ))"
  else
    # Validate explicit ID format: P<n> for plan, F<n> for review (n >= 1)
    if ! [[ "$entry_id" =~ ^${prefix}[1-9][0-9]*$ ]]; then
      die "Invalid ID format: $entry_id (must match ${prefix}<n> where n >= 1, e.g. ${prefix}1, ${prefix}42)"
    fi
  fi

  # --- Duplicate ID check ---
  local dup
  dup=$(echo "$ledger" | jq -r --arg id "$entry_id" '.entries[] | select(.id == $id) | .id')
  [[ -z "$dup" ]] || die "Duplicate ID: $entry_id already exists in ledger"

  # --- Build the stored entry (normalize fields) ---
  local new_entry
  if [[ "$type" == "plan" ]]; then
    new_entry=$(echo "$json_payload" | jq \
      --arg id "$entry_id" \
      '{id: $id, iteration: .iteration, type: .type, summary: .summary, status: "open", evidence: (.evidence // null), history: []}')
  else
    new_entry=$(echo "$json_payload" | jq \
      --arg id "$entry_id" \
      '{id: $id, iteration: .iteration, severity: .severity, summary: .summary, file: .file, line: .line, status: "open", evidence: (.evidence // null), history: []}')
  fi

  # Append entry to ledger
  echo "$ledger" | jq --argjson entry "$new_entry" '.entries += [$entry]' \
    | atomic_write "$path"

  echo "Added $entry_id to $type ledger"
}

cmd_transition() {
  local issue_num="$1" type="$2" entry_id="$3" new_status="$4" evidence="$5"
  local path
  path=$(ledger_path "$issue_num" "$type")
  local ledger
  ledger=$(read_ledger "$issue_num" "$type")

  # Validate evidence is non-empty
  local trimmed
  trimmed=$(echo "$evidence" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
  [[ -n "$trimmed" ]] || die "Evidence is required for all transitions (cannot be empty or whitespace-only)"

  # Find entry
  local current_status
  current_status=$(echo "$ledger" | jq -r --arg id "$entry_id" '.entries[] | select(.id == $id) | .status')
  [[ -n "$current_status" ]] || die "Entry not found: $entry_id"

  # Validate transition
  if [[ "$type" == "plan" ]]; then
    [[ "$current_status" == "open" ]] || die "Invalid transition: $entry_id is '$current_status' (terminal — cannot transition)"
    [[ "$new_status" == "accepted" || "$new_status" == "rejected" ]] || die "Invalid plan transition: open → $new_status (must be 'accepted' or 'rejected')"
  elif [[ "$type" == "review" ]]; then
    [[ "$current_status" == "open" ]] || die "Invalid transition: $entry_id is '$current_status' (terminal — cannot transition)"
    [[ "$new_status" == "fixed" || "$new_status" == "justified" || "$new_status" == "withdrawn" ]] || die "Invalid review transition: open → $new_status (must be 'fixed', 'justified', or 'withdrawn')"
  fi

  # Apply transition with history
  local now
  now=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

  echo "$ledger" | jq \
    --arg id "$entry_id" \
    --arg new_status "$new_status" \
    --arg evidence "$evidence" \
    --arg from "$current_status" \
    --arg ts "$now" \
    '(.entries[] | select(.id == $id)) |= (
      .history += [{from: $from, to: $new_status, evidence: $evidence, timestamp: $ts}]
      | .status = $new_status
      | .evidence = $evidence
    )' \
    | atomic_write "$path"

  echo "Transitioned $entry_id: $current_status → $new_status"
}

cmd_summary() {
  local issue_num="$1" type="$2"
  local ledger
  ledger=$(read_ledger "$issue_num" "$type")

  if [[ "$type" == "plan" ]]; then
    echo "$ledger" | jq '{
      open: [.entries[] | select(.status == "open")] | length,
      accepted: [.entries[] | select(.status == "accepted")] | length,
      rejected: [.entries[] | select(.status == "rejected")] | length
    }'
  else
    echo "$ledger" | jq '{
      open: [.entries[] | select(.status == "open")] | length,
      fixed: [.entries[] | select(.status == "fixed")] | length,
      justified: [.entries[] | select(.status == "justified")] | length,
      withdrawn: [.entries[] | select(.status == "withdrawn")] | length
    }'
  fi
}

cmd_assert_zero_open() {
  local issue_num="$1" type="$2"
  local ledger
  ledger=$(read_ledger "$issue_num" "$type")

  local open_count
  open_count=$(echo "$ledger" | jq '[.entries[] | select(.status == "open")] | length')

  if [[ "$open_count" -eq 0 ]]; then
    echo "All entries resolved (zero open)"
    exit 0
  else
    echo "OPEN ENTRIES REMAIN: $open_count" >&2
    echo "$ledger" | jq -r '.entries[] | select(.status == "open") | "  \(.id): \(.summary)"' >&2
    exit 1
  fi
}

cmd_prompt_context() {
  local issue_num="$1" type="$2"
  local ledger
  ledger=$(read_ledger "$issue_num" "$type")
  local path
  path=$(ledger_path "$issue_num" "$type")

  local total open_count
  total=$(echo "$ledger" | jq '.entries | length')
  open_count=$(echo "$ledger" | jq '[.entries[] | select(.status == "open")] | length')

  if [[ "$type" == "plan" ]]; then
    local accepted rejected
    accepted=$(echo "$ledger" | jq '[.entries[] | select(.status == "accepted")] | length')
    rejected=$(echo "$ledger" | jq '[.entries[] | select(.status == "rejected")] | length')

    echo "Read the plan ledger at $path. $total proposals total: $open_count open, $accepted accepted, $rejected rejected. Proposals with status accepted/rejected are settled — do not re-raise. Only suggest changes for open proposals or raise new concerns not in the ledger."
  else
    local fixed justified withdrawn
    fixed=$(echo "$ledger" | jq '[.entries[] | select(.status == "fixed")] | length')
    justified=$(echo "$ledger" | jq '[.entries[] | select(.status == "justified")] | length')
    withdrawn=$(echo "$ledger" | jq '[.entries[] | select(.status == "withdrawn")] | length')

    echo "Read the review ledger at $path. $total findings total: $open_count open, $fixed fixed, $justified justified, $withdrawn withdrawn. Findings with status fixed/justified/withdrawn are settled. For fixed findings, verify the fix via git diff. For justified findings, accept if evidence is valid or raise NEW counter-evidence. Only raise NEW findings not already in the ledger."
  fi
}

# --- Main dispatcher ---

[[ $# -ge 1 ]] || die "Usage: codex-ledger.sh <command> <issue_num> <type> [args...]"

cmd="$1"; shift

case "$cmd" in
  init)
    [[ $# -ge 2 ]] || die "Usage: codex-ledger.sh init <issue_num> <type> [--force]"
    cmd_init "$1" "$2" "${3:-}"
    ;;
  add)
    [[ $# -ge 3 ]] || die "Usage: codex-ledger.sh add <issue_num> <type> '<json>'"
    cmd_add "$1" "$2" "$3"
    ;;
  transition)
    [[ $# -ge 5 ]] || die "Usage: codex-ledger.sh transition <issue_num> <type> <id> <new_status> <evidence>"
    cmd_transition "$1" "$2" "$3" "$4" "$5"
    ;;
  summary)
    [[ $# -ge 2 ]] || die "Usage: codex-ledger.sh summary <issue_num> <type>"
    cmd_summary "$1" "$2"
    ;;
  assert-zero-open)
    [[ $# -ge 2 ]] || die "Usage: codex-ledger.sh assert-zero-open <issue_num> <type>"
    cmd_assert_zero_open "$1" "$2"
    ;;
  prompt-context)
    [[ $# -ge 2 ]] || die "Usage: codex-ledger.sh prompt-context <issue_num> <type>"
    cmd_prompt_context "$1" "$2"
    ;;
  *)
    die "Unknown command: $cmd (expected: init, add, transition, summary, assert-zero-open, prompt-context)"
    ;;
esac
