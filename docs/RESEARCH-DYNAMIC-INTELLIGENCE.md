# Research: Dynamic Intelligence for claude-pm-toolkit

**Date:** 2026-02-18
**Context:** The user asked "how do you make an AI more powerful to accomplish what you want" — exploring directions beyond static playbook files to make the toolkit a living intelligence layer.

---

## Executive Summary

The claude-pm-toolkit today is a static playbook system: markdown files that tell Claude what to do. The research below maps seven dimensions of how to evolve it into a **dynamic intelligence layer** that learns, adapts, and automates. The recommendations are ordered by effort-to-impact ratio.

**Key insight from the research:** Simpler approaches consistently outperform complex ones. Sourcegraph moved away from embeddings for enterprise. Vercel found inlined AGENTS.md beats skills-based retrieval 100% vs 79%. Aider's repo map uses 5% of context window vs 55% for iterative search. **Start with file-based patterns, add SQLite for persistence, and only add vector search when keyword search demonstrably fails.**

---

## 1. MCP Server: A Living PM Brain

### What It Enables

Instead of Claude reading static markdown and running bash scripts, a custom MCP server can:

- **Query live project state** on every tool call (never stale)
- **Maintain persistent memory** across sessions (SQLite)
- **Request user input** via elicitation (e.g., "Which environment to deploy to?")
- **Request LLM completions** via sampling (e.g., "Classify this issue")
- **Send dynamic notifications** when tool/resource lists change

### Architecture

```
┌─────────────────────────────────────────────────────┐
│  pm-intelligence MCP Server (TypeScript, stdio)     │
│                                                      │
│  Tools (LLM-invoked actions):                        │
│  ├── pm_get_context      → Issue + AC + PR + state  │
│  ├── pm_validate_checklist → Pre-PR stop checks     │
│  ├── pm_move_issue       → State transition + gate  │
│  ├── pm_classify_tier    → Tier 1 vs 2 analysis     │
│  ├── pm_post_merge       → Full post-merge sequence │
│  ├── pm_record_decision  → Log architectural choice │
│  └── pm_search_decisions → Find past similar work   │
│                                                      │
│  Resources (read-only context):                      │
│  ├── pm://playbook       → Current PM workflow defs │
│  ├── pm://board/current  → Live project board state │
│  ├── pm://decisions/{n}  → Past decisions for issue │
│  └── pm://templates/*    → Issue/PR templates       │
│                                                      │
│  Prompts (user-triggered):                           │
│  ├── /pm-triage          → Issue classification     │
│  ├── /pm-readiness       → Pre-PR validation        │
│  └── /pm-health          → Project health check     │
│                                                      │
│  Persistence: SQLite (.claude/pm-state.db)           │
│  Live data: GitHub API (never cached for mutables)   │
└─────────────────────────────────────────────────────┘
```

### Why TypeScript

Matches the existing stack (pnpm workspaces, Node.js tooling). The `@modelcontextprotocol/sdk` TypeScript SDK is the most mature. A minimal server is ~30 lines of code.

### Configuration

```json
{
  "mcpServers": {
    "pm-intelligence": {
      "command": "node",
      "args": ["./tools/mcp-servers/pm-intelligence/build/index.js"],
      "env": {
        "GITHUB_TOKEN": "${GITHUB_PERSONAL_ACCESS_TOKEN}"
      }
    }
  }
}
```

**Effort:** 1-2 weeks for a production-quality implementation.

---

## 2. GitHub Actions: Continuous Automation

### What Works Today (Zero Custom Code)

| Automation | Trigger | Implementation |
|-----------|---------|---------------|
| Auto-add issues to project | `issues.opened` | GitHub's built-in auto-add workflow (UI config) |
| Post-merge → Done | `pull_request.closed` + `merged==true` | Parse `Fixes #N`, GraphQL `updateProjectV2ItemFieldValue` |
| PR quality gate | `pull_request.opened/edited` | Validate `Fixes #N` exists, conventional commit prefix, issue in Active state |
| Ready-for-review alert | `pull_request.ready_for_review` | Notification to team channel |
| Stale issue detection | `schedule` (cron) | `actions/stale` with custom labels |

### Breaking News: GitHub Agentic Workflows (Feb 17, 2026)

GitHub just announced **Agentic Workflows** in technical preview — essentially official support for what our toolkit does manually:

- Workflows defined in **plain Markdown** (not YAML)
- AI agents execute in **sandboxed containers** with read-only repo access
- Write actions pass through reviewable **"safe outputs"**
- Supported engines: GitHub Copilot, Claude Code, OpenAI Codex

**PM-relevant use cases from the gallery:**
- Continuous triage (auto-label, auto-route new issues)
- Metrics and reporting (health reports)
- CI failure diagnosis
- Cross-repo feature sync

**Anthropic's `claude-code-action`** is one of the supported engines. It can:
- Respond to `@claude` mentions in PRs/issues
- Pick up assigned issues and work on them autonomously
- Open PRs linked back to the original issue

### Recommended Actions to Build

1. **Post-merge checklist** — Eliminates manual `project-move.sh Done` step
2. **PR quality gate** — Enforces `Fixes #N`, conventional commits, Active state
3. **Semantic duplicate detection** — Embeddings-based on `issues.opened`
4. **Auto-labeling** — NLP classification of issue body text

**Effort:** 1-3 days per action (post-merge and quality gate are simplest).

---

## 3. Persistent Memory Across Sessions

### The Problem

Each Claude Code session starts fresh. The toolkit's knowledge resets. Decisions made in session A are invisible in session B.

### Tiered Approach (Simplest First)

#### Tier 1: Structured JSONL Logs (Ship This Week)

```
.claude/memory/
├── MEMORY.md          # Cross-session learnings (exists)
├── decisions.jsonl    # Architectural decisions
├── outcomes.jsonl     # What worked / what caused rework
└── patterns.jsonl     # Extracted codebase patterns
```

Each file is append-only, git-tracked, human-readable. Auto-memory already loads `MEMORY.md` into system prompt. Claude can query JSONL files via `jq` when needed.

**Cost:** Zero infrastructure. Uses existing CLAUDE.md infrastructure.

#### Tier 2: SQLite MCP Memory Server (Ship This Month)

Add one of these existing MCP servers to `.mcp.json`:

- **mcp-memory-keeper**: Simplest. SQLite `context.db` auto-created in project directory.
- **mcp-memory-service**: Full-featured. ChromaDB for semantic search + SQLite.
- **claude-mem**: Triple-redundancy (SQLite + FTS5 + ChromaDB). 3-layer retrieval. 10x token savings through progressive disclosure.

**Cost:** 30 minutes setup.

#### Tier 3: Custom Outcome Tracker (Ship This Quarter)

Extract learning signals from git/GitHub data you already have:

```typescript
// What was the rework rate for game-engine changes?
// How many review rounds do contracts PRs typically take?
// Which approach worked for similar issues?
interface Outcome {
  issue_number: number;
  approach: string;
  result: 'merged' | 'rework' | 'reverted';
  review_rounds: number;
  time_to_merge_hours: number;
  rework_reasons: string[];
}
```

Data sources: `git log`, GitHub API (PR review rounds, time-to-merge, revert commits).

**Cost:** 1 week.

#### Tier 4: Project-Specific RAG (Ship Next Quarter)

Full codebase + issues + PRs + reviews indexing:

1. **tree-sitter** for code chunking (respects AST boundaries)
2. **Nomic Embed Code** (open source, local) for embeddings
3. **ChromaDB** (embedded, no server) for vector storage
4. Hybrid retrieval: vector similarity + BM25 keyword search

**Warning:** Sourcegraph explicitly moved away from embeddings for enterprise Cody (privacy + scaling concerns). Only add this when keyword search demonstrably fails.

**Cost:** 2-3 weeks.

---

## 4. Claude Code Hooks: Dynamic Behavior

### What the Toolkit Already Uses

| Hook | Script | Purpose |
|------|--------|---------|
| PreToolUse:Bash | `claude-command-guard.sh` | Block dangerous commands |
| PreToolUse:Bash | `claude-secret-bash-guard.sh` | Block secret exposure |
| PreToolUse:Read | `claude-secret-guard.sh` | Block reading sensitive files |
| PreToolUse:AskUserQuestion | `portfolio-notify.sh needs-input` | Track user questions |
| PostToolUse:Read,Bash | `claude-secret-detect.sh` | Post-execution secret scanning |
| Notification:permission_prompt | `portfolio-notify.sh needs-permission` | Permission alerts |
| Stop | `portfolio-notify.sh idle` | Mark session idle |

### New Hook Capabilities to Exploit

| Capability | Hook Event | Use Case |
|-----------|-----------|----------|
| **Context injection** | SessionStart `additionalContext` | Load relevant past decisions/outcomes at session start |
| **Parameter rewriting** | PreToolUse `updatedInput` | Auto-correct file paths, add `--dry-run` flags, enforce conventions |
| **Prevent premature completion** | Stop `decision: "block"` | Ensure post-implementation checklist is complete before stopping |
| **LLM-evaluated gates** | Prompt/Agent hooks on PreToolUse | Use a fast model to evaluate "is this commit message conventional?" |
| **Quality gates** | TaskCompleted exit code 2 | Block task completion until tests pass |
| **Async monitoring** | PostToolUse `async: true` | Run tests in background after each edit |
| **Environment setup** | SessionStart `CLAUDE_ENV_FILE` | Set port offsets, worktree paths per session |

### High-Value New Hooks

1. **SessionStart → Load relevant context**: Query SQLite memory for past decisions related to the current working directory / issue number. Inject as `additionalContext`.

2. **PreToolUse:Bash → Convention enforcement**: When Claude runs `git commit`, intercept and validate conventional commit format. Use `updatedInput` to fix the message transparently.

3. **Stop → Checklist verification**: Before Claude finishes, verify the post-implementation sequence was followed. Block with reason if steps were skipped.

4. **PostToolUse:Bash(git push) → Auto-move to Review**: When Claude pushes, automatically run `project-move.sh Review`.

**Effort:** 1-2 days per hook.

---

## 5. Competitive Landscape: What Others Do

### Cursor (Background Agents + Linear)

- **8 parallel agents** via git worktrees (same pattern as our portfolio manager)
- **Linear integration**: Assign issue to Cursor → agent works → updates issue with PR
- **Subagents** (Jan 2026): Specialized agents with own context and tools
- **Agent Skills**: Define domain knowledge in SKILL.md files (same concept as our skills)

**What we can learn:** Linear integration model — assign an issue label and an agent picks it up. We already have `claude-code-action` which can do this for GitHub issues.

### Devin (MultiDevin + Interactive Planning)

- **MultiDevin**: Manager agent spawns worker agents for parallel execution
- **Interactive planning**: Human review/adjust plans before execution
- **Compound AI system**: Planner → Coder → Critic → Browser (specialized models)
- **Devin Wiki**: Machine-generated documentation updated by the agent itself

**What we can learn:** The Planner→Coder→Critic pattern maps to our Collaborative Planning (Claude + Codex). The Devin Wiki concept maps to auto-memory.

### OpenAI Codex (Desktop App, Multi-Agent)

- **"Command center for agents"**: Run multiple coding tasks simultaneously
- **30-minute autonomous work** before returning completed code
- **Multi-agent PR review**: Spawn one agent per review point, summarize results
- **Customizable roles via config**: Orchestrator fans out to team members

**What we can learn:** The multi-agent PR review pattern could enhance our Codex Implementation Review sub-playbook.

### Self-Improving Agents (AGENTS.md Pattern)

- Agents append learnings after each task to a running notebook
- "Every mistake becomes a rule" (Anthropic's approach for Claude Code)
- Over time the knowledge base steers agents away from repeating past mistakes
- Darwin Godel Machine: 20% → 50% improvement through self-modification

**What we can learn:** We already have auto-memory. The key insight is making it *systematic* — after every rework cycle, automatically record what went wrong.

---

## 6. Plugin Distribution

### Current State

The toolkit installs by copying files. This means:
- Updates require `--update` reruns
- No easy way for users to extend without forking
- Skills, hooks, and scripts are tightly coupled

### Claude Code Plugin System

Claude Code now has a plugin system that bundles:
- Skills (`skills/`)
- Hooks (`hooks/hooks.json`)
- MCP servers
- Subagent definitions

Community registries exist at `claude-plugins.dev` and `buildwithclaude`.

### Migration Path

The toolkit could be distributed as a **Claude Code plugin** instead of a file-copy installer:

```
claude-pm-toolkit/
├── .claude-plugin/
│   └── plugin.json        # Manifest
├── skills/
│   ├── issue/SKILL.md
│   ├── pm-review/SKILL.md
│   └── weekly/SKILL.md
├── hooks/
│   └── hooks.json          # All security + portfolio hooks
├── mcp-servers/
│   └── pm-intelligence/    # Dynamic MCP server
└── agents/
    └── pm-reviewer.md      # Custom subagent
```

Users would enable via `enabledPlugins` in settings instead of running `install.sh`. Updates would be `git pull` in the plugin directory.

**Effort:** 2-3 weeks to restructure (the content already exists).

---

## 7. Agent Teams: Multi-Agent Orchestration

### What's Available

Claude Code has an experimental Agent Teams feature:
- One lead agent coordinates, multiple teammates work in parallel
- Teammates share a task list with dependency tracking
- `TeammateIdle` and `TaskCompleted` hooks enforce quality gates
- Enable via `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS`

### How This Maps to the Toolkit

Our portfolio manager (tmux + worktrees) already does multi-agent orchestration, but manually. Agent Teams could formalize this:

| Current (Manual) | Agent Teams (Built-in) |
|-----------------|----------------------|
| `tmux-session.sh start` spawns windows | Lead agent spawns teammates |
| `portfolio-notify.sh` tracks status | TaskList/TaskUpdate track progress |
| User switches between windows | Lead agent coordinates automatically |
| `/issue` loads context per window | Each teammate gets scoped context |

### The Vision

Instead of a user manually running `/issue 42` in one window and `/issue 57` in another, the lead agent could:

1. Read the project board
2. Identify Ready issues
3. Spawn teammates for each, with proper context
4. Monitor progress via TaskCompleted hooks
5. Run `/pm-review` when teammates finish
6. Report results back to the user

**Effort:** Experimental — depends on Agent Teams stability. Worth prototyping.

---

## Prioritized Roadmap

| Priority | What | Impact | Effort | Status |
|----------|------|--------|--------|--------|
| **P0** | GitHub Actions: post-merge + PR quality gate | Eliminates manual checklist steps | 2-3 days | ✅ Done (v0.5.0) |
| **P1** | SessionStart hook: load relevant context | Every session starts smarter | 1 day | ✅ Done (v0.5.0) |
| **P2** | Structured JSONL decision/outcome logs | Persistent learning, zero infra | 1 day | ✅ Done (v0.5.0) |
| **P3** | Event stream logging (portfolio-notify.sh) | Analytics, replay, debugging | 0.5 day | ✅ Done (v0.5.0) |
| **P4** | MCP server (pm-intelligence) | Live state, tools, resources | 1-2 weeks | ✅ Done (v0.5.0) |
| **P4.1** | Sprint analytics, approach suggestion, readiness | Deep process intelligence | 1 day | ✅ Done (v0.6.0) |
| **P4.2** | Smart hooks (commit guard, stop guard) | Convention enforcement, work tracking | 0.5 day | ✅ Done (v0.6.0) |
| **P4.3** | Git history mining (hotspots, coupling, risk) | Codebase risk intelligence | 1 day | ✅ Done (v0.6.0) |
| **P4.4** | Predictive intelligence (completion, rework) | Forecasting from historical data | 1 day | ✅ Done (v0.7.0) |
| **P4.5** | DORA metrics + knowledge risk | Engineering health assessment | 0.5 day | ✅ Done (v0.7.0) |
| **P4.6** | Review learning + decision decay | Self-calibrating reviews | 0.5 day | ✅ Done (v0.7.0) |
| **P5** | SQLite memory server (mcp-memory-keeper) | Cross-session persistence | 0.5 day | Ready to deploy |
| **P6** | Plugin distribution format | Easier install, updates, sharing | 2-3 weeks | Design phase |
| **P7** | claude-code-action integration | Assign issue → agent works → PR | 1 week | Research phase |
| **P8** | Outcome tracker (git history mining) | Learn from rework patterns | 1 week | ✅ Done (v0.6.0) |
| **P9** | Agent Teams prototype | Automated parallel development | 2 weeks | Experimental |
| **P10** | Project-specific RAG | Semantic search across all knowledge | 2-3 weeks | Future |

### Next Priorities (v0.9.0+)

| Priority | What | Impact | Effort | Status |
|----------|------|--------|--------|--------|
| **P11** | E2E install test on real repo | Validates install works for new users | 0.5 day | ✅ Done (v0.7.0) |
| **P12** | Graph-based memory (entity-relationship) | Multi-hop reasoning across sessions | 1-2 weeks | Research |
| **P13** | Review sub-agents (specialist decomposition) | Parallel expert review per domain | 1 week | Design |
| **P14** | Monte Carlo sprint simulation | Probability-based sprint forecasting | 1 day | ✅ Done (v0.8.0) |
| **P15** | Context efficiency tracking | Measure AI context waste per issue | 0.5 day | ✅ Done (v0.8.0) |
| **P16** | Dependency graph analysis | Detect blocked chains, critical path | 1 day | ✅ Done (v0.9.0) |
| **P17** | Team capacity modeling | Multi-contributor throughput simulation | 0.5 day | ✅ Done (v0.9.0) |
| **P18** | Scope creep detector | Alert when PR touches files outside plan | 0.5 day | ✅ Done (v0.8.0) |
| **P19** | Issue dependency visualization | ASCII graph + Mermaid diagram output | 0.5 day | ✅ Done (v0.11.0) |
| **P20** | Sprint planning assistant | AI-assisted sprint planning from capacity + backlog | 1 day | ✅ Done (v0.10.0) |

---

## Sources

### MCP Protocol & SDK
- [MCP Introduction](https://modelcontextprotocol.io/introduction)
- [MCP Architecture](https://modelcontextprotocol.io/docs/concepts/architecture)
- [MCP Tools](https://modelcontextprotocol.io/docs/concepts/tools)
- [MCP Resources](https://modelcontextprotocol.io/docs/concepts/resources)
- [MCP Sampling](https://modelcontextprotocol.io/docs/concepts/sampling)
- [TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)
- [MCP Async Tasks](https://workos.com/blog/mcp-async-tasks-ai-agent-workflows)

### GitHub Automation
- [GitHub Agentic Workflows (Feb 2026)](https://github.github.io/gh-aw/)
- [claude-code-action](https://github.com/anthropics/claude-code-action)
- [GitHub Projects v2 API](https://docs.github.com/en/issues/planning-and-tracking-with-projects/automating-your-project/using-the-api-to-manage-projects)
- [actions/add-to-project](https://github.com/actions/add-to-project)
- [simili-bot (duplicate detection)](https://github.com/similigh/simili-bot)

### Claude Code Extensibility
- [Hooks Reference](https://code.claude.com/docs/en/hooks)
- [Hooks Guide](https://code.claude.com/docs/en/hooks-guide)
- [Memory Management](https://code.claude.com/docs/en/memory)
- [Skills](https://code.claude.com/docs/en/skills)
- [Agent Teams](https://code.claude.com/docs/en/agent-teams)
- [Plugins](https://code.claude.com/docs/en/plugins)
- [updatedInput feature](https://github.com/anthropics/claude-code/issues/4368)

### Memory & Learning
- [claude-mem](https://github.com/thedotmack/claude-mem) — Triple-redundancy memory
- [mcp-memory-keeper](https://github.com/mkreyman/mcp-memory-keeper) — SQLite memory
- [mcp-memory-service](https://github.com/doobidoo/mcp-memory-service) — ChromaDB memory
- [Aider Repository Map](https://aider.chat/docs/repomap.html) — 5% context usage
- [Sourcegraph: Why we moved away from embeddings](https://sourcegraph.com/blog/how-cody-understands-your-codebase)
- [Vercel: AGENTS.md outperforms skills](https://vercel.com/blog/agents-md-outperforms-skills-in-our-agent-evals)
- [Nomic Embed Code](https://www.nomic.ai/blog/posts/introducing-state-of-the-art-nomic-embed-code)

### Competitive Analysis
- [Cursor Background Agents](https://devops.com/cursor-2-0-brings-faster-ai-coding-and-multi-agent-workflows/)
- [Cursor + Linear Integration](https://linear.app/integrations/cursor)
- [Devin MultiDevin](https://docs.devin.ai/working-with-teams/multidevin)
- [Devin Interactive Planning](https://docs.devin.ai/work-with-devin/interactive-planning)
- [OpenAI Codex Desktop App](https://venturebeat.com/orchestration/openai-launches-a-codex-desktop-app-for-macos-to-run-multiple-ai-coding-agents-in-parallel)
- [Self-Improving Agents](https://addyosmani.com/blog/self-improving-agents/)
- [Agent Lightning (Microsoft RL)](https://www.microsoft.com/en-us/research/blog/agent-lightning-adding-reinforcement-learning-to-ai-agents-without-code-rewrites/)

### Architecture Decision Records
- [AgenticAKM (automated ADR generation)](https://arxiv.org/html/2602.04445v1)
- [Using ADRs with AI Coding Assistants](https://blog.thestateofme.com/2025/07/10/using-architecture-decision-records-adrs-with-ai-coding-assistants/)
