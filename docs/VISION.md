# Conductor Vision

## What Conductor Does

Conductor turns GitHub issues into active engineering processes.

You select an issue. Conductor wakes up. Agents assemble context, spin up isolated environments, negotiate plans, write code, review each other's work, run tests, and open PRs — all in public, all auditable, all under your control.

The magic is not autonomy. The magic is that **complexity disappears while control remains**.

You stop being the bottleneck. You become the decision-maker.

---

## The Core Experience

When you select an issue in Conductor and click **Start Run**, something comes alive:

- **Environments materialize.** Isolated worktrees, dedicated ports, sandboxed servers — each task gets its own world.
- **Agents coordinate.** A planning agent proposes an approach. An implementation agent writes code. A review agent critiques it. They negotiate in public, in the issue thread.
- **Work happens in parallel.** Multiple issues can be in flight. Plans are debated while other tasks are being tested.
- **PRs appear with confidence.** By the time you see a PR, it has already been planned, implemented, self-reviewed, and tested.

You don't manage the process. You approve decisions and merge results.

---

## Design Principles

### GitHub Is the Conversation Fabric

Conductor doesn't have its own chat interface because **GitHub already is one**.

Issues are tasks. Comments are messages. PR reviews are critiques. Check runs are status updates. Projects are dashboards.

Every agent action produces a GitHub artifact. Every decision is a comment. Every state change is visible in the UI you already use.

The system is transparent not because it's limited, but because GitHub is the natural home for engineering work.

### Agents Start Fresh, Think Deep

Agents don't carry hidden memory between tasks. Each invocation begins clean.

But "fresh" doesn't mean "ignorant." Agents dynamically assemble context: they read the issue, pull relevant files, examine past PRs, understand the codebase structure. They know what they need to know because they retrieve it explicitly — and you can see exactly what they retrieved.

No spooky accumulated state. No "the AI remembers something you can't see." Just transparent, on-demand intelligence.

### AI Routing with Policy Guardrails

Routing decisions can be intelligent. The system can learn that certain types of issues need architectural review, that some codepaths require senior approval, that test failures in specific modules need human diagnosis.

But intelligence operates within boundaries:
- **Policies constrain what's possible.** Security-sensitive paths always require human review.
- **Decisions are logged.** Every routing choice is recorded with reasoning.
- **Humans can override.** Any automatic decision can be reversed.

This is power with accountability, not autonomy without oversight.

### Isolation Is Infrastructure Magic

Each task runs in complete isolation:
- Its own Git worktree (no cross-contamination of changes)
- Its own branch (no conflicts with parallel work)
- Its own environment (dedicated ports, isolated servers, sandboxed execution)

You can have five issues in flight, each with agents actively working, and they cannot interfere with each other. When a task completes or fails, its world is cleaned up.

This isn't just safety — it's how you scale. Parallelism without chaos.

### Multi-Agent Planning Is a Negotiation

Planning isn't "Claude dumps a PLAN.md and we hope it's good."

Planning is iterative and adversarial:
- A **planning agent** proposes an approach
- A **review agent** critiques it (too complex? missing edge cases? wrong abstraction?)
- They iterate until the plan is solid — or escalate to a human

By the time you see a plan, it has already survived scrutiny. Your job is to approve the direction, not debug the thinking.

### Code Review Is Programmable

Conductor doesn't skip code review. It **multiplies** it.

- Agents review each other's code before humans ever see it
- Style, correctness, security, and architecture can each have dedicated review passes
- Humans review the final product, informed by bot analysis

The goal isn't "remove humans from review." The goal is "humans review work that's already been vetted." Your attention goes to decisions that matter, not catching typos.

---

## Intentional Boundaries

Conductor is opinionated. These boundaries exist because they make the system trustworthy.

### Humans Own Merge (By Default)

By default, no PR is merged without human action. Agents propose. Humans decide.

Conductor can achieve high confidence — plans reviewed, code tested, bots satisfied — but the merge button belongs to you unless you explicitly configure otherwise. Policy-gated autonomous merge is supported for trusted repos, change classes, and confidence thresholds, but it is never implicit.

### Humans Can Always Stop

Any task can be cancelled. Any agent can be interrupted. Any decision can be overridden.

The system moves fast, but it never outruns your ability to say "stop."

### State Is Visible

If Conductor knows something, you can see it. Agent context is logged. Routing decisions are recorded. State transitions are posted to the issue.

There is no hidden reasoning. If you want to understand why something happened, read the thread.

### Failures Are Loud

When something goes wrong, Conductor doesn't quietly retry and hope. It stops, posts a clear explanation, and waits for guidance.

Silent failures are worse than visible ones. The system prefers to block and explain rather than proceed and confuse.

---

## Why Conductor Feels Magical (Without Being Unsafe)

The magic comes from **absorbed complexity**, not **surrendered control**.

| What You Experience | What's Actually Happening |
|---------------------|--------------------------|
| "I clicked Start Run and a PR appeared" | Agents planned, implemented, reviewed, tested, and proposed — all logged in the thread |
| "The system knew which files to change" | Context retrieval pulled relevant code, and you can see exactly what it read |
| "It fixed its own test failures" | Implementation agent received failure output and iterated, with each attempt logged |
| "The PR was already reviewed" | Review agents ran multiple passes; their comments are visible in the thread |
| "Multiple issues progressed in parallel" | Isolated worktrees and environments prevented interference |

You do less. The system does more. But everything that happened is recorded, and you could have intervened at any point.

That's the trick: **delegate execution, retain authority**.

---

## The Lifecycle (Not Steps — Phases)

Work doesn't flow through Conductor in a rigid sequence. It moves through **phases**, and multiple phases can be active simultaneously across different tasks.

### Phase: Activation

An issue is selected for work. Conductor creates an isolated environment: worktree, branch, sandboxed runtime. The task is now "alive."

*Multiple tasks can be activated in parallel.*

### Phase: Planning

Agents assemble context and propose an approach. A planning agent drafts. A review agent critiques. They iterate. When the plan stabilizes, it's posted for human approval.

*Planning can involve multiple rounds of agent discussion.*

### Phase: Human Decision Point

You review the plan. You approve, request changes, or reject. This is where human judgment enters.

*This is a gate, not a step. The system waits for you.*

### Phase: Execution

Implementation agents write code in the isolated environment. They commit, run tests, self-review, iterate. If tests fail, they fix and retry (up to a limit).

*Execution can involve multiple agents and multiple iterations.*

### Phase: Proposal

When confidence is high — tests pass, review bots are satisfied — a PR is opened. It's linked to the issue, summarizes the plan, and includes the full audit trail.

*The PR is the deliverable. Everything before it was preparation.*

### Phase: Human Merge

You review the PR. You can request changes (which sends work back to execution) or merge. Merging completes the task and cleans up the environment.

*You always make the final call.*

---

## Surfaces

**GitHub is where work lives. Conductor UI is where work is operated.**

### Conductor UI (The Control Plane)

The Conductor dashboard is where operators drive work:

- **Start runs** — Select issues from your backlog and kick off work
- **Approve/reject gates** — Review plans, approve execution, handle escalations
- **Monitor progress** — Real-time view of all active runs across repos
- **Override controls** — Pause, resume, cancel, retry, reprioritize
- **Configuration** — Policies, agent prompts, MCP servers, routing rules
- **Audit logs** — Searchable history across all projects

**You use Conductor UI to:** operate. Every control action lives here.

Conductor maintains an internal database for configuration, indexing, run history, and cross-project observability. Decisions made in the UI are mirrored to GitHub as comments for auditability.

### Issues (GitHub)

The issue is the task definition and the conversation log. Everything that happens is posted here: agent discussions, state changes, operator decisions, artifacts, errors.

**You use issues to:** define requirements, follow the narrative, understand what happened.

### Pull Requests (GitHub)

The PR is the deliverable. It contains the code changes, links to the originating issue, and summarizes the work.

**You use PRs to:** review final code, request changes, merge completed work.

### GitHub Projects (Optional)

The project board provides a secondary dashboard. Conductor can sync run phases to Project columns for teams that prefer GitHub-native views.

**You use Projects to:** visualize progress if you prefer GitHub's interface.

### Check Runs (GitHub)

Checks represent agent activity and quality gates. A running check means an agent is working. A failed check means something needs attention.

**You use Checks to:** see CI status, understand failures at a glance.

---

## Success Looks Like

Conductor is successful when:

- You can point it at a backlog and trust that reviewable PRs will appear
- You spend your time on decisions, not mechanics
- You can understand exactly what happened by reading the issue thread
- Failures are obvious, contained, and recoverable
- The system feels like a capable team, not a tool you're babysitting
- You forget that agents are involved — it just feels like work getting done

---

## What Conductor Replaces

| Before Conductor | After Conductor |
|-----------------|-----------------|
| You read the issue, plan the work, write the code, test it, open a PR | You approve the plan, review the PR |
| Context switching between issues | Parallel progress on multiple issues |
| "Let me understand what this code does" | Agents retrieve and synthesize context for you |
| First-pass code review catching obvious issues | Bot review handles the obvious; you focus on substance |
| Manual environment setup per task | Automatic isolation per task |
| Lost context when you context-switch | Full audit trail in every issue thread |

You're still the engineer. You still make the decisions. But the mechanical work — the context assembly, the boilerplate, the test-fix cycles, the first-pass review — is handled.

You operate at a higher level.

---

## How Conductor Runs

### A Portable Control Plane

Conductor is a single service that runs the same way everywhere:

| Mode | Where | For Whom |
|------|-------|----------|
| **Local** | Your machine | Solo founders, power users (default) |
| **Remote** | Linux instance | Teams, always-on orchestration |

Same codebase. Same behavior. Same guarantees. The only difference is where the bits live.

### Local First

**Local mode is the default and recommended starting point.**

Conductor runs on your machine. Open the UI, connect GitHub, register repos. Repos clone locally. Dev servers use local ports. You have direct access to everything.

Why start local?
- **Zero infrastructure** — No servers to provision
- **Instant feedback** — Watch agents work in real-time
- **Full control** — Your machine, your credentials
- **Trust building** — Understand Conductor before giving it infrastructure

### Scale When Ready

When you outgrow local mode — long-running tasks, team usage, always-on orchestration — move to remote mode on a Linux instance. Your projects, repos, and configuration transfer cleanly.

The orchestration logic is identical. Only the host changes.

See [DEPLOYMENT.md](DEPLOYMENT.md) for full details.

---

## Getting Started

### Point and Go

Conductor is designed for **minimal-touch onboarding**:

1. Open Conductor UI → **Projects → Create Project**
2. Click **Add Repo** → select from your GitHub repos
3. Conductor analyzes the repository, detects your stack, indexes the codebase

No repo changes required. No PR to merge. No configuration files to maintain.

**Prerequisites:** GitHub App installation on your org and webhook delivery (public endpoint or tunnel).

### No Repo Modifications Required

Conductor is an external orchestrator, not a repo plugin. Your repositories stay clean:

- **No config files added** — Conductor stores configuration internally
- **No special directories** — No `.conductor/` or similar artifacts
- **No workflow changes** — Your existing CI/CD remains untouched
- **Works with any repo** — Public, private, monorepo, polyrepo

Configuration, policies, and agent prompts live in Conductor's control plane. You can customize behavior per-repo without touching the repo itself.

See [ONBOARDING.md](ONBOARDING.md) for the full onboarding process.

---

## Further Reading

- [ARCHITECTURE.md](ARCHITECTURE.md) — System components and data flow
- [CONTROL_PLANE_UX.md](CONTROL_PLANE_UX.md) — UI screens, actions, and operator workflows
- [ISSUE_INTAKE.md](ISSUE_INTAKE.md) — PM agent and natural language issue creation
- [PROJECTS.md](PROJECTS.md) — Multi-tenant projects, repos, and work items
- [DATA_MODEL.md](DATA_MODEL.md) — Database schema and entity relationships
- [DEPLOYMENT.md](DEPLOYMENT.md) — Local and remote deployment modes
- [PROTOCOL.md](PROTOCOL.md) — State machine, events, and artifacts
- [ROUTING_AND_GATES.md](ROUTING_AND_GATES.md) — How routing and quality gates work
- [ONBOARDING.md](ONBOARDING.md) — How to onboard a repository
- [MVP_SCOPE.md](MVP_SCOPE.md) — What's in v0.1 and what comes later
