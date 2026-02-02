# Conductor

**External control plane for AI coding agents.**

Conductor orchestrates AI agents to turn GitHub issues into merged PRs. It is not a chat app, not an IDE plugin, not a GitHub wrapper. It is a control tower: you start runs, approve plans, and merge PRs. Agents do the work in between.

**Conversational surface:** Conductor has exactly one conversational interface: Issue Intake (a guided PM agent for creating well-formed issues). Everything else is command-and-observe.

**Core loop:** Issue → Run → Plan Gate → Implementation → PR → Merge

---

## Status: Design Specification

**This repository contains design documents only. No runnable code exists yet.**

What's here:
- Complete architectural specifications
- Data model and protocol definitions
- UI/UX specifications
- Policy engine design

What's not here:
- Working CLI
- Installable package
- Prototype code

Implementation begins after design review. Follow along by reading the specs below.

---

## What Makes Conductor Different

These are the real differentiators, not marketing:

### Deterministic Routing + Auditable Decisions

Every routing decision is logged with inputs and outputs. Classifier results are stored. You can replay why any run went where it went.

### Gates, Not Suggestions

Human approval is required at defined points. Plan approval gate. Test pass gate. Code review gate. Merge gate. Agents propose; humans decide.

### Policy Engine at Tool Invocation + Pre-Push

Policies are enforced when agents call tools, not after the fact. Diff inspection happens before push. Secrets are blocked before they leave the worktree.

### Worktree-per-Run Isolation

Each run gets its own Git worktree, branch, ports, and sandboxed environment. Five runs in parallel on the same repo? No interference, no shared state.

### GitHub is Audit Surface; UI is Control Surface

GitHub shows the checkpointed narrative: plans, approvals, failures, summaries. Conductor UI shows everything: tool invocations, token usage, real-time logs. Control actions happen in UI. GitHub is the record.

---

## Autonomy Is Policy-Gated

Conductor is not all-or-nothing automation. Autonomy increases only when explicitly allowed by policy.

Examples of merge policies Conductor is designed to support:

| Policy | Behavior |
|--------|----------|
| Default | Always require human merge |
| Docs-only | Auto-merge documentation changes |
| High-confidence | Auto-merge when: all tests pass, no policy violations, reviewer confidence ≥ threshold, repo marked trusted |
| Time-delayed | Merge if no objections after N hours |

These capabilities are **not enabled in MVP**, but the system is explicitly designed to support them without changing core architecture.

---

## How It Works

1. **You start a run** — Select issue in Conductor UI, click Start Run
2. **Planner drafts plan; Reviewer critiques** — Bounded iteration (max retries enforced)
3. **You approve the plan** — Gate blocks progress until human decision
4. **Implementer writes code; Tester validates** — Tests run, results stored as ground truth
5. **PR opens** — Already planned, tested, reviewed by agents
6. **Merge** — By default, humans own the merge button. Conductor may merge autonomously only when explicitly allowed by policy.

Autonomous merge is not part of the MVP, but the architecture supports policy-gated auto-merge for trusted repos, change classes, and confidence thresholds.

**Policies can block runs.** Retries and escalations exist. Failures are loud. Nothing happens silently.

---

## Prerequisites

Conductor requires:

- **GitHub App installation** — Grants API permissions to your org/repos
- **Webhook delivery** — Either public endpoint or `conductor tunnel` for local dev
- **Repo registration** — Explicit opt-in per repository (no auto-discovery)

Conductor does not modify your repositories. No config files, no workflows, no `.conductor/` directories. All configuration lives in Conductor's database.

---

## UI-First Onboarding (Target UX)

Projects are the primary unit of work in Conductor. Repository registration happens as part of creating a project — not in settings.

1. Open Conductor UI
2. Click **Create Project**
3. Name the project (e.g., "Acme Platform")
4. Click **Add Repo**
5. Connect GitHub (install/authorize the Conductor GitHub App)
6. Select one or more repositories
7. Review detected repo profiles (stack, test commands) and policy defaults
8. Backlog populates → select an issue → **Start Run**

**Onboarding is a control-plane action, therefore it lives in the UI.** No setup scripts, no CLI commands, no config files to edit.

### Optional CLI (Future, Non-Primary)

A CLI may exist for self-hosting operations (backup/restore, migrations, diagnostics, tunnel setup). It is not the primary interface for operators. All control actions happen in the UI.

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                        Conductor Host                           │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────┐  │
│  │  Conductor   │  │   Agent      │  │   Worktree &         │  │
│  │  Core        │◄─┤   Runtime    │◄─┤   Environment Mgr    │  │
│  │  (Orchest.)  │  │              │  │                      │  │
│  └──────┬───────┘  └──────────────┘  └──────────────────────┘  │
│         │                                                       │
│  ┌──────┴───────┐  ┌──────────────┐  ┌──────────────────────┐  │
│  │   Database   │  │  MCP Tool    │  │   Control Plane      │  │
│  │              │  │  Layer       │  │   UI                 │  │
│  └──────────────┘  └──────────────┘  └──────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                    GitHub Integration                           │
│         (Webhooks, API, App Authentication)                     │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                         GitHub                                  │
│       Issues │ Pull Requests │ Projects │ Checks                │
└─────────────────────────────────────────────────────────────────┘
```

**Components:**
- **Conductor Core** — Orchestrator, state machine, policy enforcement
- **Agent Runtime** — Executes Planner, Implementer, Reviewer, Tester agents
- **MCP Tool Layer** — Sandboxed tools, GitHub write proxy, audit logging
- **Worktree Manager** — Per-run isolation, port allocation, cleanup
- **GitHub Integration** — Webhooks, API auth, rate limiting
- **Database** — Runs, policies, events, artifacts (not file content)
- **Control Plane UI** — Start, approve, cancel, observe

---

## Observability Primitives

Concrete mechanisms, not marketing:

| Primitive | What It Captures |
|-----------|------------------|
| **Tool invocation log** | Every tool call with inputs, outputs, timing, policy decision |
| **Artifact validation** | Plans, test reports, reviews stored with `validation_status` |
| **Exit code truth** | Test pass/fail stored by Orchestrator, not agent interpretation |
| **Phase timeline** | Visual timeline of run phases with durations |
| **Approvals inbox** | Pending decisions grouped by gate type |
| **Event stream** | All events with `fact/decision/signal` classification |

GitHub shows checkpointed summaries. Conductor UI shows the full trace.

---

## Agent Roles

| Role | Responsibility |
|------|----------------|
| **Planner** | Drafts implementation plan from issue |
| **Reviewer** | Critiques plans and code |
| **Implementer** | Writes code, commits changes |
| **Tester** | Interprets test results (Orchestrator captures ground truth) |
| **Orchestrator** | System role: phase transitions, GitHub mirroring, policy enforcement, merge eligibility evaluation |

Agents are stateless. Each invocation assembles context fresh. No hidden memory, no drift.

---

## Documentation

### Start Here (Recommended Order)

1. **[VISION.md](VISION.md)** — Philosophy and product principles
2. **[CONTROL_PLANE_UX.md](CONTROL_PLANE_UX.md)** — UI screens, operator workflows, UX invariants
3. **[ROUTING_AND_GATES.md](ROUTING_AND_GATES.md)** — How routing decisions and quality gates work
4. **[ARCHITECTURE.md](ARCHITECTURE.md)** — System components, trust boundaries, isolation model
5. **[PROTOCOL.md](PROTOCOL.md)** — State machine, events, artifact schemas
6. **[POLICIES.md](POLICIES.md)** — Policy engine, enforcement points, redaction rules

### Reference Documentation

| Document | Description |
|----------|-------------|
| [DATA_MODEL.md](DATA_MODEL.md) | Database schema and entity relationships |
| [INTEGRATION_MODEL.md](INTEGRATION_MODEL.md) | GitHub App integration and permissions |
| [ISSUE_INTAKE.md](ISSUE_INTAKE.md) | PM agent and natural language issue creation |
| [PROJECTS.md](PROJECTS.md) | Multi-tenant projects, repos, and work items |
| [DEPLOYMENT.md](DEPLOYMENT.md) | Local and remote deployment modes |
| [ONBOARDING.md](ONBOARDING.md) | Repository onboarding process |
| [MVP_SCOPE.md](MVP_SCOPE.md) | v0.1 scope, work packages, and success criteria |
| [ROADMAP.md](ROADMAP.md) | Future versions (v0.2+) and deferred features |

---

## License

Internal use only. License TBD before public release.

---

## Contributing

Not accepting external contributions during design phase. Internal feedback welcome via design review process.
