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

domain:   planning | implementation | review | script | research | pm | reporting
action:   create | execute | revise | code | lint | test | typecheck | build | deploy | ...
```

Examples: `planning.create`, `implementation.execute`, `review.code`, `script.lint`, `pm.triage`, `reporting.retrospective`

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
| Capabilities | `planning.create`, `planning.revise` |
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
| Capabilities | `implementation.execute`, `implementation.fix` |
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
- `CODE_CHANGES` artifact: Git diff of all changes
- `TEST_RESULTS` artifact: Test output from changes

**Checkpoint behavior:** Checkpoints after each file modification. If interrupted, resumes from last checkpoint.

**Typical Workflow Stages:** `implementing` (feature, bug_fix), `reworking` (feature)

### 2.3 Reviewer

**Purpose:** Review code changes for correctness, security, performance, and spec compliance.

| Property | Value |
| --- | --- |
| Role ID | `reviewer` |
| Worker Class | `ai` |
| Capabilities | `review.code`, `review.plan` |
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

---

## 4. Built-in Human Roles

### 4.1 Code Reviewer (Human)

| Property | Value |
| --- | --- |
| Role ID | `human_reviewer` |
| Worker Class | `human` |
| Capabilities | `review.code`, `review.security` |
| Timeout | `24 hours` (configurable) |

**Task routing:** Via PR review request on GitHub/GitLab, or Conductor Web UI notification.
**Response format:** Approve, request changes, or comment (same format as AI reviewer).

### 4.2 Plan Approver

| Property | Value |
| --- | --- |
| Role ID | `plan_approver` |
| Worker Class | `human` |
| Capabilities | `gate.plan_approval` |
| Timeout | `4 hours` |

**Task routing:** Via Conductor Web UI, Slack notification, or email.
**Response format:** Approve or reject with comments.

### 4.3 Merge Approver

| Property | Value |
| --- | --- |
| Role ID | `merge_approver` |
| Worker Class | `human` |
| Capabilities | `gate.merge_approval` |
| Timeout | `24 hours` |

---

## 5. Built-in PM Roles

PM worker roles fall into two categories:

### 5.1 Intelligence Module Roles

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

### 5.2 Workflow-Specific PM Roles

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
| `pm.memory.recorder` | Record decisions and outcomes to data layer | script | No |
| `pm.memory.decay_checker` | Check for stale decisions | script | No |
| `pm.memory.linker` | Link outcomes to decisions | script | No |

**Key observation:** Only 5 of 17 workflow-specific PM roles need an LLM (structurer, analyzer, evaluator, retrospective, release notes). The rest are script workers that compose data and apply rules.

---

## 6. Operation Reference

Complete list of operation identifiers used in workflow templates. Each operation maps to a role capability.

### 6.1 Development Operations

| Operation | Description | Typical Role |
| --- | --- | --- |
| `planning.create` | Create an implementation plan | planner |
| `planning.revise` | Revise a plan based on feedback | planner |
| `implementation.execute` | Implement changes per plan | implementer |
| `implementation.fix` | Fix issues from test/lint/review | implementer |
| `review.code` | Review code changes | reviewer |
| `review.plan` | Review an implementation plan | reviewer |
| `review.security` | Security-focused review | security_reviewer |
| `research.investigate` | Open-ended research | researcher |
| `research.evaluate` | Evaluate specific options | researcher |

### 6.2 Script Operations

| Operation | Description | Typical Role |
| --- | --- | --- |
| `script.lint` | Run linter | linter |
| `script.test` | Run tests | tester |
| `script.typecheck` | Run type checker | typechecker |
| `script.build` | Build project | builder |
| `script.format` | Format code | formatter |
| `script.deploy` | Deploy to environment | deployer |
| `script.security_scan` | Run security scanner | security_scanner |

### 6.3 Gate Operations

| Operation | Description | Typical Role |
| --- | --- | --- |
| `gate.plan_approval` | Approve/reject a plan | plan_approver (human) |
| `gate.merge_approval` | Approve/reject a merge | merge_approver (human) |

### 6.4 PM Operations

| Operation | Description | Typical Role |
| --- | --- | --- |
| `pm.triage` | Classify and assess a work item | pm.triage.classifier |
| `pm.plan_iteration` | Create an iteration plan | pm.planning.ranker + proposer |
| `pm.review_pr` | Review a PR (PM-level) | pm.review.analyzer + evaluator |
| `pm.retrospective` | Generate retrospective | pm.reporting.retrospective |
| `pm.release_notes` | Generate release notes | pm.reporting.release_notes |

---

## 7. Custom Role Authoring

### 7.1 Defining a Custom Role

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

### 7.2 Using Custom Roles in Workflow Templates

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

### 7.3 Custom Role Checklist

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

## 8. Role Selection Algorithm

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
    3. Provider health (provider not down)
    4. Circuit breaker (not open for this worker type)
    │
    ▼
Rank by:
    1. Capability priority boost (from worker_capabilities table)
    2. Availability (fewer current tasks = higher rank)
    3. Success rate (historical task success/failure ratio)
    4. Area match (PM Engine area expertise, if available)
    │
    ▼
Assign top-ranked worker
```

**Multiple roles for the same capability** is expected and encouraged. It enables:
- **Failover:** If the primary model's provider is down, the secondary takes over
- **Cost optimization:** Use cheaper models for low-risk tasks, expensive models for high-risk
- **A/B testing:** Compare model performance on the same role over time
- **Specialization:** `security_reviewer` has `review.code` + `review.security`, so it gets assigned security-sensitive reviews
