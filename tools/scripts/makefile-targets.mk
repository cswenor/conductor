# ---------------------------------------------------------------------------
# claude-pm-toolkit targets
# ---------------------------------------------------------------------------
# These targets were added by claude-pm-toolkit install.
# Remove this block to uninstall the Makefile integration.

claude: ## Start Claude Code with tmux portfolio management
	@if command -v tmux >/dev/null 2>&1; then \
		./tools/scripts/tmux-session.sh init-and-run; \
	else \
		echo "tmux not installed. Starting Claude directly..."; \
		claude; \
	fi

pm-status: ## Show PM toolkit dashboard (health, worktrees, board)
	@./tools/scripts/pm-dashboard.sh

pm-validate: ## Validate PM toolkit installation
	@./tools/scripts/pm-dashboard.sh && echo "" && \
	echo "Quick validation:" && \
	errors=0; \
	for f in tools/scripts/pm.config.sh .claude/settings.json .claude/skills/issue/SKILL.md docs/PM_PLAYBOOK.md; do \
		if [ ! -f "$$f" ]; then echo "  FAIL: $$f missing"; errors=$$((errors+1)); fi; \
	done; \
	if grep -qE '^\w+=".*\{\{' tools/scripts/pm.config.sh 2>/dev/null; then \
		echo "  FAIL: pm.config.sh has unresolved placeholders"; errors=$$((errors+1)); \
	fi; \
	if [ "$$errors" -eq 0 ]; then echo "  All critical files present, no unresolved placeholders."; \
	else echo "  $$errors issue(s) found. Run install.sh --update to fix."; exit 1; fi

pm-archive: ## Archive completed issues (Done > 7 days)
	@./tools/scripts/project-archive-done.sh

# ---------------------------------------------------------------------------
# End claude-pm-toolkit targets
# ---------------------------------------------------------------------------
