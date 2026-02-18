# ---------------------------------------------------------------------------
# claude-pm-toolkit targets
# ---------------------------------------------------------------------------
# These targets were added by claude-pm-toolkit install.
# Remove this block to uninstall the Makefile integration.

## Start a Claude Code tmux session with portfolio management
claude: ## Start Claude Code (tmux portfolio mode)
	@if command -v tmux >/dev/null 2>&1; then \
		./tools/scripts/tmux-session.sh init-and-run; \
	else \
		echo "tmux not installed. Starting Claude directly..."; \
		claude; \
	fi

## Show PM toolkit dashboard (toolkit health, worktrees, board summary)
pm-status: ## PM toolkit dashboard
	@./tools/scripts/pm-dashboard.sh

## Validate PM toolkit installation
pm-validate: ## Validate toolkit installation
	@./tools/scripts/pm-dashboard.sh && echo "" && echo "For full validation, run: validate.sh"

## Archive completed issues older than 30 days
pm-archive: ## Archive completed issues
	@./tools/scripts/project-archive-done.sh

# ---------------------------------------------------------------------------
# End claude-pm-toolkit targets
# ---------------------------------------------------------------------------
