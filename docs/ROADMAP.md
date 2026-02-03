# Roadmap

> **Future features and expansion plans.** This document captures capabilities intentionally deferred from v0.1 to keep the MVP shippable. Nothing here is aspirational; all items have known implementation paths.

---

## Roadmap Semantics

This document captures **intended future capabilities**, not contractual commitments.

- Inclusion here does **not** imply priority, timeline guarantees, or exact implementation.
- Nothing in this document expands the v0.1 contract defined in [MVP_SCOPE.md](MVP_SCOPE.md).
- Features may change shape, move versions, or be removed based on learning from shipped releases.

**Maturity levels:**

| Level | Meaning |
|-------|---------|
| Concept | Clear intent, details may change |
| Designed | Data model + lifecycle understood |
| Proven | Partial implementation or prototype exists |

---

## Release Timeline

| Version | Theme | Key Capabilities |
|---------|-------|------------------|
| **v0.1** | Core Loop | Issue → Run → Plan → Approve → Implement → PR → Merge |
| **v0.2** | Intelligence | Routing, Issue Intake, lint gates, expanded tool access |
| **v0.3** | Scale | Multi-operator, higher parallelism, remote deployment |
| **v0.4** | Autonomy | Policy-gated auto-merge, cross-repo runs |

---

## v0.2: Intelligence Layer

**Theme:** Make Conductor smarter about what it's doing.

### Issue Intake (PM Agent)

The **only** conversational surface in Conductor.

| Capability | Description | Maturity |
|------------|-------------|----------|
| Natural language issue creation | User describes problem; PM agent structures it | Designed |
| Guided refinement | Agent asks clarifying questions | Designed |
| Scope negotiation | Agent suggests breakdown for large issues | Concept |
| Label/priority inference | Auto-suggest based on content | Concept |

**Why deferred:** Core loop must work first. Issue Intake is additive.

**Implementation path:** Standalone agent invocation from Backlog screen. No changes to run state machine.

**Invariant:** Issue Intake does not create, modify, or advance runs. It only produces issues that may later be selected for execution.

---

### Intelligent Routing

| Capability | Description | Maturity |
|------------|-------------|----------|
| Issue classification | Bug vs feature vs refactor vs docs | Designed |
| Scope estimation | Small/medium/large based on affected files | Designed |
| Sensitive path prediction | Flag issues likely to touch protected areas | Concept |
| Agent graph selection | Choose which agents participate based on classification | Concept |

**Why deferred:** Default routing (all agents, linear) is sufficient for MVP promise.

**Implementation path:** Classifier runs at `run.started`; results stored in `RoutingDecision`; replay-safe.

**Invariant:** Routing decisions are immutable for the lifetime of a run. Replays and retries must reuse the original RoutingDecision.

---

### Lint Gate

| Capability | Description | Maturity |
|------------|-------------|----------|
| Lint command detection | Infer from package.json, pyproject.toml, etc. | Designed |
| Lint gate evaluation | Run lint, block on failure | Designed |
| Auto-fix attempt | Agent tries to fix lint errors (bounded retries) | Concept |

**Why deferred:** Test gate proves the gate model. Lint is additive.

**Implementation path:** Add `lint_pass` gate type; extend repo profile detection.

---

### Expanded Tool Access

Upgrade from v0.1's minimal tool shim to full MCP layer.

| Capability | Description | Maturity |
|------------|-------------|----------|
| MCP server | Standardized tool protocol | Designed |
| Generalized shell execution | Sandboxed bash with network controls | Concept |
| Tool extensions | Plugin model for Conductor-owned tools | Concept |
| Dev server management | Start/stop dev servers, health checks | Designed |

**Why deferred:** v0.1 needs only file read/write and test execution. MCP is a subsystem.

**Implementation path:** Replace hardcoded tool shim with MCP server; existing logging schema unchanged.

**Non-goal:** User-defined or dynamically uploaded tools. All tools remain Conductor-owned and policy-controlled.

---

### GitHub Projects Sync

| Capability | Description | Maturity |
|------------|-------------|----------|
| Board column mapping | Map run phases to project columns | Concept |
| Automatic card movement | Move cards as runs progress | Concept |
| Two-way sync | Reflect manual column changes | Concept |

**Why deferred:** Comments are sufficient audit surface for v0.1.

**Implementation path:** GitHub Projects API integration; sync on `phase.transitioned` events.

---

## v0.3: Scale

**Theme:** Support real teams and workloads.

v0.3 splits into two sub-themes that can ship independently:

### Scale: Infrastructure

#### Higher Parallelism

| Capability | Description | Maturity |
|------------|-------------|----------|
| 10+ concurrent runs | Per host, with resource management | Designed |
| Run queue | Excess runs queued, not rejected | Designed |
| Priority scheduling | High-priority runs preempt queue | Concept |
| Resource limits | Per-run memory/CPU caps | Concept |

**Why deferred:** 2 concurrent runs proves isolation model without scheduler complexity.

**Implementation path:** Add run queue table; implement scheduler service; resource monitoring.

---

#### Remote Deployment

| Capability | Description | Maturity |
|------------|-------------|----------|
| Cloud hosting | Conductor as hosted service | Concept |
| Multi-host | Distribute runs across workers | Concept |
| Webhook reliability | Queue with retry, no missed events | Designed |
| Database migration | SQLite → PostgreSQL option | Concept |

**Why deferred:** Local mode is sufficient for proving the product.

**Implementation path:** Extract worker process; add job queue (Redis/SQS); PostgreSQL adapter.

---

#### Webhook Queue

| Capability | Description | Maturity |
|------------|-------------|----------|
| Durable webhook storage | No missed events on restart | Designed |
| Retry with backoff | Failed processing retried | Designed |
| Deduplication | Idempotent event handling | Designed |

**Why deferred:** Acceptable to miss webhooks during restart in v0.1.

**Implementation path:** Persist webhooks before processing; mark processed after commit.

---

### Scale: Governance

#### Multi-Operator Authentication

| Capability | Description | Maturity |
|------------|-------------|----------|
| User accounts | Login, roles, permissions | Designed |
| Team membership | Users belong to projects | Designed |
| Audit attribution | Actions attributed to specific operators | Designed |
| SSO integration | OAuth, SAML | Concept |

**Why deferred:** Single operator is sufficient for proving the product.

**Implementation path:** Add `users` and `project_members` tables; wrap all actions in auth middleware.

**Prerequisite from v0.1/WP13-A:** Keep owner-only authorization checks centralized behind one policy layer so project membership/roles can be added without changing every API route.

---

## v0.4: Autonomy

**Theme:** Let Conductor do more without human intervention—when explicitly allowed.

**Invariant:** Autonomy features are opt-in per project and per repository. Default behavior always requires explicit human approval.

### Policy-Gated Auto-Merge

| Capability | Description | Maturity |
|------------|-------------|----------|
| Merge policies | Define conditions for autonomous merge | Designed |
| Confidence thresholds | Require reviewer confidence score | Concept |
| Change class rules | Auto-merge docs, require human for core | Designed |
| Time-delayed merge | Merge if no objections after N hours | Concept |

**Why deferred:** Human merge is the correct trust boundary for v0.1.

**Implementation path:** Add `merge_policy` to repo config; evaluate at `pr.ready` event; MergeEligibility struct.

**Policies designed to support:**

| Policy | Behavior |
|--------|----------|
| Default | Always require human merge |
| Docs-only | Auto-merge documentation changes |
| High-confidence | Auto-merge when: all tests pass, no policy violations, confidence ≥ threshold |
| Time-delayed | Merge if no objections after N hours |

---

### Cross-Repo Runs

| Capability | Description | Maturity |
|------------|-------------|----------|
| Multi-repo issues | Single issue spans multiple repos | Concept |
| Coordinated PRs | PRs created in sync | Concept |
| Atomic merge | All-or-nothing merge coordination | Concept |

**Why deferred:** Single repo per run is sufficient for most use cases.

**Implementation path:** Run becomes a tree of sub-runs; coordination layer for merge.

---

### Agent Memory / Learning

| Capability | Description | Maturity |
|------------|-------------|----------|
| Repo-specific patterns | Learn from past runs on same repo | Concept |
| Error pattern recognition | Avoid repeated mistakes | Concept |
| Style inference | Match existing code style | Concept |

**Why deferred:** Fresh context is a feature for v0.1—no hidden state, no drift.

**Implementation path:** Embeddings of past runs; retrieval at context assembly; explicit memory management.

**Invariant:** All agent memory must be inspectable, explainable, and deletable by operators. No opaque learned state.

---

### Cost Tracking

| Capability | Description | Maturity |
|------------|-------------|----------|
| Token usage per run | Track input/output tokens | Designed |
| Cost attribution | Roll up to project/repo | Designed |
| Budget limits | Warn or block on threshold | Concept |
| Usage reports | Dashboard and export | Concept |

**Why deferred:** Need run history first; cost is metadata on existing events.

**Implementation path:** Add `tokens_in`, `tokens_out` to agent invocation events; aggregation queries.

---

## Explicit Guards

The following will **not** ship before the listed versions, regardless of demand:

| Feature | Earliest Version | Rationale |
|---------|------------------|-----------|
| Auto-merge | v0.4 | Trust boundary; requires proven policy engine |
| Cross-repo runs | v0.4 | Coordination complexity; single-repo must be solid |
| Agent memory/learning | v0.4 | Auditability risk; fresh context is a feature |
| User-defined tools | Never (current plans) | Security boundary; agents are system components |

These guards exist to prevent roadmap gravity from pulling high-risk features forward prematurely.

---

## Out of Scope (No Current Plans)

These are explicitly **not** on the roadmap:

| Non-Feature | Rationale |
|-------------|-----------|
| CLI as primary interface | UI-first is a core design decision |
| GitLab / Bitbucket | GitHub-first; other forges add significant surface |
| IDE integration | Conductor is a control plane, not a dev tool |
| General chat UI | Issue Intake is the only conversational surface |
| Real-time collaboration | Conductor is command-and-observe, not multiplayer |
| Custom agent development | Agents are system components, not user-extensible |

---

## Feature Requests

To propose a feature:

1. Check this document—it may already be planned
2. Check [MVP_SCOPE.md](MVP_SCOPE.md)—it may be intentionally deferred
3. Open a discussion with:
   - Problem statement (what user need)
   - Proposed solution (high level)
   - Why it can't wait for the planned version

---

## Further Reading

- [MVP_SCOPE.md](MVP_SCOPE.md) — What's in v0.1
- [VISION.md](VISION.md) — Product philosophy
- [ARCHITECTURE.md](ARCHITECTURE.md) — System design
- [POLICIES.md](POLICIES.md) — Policy engine design
