# Appendix K: Priority Reasoning Guidelines

## Priority Definitions

| Priority     | Meaning                     | When to Use                                               |
| ------------ | --------------------------- | --------------------------------------------------------- |
| **Critical** | Drop everything and address | Production outage, security vulnerability, data loss risk |
| **High**     | Address before normal work  | High user/developer impact, blocking planned work         |
| **Normal**   | Standard priority           | Most features, bugs, and improvements                     |

## Factor Evaluation Guide

### Urgency (Is this time-sensitive?)

| Rating   | Signals                                                            |
| -------- | ------------------------------------------------------------------ |
| **High** | Blocking other active work; production impact; time-boxed deadline |
| **Med**  | Compounds over time; affects upcoming sprint work; user-reported   |
| **Low**  | No deadline pressure; can wait for natural prioritization          |

### Impact (How many people are affected? How severe?)

| Rating   | Signals                                                            |
| -------- | ------------------------------------------------------------------ |
| **High** | Affects all users/developers; core workflow broken; data integrity |
| **Med**  | Affects subset of users; degraded experience; workaround exists    |
| **Low**  | Edge case; cosmetic; single user affected                          |

### Dependencies (Does other work depend on this?)

| Rating   | Signals                                                        |
| -------- | -------------------------------------------------------------- |
| **High** | Multiple issues blocked by this; prerequisite for planned epic |
| **Med**  | One issue depends on this; enables future work                 |
| **Low**  | Standalone; no other work waiting on this                      |

### Effort (How much work is involved?)

| Rating   | Signals                                                   |
| -------- | --------------------------------------------------------- |
| **High** | Multi-day; cross-package changes; requires research/spike |
| **Med**  | Half-day to full day; few files; well-understood approach |
| **Low**  | Quick win; single file; mechanical change                 |

**Note on Effort:** High effort does NOT lower priority — it informs scheduling. A high-impact, high-effort issue is still high priority; it just takes longer. Low effort + high impact = prioritize (quick win).

## Priority Rules

| Condition                                        | Priority     |
| ------------------------------------------------ | ------------ |
| Blocking other work right now                    | **Critical** |
| Impact=High OR (Urgency=High AND Impact>=Medium) | **High**     |
| Everything else                                  | **Normal**   |

## Key Principle

**Claude can propose priorities; humans decide.** The reasoning table makes Claude's thinking visible so the user can agree, adjust, or override. Never skip the confirmation step.

## Worked Examples

### Example 1: CLAUDE.md optimization

```
| Factor           | Rating | Explanation                                        |
| ---------------- | ------ | -------------------------------------------------- |
| **Urgency**      | Med    | Not blocking, but compounds every session          |
| **Impact**       | High   | Affects every development session for every dev    |
| **Dependencies** | Low    | No other work depends on this                      |
| **Effort**       | Med    | Analysis + restructuring of instruction file       |

Rule match: Impact=High → **High**
Recommended priority: High
```

### Example 2: Production login failure

```
| Factor           | Rating | Explanation                                        |
| ---------------- | ------ | -------------------------------------------------- |
| **Urgency**      | High   | Users cannot access the platform right now          |
| **Impact**       | High   | All users affected; core functionality broken       |
| **Dependencies** | High   | Blocks all user-facing work and testing             |
| **Effort**       | Low    | Likely config or deployment issue; quick to fix     |

Rule match: Blocking other work right now → **Critical**
Recommended priority: Critical
```

### Example 3: Add tooltip to settings page

```
| Factor           | Rating | Explanation                                        |
| ---------------- | ------ | -------------------------------------------------- |
| **Urgency**      | Low    | No deadline; cosmetic improvement                  |
| **Impact**       | Low    | Minor UX improvement; few users visit settings     |
| **Dependencies** | Low    | Standalone; nothing depends on this                |
| **Effort**       | Low    | Single component change                            |

Rule match: Everything else → **Normal**
Recommended priority: Normal
```

## Plan Files

**Default location:** Claude Code stores plan files in `~/.claude/plans/` (global). File names are randomly generated (e.g., `abundant-tumbling-zebra.md`) — this is observed behavior, not a documented guarantee.

**Project override:** This repo sets `plansDirectory` in `.claude/settings.json` to `.claude/plans`, which makes plan files project-local. Each worktree resolves this relative path against its own root directory, giving automatic per-worktree isolation.

**How isolation works:**

| Worktree              | Resolved plan directory             |
| --------------------- | ----------------------------------- |
| `/Users/dev/cnd-305/` | `/Users/dev/cnd-305/.claude/plans/` |
| `/Users/dev/cnd-270/` | `/Users/dev/cnd-270/.claude/plans/` |
| Main repo             | `<repo-root>/.claude/plans/`        |

Plans in one worktree cannot affect plans in another — they are in entirely separate directories.

**Finding plans for an issue:**

```bash
# Find all plan files mentioning issue #305 (local project only)
./tools/scripts/find-plan.sh 305

# Find only the most recent match
./tools/scripts/find-plan.sh 305 --latest

# Also search ~/.claude/plans/ for legacy/global plans
./tools/scripts/find-plan.sh 305 --include-global
```

By default, the script only searches `.claude/plans/` in the current project. Use `--include-global` to also search `~/.claude/plans/` (legacy location) — note that global plans may belong to other repositories with the same issue number.

**Note:** `.claude/plans/` is gitignored. Plan files are session-specific working files and are not shared between developers.
