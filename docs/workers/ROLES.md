# Worker Roles

Status: Normative specification
Audience: Engineering, platform integrators, AI agent developers
Updated: 2026-02-19

This document provides complete specifications for all built-in worker roles and a guide for authoring custom roles. For the high-level role model, see `OVERVIEW.md §§ 2.1, 5`.

---

## 1. Role Architecture

A **role** is a named set of capabilities that defines what a worker can do. The orchestrator routes tasks to workers by matching the required capability (from the workflow template) to the worker's declared capabilities (from its role).

```
Workflow Template                    Worker Registry
──────────────────                   ───────────────
Phase: planning                      planner-claude-opus
  requires: planning.create    ───►    role: planner
                                       capabilities: [planning.create, planning.revise]

Phase: testing                       vitest-worker
  requires: script.test        ───►    role: tester
                                       capabilities: [script.test]
```

### 1.1 Capability Naming Convention

```
{domain}.{action}

domain:   planning | implementation | review | script | research | docs | pm | reporting | gate
action:   create | execute | revise | code | lint | test | typecheck | build | deploy | ...
```

Examples: `planning.create`, `implementation.execute`, `review.code`, `script.lint`, `pm.triage`, `docs.generate`, `gate.plan_approval`

### 1.2 Role Inheritance

Roles can inherit from a base role and add or override capabilities:

```yaml
roles:
  base_reviewer:
    capabilities: [review.code]
    worker_class: ai
    sandbox: read-only

  security_reviewer:
    inherits: base_reviewer
    capabilities_add: [review.security]    # Gets review.code + review.security
    system_prompt_append: |
      Additionally, check for OWASP Top 10 vulnerabilities...
```

---

## 2. Built-in AI Roles

### 2.1 Planner

**Purpose:** Create and revise implementation plans for work items.

| Property | Value |
| --- | --- |
| Role ID | `planner` |
| Worker Class | `ai` |
| Capabilities | `planning.create`, `planning.revise`, `planning.scope_map` |
| Sandbox | `read-only` (reads codebase, doesn't modify) |
| Default Model | `claude-sonnet-4-6` |
| Temperature | `0.7` (creative but grounded) |
| Token Budget | `100,000` per task |
| Timeout | `5 minutes` |

**System Prompt Core:**

```
You are a senior software architect creating an implementation plan.

Given a work item with acceptance criteria, produce a plan that includes:
1. Approach summary (2-3 sentences)
2. File-by-file change list with rationale
3. AC traceability table mapping each criterion to implementation files and test files
4. Risk flags and mitigations
5. Scope boundary (what this plan does NOT include)

Read the codebase first. Understand existing patterns before proposing changes.
Do not implement — plan only.
```

**Input (task context):**
- Work item: title, body, acceptance criteria, non-goals
- Codebase: file tree, relevant source files
- Intelligence: `suggest_approach` output, `predict_rework` output, `history_insights` output
- Previous plan (if revising)

**Output (artifacts):**
- `PLAN` artifact: Markdown plan file
- `PLAN_METADATA` artifact: JSON with file list, estimated complexity, risk flags

**Typical Workflow Stages:** `planning` (feature), `planning` (epic), `planning` (bug_fix, medium/large)

### 2.2 Implementer

**Purpose:** Write code changes based on an approved plan.

| Property | Value |
| --- | --- |
| Role ID | `implementer` |
| Worker Class | `ai` |
| Capabilities | `implementation.execute`, `implementation.fix`, `implementation.test`, `implementation.prepare_pr` |
| Sandbox | `workspace-write` (writes to worktree, no system access) |
| Default Model | `claude-sonnet-4-6` |
| Temperature | `0.3` (precise, less creative) |
| Token Budget | `200,000` per task |
| Timeout | `15 minutes` |

**System Prompt Core:**

```
You are a senior software engineer implementing changes according to an approved plan.

Follow the plan exactly. Do not add features, refactor code, or make improvements
beyond what the plan specifies. If you discover work outside the plan's scope, STOP
and report it — do not implement it.

Write tests for every change. Follow existing code patterns.
Do not introduce security vulnerabilities.
```

**Input:**
- Approved plan artifact
- Work item acceptance criteria
- Codebase access (read + write within worktree)
- Tool access: file read/write, grep, glob, bash (workspace-scoped)

**Output:**
- `CODE` artifact: Source files modified in worktree
- `PATCHSET` artifact: Git diff of all changes
- `TEST_REPORT` artifact: Test output from changes

**Checkpoint behavior:** Checkpoints after each file modification. If interrupted, resumes from last checkpoint.

**Typical Workflow Stages:** `implementing` (feature, bug_fix), `reworking` (feature)

### 2.3 Reviewer

**Purpose:** Review code changes for correctness, security, performance, and spec compliance.

| Property | Value |
| --- | --- |
| Role ID | `reviewer` |
| Worker Class | `ai` |
| Capabilities | `review.code`, `review.plan`, `review.scope` |
| Sandbox | `read-only` |
| Default Model | `claude-sonnet-4-6` |
| Temperature | `0.2` (precise, conservative) |
| Token Budget | `50,000` per task |
| Timeout | `5 minutes` |

**System Prompt Core:**

```
You are a meticulous code reviewer. Your job is to find real problems, not style nits.

For each finding:
1. Cite the exact file:line
2. Explain what is wrong and why it matters
3. Suggest a specific fix
4. Rate severity: blocking, high, medium, low, suggestion

Do NOT flag:
- Style preferences (formatting, naming conventions) unless they violate project patterns
- Theoretical issues that cannot happen given the code's constraints
- Missing documentation unless explicitly required by the acceptance criteria

Every finding must have evidence. "This could be a problem" is not evidence.
```

**Input:**
- PR diff or code changes artifact
- Work item acceptance criteria
- Plan artifact (for scope check)
- Calibration data (historical hit rates per finding type, if available)

**Output:**
- `REVIEW_FINDINGS` artifact: Array of findings with severity, location, issue, fix
- `REVIEW_VERDICT` artifact: approved | changes_requested | needs_discussion

**Typical Workflow Stages:** `reviewing` (feature, bug_fix), `quick_review` (incident)

### 2.4 Researcher

**Purpose:** Investigate questions, evaluate approaches, and produce research documents.

| Property | Value |
| --- | --- |
| Role ID | `researcher` |
| Worker Class | `ai` |
| Capabilities | `research.investigate`, `research.evaluate` |
| Sandbox | `read-only` |
| Default Model | `claude-sonnet-4-6` |
| Temperature | `0.5` |
| Token Budget | `80,000` per task |
| Timeout | `10 minutes` |

**System Prompt Core:**

```
You are a technical researcher. Investigate the question thoroughly.

Produce a research document that includes:
1. Question or hypothesis being investigated
2. Methodology (what you examined and how)
3. Findings with evidence
4. Recommendations with tradeoffs
5. Open questions (what you couldn't determine)

Cite specific code, documentation, or external sources for every claim.
```

**Input:**
- Research question (from spike work item)
- Codebase access (read-only)
- Web search access (if configured)

**Output:**
- `RESEARCH` artifact: Markdown research document

**Typical Workflow Stages:** `researching` (spike)

### 2.5 Security Reviewer

**Purpose:** Review code changes with focus on security vulnerabilities and threat modeling.

| Property | Value |
| --- | --- |
| Role ID | `security_reviewer` |
| Worker Class | `ai` |
| Inherits | `reviewer` |
| Capabilities | `review.code`, `review.plan`, `review.scope`, `review.security` |
| Sandbox | `read-only` |
| Default Model | `claude-opus-4-6` (highest reasoning for security analysis) |
| Temperature | `0.1` (minimal creativity — precision critical) |
| Token Budget | `80,000` per task |
| Timeout | `8 minutes` |

**System Prompt Append (extends reviewer prompt):**

```
Additionally, you are a security specialist. Check for:

1. OWASP Top 10 vulnerabilities (injection, XSS, CSRF, auth bypass, etc.)
2. Secrets or credentials in code or config
3. Insecure deserialization or input handling
4. Missing authorization checks on new endpoints
5. Path traversal, command injection, SSRF
6. Insecure cryptographic choices
7. Information disclosure in error messages or logs

Every security finding MUST include:
- CWE identifier (e.g., CWE-79 for XSS)
- Severity rating per CVSS 3.1 methodology
- Concrete exploit scenario (how an attacker would use this)
- Specific fix with code example

False positives in security findings are expensive. Only flag issues you can demonstrate.
```

**When assigned:** Security reviewers are selected when:
- Work item has `area: security` label
- Changed files touch authentication, authorization, or crypto paths
- Project policy requires security review for all PRs
- Explicit request via `review.security` operation in workflow template

**Typical Workflow Stages:** `reviewing` (feature with security label), custom security review stages

### 2.6 Documenter

**Purpose:** Generate and update documentation based on code changes and specifications.

| Property | Value |
| --- | --- |
| Role ID | `documenter` |
| Worker Class | `ai` |
| Capabilities | `docs.generate`, `docs.update` |
| Sandbox | `workspace-write` (writes doc files) |
| Default Model | `claude-sonnet-4-6` |
| Temperature | `0.4` |
| Token Budget | `40,000` per task |
| Timeout | `5 minutes` |

**System Prompt Core:**

```
You are a technical writer. Generate clear, accurate documentation.

Given code changes and their purpose, produce or update documentation that:
1. Explains what changed and why
2. Updates API docs, README sections, or user guides as needed
3. Follows the project's existing documentation style and structure
4. Includes code examples where helpful
5. Does NOT duplicate information already in code comments

Write for the reader who will use this code, not the person who wrote it.
```

**Input:**
- Code changes artifact (PATCHSET or CODE)
- Work item description and acceptance criteria
- Existing documentation files

**Output:**
- `PLAN` artifact: Updated documentation files (reuses PLAN type since docs are markdown)

**Typical Workflow Stages:** Async stage triggered after implementation completes (fire-and-forget or monitored).

---

## 3. Built-in Script Roles

Script roles wrap deterministic tools. They don't need LLMs.

### 3.1 Linter

| Property | Value |
| --- | --- |
| Role ID | `linter` |
| Worker Class | `script` |
| Capabilities | `script.lint` |
| Default Script | `eslint` (configurable per project) |
| Runtime | `node` |
| Timeout | `2 minutes` |

**Input:** File list (from changed files in PR/worktree)
**Output:** Lint findings (parsed into `ReviewFindingSchema` format)
**Exit codes:** 0 = clean, 1 = findings, 2 = error

### 3.2 Tester

| Property | Value |
| --- | --- |
| Role ID | `tester` |
| Worker Class | `script` |
| Capabilities | `script.test` |
| Default Script | `vitest` (configurable per project) |
| Runtime | `node` |
| Timeout | `5 minutes` |

**Input:** Test command, optional test filter
**Output:** Test results (pass/fail count, failure details)
**Exit codes:** 0 = all pass, 1 = failures, 2 = error

### 3.3 Type Checker

| Property | Value |
| --- | --- |
| Role ID | `typechecker` |
| Worker Class | `script` |
| Capabilities | `script.typecheck` |
| Default Script | `tsc --noEmit` |
| Runtime | `node` |
| Timeout | `3 minutes` |

### 3.4 Builder

| Property | Value |
| --- | --- |
| Role ID | `builder` |
| Worker Class | `script` |
| Capabilities | `script.build` |
| Default Script | `tsc` or build command from config |
| Runtime | `node` |
| Timeout | `5 minutes` |

### 3.5 Deployer

| Property | Value |
| --- | --- |
| Role ID | `deployer` |
| Worker Class | `script` |
| Capabilities | `script.deploy` |
| Sandbox | `full-access` (needs network, filesystem) |
| Timeout | `10 minutes` |

**Note:** Deployer is the only script role that defaults to `full-access` sandbox. Deployment scripts typically need network access (push to registry, call deploy APIs) and filesystem access beyond the worktree.

### 3.6 Formatter

| Property | Value |
| --- | --- |
| Role ID | `formatter` |
| Worker Class | `script` |
| Capabilities | `script.format` |
| Default Script | `prettier --write` |
| Runtime | `node` |
| Timeout | `1 minute` |

### 3.7 Security Scanner

| Property | Value |
| --- | --- |
| Role ID | `security_scanner` |
| Worker Class | `script` |
| Capabilities | `script.security_scan` |
| Default Script | `npm audit` / `trivy` / `semgrep` (configurable) |
| Runtime | `node` or `bash` |
| Sandbox | `read-only` |
| Timeout | `5 minutes` |

**Input:** Worktree path, optional file filter
**Output:** Security findings (parsed into `ReviewFindingSchema` format with CWE identifiers)
**Exit codes:** 0 = clean, 1 = findings, 2 = error

### 3.8 Migrator

| Property | Value |
| --- | --- |
| Role ID | `migrator` |
| Worker Class | `script` |
| Capabilities | `script.migrate` |
| Default Script | `prisma migrate` / `knex migrate` / custom (configurable) |
| Runtime | `node` or `python` |
| Sandbox | `full-access` (needs DB connection, filesystem) |
| Timeout | `5 minutes` |

**Input:** Migration direction (up/down), target version (optional)
**Output:** Migration result (applied count, current version)
**Exit codes:** 0 = success, 1 = failure, 2 = error

### 3.9 Notifier

| Property | Value |
| --- | --- |
| Role ID | `notifier` |
| Worker Class | `script` |
| Capabilities | `script.notify` |
| Default Script | Webhook/Slack/email dispatcher (configurable) |
| Runtime | `bash` or `node` |
| Sandbox | `read-only` + network (sends outbound requests only) |
| Timeout | `30 seconds` |

**Input:** Notification type, recipient channel, message template, context data
**Output:** Delivery status (sent/failed, recipient, timestamp)
**Note:** Always used as async fire-and-forget stages. Notification failure never blocks a run.

### 3.10 Metrics Collector

| Property | Value |
| --- | --- |
| Role ID | `metrics` |
| Worker Class | `script` |
| Capabilities | `script.metrics` |
| Default Script | Custom collector (configurable) |
| Runtime | `node` or `python` |
| Sandbox | `read-only` |
| Timeout | `2 minutes` |

**Input:** Metric query type, scope (run/project/iteration)
**Output:** `METRICS` artifact (JSON with metric values, timestamps, dimensions)
**Note:** Typically async. Feeds PM Engine dashboards and analytics.

### 3.11 Validator

| Property | Value |
| --- | --- |
| Role ID | `validator` |
| Worker Class | `script` |
| Capabilities | `script.validate` |
| Default Script | Schema validator (JSON Schema, OpenAPI, etc.) |
| Runtime | `node` or `python` |
| Sandbox | `read-only` |
| Timeout | `1 minute` |

**Input:** File paths to validate, schema references
**Output:** Validation results (pass/fail, specific schema violations)
**Exit codes:** 0 = valid, 1 = invalid, 2 = error

---

## 4. Built-in Human Roles

Human workers are routed through Conductor's interfaces (Web UI, GitHub PR reviews, Slack, email). They respond with the same task result format as AI and script workers.

### 4.1 Code Reviewer (Human)

| Property | Value |
| --- | --- |
| Role ID | `human_reviewer` |
| Worker Class | `human` |
| Capabilities | `review.code`, `review.plan` |
| Timeout | `24 hours` (configurable) |

**Task routing:** Via PR review request on GitHub/GitLab, or Conductor Web UI notification.
**Response format:** Approve, request changes, or comment (same format as AI reviewer).

### 4.2 Security Reviewer (Human)

| Property | Value |
| --- | --- |
| Role ID | `human_security` |
| Worker Class | `human` |
| Capabilities | `review.code`, `review.security` |
| Timeout | `24 hours` |

**Task routing:** Via security-team-specific notification channel. Assigned when PR touches security-sensitive paths or when project policy requires human security review.
**Response format:** Same as human_reviewer, with additional security-specific finding fields.

### 4.3 Product Owner

| Property | Value |
| --- | --- |
| Role ID | `human_product` |
| Worker Class | `human` |
| Capabilities | `review.requirements`, `gate.scope_approval` |
| Timeout | `48 hours` |

**Task routing:** Via Conductor Web UI, Slack, or email.
**Response format:** Approve scope, reject with feedback, or request clarification.
**When assigned:** Discovery workflows (spec validation), scope change approvals, requirement disputes.

### 4.4 Plan Approver

| Property | Value |
| --- | --- |
| Role ID | `plan_approver` |
| Worker Class | `human` |
| Capabilities | `gate.plan_approval` |
| Timeout | `4 hours` |

**Task routing:** Via Conductor Web UI, Slack notification, or email.
**Response format:** Approve or reject with comments.

### 4.5 Merge Approver

| Property | Value |
| --- | --- |
| Role ID | `merge_approver` |
| Worker Class | `human` |
| Capabilities | `gate.merge_approval` |
| Timeout | `24 hours` |

---

## 5. Built-in Service Roles

Service workers are long-running processes that accept tasks continuously. Unlike AI workers (spawned per task) and script workers (executed per task), service workers register once and serve indefinitely.

### 5.1 PM Engine

| Property | Value |
| --- | --- |
| Role ID | `pm_engine` |
| Worker Class | `service` |
| Capabilities | All `conductor_*` PM intelligence tools (55 operations) |
| Sandbox | Own SQLite database (read/write), GitHub API (read) |
| Instances | Singleton per project |
| Timeout | Varies per operation (30s for queries, 5min for sync) |

**Architecture:** The PM Engine is the largest service worker. It wraps 10 intelligence modules, each of which could be modeled as its own worker. At the current scale they run in-process as a monolith; at scale they could be decomposed into separate service workers.

**Operations (subset):** `conductor_triage_work_item`, `conductor_plan_iteration`, `conductor_get_risk_radar`, `conductor_predict_completion`, `conductor_suggest_next_work_item`, `conductor_decompose_work_item`, `conductor_sync_from_source`, etc.

**State:** Maintains SQLite database (`.pm/state.db`) with work items, events, decisions, outcomes, dependencies, and projections.

**Health:** Exposes `/health` endpoint. Auto-syncs on startup if data is stale (>1hr). Reports sync lag as a health metric.

### 5.2 CI Service

| Property | Value |
| --- | --- |
| Role ID | `ci_service` |
| Worker Class | `service` |
| Capabilities | `script.ci_trigger`, `script.ci_status` |
| Sandbox | Network access (GitHub Actions API, GitLab CI API) |
| Instances | Singleton per project |
| Timeout | `ci_trigger`: 30s, `ci_status`: 10s |

**Architecture:** Wraps the project's CI system (GitHub Actions, GitLab CI, CircleCI, etc.) behind a uniform interface. The orchestrator triggers CI runs and polls for status without knowing which CI system is in use.

**Operations:**
- `script.ci_trigger` — Start a CI workflow (e.g., run tests on a PR branch)
- `script.ci_status` — Query status of a CI run (pending, running, passed, failed)

**Webhook integration:** Optionally receives CI webhooks for real-time status updates instead of polling.

---

## 6. Built-in PM Roles

PM worker roles fall into two categories:

### 6.1 Intelligence Module Roles

These are specified in detail in `../pm-engine/INTELLIGENCE_MODULES.md`. Each has an algorithm contract, input/output schemas, and caching strategy.

| Role ID | Capabilities | Worker Class | Detail Doc |
| --- | --- | --- | --- |
| `pm.analytics.cycle_time` | `pm.analytics.cycle_time` | script | `INTELLIGENCE_MODULES.md § 1` |
| `pm.analytics.velocity` | `pm.analytics.velocity` | script | `INTELLIGENCE_MODULES.md § 2` |
| `pm.prediction.monte_carlo` | `pm.prediction.monte_carlo` | script | `INTELLIGENCE_MODULES.md § 3` |
| `pm.prediction.rework` | `pm.prediction.rework` | script/hybrid | `INTELLIGENCE_MODULES.md § 4` |
| `pm.graph.analysis` | `pm.graph.analysis` | script | `INTELLIGENCE_MODULES.md § 5` |
| `pm.synthesis.risk_radar` | `pm.synthesis.risk_radar` | script | `INTELLIGENCE_MODULES.md § 6` |
| `pm.memory.retrieval` | `pm.memory.retrieval` | script/hybrid | `INTELLIGENCE_MODULES.md § 7` |
| `pm.calibration.review` | `pm.calibration.review` | script | `INTELLIGENCE_MODULES.md § 8` |
| `pm.capacity.model` | `pm.capacity.model` | script | `INTELLIGENCE_MODULES.md § 9` |
| `pm.detection.anomaly` | `pm.detection.anomaly` | script | `INTELLIGENCE_MODULES.md § 10` |

### 6.2 Workflow-Specific PM Roles

These are simpler roles used in PM workflow stages (`../pm-engine/WORKFLOWS.md`). They typically compose intelligence module outputs or interact with the data layer.

| Role ID | Purpose | Worker Class | Needs LLM? |
| --- | --- | --- | --- |
| `pm.triage.classifier` | Classify work item type, area, priority | script or AI | Optional (heuristic or LLM) |
| `pm.synthesis.risk_assessor` | Combine triage + rework + similar into risk assessment | script | No |
| `pm.planning.ranker` | Rank backlog items by WSJF, risk, dependencies | script | No |
| `pm.planning.proposer` | Produce iteration plan from ranked items + simulation | script | No |
| `pm.discovery.structurer` | Transform raw idea into structured work item | AI | Yes |
| `pm.discovery.validator` | Assess spec readiness (completeness, ambiguity) | script or AI | Optional |
| `pm.valuation.assessor` | Score value dimensions of a work item | script or AI | Optional |
| `pm.review.analyzer` | Analyze PR changes against acceptance criteria | script + AI | Yes (for code understanding) |
| `pm.review.scope_checker` | Check PR scope against planned file list | script | No |
| `pm.review.evaluator` | Evaluate code quality and produce findings | AI | Yes |
| `pm.review.verdict` | Produce final review verdict from findings + calibration | script | No |
| `pm.synthesis.pattern_miner` | Extract patterns from retrospective data | script | No |
| `pm.reporting.retrospective` | Generate retrospective narrative | AI | Yes |
| `pm.reporting.release_notes` | Generate release notes from PR data | AI | Yes |
| `pm.reporting.standup` | Generate daily standup from activity data | AI | Yes |
| `pm.memory.recorder` | Record decisions and outcomes to data layer | script | No |
| `pm.memory.decay_checker` | Check for stale decisions | script | No |
| `pm.memory.linker` | Link outcomes to decisions | script | No |

**Key observation:** Only 6 of 18 workflow-specific PM roles need an LLM (structurer, analyzer, evaluator, retrospective, release notes, standup). The rest are script workers that compose data and apply rules.

---

## 7. Operation Reference

Complete list of operation identifiers used in workflow templates. Each operation maps to a role capability.

### 7.1 Development Operations

| Operation | Description | Typical Role |
| --- | --- | --- |
| `planning.create` | Create an implementation plan | planner |
| `planning.revise` | Revise a plan based on feedback | planner |
| `planning.scope_map` | Map acceptance criteria to files and tests | planner |
| `implementation.execute` | Implement changes per plan | implementer |
| `implementation.fix` | Fix issues from test/lint/review | implementer |
| `implementation.test` | Run implementation-scoped tests | implementer |
| `implementation.prepare_pr` | Create PR from worktree changes | implementer |
| `review.code` | Review code changes | reviewer |
| `review.plan` | Review an implementation plan | reviewer |
| `review.scope` | Check scope alignment against plan | reviewer |
| `review.security` | Security-focused review | security_reviewer |
| `review.requirements` | Validate requirements coverage | human_product |
| `research.investigate` | Open-ended research | researcher |
| `research.evaluate` | Evaluate specific options | researcher |
| `docs.generate` | Generate documentation from changes | documenter |
| `docs.update` | Update existing documentation | documenter |

### 7.2 Script Operations

| Operation | Description | Typical Role |
| --- | --- | --- |
| `script.lint` | Run linter | linter |
| `script.test` | Run tests | tester |
| `script.typecheck` | Run type checker | typechecker |
| `script.build` | Build project | builder |
| `script.format` | Format code | formatter |
| `script.deploy` | Deploy to environment | deployer |
| `script.security_scan` | Run security scanner | security_scanner |
| `script.migrate` | Run database migrations | migrator |
| `script.notify` | Send notifications | notifier |
| `script.metrics` | Collect and report metrics | metrics |
| `script.validate` | Validate schemas/configs | validator |
| `script.ci_trigger` | Trigger CI workflow | ci_service |
| `script.ci_status` | Query CI run status | ci_service |

### 7.3 Gate Operations

| Operation | Description | Typical Role |
| --- | --- | --- |
| `gate.plan_approval` | Approve/reject a plan | plan_approver (human) |
| `gate.merge_approval` | Approve/reject a merge | merge_approver (human) |
| `gate.scope_approval` | Approve/reject scope changes | human_product |

### 7.4 PM Operations

| Operation | Description | Typical Role |
| --- | --- | --- |
| `pm.triage` | Classify and assess a work item | pm.triage.classifier |
| `pm.decompose` | Break work item into subtasks | pm_engine |
| `pm.suggest_next` | Recommend next work item | pm_engine |
| `pm.forecast` | Monte Carlo completion forecast | pm_engine |
| `pm.risk` | Compute risk radar | pm_engine |
| `pm.plan_iteration` | Create an iteration plan | pm.planning.ranker + proposer |
| `pm.record_outcome` | Record work outcome | pm.memory.recorder |
| `pm.review_pr` | Review a PR (PM-level) | pm.review.analyzer + evaluator |
| `pm.retrospective` | Generate retrospective | pm.reporting.retrospective |
| `pm.release_notes` | Generate release notes | pm.reporting.release_notes |
| `pm.standup` | Generate daily standup | pm.reporting.standup |

---

## 8. Worker Variant Registry

A **worker variant** is a concrete instance of a role, bound to a specific provider and model configuration. Multiple variants of the same role enable failover, cost optimization, and A/B testing.

### 8.1 Typical Production Registry

```
Role: planner
├── planner-claude-opus         provider: anthropic   model: claude-opus-4-6      cost: $$$   quality: highest
├── planner-claude-sonnet       provider: anthropic   model: claude-sonnet-4-6    cost: $$    quality: high
├── planner-gpt4                provider: openai      model: gpt-4.1              cost: $$$   quality: highest
├── planner-gemini-pro          provider: google      model: gemini-2.5-pro       cost: $$    quality: high
└── planner-local-llama         provider: ollama      model: llama-3.3-70b        cost: $     quality: medium

Role: implementer
├── impl-claude-sonnet          provider: anthropic   model: claude-sonnet-4-6    cost: $$    quality: high
├── impl-claude-opus            provider: anthropic   model: claude-opus-4-6      cost: $$$   quality: highest
├── impl-gpt4                   provider: openai      model: gpt-4.1              cost: $$    quality: high
├── impl-codex                  provider: openai      model: codex                cost: $$    quality: high (code-specific)
└── impl-local-deepseek         provider: ollama      model: deepseek-coder-v3    cost: $     quality: medium

Role: reviewer
├── reviewer-claude-opus        provider: anthropic   model: claude-opus-4-6      cost: $$$   quality: highest
├── reviewer-gpt4               provider: openai      model: gpt-4.1              cost: $$$   quality: highest
├── reviewer-gemini-pro         provider: google      model: gemini-2.5-pro       cost: $$    quality: high
└── reviewer-sonnet             provider: anthropic   model: claude-sonnet-4-6    cost: $$    quality: high

Role: security_reviewer
├── sec-reviewer-claude-opus    provider: anthropic   model: claude-opus-4-6      cost: $$$   quality: highest
└── sec-reviewer-gpt4           provider: openai      model: gpt-4.1              cost: $$$   quality: highest

Role: researcher
├── researcher-claude-opus      provider: anthropic   model: claude-opus-4-6      cost: $$$   quality: highest
├── researcher-gemini-pro       provider: google      model: gemini-2.5-pro       cost: $$    quality: high (1M context)
└── researcher-local            provider: ollama      model: llama-3.3-70b        cost: $     quality: medium

Role: documenter
├── docs-claude-sonnet          provider: anthropic   model: claude-sonnet-4-6    cost: $$    quality: high
├── docs-gpt4-mini              provider: openai      model: gpt-4.1-mini         cost: $     quality: good
└── docs-haiku                  provider: anthropic   model: claude-haiku-4-5     cost: $     quality: good

Role: pm.triage.classifier
├── triage-haiku                provider: anthropic   model: claude-haiku-4-5     cost: $     quality: good (fast, cheap)
├── triage-gpt4-nano            provider: openai      model: gpt-4.1-nano         cost: $     quality: good
└── triage-script               provider: —           model: —                    cost: free  quality: heuristic only

Role: pm.reporting.retrospective
├── retro-claude-sonnet         provider: anthropic   model: claude-sonnet-4-6    cost: $$    quality: high
└── retro-gpt4-mini             provider: openai      model: gpt-4.1-mini         cost: $     quality: good

Script roles (no variants — one instance per project):
├── eslint-worker               role: linter          runtime: node
├── vitest-worker               role: tester          runtime: node
├── tsc-worker                  role: typechecker     runtime: node
├── build-worker                role: builder         runtime: node
├── prettier-worker             role: formatter       runtime: node
├── vercel-deploy               role: deployer        runtime: bash
├── semgrep-worker              role: security_scanner runtime: bash
├── prisma-migrate              role: migrator        runtime: node
├── slack-notifier              role: notifier        runtime: node
├── metrics-collector           role: metrics         runtime: node
├── schema-validator            role: validator       runtime: node

Human roles (no variants — humans are humans):
├── @alice                      role: human_reviewer  routing: github-pr
├── @bob                        role: plan_approver   routing: web-ui
├── @carol                      role: merge_approver  routing: web-ui
├── @dave                       role: human_security  routing: slack-channel
├── @eve                        role: human_product   routing: web-ui

Service roles (singletons):
├── pm-engine-v1                role: pm_engine       instances: 1
└── github-ci-adapter           role: ci_service      instances: 1
```

### 8.2 Dynamic Selection Rules

The orchestrator selects from variants based on runtime conditions. This is not static configuration — it adapts.

| Signal | Selection Effect |
| --- | --- |
| **Work item risk level** | `risk >= high` → use highest-quality variant (Opus, GPT-4.1) |
| **Provider health** | Provider circuit breaker open → failover to next provider |
| **Cost budget** | Monthly budget remaining < 20% → prefer cheaper variants |
| **Task complexity** | Simple tasks (estimated_scope=small) → use cheaper models |
| **Area expertise** | If variant has higher success rate in this area → rank boost |
| **Rework probability** | `predict_rework > 0.5` → use highest-quality variant |
| **Time of day** | Off-peak → batch via Anthropic Batch API (50% cost reduction) |
| **Queue depth** | High queue → spread across providers for parallelism |
| **Token budget** | Task needs >100K tokens → only variants with 200K+ context |
| **Privacy policy** | `privacy: strict` → only local providers (Ollama) |

### 8.3 Dynamic Adaptation Scenarios

**Scenario 1: Provider outage**
```
Anthropic API returns 503 for 3 consecutive requests
→ Circuit breaker opens for anthropic provider (30s cooldown)
→ All anthropic variants marked unavailable
→ Orchestrator routes to next-ranked variant:
    planner-claude-opus → planner-gpt4
    impl-claude-sonnet → impl-gpt4
    reviewer-claude-opus → reviewer-gpt4
→ After 30s, circuit breaker half-opens (allows 1 probe request)
→ If probe succeeds, circuit closes, anthropic variants available again
→ Event: provider_failover { from: anthropic, to: openai, duration_ms: 30000 }
```

**Scenario 2: Cost optimization mid-sprint**
```
Budget tracker: $180 spent of $200 monthly budget (90%)
→ Cost policy activates tier downgrade:
    planner: claude-opus-4-6 → claude-sonnet-4-6 (save ~60%)
    reviewer: claude-opus-4-6 → claude-sonnet-4-6 (save ~60%)
    implementer: unchanged (already sonnet)
→ Critical work items exempt (risk_level=critical always gets best model)
→ Event: cost_policy_activated { budget_remaining_pct: 10, downgraded: [planner, reviewer] }
```

**Scenario 3: Quality regression detected**
```
PM Engine detects: rework rate for impl-gpt4 is 45% (vs 15% for impl-claude-sonnet)
→ Area-specific: only in backend area (frontend is fine)
→ Orchestrator adjusts ranking:
    For backend work items: impl-claude-sonnet +20 rank boost
    For frontend work items: no change
→ Event: quality_adjustment { worker: impl-gpt4, area: backend, rework_rate: 0.45 }
```

**Scenario 4: Model upgrade rollout**
```
New model released: claude-sonnet-4-7
→ Admin adds new variant: impl-claude-sonnet-47
→ Canary policy: route 10% of implementation tasks to new variant
→ After 20 tasks: compare rework rate, cycle time, test pass rate
→ If metrics equal or better: increase to 50%, then 100%
→ If metrics worse: disable variant, alert admin
→ Event: canary_evaluation { variant: impl-claude-sonnet-47, tasks: 20, result: promoted }
```

**Scenario 5: Privacy-sensitive project**
```
Project policy: privacy=strict (no data leaves network)
→ All cloud providers filtered out
→ Only local variants available:
    planner-local-llama, impl-local-deepseek, researcher-local
→ If no local variant exists for a role: run blocked, human escalation
→ Quality may be lower, but data sovereignty is maintained
→ Event: privacy_filter { excluded_providers: [anthropic, openai, google] }
```

---

## 9. Custom Role Authoring

### 9.1 Defining a Custom Role

```yaml
# In conductor.project.yaml or conductor.roles.yaml
custom_roles:
  my_custom_role:
    display_name: "My Custom Role"
    description: "What this role does"
    worker_class: ai | script | human
    capabilities: ["my_domain.my_action"]

    # For AI roles:
    requires_llm: true
    provider: anthropic
    model: claude-sonnet-4-6
    temperature: 0.3
    token_budget: 50000
    sandbox: read-only
    system_prompt: |
      Your role-specific instructions here.
      Be specific about what the role should and should not do.

    # For script roles:
    requires_llm: false
    runtime: node | python | bash
    script: ./path/to/script
    args: ["--flag", "value"]
    env:
      MY_CONFIG: value

    # Constraints:
    default_timeout_ms: 300000
    default_max_parallel: 1
```

### 9.2 Using Custom Roles in Workflow Templates

Reference the capability in the workflow template:

```yaml
# Custom workflow template
templates:
  my_workflow:
    phases:
      - phase_id: custom_check
        operation: my_domain.my_action
        execution_mode: sync
```

The orchestrator will route `my_domain.my_action` to any worker whose role declares that capability.

### 9.3 Custom Role Checklist

Before deploying a custom role:

- [ ] Role has a unique `role_id`
- [ ] Capabilities follow the `{domain}.{action}` naming convention
- [ ] System prompt (for AI roles) is specific and testable
- [ ] Sandbox mode is minimal (read-only unless writes are required)
- [ ] Token budget is set (for AI roles) — don't use unlimited
- [ ] Timeout is set — no worker should run forever
- [ ] Output format matches the expected artifact type for the workflow stage
- [ ] Error handling: what happens when the role fails? (retry? block? skip?)
- [ ] Tested with `conductor test-role --role my_custom_role`

---

## 10. Role Selection Algorithm

When the orchestrator needs to assign a task with a specific operation, it selects from registered workers:

```
Operation required: "review.code"
    │
    ▼
Find all workers whose role includes "review.code" capability
    │
    ├── reviewer-claude-opus     (role: reviewer, provider: anthropic)
    ├── reviewer-gpt4            (role: reviewer, provider: openai)
    ├── security-reviewer-claude (role: security_reviewer, provider: anthropic)
    │
    ▼
Filter by:
    1. Worker status (available, not at max_parallel)
    2. Project scope (worker enabled for this project)
    3. Provider health (provider not down, circuit breaker closed)
    4. Privacy policy (provider allowed for this project's data classification)
    5. Token budget (variant has sufficient context window for task)
    │
    ▼
Rank by:
    1. Risk-based quality boost (high risk → highest quality variant)
    2. Cost tier (within budget constraints)
    3. Capability priority boost (from worker_capabilities table)
    4. Availability (fewer current tasks = higher rank)
    5. Success rate (historical task success/failure ratio)
    6. Area match (PM Engine area expertise, if available)
    7. Canary weighting (if A/B testing is active)
    │
    ▼
Assign top-ranked worker
```

**Multiple roles for the same capability** is expected and encouraged. It enables:
- **Failover:** If the primary model's provider is down, the secondary takes over
- **Cost optimization:** Use cheaper models for low-risk tasks, expensive models for high-risk
- **A/B testing:** Compare model performance on the same role over time
- **Specialization:** `security_reviewer` has `review.code` + `review.security`, so it gets assigned security-sensitive reviews
- **Privacy isolation:** Local-only variants for sensitive projects
- **Canary deployments:** Gradually roll out new models with controlled traffic

---

## 11. Complete Role Census

Summary of every built-in role, organized by worker class.

| # | Role ID | Worker Class | Capabilities | LLM? |
| --- | --- | --- | --- | --- |
| 1 | `planner` | ai | `planning.create`, `planning.revise`, `planning.scope_map` | Yes |
| 2 | `implementer` | ai | `implementation.execute`, `implementation.fix`, `implementation.test`, `implementation.prepare_pr` | Yes |
| 3 | `reviewer` | ai | `review.code`, `review.plan`, `review.scope` | Yes |
| 4 | `researcher` | ai | `research.investigate`, `research.evaluate` | Yes |
| 5 | `security_reviewer` | ai | `review.code`, `review.plan`, `review.scope`, `review.security` | Yes |
| 6 | `documenter` | ai | `docs.generate`, `docs.update` | Yes |
| 7 | `linter` | script | `script.lint` | No |
| 8 | `tester` | script | `script.test` | No |
| 9 | `typechecker` | script | `script.typecheck` | No |
| 10 | `builder` | script | `script.build` | No |
| 11 | `deployer` | script | `script.deploy` | No |
| 12 | `formatter` | script | `script.format` | No |
| 13 | `security_scanner` | script | `script.security_scan` | No |
| 14 | `migrator` | script | `script.migrate` | No |
| 15 | `notifier` | script | `script.notify` | No |
| 16 | `metrics` | script | `script.metrics` | No |
| 17 | `validator` | script | `script.validate` | No |
| 18 | `human_reviewer` | human | `review.code`, `review.plan` | No |
| 19 | `human_security` | human | `review.code`, `review.security` | No |
| 20 | `human_product` | human | `review.requirements`, `gate.scope_approval` | No |
| 21 | `plan_approver` | human | `gate.plan_approval` | No |
| 22 | `merge_approver` | human | `gate.merge_approval` | No |
| 23 | `pm_engine` | service | All `conductor_*` operations | No |
| 24 | `ci_service` | service | `script.ci_trigger`, `script.ci_status` | No |
| 25-34 | `pm.analytics.*`, `pm.prediction.*`, etc. | script | PM intelligence operations | No (8/10) |
| 35-52 | `pm.triage.*`, `pm.planning.*`, etc. | script/ai | PM workflow operations | Partial (6/18) |

**Totals: 52 built-in roles** — 6 AI, 11 script, 5 human, 2 service, 10 PM intelligence, 18 PM workflow.
