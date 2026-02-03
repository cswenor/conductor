# Conductor

**External control plane for AI coding agents.**

Conductor orchestrates AI agents to turn GitHub issues into merged PRs. It is not a chat app, not an IDE plugin, not a GitHub wrapper. It is a control tower: you start runs, approve plans, and merge PRs. Agents do the work in between.

**Conversational surface:** Conductor has exactly one conversational interface: Issue Intake (a guided PM agent for creating well-formed issues). Everything else is command-and-observe.

**Core loop:** Issue → Run → Plan Gate → Implementation → PR → Merge

---

## Status: WP1 + WP2 (Core) Complete

**Design complete. Implementation in progress (WP3: Projects & Repos UI).**

What's implemented:
- Complete architectural specifications in `docs/`
- SQLite database with migrations and WAL mode
- Redis + BullMQ job queue infrastructure
- GitHub App integration (webhooks, API client, outbox pattern)
- Webhook receiver with signature verification
- Event normalization (GitHub webhooks → internal events)
- Worker process with webhook and outbox processors
- Bootstrap module for unified service initialization
- Configuration validation and environment handling
- Redaction utilities for sensitive data
- 74 passing tests, lint clean, typecheck clean

Deferred:
- WP2.2: GitHub App installation flow (UI for installing app on orgs)

What's next (WP3):
- Projects list and creation UI
- GitHub connection flow (including WP2.2 completion)
- Repository registration
- Repo profile detection

Follow progress via work packages in `docs/MVP_SCOPE.md`.

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
│                                                                  │
│  ┌─────────────────┐    ┌─────────────────┐    ┌─────────────┐  │
│  │    Next.js      │    │     Redis       │    │   Worker    │  │
│  │   (UI + API +   │───▶│   + BullMQ      │───▶│ (Orchestr.) │  │
│  │    Webhooks)    │    │   Job Queue     │    │             │  │
│  └─────────────────┘    └─────────────────┘    └─────────────┘  │
│          │                                            │          │
│          │              ┌─────────────────┐           │          │
│          └─────────────▶│     SQLite      │◀──────────┘          │
│                         │   (state only)  │                      │
│                         └─────────────────┘                      │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                         GitHub                                  │
│       Issues │ Pull Requests │ Projects │ Checks                │
└─────────────────────────────────────────────────────────────────┘
```

**Components:**
- **Next.js** — UI, API routes, webhook receiver, enqueues jobs
- **Redis + BullMQ** — Durable job queue with retries
- **Worker** — Orchestrator, agent runtime, worktree management
- **SQLite** — Runs, policies, events, artifacts (not file content)
- **GitHub Integration** — Webhooks, API auth, rate limiting

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

1. **[VISION.md](docs/VISION.md)** — Philosophy and product principles
2. **[CONTROL_PLANE_UX.md](docs/CONTROL_PLANE_UX.md)** — UI screens, operator workflows, UX invariants
3. **[ROUTING_AND_GATES.md](docs/ROUTING_AND_GATES.md)** — How routing decisions and quality gates work
4. **[ARCHITECTURE.md](docs/ARCHITECTURE.md)** — System components, trust boundaries, isolation model
5. **[PROTOCOL.md](docs/PROTOCOL.md)** — State machine, events, artifact schemas
6. **[POLICIES.md](docs/POLICIES.md)** — Policy engine, enforcement points, redaction rules

### Reference Documentation

| Document | Description |
|----------|-------------|
| [DATA_MODEL.md](docs/DATA_MODEL.md) | Database schema and entity relationships |
| [INTEGRATION_MODEL.md](docs/INTEGRATION_MODEL.md) | GitHub App integration and permissions |
| [ISSUE_INTAKE.md](docs/ISSUE_INTAKE.md) | PM agent and natural language issue creation |
| [PROJECTS.md](docs/PROJECTS.md) | Multi-tenant projects, repos, and work items |
| [DEPLOYMENT.md](docs/DEPLOYMENT.md) | Local and remote deployment modes |
| [ONBOARDING.md](docs/ONBOARDING.md) | Repository onboarding process |
| [MVP_SCOPE.md](docs/MVP_SCOPE.md) | v0.1 scope, work packages, and success criteria |
| [ROADMAP.md](docs/ROADMAP.md) | Future versions (v0.2+) and deferred features |

---

## License

Internal use only. License TBD before public release.

---

## Contributing

Not accepting external contributions during design phase. Internal feedback welcome via design review process.
