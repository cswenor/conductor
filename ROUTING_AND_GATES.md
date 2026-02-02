# Routing and Gates

This document defines how Conductor decides what happens next (routing) and what must be true before proceeding (gates).

---

## Core Concepts

### Routing

**Routing** determines which agents participate in a run, in what order, and with what context.

Routing is:
- **Reproducible**: Same stored inputs → same agent graph (see Determinism Constraints below)
- **Logged**: Every routing decision is recorded with classifier outputs
- **Policy-bound**: Constrained by project and repo policies

**Determinism Constraints:**

Some routing inputs involve inference (e.g., "files likely affected", "sensitive paths predicted"). For reproducibility:

| Input Type | Determinism Approach |
|------------|---------------------|
| Issue content | Snapshotted at run start |
| Repo profile | Versioned config from DB |
| Policy config | `policy_set_id` locked at run start |
| Inference outputs | **Stored in RoutingDecision** (not re-computed on replay) |

Inference-based inputs (issue classification, scope estimation, sensitivity prediction) use:
- Fixed model version (locked per Conductor release)
- Temperature = 0
- Canonical prompt templates (versioned)
- **Output stored**: The classifier result is stored in `RoutingDecision.inputs`, so replay doesn't require re-running the model

### Gates

**Gates** are checkpoints that block forward progress until conditions are met.

Gates are:
- **Ternary evaluation**: `pending` (waiting), `passed` (proceed), `failed` (stop)
- **Binary terminal outcome**: A gate can be `pending` through multiple evaluations, but once it leaves `pending`, it resolves to either `passed` or `failed`—no partial credit
- **Auditable**: Every evaluation recorded with reasoning
- **Overridable**: By operators, with justification logged

```typescript
type GateStatus = 'pending' | 'passed' | 'failed';

interface GateResult {
  status: GateStatus;
  reason?: string;
  escalate?: boolean;  // Hint to surface in Approvals Inbox
}
```

Note: "Blocked" is a **run phase**, not a gate status. A run enters `blocked` when a gate fails and cannot be auto-retried.

**Blocking Semantics (canonical rule):** Tool-level blocks are local; run-level blocks happen only when no valid path forward exists (e.g., pre-push) or escalation triggers. Policy violations at `tool_invocation` fail the specific tool call (agent can adapt); violations at `pre_push` or failed gates block the run.

---

## Routing Engine

### Inputs to Routing

When a run starts, the routing engine considers:

| Input | Source | Example |
|-------|--------|---------|
| Issue content | GitHub | Title, body, labels |
| Repo profile | Conductor DB | `node-pnpm`, `python-pytest` |
| Files likely affected | PM agent / Planner inference | `src/auth/*`, `tests/` |
| Sensitive paths config | Policy config | `src/payments/`, `**/secrets.ts` |
| Past run history | Conductor DB | Previous failures on this issue |
| Project policies | Conductor DB | Required gates, agent constraints |

### Sensitive Path Handling

Sensitive paths are evaluated at two points:

| Check | When | Source | Effect |
|-------|------|--------|--------|
| **Predicted sensitivity** | Planning | PM agent / Planner inference | Force planning reviewer + human approval |
| **Actual sensitivity** | Pre-push | Git diff analysis | Hard policy check, may require additional human gate |

This split ensures:
- Planning gets extra scrutiny if sensitive paths *might* be touched
- Execution is hard-blocked if sensitive paths *are* touched without proper gates

### Routing Decision Record

Every run produces two records:

### Routing Decision (Immutable)

Captured at run start, never modified:

```typescript
interface RoutingDecision {
  run_id: string;
  decided_at: string;

  // What was considered at start
  inputs: {
    issue_type: 'bug' | 'feature' | 'refactor' | 'docs' | 'chore';
    estimated_scope: 'small' | 'medium' | 'large';
    sensitive_paths_predicted: boolean;  // From planner inference
    repo_profile: string;
    policy_overrides: string[];
  };

  // What was decided
  agent_graph: AgentNode[];
  required_gates: GateId[];
  optional_gates: GateId[];

  // Why
  reasoning: string;
}
```

### Execution Facts (Derived View)

`ExecutionFacts` is a **derived view**, not a stored mutable blob. It is computed from authoritative records:

```typescript
// ExecutionFacts is derived, not stored
interface ExecutionFacts {
  run_id: string;
  computed_at: string;  // When this view was generated

  // Derived from: latest git diff analysis (stored in tool_invocations)
  sensitive_paths_modified: boolean;
  files_actually_changed: string[];

  // Derived from: diff analysis + policy evaluation
  dependencies_added: string[];

  // Derived from: policy_violations table
  policy_violations: PolicyViolation[];

  // Derived from: routing rules applied to above facts
  additional_gates_required: GateId[];
}

// Derivation function (runs on demand, not stored)
function deriveExecutionFacts(run_id: string): ExecutionFacts {
  const diffAnalysis = getLatestDiffAnalysis(run_id);  // From tool_invocations
  const violations = getPolicyViolations(run_id);       // From policy_violations table
  const additionalGates = evaluateRoutingRules(diffAnalysis, violations);

  return {
    run_id,
    computed_at: new Date().toISOString(),
    sensitive_paths_modified: diffAnalysis.sensitive_paths.length > 0,
    files_actually_changed: diffAnalysis.files_changed,
    dependencies_added: diffAnalysis.dependencies_added,
    policy_violations: violations,
    additional_gates_required: additionalGates,
  };
}
```

**Why derived, not stored:**
- Authoritative data lives in `tool_invocations`, `policy_violations`, `artifacts`
- No "mutable blob" that can drift from source records
- Audit trail comes from the source tables, not a denormalized copy
- Orchestrator applies routing rules to derive additional gates on demand

interface AgentNode {
  id: string;                 // e.g., "planner-1", "reviewer-planning", "reviewer-code"
  agent: 'planner' | 'implementer' | 'reviewer' | 'tester';
  action: string;             // e.g., "create_plan", "review_plan", "review_code"
  phase: Phase;
  depends_on: string[];       // Node IDs, not nested objects
  context_sources: string[];  // What this agent will be given
}
```

Note: The same agent role (e.g., `reviewer`) can appear multiple times with different actions:
- `reviewer-planning`: Reviews the plan artifact
- `reviewer-code`: Reviews the implementation
```

### Default Agent Graph

For most runs, the default graph is:

```
┌──────────┐     ┌──────────┐     ┌─────────────┐
│ Planner  │────▶│ Reviewer │────▶│ Human Gate  │
└──────────┘     └──────────┘     │ (approval)  │
                                  └──────┬──────┘
                                         │
                                         ▼
                                  ┌─────────────┐
                                  │ Implementer │◀──┐
                                  └──────┬──────┘   │
                                         │          │
                                         ▼          │ (on failure)
                                  ┌─────────────┐   │
                                  │   Tester    │───┘
                                  └──────┬──────┘
                                         │
                                         ▼
                                  ┌─────────────┐
                                  │  Reviewer   │
                                  │ (code review)│
                                  └──────┬──────┘
                                         │
                                         ▼
                                  ┌─────────────┐
                                  │ Human Gate  │
                                  │ (PR merge)  │
                                  └─────────────┘
```

### Routing Variations

Routing adapts based on context:

| Condition | Routing Adjustment |
|-----------|-------------------|
| **Small scope** (< 3 files, no predicted sensitive paths, no policy-required gates) | Skip planning reviewer (code review still applies) |
| **Docs-only change** | Skip tester, simplified code review |
| **Sensitive path predicted** | Force planning reviewer + human plan approval |
| **Sensitive path modified** (diff-based) | Force pre-push policy check + sensitive change approval gate |
| **Security-related labels** | Add security-focused review pass |
| **Flaky test history** | Increase test retry limit |
| **Previous run failed** | Include failure context for agents |

### Routing Override Precedence (Normative)

Shortcuts (skip reviewer, skip tester) can only apply if higher-priority constraints are satisfied:

| Priority | Constraint | Effect |
|----------|------------|--------|
| 1 | Non-overridable policies (worktree scope, credentials) | **Always enforced** - cannot skip |
| 2 | Sensitive path predicted or modified | **Force gates** - cannot skip reviewer/approval |
| 3 | Project-required gates | **Force gates** - per project config |
| 4 | Repo-required gates | **Force gates** - per repo config |
| 5 | Dependency changes detected | **Force review** - cannot skip reviewer |
| 6 | Apply optimizations | Skip reviewer/tester per conditions above |

**Example evaluation:**

```typescript
function canSkipPlanningReviewer(run: Run, routingInputs: RoutingInputs): boolean {
  // Priority 1: Non-overridable policies - N/A for reviewer skip

  // Priority 2: Sensitive paths
  if (routingInputs.sensitive_paths_predicted) return false;

  // Priority 3: Project requires planning reviewer
  if (getProjectPolicy(run, 'gates.require_planning_reviewer')) return false;

  // Priority 4: Repo requires planning reviewer
  if (getRepoPolicy(run, 'gates.require_planning_reviewer')) return false;

  // Priority 5: Dependency changes detected (from PM agent inference)
  if (routingInputs.dependencies_likely_changed) return false;

  // Priority 6: Apply optimization if small scope
  return routingInputs.estimated_scope === 'small'
      && routingInputs.files_predicted.length < 3;
}
```

### Profile-Based Routing

Repo profiles influence routing:

| Profile | Tester Behavior | Reviewer Focus |
|---------|-----------------|----------------|
| `node-pnpm` | Run `pnpm test` | Check for type errors, lint |
| `python-pytest` | Run `pytest` | Check for type hints, style |
| `go-standard` | Run `go test ./...` | Check for error handling |
| `docs-only` | Skip tests | Check links, formatting |

### Routing Policy Configuration

```yaml
# Stored in Conductor DB
project: acme-platform
routing:
  # Default agent graph for this project
  default_agents:
    - planner
    - reviewer
    - implementer
    - tester

  # Conditions that modify routing
  rules:
    - condition: "sensitive_paths_predicted"
      action: "require_planning_reviewer"

    - condition: "sensitive_paths_modified"  # Checked at pre-push
      action: "require_human_gate_before_push"

    - condition: "scope == 'small' AND NOT sensitive_paths_predicted"
      action: "skip_planning_review"

    - condition: "labels CONTAINS 'security'"
      action: "add_security_review"

  # Path sensitivity
  sensitive_paths:
    - "src/payments/**"
    - "src/auth/**"
    - "**/secrets.*"
    - ".env*"
```

---

## Gate Definitions

### Gate: Plan Approval

**Purpose:** Human confirms the approach before implementation begins.

| Property | Value |
|----------|-------|
| **Trigger phase** | `awaiting_plan_approval` |
| **Required artifacts** | PLAN (from planner), REVIEW (from reviewer) |
| **Pass condition** | Operator clicks "Approve" in UI |
| **Fail condition** | Operator clicks "Reject" |
| **Pending condition** | No operator action yet |
| **Retry semantics** | On "Revise", returns to planning (counts as revision) |
| **Override** | N/A (this is already human-controlled) |
| **UX surface** | Approvals Inbox, Run Detail |
| **Timeout** | Configurable (default: 72 hours), reminder at 24 hours |

**Evaluation logic:**
```typescript
function evaluatePlanApproval(run: Run): GateResult {
  const plan = getValidArtifact(run, 'PLAN');  // Only validated artifacts
  const review = getValidArtifact(run, 'REVIEW');

  if (!plan || !review) {
    return { status: 'pending', reason: 'Awaiting required artifacts (PLAN, REVIEW)' };
  }

  if (review.verdict === 'CHANGES_REQUESTED') {
    return { status: 'pending', reason: 'Review requested changes' };
  }

  // Check for operator action using canonical action types from protocol
  // OperatorActionType: 'approve_plan' | 'revise_plan' | 'reject_run' | ...
  const approveAction = getOperatorAction(run, 'approve_plan');
  const rejectAction = getOperatorAction(run, 'reject_run');

  if (approveAction) {
    return { status: 'passed' };
  }

  if (rejectAction) {
    return { status: 'failed', reason: rejectAction.comment || 'Plan rejected' };
  }

  // No action yet
  return { status: 'pending', reason: 'Awaiting operator approval' };
}
```

---

### Gate: Tests Pass

**Purpose:** Code changes don't break existing functionality.

| Property | Value |
|----------|-------|
| **Trigger phase** | `executing` (after implementation) |
| **Required artifacts** | TEST_REPORT (from tester/implementer) |
| **Pass condition** | TEST_REPORT.result === 'PASS' |
| **Fail condition** | TEST_REPORT.result === 'FAIL' after max retries |
| **Pending condition** | Tests running or retry in progress |
| **Retry semantics** | Auto-retry up to limit; implementer attempts fix |
| **Override** | Operator can "Skip Tests" with justification (logged) |
| **UX surface** | Run Detail (inline), Approvals Inbox (on escalation) |
| **Timeout** | Configurable per test suite (default: 15 minutes) |

**Evaluation logic:**
```typescript
function evaluateTestsPass(run: Run): GateResult {
  const report = getLatestArtifact(run, 'TEST_REPORT');

  if (!report) {
    return { status: 'pending', reason: 'Tests not yet run' };
  }

  if (report.result === 'PASS') {
    return { status: 'passed' };
  }

  // Check retry count
  const attempts = run.iterations.test_fix_attempts;
  const maxAttempts = getPolicy(run, 'limits.test_fix_attempts');

  if (attempts < maxAttempts) {
    return { status: 'pending', reason: `Retry ${attempts}/${maxAttempts}` };
  }

  return {
    status: 'failed',
    reason: `Tests failed after ${maxAttempts} attempts`,
    escalate: true
  };
}
```

---

### Gate: Code Review Approval

**Purpose:** Agent-generated code meets quality standards.

| Property | Value |
|----------|-------|
| **Trigger phase** | `executing` (after tests pass) |
| **Required artifacts** | REVIEW (from reviewer, on code) |
| **Pass condition** | REVIEW.verdict === 'APPROVED' |
| **Fail condition** | REVIEW.verdict === 'CHANGES_REQUESTED' after max rounds |
| **Pending condition** | Review in progress or fix iteration ongoing |
| **Retry semantics** | Implementer addresses feedback, reviewer re-reviews |
| **Override** | Operator can "Accept with Issues" (logged) |
| **UX surface** | Run Detail |
| **Max rounds** | Configurable (default: 3) |

**Evaluation logic:**
```typescript
function evaluateCodeReview(run: Run): GateResult {
  const review = getLatestArtifact(run, 'REVIEW', { on: 'code' });

  if (!review) {
    return { status: 'pending', reason: 'Review not yet complete' };
  }

  if (review.verdict === 'APPROVED') {
    return { status: 'passed' };
  }

  const rounds = run.iterations.review_rounds;
  const maxRounds = getPolicy(run, 'limits.review_rounds');

  if (rounds < maxRounds) {
    return { status: 'pending', reason: `Addressing feedback (round ${rounds})` };
  }

  return {
    status: 'failed',
    reason: `Review issues not resolved after ${maxRounds} rounds`,
    escalate: true
  };
}
```

---

### PR Merge Wait (Event-Driven)

**Purpose:** Wait for human to merge or close PR in GitHub.

Unlike other gates, this is **event-driven**, not continuously evaluated. The run waits in `awaiting_review` phase until a GitHub webhook indicates the PR state changed.

| Property | Value |
|----------|-------|
| **Phase** | `awaiting_review` |
| **Required artifacts** | PR created |
| **Proceed condition** | Webhook: PR merged |
| **Fail condition** | Webhook: PR closed without merge |
| **Return to execution** | Webhook: changes requested (derived from review state) |
| **Override** | N/A (human-controlled in GitHub) |
| **UX surface** | Run Detail, PR Review Assist |
| **Timeout** | None (waits indefinitely for webhook) |

**Event handling (Two-Stage Model):**

Per Protocol invariants, webhooks persist fact events; only orchestrator emits decision events.

```typescript
// Stage 1: Webhook handler (limited authority)
// Persists fact event, does NOT return phase transition
async function handlePRWebhook(payload: PRWebhookPayload): Promise<void> {
  // Compare using node_id (stable), not PR number
  const run = await findRunByPRNodeId(payload.pull_request.node_id);
  if (!run) return;

  // Persist fact event (webhook handler authority)
  await emitEvent({
    type: `github_webhook:pull_request.${payload.action}`,
    class: 'fact',  // NOT decision
    source: 'github_webhook',
    run_id: run.run_id,
    payload: {
      pr_node_id: payload.pull_request.node_id,
      action: payload.action,
      merged: payload.pull_request.merged,
      // ... other fields
    },
  });
}

// Stage 2: Orchestrator consumes fact and emits decision
// (runs in orchestrator's event processing loop)
function derivePhaseTransitionFromPREvent(
  event: Event,
  run: Run
): PhaseTransitionedPayload | null {
  if (!event.type.startsWith('github_webhook:pull_request.')) return null;

  // Verify PR identity using node_id (not PR number)
  if (event.payload.pr_node_id !== run.pr_node_id) return null;

  switch (event.payload.action) {
    case 'closed':
      if (event.payload.merged) {
        return {
          from: run.phase,
          to: 'completed',
          reason: 'PR merged',
          trigger: { type: 'github_webhook', ref: event.event_id },
        };
      } else {
        return {
          from: run.phase,
          to: 'cancelled',
          reason: 'PR closed without merge',
          trigger: { type: 'github_webhook', ref: event.event_id },
        };
      }

    case 'review_submitted':
      // changes_requested derived from review state
      if (event.payload.review_state === 'changes_requested') {
        return {
          from: run.phase,
          to: 'executing',
          reason: 'Changes requested on PR',
          trigger: { type: 'github_webhook', ref: event.event_id },
        };
      }
      return null;  // Approval or comment, no phase change

    default:
      return null;
  }
}
```

Note: `changes_requested` is derived by GitHub Integration from the PR's review states and required checks—it's not a single boolean field in GitHub's API.

**Source of Truth:**
- Conductor DB phase is authoritative
- PR webhooks persist fact events (idempotently—delivery retries are safe)
- Orchestrator emits decision events that update projection
- UI reads from DB
- GitHub is the trigger source, not the authority

---

## Policy Engine

Policy enforcement is **continuous**, not a gate. The Policy Engine runs as a guardrail throughout execution.

### How Policy Engine Works

The Policy Engine evaluates:
- **Tool invocations**: Before MCP tools execute (file writes, GitHub writes, shell commands)
- **Diff inspection**: Before pushing commits
- **Artifact validation**: When artifacts are produced

```typescript
interface PolicyCheck {
  policy_id: string;
  check_point: 'tool_invocation' | 'pre_push' | 'artifact_validation';
  result: 'allowed' | 'blocked';
  violation?: PolicyViolation;
}

interface PolicyViolation {
  policy_id: string;
  description: string;
  severity: 'warning' | 'blocking';
  evidence: string;  // What triggered the violation
}
```

### Policy Types

| Policy | Check Point | Violation Example |
|--------|-------------|-------------------|
| `no_secrets_in_code` | pre_push | Agent wrote hardcoded API key |
| `require_tests` | artifact_validation | No TEST_REPORT for code changes |
| `sensitive_path_protection` | pre_push | Modified `src/payments/` without flag |
| `max_file_changes` | pre_push | Diff includes > 20 files |
| `no_dependency_changes` | pre_push | Added new npm package |
| `no_force_push` | tool_invocation | Agent attempted force push |

### When Violations Occur

- **Warning**: Logged, run continues, surfaced in Run Detail
- **Blocking**: Orchestrator transitions run to `blocked` phase via event

**Phase Handling (Event-Driven):**

Per Protocol invariants, phase changes occur **only** via orchestrator-emitted events. Policy violations follow this pattern:

```typescript
// Step 1: Policy Engine detects blocking violation
// Emits a fact/signal event (does NOT mutate run.phase)
await emitEvent({
  type: 'policy.violation_blocking',
  class: 'fact',
  run_id: run.run_id,
  payload: {
    policy_id: violation.policy_id,
    violation_id: violation.violation_id,
    prior_phase: run.phase,
  },
});

// Step 2: Orchestrator consumes the event and emits decision
// (in orchestrator's event processing loop)
await emitEvent({
  type: 'phase.transitioned',
  class: 'decision',
  run_id: run.run_id,
  causation_id: violationEvent.event_id,
  payload: {
    from: run.phase,
    to: 'blocked',
    reason: 'policy_exception_required',
    trigger: { type: 'policy_violation', ref: violation.violation_id },
    blocked_context: { prior_phase: run.phase },
  },
});

// Step 3: Projection update (same transaction as decision event)
// runs.phase = 'blocked', runs.blocked_context populated

// Step 4: On operator resolution (grant or deny exception)
// Orchestrator emits another phase.transitioned event
await emitEvent({
  type: 'phase.transitioned',
  class: 'decision',
  run_id: run.run_id,
  causation_id: operatorActionEvent.event_id,
  payload: {
    from: 'blocked',
    to: exception.decision === 'allow' ? blockedContext.prior_phase : 'cancelled',
    reason: exception.decision === 'allow' ? 'policy_exception_granted' : 'policy_exception_denied',
    trigger: { type: 'operator_action', ref: operatorAction.operator_action_id },
  },
});
```

This keeps the phase model simple—`blocked` with contextual reason, resolved via Approvals Inbox—while respecting the event-driven state machine.

---

### Gate: Sensitive Change Approval

**Purpose:** Human confirms that changes to sensitive paths are intentional and reviewed before PR creation.

This gate is triggered dynamically when diff analysis (at pre-push) detects modifications to sensitive paths.

| Property | Value |
|----------|-------|
| **Trigger** | Diff analysis detects `sensitive_paths_modified: true` |
| **Phase** | `executing` (after implementation, before `create_pr` step) |
| **Step** | `wait_sensitive_approval` (new step between implementation and PR creation) |
| **Required inputs** | Diff summary, policy report, list of sensitive files modified |
| **Pass condition** | Operator clicks "Approve Sensitive Changes" in UI |
| **Fail condition** | Operator clicks "Reject" or cancels run |
| **Pending condition** | Awaiting operator decision |
| **Override** | N/A (this is already human-controlled) |
| **UX surface** | Approvals Inbox, Run Detail (highlighted warning) |

**When it appears:**

```
┌─────────────────────┐
│   Implementation    │
└──────────┬──────────┘
           │
           ▼
┌─────────────────────┐
│   Pre-push diff     │  ← Diff analysis runs here
│     analysis        │
└──────────┬──────────┘
           │
     ┌─────┴─────┐
     │           │
     ▼           ▼
  No sensitive   Sensitive paths
  paths modified modified
     │           │
     │           ▼
     │    ┌─────────────────────┐
     │    │ Sensitive Change    │  ← NEW GATE
     │    │ Approval (human)    │
     │    └──────────┬──────────┘
     │               │
     └───────┬───────┘
             │
             ▼
┌─────────────────────┐
│     Create PR       │
└─────────────────────┘
```

**Evaluation logic:**
```typescript
function evaluateSensitiveChangeApproval(run: Run): GateResult {
  const facts = deriveExecutionFacts(run.run_id);

  // Gate only applies if sensitive paths were modified
  if (!facts.sensitive_paths_modified) {
    return { status: 'passed', reason: 'No sensitive paths modified' };
  }

  // Check for operator action
  const approveAction = getOperatorAction(run, 'approve_sensitive_changes');
  const rejectAction = getOperatorAction(run, 'reject_run');

  if (approveAction) {
    return { status: 'passed' };
  }

  if (rejectAction) {
    return { status: 'failed', reason: rejectAction.comment || 'Sensitive changes rejected' };
  }

  return {
    status: 'pending',
    reason: 'Awaiting approval for sensitive path modifications',
    escalate: true,  // Surface in Approvals Inbox
  };
}
```

**Evidence provided to operator:**
- List of sensitive files modified
- Diff summary for each sensitive file
- Policy that flagged these paths as sensitive
- Link to full diff in Run Detail

---

### Gate: Policy Exception

**Purpose:** Human decides whether to allow a blocked policy violation.

This gate only appears when the Policy Engine blocks progress.

| Property | Value |
|----------|-------|
| **Trigger** | Policy Engine emits blocking violation |
| **Required artifacts** | PolicyViolation record |
| **Pass condition** | Operator grants exception |
| **Fail condition** | Operator denies exception |
| **Pending condition** | Awaiting operator decision |
| **Override scope** | `this_run`, `this_task`, `this_repo`, `project_wide` |
| **UX surface** | Approvals Inbox (exception requests) |

**Evaluation logic:**
```typescript
function evaluatePolicyException(run: Run, violation: PolicyViolation): GateResult {
  // Check for operator actions using canonical action types
  // OperatorActionType: 'grant_policy_exception' | 'deny_policy_exception' | ...
  const grantAction = getOperatorActionForViolation(run, 'grant_policy_exception', violation.violation_id);
  const denyAction = getOperatorActionForViolation(run, 'deny_policy_exception', violation.violation_id);

  if (grantAction) {
    return { status: 'passed' };
  }

  if (denyAction) {
    return { status: 'failed', reason: denyAction.comment || 'Exception denied' };
  }

  return { status: 'pending', reason: `Awaiting decision on ${violation.policy_id}` };
}
```

---

## Retry and Escalation Policy

### Retry Limits

| Situation | Max Retries | After Limit |
|-----------|-------------|-------------|
| Plan revision (planner ↔ reviewer) | 3 | Escalate to human |
| Test fix (implementer ↔ tester) | 3 | Block run, escalate |
| Code review fix (implementer ↔ reviewer) | 3 | Block run, escalate |
| Transient errors (network, timeout) | 3 | Block run, alert operator |
| Agent errors (invalid output) | 1 | Block run, escalate |

### What Resets Retry Counters

Counters reset **only on explicit operator actions**, not on feedback alone:

| Operator Action | Resets |
|-----------------|--------|
| **Approve Plan** | Plan revision counter (loop ends) |
| **Revise Plan** (with feedback) | Nothing (counts as another revision) |
| **Retry Phase** | All counters for that phase |
| **Start New Run** | All counters (fresh run) |

Human feedback attached to Revise/Retry actions provides context to agents but does **not** independently reset counters. This prevents infinite loops from well-meaning but ineffective feedback.

### Escalation Triggers

A run escalates to human (enters `blocked` + appears in Approvals Inbox) when:

1. **Retry limit exceeded** for any gate
2. **Agent explicitly escalates** (question, uncertainty)
3. **Policy violation** detected
4. **Timeout** (agent or gate)
5. **Unhandled error** (system, infrastructure)

### Escalation Record

```typescript
interface Escalation {
  run_id: string;
  escalated_at: string;
  reason: EscalationReason;

  // Context for human
  summary: string;
  what_was_tried: string[];
  suggested_actions: string[];

  // Links
  relevant_artifacts: string[];
  relevant_logs: string;

  // Resolution
  resolved_at?: string;
  resolution: 'retry' | 'cancel' | 'override' | 'manual_fix';
  operator: string;
  comment?: string;
}
```

---

## Overrides

Operators can override gates and authorize policy exceptions. All overrides are logged.

### Override Taxonomy

| Type | What It Does | Example | Audit Semantics |
|------|--------------|---------|-----------------|
| **Gate Override** | Forces a gate outcome | Skip tests, accept code with issues | "Gate X was overridden" |
| **Policy Exception** | Authorizes a policy violation | Allow dependency change, allow sensitive path edit | "Policy Y was excepted" |

Both appear in Approvals Inbox and have similar UX (decision + justification), but they're tracked separately for compliance reporting.

### Override Types

| Override | When Available | Justification Required |
|----------|----------------|------------------------|
| **Skip Tests** | Tests failing, want to proceed | Yes |
| **Accept with Issues** | Code review has unresolved items | Yes |
| **Grant Policy Exception** | Policy blocks action | Yes |
| **Force Retry** | Beyond retry limit | No (but logged) |
| **Bypass Planning Review** | Small/urgent change | Yes |

### Override Record

Gate status remains **ternary** (`pending | passed | failed`). There is no "skipped" status.

When an operator skips a gate, it is recorded as `passed` with an override reason:

```typescript
interface Override {
  override_id: string;
  run_id: string;
  gate_id: string;

  operator: string;
  timestamp: string;

  // What was overridden
  original_status: 'failed' | 'pending';  // What status the gate had before override

  // Result is always 'passed' (gate status remains ternary)
  // The override_kind captures the semantic meaning
  override_kind: 'skip_tests' | 'accept_with_issues' | 'grant_policy_exception' | 'force_retry' | 'bypass_planning_review';

  // Why
  justification: string;

  // Scope
  scope: 'this_run' | 'this_task' | 'this_repo' | 'project_wide';
}
```

**Gate status after override:**

| Override Kind | Gate Status | GateEvaluation.reason |
|---------------|-------------|----------------------|
| `skip_tests` | `passed` | `"overridden: skip_tests by @operator"` |
| `accept_with_issues` | `passed` | `"overridden: accept_with_issues by @operator"` |
| `grant_policy_exception` | `passed` | `"overridden: policy_exception by @operator"` |

This keeps gate evaluation queries simple (filter by `status = 'passed'`) while preserving full audit trail of overrides.

### Override Audit

Overrides are:
1. **Stored in DB** with full context
2. **Mirrored to GitHub** as audit comment
3. **Visible in Run Detail** with warning indicator
4. **Surfaced in reports** for compliance review

### What Cannot Be Overridden (v1)

| Constraint | Why |
|------------|-----|
| Human merge gate | Fundamental trust boundary |
| Credential exposure | Security non-negotiable |
| Run cancellation by other operators | Conflict prevention |

---

## Artifact Validation

Before any gate uses an artifact, the artifact must pass validation. Invalid artifacts are treated as agent errors.

**Where it runs:** Artifact validation runs in **Conductor Core**, not in agent-land. Agents produce artifacts; Conductor validates them.

**What it blocks:** Gates **only read validated artifacts**. Validation failure prevents gate evaluation entirely.

### Artifact Validation Status

Artifacts have a validation status that gates MUST check:

```typescript
type ArtifactValidationStatus = 'pending' | 'valid' | 'invalid';

interface Artifact {
  artifact_id: string;
  run_id: string;
  type: 'PLAN' | 'TEST_REPORT' | 'REVIEW';
  version: number;
  content: string;

  // Validation status (REQUIRED for gate evaluation)
  validation_status: ArtifactValidationStatus;
  validation_errors?: string[];
  validated_at?: string;
}
```

**Gate evaluation rule:** `getValidArtifact()` returns only artifacts where `validation_status = 'valid'`. Pending or invalid artifacts are not visible to gate evaluation.

```typescript
function getValidArtifact(run: Run, type: ArtifactType): Artifact | null {
  return db.query(`
    SELECT * FROM artifacts
    WHERE run_id = ? AND type = ? AND validation_status = 'valid'
    ORDER BY version DESC
    LIMIT 1
  `, [run.run_id, type]);
}
```

### Validation Requirements

| Artifact | Required Sections | Validation Rules |
|----------|-------------------|------------------|
| **PLAN** | Goal, Approach, Files, Risks | Files referenced must exist in repo |
| **TEST_REPORT** | Summary, Result | Result must match exit code truth |
| **REVIEW** | Summary, Verdict, Findings | Line numbers must exist in referenced files |

### Validation Flow

```
Agent produces artifact
        │
        ▼
┌──────────────────┐
│ Insert artifact   │  validation_status = 'pending'
└────────┬─────────┘
         │
         ▼
┌──────────────────┐
│ Schema validation │  (Required sections present?)
└────────┬─────────┘
         │
         ▼
┌──────────────────┐
│ Reference check   │  (Files/lines exist?)
└────────┬─────────┘
         │
         ▼
┌──────────────────┐
│ Truth check       │  (TEST_REPORT matches exit code?)
└────────┬─────────┘
         │
    ┌────┴────┐
    ▼         ▼
 Valid     Invalid
    │         │
    ▼         ▼
┌──────────────────┐  ┌──────────────────┐
│ validation_status │  │ validation_status │
│     = 'valid'     │  │    = 'invalid'   │
└────────┬─────────┘  └────────┬─────────┘
         │                     │
         ▼                     ▼
  Gate evaluates        Agent retry
  (can see artifact)    (once, then block)
```

### Validation Event

Validation status changes are events:

```typescript
// Emitted when validation completes
await emitEvent({
  type: 'artifact.validated',
  class: 'decision',  // Validation is a Conductor decision
  run_id: artifact.run_id,
  payload: {
    artifact_id: artifact.artifact_id,
    artifact_type: artifact.type,
    validation_status: 'valid' | 'invalid',
    validation_errors: errors,
  },
});
```

### Race Prevention

The validation status prevents races:

| Scenario | Behavior |
|----------|----------|
| Gate evaluates before validation completes | `getValidArtifact()` returns null → gate stays pending |
| Retry writes v2 while validator on v1 | Each version validated independently |
| Validation fails, agent retries | New version (v2) with `pending` status, v1 remains `invalid` |

### Invalid Artifact Handling

```typescript
// On invalid artifact:
// 1. Log validation errors
// 2. Emit artifact.validated event with status='invalid'
// 3. Retry agent once with error context
// 4. If still invalid, block run and escalate
```

---

## Gate Execution Model

### Who Runs Tests?

Tests are run by the **Tester agent** (or Implementer if no separate Tester):

1. Agent invokes test command via MCP shell tool
2. Command runs in isolated worktree
3. Output captured by Conductor
4. Agent parses output into TEST_REPORT artifact
5. Gate engine evaluates TEST_REPORT

### Test Truth Guarantees

To prevent hallucinated test results:

| Control | Implementation |
|---------|----------------|
| **Tests run in worktree** | Not in agent's imagination |
| **Output captured verbatim** | Stored with TEST_REPORT |
| **Exit code checked** | Agent cannot fake pass |
| **Output hash stored** | Tamper detection |
| **Re-runnable** | Operator can trigger manual re-run |

```typescript
interface TestExecution {
  run_id: string;
  command: string;
  exit_code: number;
  stdout: string;
  stderr: string;
  duration_ms: number;
  output_hash: string;  // SHA256 of stdout+stderr

  // Agent's interpretation (may differ from truth)
  agent_interpretation: TEST_REPORT;

  // Ground truth
  actual_passed: boolean;  // Based on exit code
}
```

If `agent_interpretation.result` differs from `actual_passed`, the gate engine uses `actual_passed`.

### Review Artifact Validation

Code reviews are agent-generated. To ensure quality:

| Control | Implementation |
|---------|----------------|
| **Review references real files** | Validated against worktree |
| **Line numbers exist** | Checked against actual file |
| **Issues are actionable** | Structured format enforced |

---

## Gate Evaluation Flow

```
┌──────────────────┐
│  Phase Complete  │
└────────┬─────────┘
         │
         ▼
┌──────────────────┐
│  Identify Gates  │  (From routing decision)
└────────┬─────────┘
         │
         ▼
┌──────────────────┐
│  Collect Inputs  │  (Artifacts, actions, state)
└────────┬─────────┘
         │
         ▼
┌──────────────────┐     ┌─────────────────┐
│  Evaluate Gate   │────▶│  status: passed │──▶ Proceed
└────────┬─────────┘     └─────────────────┘
         │
         │               ┌─────────────────┐
         └──────────────▶│ status: pending │──▶ Wait
                         └─────────────────┘
         │
         │               ┌─────────────────┐
         └──────────────▶│ status: failed  │──▶ Check retry
                         └────────┬────────┘
                                  │
                    ┌─────────────┴─────────────┐
                    ▼                           ▼
             ┌────────────┐              ┌────────────┐
             │ Can retry  │              │ Max retry  │
             └─────┬──────┘              └─────┬──────┘
                   │                           │
                   ▼                           ▼
             ┌────────────┐              ┌────────────┐
             │   Retry    │              │  Escalate  │
             └────────────┘              └────────────┘
```

---

## Configuration Reference

### Project-Level Gate Configuration

```yaml
project: acme-platform
gates:
  plan_approval:
    required: true
    timeout_hours: 72
    reminder_hours: 24

  tests_pass:
    required: true
    max_retries: 3
    timeout_minutes: 15
    allow_skip: false  # Can operator skip?

  code_review:
    required: true
    max_rounds: 3
    allow_accept_with_issues: true

  merge_wait:
    required: true  # Always required (human merge is non-negotiable)
```

### Per-Repo Overrides

```yaml
repo: acme/scripts
gates:
  tests_pass:
    required: false  # No tests in this repo
  code_review:
    max_rounds: 1    # Simpler review for scripts
```

---

## Further Reading

- [PROTOCOL.md](PROTOCOL.md) — State machine and event schemas
- [CONTROL_PLANE_UX.md](CONTROL_PLANE_UX.md) — How operators interact with gates
- [ARCHITECTURE.md](ARCHITECTURE.md) — System components
- [DATA_MODEL.md](DATA_MODEL.md) — Database schema for routing and gates
- [POLICIES.md](POLICIES.md) — Policy engine, enforcement points, redaction strategy
