# Appendix J: Git Worktrees & Port Isolation

## Why Worktrees?

Git worktrees enable parallel development by creating separate working directories, each with its own branch. Benefits:

- **Parallel work**: Run multiple Claude Code sessions, each on a different issue
- **Clean state**: Each worktree has fresh `node_modules/` and build artifacts
- **No context switching**: Don't lose uncommitted work when switching issues
- **Isolated dev stacks**: Run `make dev` in multiple worktrees simultaneously

## Worktree Location

Worktrees are created as sibling directories to the main repo:

```
~/Development/
├── conductor/    # Main repo
├── cnd-294/                  # Worktree for issue #294
├── cnd-295/                  # Worktree for issue #295
└── cnd-301/                  # Worktree for issue #301
```

## Port Isolation

Each worktree gets a unique port offset based on `(issue_number % 79) * 100 + 3200`.

Port services are configured in `tools/scripts/worktree-ports.conf`. Each service defined there gets `BASE_PORT + offset` as its assigned port. URL-based exports are configured in `tools/scripts/worktree-urls.conf`.

Port offsets are set via shell exports (no env files):

```bash
# In the worktree, before running make dev:
eval "$(./tools/scripts/worktree-setup.sh 294 --print-env)"
make dev
```

This reads the port config and prints exports like:

```bash
export COMPOSE_PROJECT_NAME=cnd-294
export DEV_PORT=6200
export DB_PORT=8632
# ... (based on your worktree-ports.conf)
```

## Worktree Lifecycle

**Creation:** Automatic when running `/issue <num>` in START mode from main repo.

**Cleanup:** Manual. When done with an issue:

```bash
# From main repo
git worktree remove ../cnd-294
# Or delete the directory and prune
rm -rf ../cnd-294
git worktree prune
```

## Collision Risk

Port collisions occur when `issue_a % 79 == issue_b % 79`:

- Issues 294 and 373 would collide (both % 79 = 57)
- Issues 291 and 294 do NOT collide (54 vs 57)

If you need to work on colliding issues simultaneously, override the offset:

```bash
WORKTREE_PORT_OFFSET=3200 ./tools/scripts/worktree-setup.sh 294 feat/my-feature
```

Override must be in range 3200–11000 to avoid macOS system port collisions (below) and port overflow (above).

## Troubleshooting

**"Worktree already exists" when it doesn't:**

```bash
git worktree prune  # Clean up stale metadata
```

**Port conflict errors:**

```bash
# Check what's using the port
lsof -i :<port>
# Kill the process or use a different worktree
```

**Worktree detection fails:**

```bash
# Verify worktree list
git worktree list
# Should show all active worktrees with their branches
```

## tmux Portfolio Manager

The portfolio manager enables running multiple Claude Code sessions in parallel, each working on a separate issue. It uses tmux windows for process isolation and a hook-based notification system to alert you when a session needs attention.

### Architecture

```
tmux-session.sh (orchestrator)
├── Creates/manages tmux windows per issue
├── Tracks state in ~/.cnd/portfolio/<num>/
└── Provides list/focus/stop commands

portfolio-notify.sh (hook handler)
├── Called by Claude Code hooks automatically
├── Updates issue status files
├── Sends tmux bell + macOS notification on attention events
└── No-op when CND_ISSUE_NUM not set (safe for non-portfolio sessions)

.claude/settings.json hooks
├── PreToolUse:AskUserQuestion → needs-input
├── Notification:permission_prompt → needs-permission
├── PostToolUse:AskUserQuestion → running
└── Stop → idle
```

### Quick Start

```bash
# 1. Start your day (the only command you type)
make claude

# 2. Inside Claude, start issues — they spawn as background windows
/issue 345
/issue 294

# 3. Watch tmux status bar for '!' when a worker needs input
# Switch with: Ctrl-b + <window-number>

# 4. When you focus a window, Claude is waiting — just interact
/issue 345   # (re-run to load context if fresh window)

# 5. Return to main window
Ctrl-b + 0   (or whichever number is 'main')
```

### How It Works Under the Hood

The `/issue` skill calls `tmux-session.sh start` internally when it detects `$TMUX`.
You never need to call `tmux-session.sh` directly — Claude handles all orchestration.

### User Entry Point

| Command       | Description                                   |
| ------------- | --------------------------------------------- |
| `make claude` | Start your day: creates tmux session + Claude |

### Internal Commands (called by Claude, not by users)

| Command                                | Description                            |
| -------------------------------------- | -------------------------------------- |
| `tmux-session.sh init-and-run`         | Entry point used by `make claude`      |
| `tmux-session.sh start <num> [branch]` | Create worktree + window, start Claude |
| `tmux-session.sh list`                 | Show all issues with status and age    |
| `tmux-session.sh focus <num>`          | Switch to issue's tmux window          |
| `tmux-session.sh stop <num>`           | Gracefully stop issue, close window    |
| `tmux-session.sh stop-all`             | Stop all active workers                |
| `tmux-session.sh status [num]`         | Detailed status for one or all issues  |

### Issue Lifecycle States

| State         | Meaning                          | Set By                          |
| ------------- | -------------------------------- | ------------------------------- |
| `starting`    | Window created, Claude launching | `tmux-session.sh start`         |
| `running`     | Claude actively working          | PostToolUse hook                |
| `needs-input` | Claude asked a question          | PreToolUse:AskUserQuestion hook |
| `idle`        | Claude finished turn, waiting    | Stop hook                       |
| `complete`    | Issue work done                  | `tmux-session.sh stop`          |
| `crashed`     | Window gone unexpectedly         | Detected by `list` command      |

### Notification Flow

1. Claude calls `AskUserQuestion` in a portfolio window
2. `PreToolUse` hook fires → `portfolio-notify.sh needs-input`
3. Status file updated to `needs-input`
4. tmux bell triggers an alert indicator on the window in the status bar
5. macOS notification appears (if available)
6. User notices, switches to that window (`Ctrl-b + N`)
7. User responds to Claude's question
8. `PostToolUse` hook fires → `portfolio-notify.sh running`
9. Status resets to `running`

### When to Use Portfolio Manager vs Direct Worktrees

| Scenario                                 | Use                                     |
| ---------------------------------------- | --------------------------------------- |
| Working on one issue at a time           | `claude` directly (no tmux needed)      |
| Running 2+ issues in parallel            | `make claude` then `/issue` for each    |
| Need to monitor multiple Claude sessions | `make claude` (status bar shows alerts) |
| CI/automated workflows                   | Direct worktree (no tmux)               |

### Portfolio Troubleshooting

**"Portfolio session not found"**
Run `make claude` to start. It handles session creation automatically.

**Window shows '!' but Claude isn't asking anything**
The bell indicator may persist after the question is answered. It clears when you visit the window.

**"No worktree at ... Provide a branch name"**
The worktree doesn't exist yet. Provide a branch: `tmux-session.sh start 345 feat/my-feature`

**tmux not installed**
Install with: `brew install tmux`

**Hooks fire in main session (not just portfolio)**
This is by design. `portfolio-notify.sh` is a no-op when `CND_ISSUE_NUM` is not set, so it silently exits in non-portfolio sessions.
