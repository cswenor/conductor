#!/usr/bin/env bash
set -euo pipefail

# uninstall.sh - Remove claude-pm-toolkit from an existing repository
#
# Usage:
#   ./uninstall.sh /path/to/your/repo             # Show what would be removed
#   ./uninstall.sh --confirm /path/to/your/repo    # Actually remove files

# ---------------------------------------------------------------------------
# Colors
# ---------------------------------------------------------------------------
RED='\033[0;31m'
YELLOW='\033[1;33m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
BOLD='\033[1m'
RESET='\033[0m'

log_info()    { printf "${CYAN}[info]${RESET}  %s\n" "$*"; }
log_ok()      { printf "${GREEN}[ok]${RESET}    %s\n" "$*"; }
log_warn()    { printf "${YELLOW}[warn]${RESET}  %s\n" "$*"; }
log_error()   { printf "${RED}[error]${RESET} %s\n" "$*" >&2; }
log_section() { printf "\n${BOLD}%s${RESET}\n%s\n" "$*" "$(printf '%0.s-' {1..60})"; }

# ---------------------------------------------------------------------------
# Parse arguments
# ---------------------------------------------------------------------------
CONFIRM=false
TARGET=""

for arg in "$@"; do
  case "$arg" in
    --confirm) CONFIRM=true ;;
    --help|-h)
      cat <<EOF
uninstall.sh - Remove claude-pm-toolkit from a repository

USAGE
  ./uninstall.sh /path/to/repo             # Dry run (show what would be removed)
  ./uninstall.sh --confirm /path/to/repo   # Actually remove files

WHAT IT REMOVES
  - tools/scripts/pm.config.sh, project-*.sh, worktree-*.sh, tmux-session.sh
  - tools/scripts/claude-*-guard.sh, claude-secret-*.sh, portfolio-notify.sh
  - tools/scripts/find-plan.sh
  - tools/config/ (command-guard.conf, secret-patterns.json, secret-paths.conf)
  - tools/scripts/worktree-ports.conf, worktree-urls.conf
  - .claude/skills/issue/, .claude/skills/pm-review/, .claude/skills/weekly/
  - docs/PM_PLAYBOOK.md, docs/PM_PROJECT_CONFIG.md
  - reports/weekly/ (directory structure only, not reports you generated)
  - .claude-pm-toolkit.json (metadata)

WHAT IT PRESERVES
  - CLAUDE.md (sentinel block removed, rest untouched)
  - .claude/settings.json (toolkit hooks removed, rest untouched)
  - Any files not installed by the toolkit

EOF
      exit 0
      ;;
    *) TARGET="$arg" ;;
  esac
done

if [[ -z "$TARGET" ]]; then
  log_error "Usage: ./uninstall.sh [--confirm] /path/to/repo"
  exit 1
fi

if [[ ! -d "$TARGET" ]]; then
  log_error "Target directory does not exist: $TARGET"
  exit 1
fi

TARGET="$(cd "$TARGET" && pwd)"

# Check for metadata file
METADATA="$TARGET/.claude-pm-toolkit.json"
if [[ ! -f "$METADATA" ]]; then
  log_warn "No .claude-pm-toolkit.json found — toolkit may not be installed here"
  log_warn "Continuing anyway (will remove known toolkit files if found)"
fi

# ---------------------------------------------------------------------------
# Files and directories to remove
# ---------------------------------------------------------------------------

# Toolkit-installed scripts
TOOLKIT_FILES=(
  "tools/scripts/pm.config.sh"
  "tools/scripts/project-add.sh"
  "tools/scripts/project-move.sh"
  "tools/scripts/project-status.sh"
  "tools/scripts/project-archive-done.sh"
  "tools/scripts/worktree-setup.sh"
  "tools/scripts/worktree-detect.sh"
  "tools/scripts/worktree-cleanup.sh"
  "tools/scripts/worktree-ports.conf"
  "tools/scripts/worktree-urls.conf"
  "tools/scripts/tmux-session.sh"
  "tools/scripts/portfolio-notify.sh"
  "tools/scripts/find-plan.sh"
  "tools/scripts/claude-command-guard.sh"
  "tools/scripts/claude-secret-guard.sh"
  "tools/scripts/claude-secret-bash-guard.sh"
  "tools/scripts/claude-secret-detect.sh"
  "tools/scripts/claude-secret-check-path.sh"
  "tools/scripts/codex-mcp-overrides.sh"
  "tools/scripts/pm-dashboard.sh"
  "tools/scripts/makefile-targets.mk"
  "tools/config/command-guard.conf"
  "tools/config/secret-patterns.json"
  "tools/config/secret-paths.conf"
  "docs/PM_PLAYBOOK.md"
  "docs/PM_PROJECT_CONFIG.md"
  ".claude-pm-toolkit.json"
)

# Toolkit-installed directories (removed if empty after file removal)
TOOLKIT_DIRS=(
  ".claude/skills/issue"
  ".claude/skills/pm-review"
  ".claude/skills/weekly"
  ".claude/skills"
  "tools/config"
  "tools/scripts"
  "tools"
  "reports/weekly/analysis"
  "reports/weekly"
  "reports"
)

# ---------------------------------------------------------------------------
# Sentinel block in CLAUDE.md
# ---------------------------------------------------------------------------
SENTINEL_START="<!-- claude-pm-toolkit:start -->"
SENTINEL_END="<!-- claude-pm-toolkit:end -->"

# ---------------------------------------------------------------------------
# Hooks in settings.json
# ---------------------------------------------------------------------------
# These are the script paths that the toolkit installs as hooks
TOOLKIT_HOOK_SCRIPTS=(
  "./tools/scripts/claude-command-guard.sh"
  "./tools/scripts/claude-secret-bash-guard.sh"
  "./tools/scripts/claude-secret-guard.sh"
  "./tools/scripts/claude-secret-detect.sh"
  "./tools/scripts/portfolio-notify.sh"
)

# ---------------------------------------------------------------------------
# Dry run or execute
# ---------------------------------------------------------------------------

if ! $CONFIRM; then
  log_section "DRY RUN — showing what would be removed"
  log_info "Run with --confirm to actually remove files"
  printf "\n"
fi

removed_count=0
skipped_count=0

# Remove individual files
log_section "Toolkit files"
for rel in "${TOOLKIT_FILES[@]}"; do
  full="$TARGET/$rel"
  if [[ -f "$full" ]]; then
    if $CONFIRM; then
      rm "$full"
      log_ok "Removed: $rel"
    else
      log_info "Would remove: $rel"
    fi
    removed_count=$((removed_count + 1))
  fi
done

# Remove skill directories (with content)
log_section "Skill directories"
for skill_dir in ".claude/skills/issue" ".claude/skills/pm-review" ".claude/skills/weekly"; do
  full="$TARGET/$skill_dir"
  if [[ -d "$full" ]]; then
    if $CONFIRM; then
      rm -rf "$full"
      log_ok "Removed: $skill_dir/"
    else
      log_info "Would remove: $skill_dir/"
    fi
    removed_count=$((removed_count + 1))
  fi
done

# Remove .gitkeep files in report dirs
for gitkeep in "reports/weekly/.gitkeep" "reports/weekly/analysis/.gitkeep"; do
  full="$TARGET/$gitkeep"
  if [[ -f "$full" ]]; then
    if $CONFIRM; then
      rm "$full"
      log_ok "Removed: $gitkeep"
    else
      log_info "Would remove: $gitkeep"
    fi
    removed_count=$((removed_count + 1))
  fi
done

# Clean up empty directories
log_section "Empty directories"
for dir_rel in "${TOOLKIT_DIRS[@]}"; do
  full="$TARGET/$dir_rel"
  if [[ -d "$full" ]] && [[ -z "$(ls -A "$full" 2>/dev/null)" ]]; then
    if $CONFIRM; then
      rmdir "$full"
      log_ok "Removed empty dir: $dir_rel/"
    else
      log_info "Would remove empty dir: $dir_rel/"
    fi
  fi
done

# Clean sentinel block from CLAUDE.md
log_section "CLAUDE.md sentinel block"
CLAUDE_MD="$TARGET/CLAUDE.md"
if [[ -f "$CLAUDE_MD" ]] && grep -qF "$SENTINEL_START" "$CLAUDE_MD"; then
  if $CONFIRM; then
    tmp_md=$(mktemp)
    awk -v start="$SENTINEL_START" -v end="$SENTINEL_END" \
        'BEGIN { skip=0 }
         $0 == start { skip=1; next }
         $0 == end   { skip=0; next }
         !skip       { print }
        ' "$CLAUDE_MD" > "$tmp_md"
    mv "$tmp_md" "$CLAUDE_MD"
    log_ok "Removed sentinel block from CLAUDE.md"
  else
    log_info "Would remove sentinel block from CLAUDE.md"
  fi
  removed_count=$((removed_count + 1))
else
  log_info "No sentinel block found in CLAUDE.md"
fi

# Clean Makefile sentinel block
log_section "Makefile targets"
TARGET_MAKEFILE="$TARGET/Makefile"
MK_SENTINEL_START="# claude-pm-toolkit:start"
MK_SENTINEL_END="# claude-pm-toolkit:end"
if [[ -f "$TARGET_MAKEFILE" ]] && grep -qF "$MK_SENTINEL_START" "$TARGET_MAKEFILE"; then
  if $CONFIRM; then
    tmp_mk=$(mktemp)
    awk -v start="$MK_SENTINEL_START" -v end="$MK_SENTINEL_END" \
        'BEGIN { skip=0 }
         $0 == start { skip=1; next }
         $0 == end   { skip=0; next }
         !skip       { print }
        ' "$TARGET_MAKEFILE" > "$tmp_mk"
    mv "$tmp_mk" "$TARGET_MAKEFILE"
    log_ok "Removed toolkit targets from Makefile"
  else
    log_info "Would remove toolkit targets from Makefile"
  fi
  removed_count=$((removed_count + 1))
else
  log_info "No toolkit targets found in Makefile"
fi

# Clean hooks from settings.json
log_section "Settings.json hooks"
SETTINGS="$TARGET/.claude/settings.json"
if [[ -f "$SETTINGS" ]]; then
  hooks_found=false
  for script in "${TOOLKIT_HOOK_SCRIPTS[@]}"; do
    if grep -qF "$script" "$SETTINGS"; then
      hooks_found=true
      break
    fi
  done

  if $hooks_found; then
    if $CONFIRM; then
      # Remove hook entries that reference toolkit scripts
      # This uses python3 for reliable JSON manipulation
      python3 -c "
import json, sys

with open('$SETTINGS') as f:
    data = json.load(f)

toolkit_scripts = set($( printf '['; for s in "${TOOLKIT_HOOK_SCRIPTS[@]}"; do printf '"%s",' "$s"; done; printf ']' ))

if 'hooks' in data:
    for event_name in list(data['hooks'].keys()):
        matchers = data['hooks'][event_name]
        cleaned_matchers = []
        for matcher in matchers:
            if 'hooks' in matcher:
                cleaned_hooks = [h for h in matcher['hooks'] if h.get('command', '') not in toolkit_scripts]
                if cleaned_hooks:
                    matcher['hooks'] = cleaned_hooks
                    cleaned_matchers.append(matcher)
            else:
                cleaned_matchers.append(matcher)
        if cleaned_matchers:
            data['hooks'][event_name] = cleaned_matchers
        else:
            del data['hooks'][event_name]

    # Remove hooks key entirely if empty
    if not data['hooks']:
        del data['hooks']

with open('$SETTINGS', 'w') as f:
    json.dump(data, f, indent=2)
    f.write('\n')
" 2>/dev/null
      log_ok "Removed toolkit hooks from settings.json"
    else
      log_info "Would remove toolkit hooks from settings.json"
    fi
    removed_count=$((removed_count + 1))
  else
    log_info "No toolkit hooks found in settings.json"
  fi
else
  log_info "No settings.json found"
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
printf "\n"
if $CONFIRM; then
  log_section "Uninstall complete"
  log_ok "Removed $removed_count items"
  log_info "Your CLAUDE.md and settings.json have been cleaned (non-toolkit content preserved)"
  log_info "You may want to run: git diff  to review changes before committing"
else
  log_section "Dry run complete"
  log_info "Would remove $removed_count items"
  log_info "Run with --confirm to actually remove files:"
  printf "  ./uninstall.sh --confirm %s\n" "$TARGET"
fi
