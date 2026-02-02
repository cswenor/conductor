# Policies

This document defines Conductor's policy system: what policies exist, how they're enforced, when they're evaluated, and how violations are handled. It also covers the redaction strategy for sensitive data in logs and audit trails.

---

## Core Principles

### Policies Are Guardrails, Not Gates

Policies enforce **continuous constraints** throughout execution. Unlike gates (which block at specific checkpoints), policies can trigger at any moment when an agent attempts a prohibited action.

| Concept | Evaluation | Trigger |
|---------|------------|---------|
| **Gate** | At phase boundaries | Phase completion |
| **Policy** | On every tool invocation, pre-push, artifact validation | Any time |

### Policies Are Defense in Depth

Policies don't trust agents. Even if an agent is prompted to "never commit secrets," the policy engine independently verifies this before any commit is pushed.

### Violations Are Explicit

Every policy violation is:
- **Logged** in the database with evidence
- **Attributed** to a specific tool invocation or action
- **Either resolved or escalated**—never silently ignored

---

## Policy Enforcement Points

Policies are evaluated at three points in the execution flow:

```
Agent invokes tool
       │
       ▼
┌──────────────────┐
│ tool_invocation  │  ← Pre-execution check
└────────┬─────────┘
         │
    [Tool executes]
         │
         ▼
┌──────────────────┐
│    pre_push      │  ← Before git push
└────────┬─────────┘
         │
         ▼
┌──────────────────┐
│artifact_validation│  ← When artifacts produced
└──────────────────┘
```

### Tool Invocation (Pre-Execution)

Evaluated **before** MCP tools execute. Can block the individual tool call.

**What's checked:**
- Target path within allowed scope
- No writes to protected paths
- No execution of prohibited commands
- No attempts to access secrets

**If blocked:** Tool does not execute. Agent receives error. Logged as violation.

**Important:** Blocking a single tool invocation does **not** block the run. The agent may:
- Retry with different parameters
- Choose an alternative approach
- Ask for clarification

The run only transitions to `blocked` phase when the agent exhausts retry attempts or escalates.

### Pre-Push

Evaluated **before** Conductor pushes a branch to GitHub. Examines the actual diff.

**What's checked:**
- No secrets in committed code
- No changes to protected files
- File count within limits
- No prohibited dependencies added

**If blocked:** Push does not occur. Unlike tool invocation blocks, a pre-push block **does transition the run to `blocked` phase** because the agent has already committed changes—there's no alternative path forward without human decision.

The orchestrator receives a `policy.pre_push_blocked` event and transitions the run phase accordingly.

### Artifact Validation

Evaluated **when** an agent produces a structured artifact (PLAN, TEST_REPORT, REVIEW).

**What's checked:**
- Required sections present
- References resolve (files exist, line numbers valid)
- No hallucinated results (TEST_REPORT matches exit code)

**If invalid:** Artifact rejected. Agent retries once, then run blocks.

### Blocking Semantics

**Canonical rule:** Tool-level blocks are local; run-level blocks happen only when no valid path forward exists (e.g., pre-push) or escalation triggers.

- **tool_invocation** blocks: The specific tool call fails. Agent receives error and can attempt alternative approaches.
- **pre_push** blocks: The run cannot proceed. Transitions to `blocked` phase.
- **artifact_validation** blocks: Agent retries once. If retry fails, run transitions to `blocked` phase.

---

## Policy Types

### File Scope Policies

Control where agents can read and write.

| Policy | Enforcement Point | Description |
|--------|-------------------|-------------|
| `worktree_scope` | tool_invocation | Writes only within run worktree |
| `sensitive_path_protection` | tool_invocation, pre_push | Extra gates for sensitive paths |
| `protected_files` | tool_invocation | Never modify certain files |
| `max_file_changes` | pre_push | Limit files changed per run |

```typescript
interface FileScopePolicy {
  policy_id: 'worktree_scope' | 'sensitive_path_protection' | 'protected_files' | 'max_file_changes';

  // For sensitive_path_protection
  sensitive_patterns?: string[];  // Glob patterns

  // For protected_files
  protected_patterns?: string[];  // Glob patterns (e.g., "*.lock", ".env*")

  // For max_file_changes
  max_files?: number;  // Default: 20
}
```

### Secret Detection Policies

Prevent secrets from being committed or logged.

| Policy | Enforcement Point | Description |
|--------|-------------------|-------------|
| `no_secrets_in_code` | pre_push | Scan diff for API keys, tokens, credentials |
| `no_secrets_in_logs` | tool_invocation | Redact secrets from tool output |
| `no_env_file_commits` | pre_push | Never commit .env files |

```typescript
interface SecretDetectionPolicy {
  policy_id: 'no_secrets_in_code' | 'no_secrets_in_logs' | 'no_env_file_commits';

  // Detection patterns (built-in defaults + custom)
  patterns?: SecretPattern[];

  // Entropy threshold for high-entropy string detection
  entropy_threshold?: number;  // Default: 4.5
}

interface SecretPattern {
  name: string;
  regex: string;
  severity: 'warning' | 'blocking';
}
```

**Built-in patterns:**
- AWS access keys (`AKIA[0-9A-Z]{16}`)
- GitHub tokens (`ghp_[a-zA-Z0-9]{36}`)
- Generic API keys (`api[_-]?key[_-]?[:=]\s*['"]?[a-zA-Z0-9]{20,}`)
- Private keys (`-----BEGIN.*PRIVATE KEY-----`)
- High-entropy strings (> threshold bits per character)

### Execution Policies

Control what agents can run.

| Policy | Enforcement Point | Description |
|--------|-------------------|-------------|
| `allowed_commands` | tool_invocation | Allowlist for commands |
| `blocked_commands` | tool_invocation | Denylist for dangerous commands |
| `no_network_access` | tool_invocation | Block curl, wget, etc. (configurable) |
| `no_force_push` | tool_invocation | Block git push --force |
| `no_shell` | tool_invocation | Enforce argv-style execution |

#### Command Specification

Commands are specified using `CommandSpec`, which enforces safe execution by default:

```typescript
interface CommandSpec {
  // The executable (resolved against PATH)
  command: string;  // e.g., "pnpm", "git", "pytest"

  // Arguments as array (NOT a shell string)
  args: string[];  // e.g., ["test", "--coverage"]

  // Shell execution (default: false)
  uses_shell: boolean;

  // Working directory (must be within worktree)
  cwd: string;

  // Environment variables (merged with safe defaults)
  env?: Record<string, string>;
}
```

**Shell Execution Rules:**

| `uses_shell` | Execution Method | Risk Level |
|--------------|------------------|------------|
| `false` (default) | `execFile(command, args)` | Low - no shell injection |
| `true` | `exec(command + args.join(' '))` | High - requires explicit allowlist |

**Important:** When `uses_shell: false`, the command and args are passed directly to the OS without shell interpretation. This prevents:
- Shell injection via `; rm -rf /`
- Environment variable expansion `$SECRET`
- Glob expansion `*.js`
- Pipe/redirect operators `| sh`, `> /etc/passwd`

Commands requiring shell features (pipes, redirects) must be explicitly allowlisted with `uses_shell: true`.

```typescript
interface ExecutionPolicy {
  policy_id: 'allowed_commands' | 'blocked_commands' | 'no_network_access' | 'no_force_push' | 'no_shell';

  // For allowed_commands (if set, only these are allowed)
  // Format: "command:arg_pattern" or just "command"
  allowed?: string[];  // e.g., ["pnpm:test", "pnpm:test:*", "git:status"]

  // For blocked_commands (these are always denied)
  blocked?: string[];  // Command patterns

  // For no_network_access (configurable exceptions)
  network_exceptions?: string[];  // Allowed hosts

  // For no_shell: commands that MAY use shell (default: none)
  shell_allowed?: string[];  // Must be explicit
}
```

**Default blocked commands:**
- `rm -rf /` (and variants)
- `git push --force` (to main/master)
- `sudo` (any)
- `chmod 777` (any)
- Any command with `uses_shell: true` unless explicitly allowlisted

### Dependency Policies

Control what dependencies agents can add.

| Policy | Enforcement Point | Description |
|--------|-------------------|-------------|
| `no_dependency_changes` | pre_push | Flag or block new dependencies |
| `allowed_dependencies` | pre_push | Allowlist for packages |
| `blocked_dependencies` | pre_push | Denylist for packages |

```typescript
interface DependencyPolicy {
  policy_id: 'no_dependency_changes' | 'allowed_dependencies' | 'blocked_dependencies';

  // Severity when triggered
  severity: 'warning' | 'blocking';

  // For *_dependencies policies
  packages?: string[];
}
```

### Quality Policies

Ensure agent output meets standards.

| Policy | Enforcement Point | Description |
|--------|-------------------|-------------|
| `require_tests` | pre_push | Must have TEST_REPORT for code changes |
| `test_coverage_threshold` | artifact_validation | Minimum coverage percentage |
| `no_console_logs` | pre_push | Remove debug statements |

---

## Severity Levels

Every policy has a severity that determines handling:

| Severity | Behavior | Action Impact | Run Impact | GitHub Mirror |
|----------|----------|---------------|------------|---------------|
| `warning` | Logged, action continues | None | None (until threshold) | Optional |
| `blocking` | Logged, action denied | Action fails | Depends on enforcement point | Yes (always) |

### Action Blocked vs Run Blocked

These are distinct concepts:

| Enforcement Point | Action Blocked | Run Blocked |
|-------------------|----------------|-------------|
| `tool_invocation` | Tool call fails | No (agent can retry) |
| `pre_push` | Push fails | Yes (requires exception) |
| `artifact_validation` | Artifact rejected | After retry exhaustion |

**Action blocked** means the specific operation was denied. **Run blocked** means the run transitions to `blocked` phase and requires human intervention.

### Warning Escalation

Warnings don't stop runs, but accumulation triggers escalation:

```typescript
interface WarningThreshold {
  max_warnings_per_run: number;      // Default: 10
  max_warnings_per_policy: number;   // Default: 3
  escalate_on_threshold: boolean;    // Default: true
}
```

When threshold is exceeded, the policy engine emits a `policy.warning_threshold_exceeded` event. The orchestrator receives this and transitions the run to `blocked` with `blocked_reason: 'warning_threshold_exceeded'`.

```typescript
// Policy engine does NOT mutate run phase directly
function checkWarningThreshold(run_id: string, policy_set_id: string): void {
  const warnings = getWarnings(run_id);
  const config = getWarningThreshold(run_id);

  if (warnings.length >= config.max_warnings_per_run) {
    // Emit event for orchestrator
    emitEvent({
      type: 'policy.warning_threshold_exceeded',
      run_id,
      payload: {
        policy_set_id,
        warning_count: warnings.length,
        threshold: config.max_warnings_per_run,
        threshold_type: 'per_run',
      },
    });
  }
}
```

---

## Policy Evaluation Flow

### Tool Invocation Check

```typescript
interface ToolInvocationCheck {
  tool: string;
  target?: string;
  args: Record<string, any>;
  worktree_path: string;
  run_id: string;
}

function evaluatePolicies(check: ToolInvocationCheck): PolicyResult {
  const violations: PolicyViolation[] = [];

  // Get current policy set (captures version for audit)
  const policySet = getActivePolicySet(check.run_id);

  for (const policy of policySet.policies) {
    if (policy.enforcement_point !== 'tool_invocation') continue;

    const result = policy.evaluate(check);
    if (result.violated) {
      violations.push({
        policy_id: policy.policy_id,
        policy_set_id: policySet.policy_set_id,  // Version tracking
        severity: policy.severity,
        description: result.reason,
        evidence: result.evidence,  // Structured, not raw string
      });
    }
  }

  // Log audit entry with policy version
  logAuditEntry({
    run_id: check.run_id,
    policy_set_id: policySet.policy_set_id,
    enforcement_point: 'tool_invocation',
    target: check.tool,
    decision: violations.some(v => v.severity === 'blocking') ? 'blocked' : 'allowed',
  });

  const blocking = violations.filter(v => v.severity === 'blocking');

  if (blocking.length > 0) {
    return { decision: 'blocked', violations, policy_set_id: policySet.policy_set_id };
  }

  // Record warnings but allow
  return { decision: 'allowed', violations, policy_set_id: policySet.policy_set_id };
}
```

### Pre-Push Check

```typescript
interface PrePushCheck {
  run_id: string;
  diff: GitDiff;
  files_changed: string[];
  commit_message: string;
}

function evaluatePrePush(check: PrePushCheck): PolicyResult {
  const violations: PolicyViolation[] = [];

  // Check each policy
  for (const policy of getActivePolicies(check.run_id)) {
    if (policy.enforcement_point !== 'pre_push') continue;

    const result = policy.evaluate(check);
    if (result.violated) {
      violations.push({
        policy_id: policy.policy_id,
        severity: policy.severity,
        description: result.reason,
        evidence_ref: result.evidence,
      });
    }
  }

  // Any blocking violation stops the push
  const blocking = violations.filter(v => v.severity === 'blocking');

  if (blocking.length > 0) {
    return { decision: 'blocked', violations };
  }

  return { decision: 'allowed', violations };
}
```

---

## Violation Handling

### Violation Record

Every violation is persisted:

```typescript
interface PolicyViolation {
  violation_id: string;
  run_id: string;

  policy_id: string;
  policy_set_id: string;  // Version of policy set at evaluation time
  severity: 'warning' | 'blocking';
  description: string;  // Never contains secret values

  // Evidence storage (see Evidence Storage section below)
  evidence: ViolationEvidence;

  tool_invocation_id?: string;

  detected_at: string;

  // Resolution
  resolved_by_override_id?: string;
}
```

### Evidence Storage

Evidence must **never contain raw secret values** in queryable database fields. Evidence is stored in a structured format that separates metadata from sensitive content:

```typescript
interface ViolationEvidence {
  // Type of evidence
  kind: 'file_location' | 'command' | 'diff_snippet' | 'artifact';

  // Safe metadata (stored in main DB, queryable)
  location?: {
    file: string;
    line_start: number;
    line_end: number;
  };
  command_name?: string;  // Just the command, not args
  pattern_matched?: string;  // Name of pattern, not the match

  // Sensitive content (stored separately, encrypted, short retention)
  sensitive_content_ref?: string;  // Reference to encrypted storage

  // Content hash for override matching
  content_hash: string;  // SHA-256 of the actual evidence
}

interface SensitiveEvidenceStorage {
  evidence_id: string;
  violation_id: string;

  // Encrypted blob containing actual evidence
  encrypted_content: string;  // AES-256-GCM encrypted

  // Retention
  created_at: string;
  expires_at: string;  // Default: 7 days

  // Access control
  access_requires_role: 'operator' | 'admin';
}
```

**Evidence Access Rules:**

| Access Level | Can See | Cannot See |
|--------------|---------|------------|
| Agent | Nothing (violations block actions) | Any evidence |
| Operator | Metadata + redacted content | Raw secret values |
| Admin | Full evidence (audit logged) | Nothing restricted |
| GitHub Mirror | Metadata only | Any content |

**Example:** A secret detection violation stores:
- `location: { file: "src/config.ts", line_start: 42, line_end: 42 }`
- `pattern_matched: "github_token"`
- `content_hash: "sha256:abc123..."`
- `sensitive_content_ref: "evidence/v_xyz789"` → encrypted storage

The operator sees "GitHub token pattern matched at src/config.ts:42" but not the actual token value unless they access encrypted storage (which is audit logged).
```

### Blocking Violation Flow

When a blocking violation occurs at a run-blocking enforcement point (e.g., `pre_push`):

```
Policy violation detected
         │
         ▼
┌──────────────────┐
│  Log violation   │  (with policy_set_id for version tracking)
└────────┬─────────┘
         │
         ▼
┌──────────────────┐
│ Block the action │  (tool doesn't execute, push doesn't happen)
└────────┬─────────┘
         │
         ▼
┌──────────────────┐
│ Emit event       │  type: 'policy.violation_blocking'
│ to orchestrator  │  (policy engine does NOT mutate phase)
└────────┬─────────┘
         │
         ▼
┌──────────────────┐
│ Orchestrator     │  Receives event, transitions run to 'blocked'
│ transitions run  │  blocked_reason: 'policy_exception_required'
└────────┬─────────┘
         │
         ▼
┌──────────────────┐
│ Surface in       │  Approvals Inbox shows exception request
│ Approvals Inbox  │
└────────┬─────────┘
         │
         ▼
    Await operator
```

**Note:** The policy engine emits events; only the orchestrator mutates run phase. See [PROTOCOL.md](PROTOCOL.md) for the event-driven state machine.

### Exception Request

When blocked, the run creates an exception request:

```typescript
interface ExceptionRequest {
  run_id: string;
  violation_id: string;
  policy_id: string;

  // Context for operator
  what_was_blocked: string;
  why_blocked: string;
  agent_explanation?: string;  // If agent provided reasoning

  // Options
  suggested_scope: OverrideScope;

  requested_at: string;
}
```

---

## Overrides and Exceptions

Operators can authorize policy exceptions through the Approvals Inbox.

### Override Scopes

| Scope | Duration | Persists |
|-------|----------|----------|
| `this_run` | Current run only | In run record |
| `this_task` | All runs for this task | In task record |
| `this_repo` | All runs in repo | In repo config |
| `project_wide` | All runs in project | In project config |

### Override Constraints

Overrides are **not blanket exceptions**. Each override specifies constraints that limit what it permits:

```typescript
interface OverrideConstraints {
  // For command policies: specific commands allowed
  allowed_commands?: string[];  // e.g., ["curl https://api.example.com"]

  // For path policies: specific paths allowed
  allowed_paths?: string[];  // Glob patterns

  // For secret policies: specific file + line (one-time)
  allowed_locations?: Array<{
    file: string;
    line_start: number;
    line_end: number;
    content_hash: string;  // Must match to apply
  }>;

  // For network policies: specific hosts
  allowed_hosts?: string[];

  // For diff policies: specific diff hash
  diff_hash?: string;  // Exception applies only to this exact diff
}
```

**Example:** An exception for `no_secrets_in_code` doesn't allow all secrets—it allows a specific secret at a specific location with a matching content hash.

### Override Record

```typescript
interface Override {
  override_id: string;
  run_id: string;  // Where it was granted

  kind: 'policy_exception';
  target_id: string;  // policy_id
  scope: OverrideScope;

  // Constraints limit what this override permits
  constraints?: OverrideConstraints;

  operator: string;
  justification: string;  // Required

  created_at: string;
  expires_at?: string;  // Optional expiration

  // Audit trail
  github_mirror?: {
    comment_node_id: string;
    comment_url: string;
  };
}
```

### Exception Decision Flow

**Important:** Policy resolution does not directly mutate run phase. Only the orchestrator can transition phases (see [PROTOCOL.md](PROTOCOL.md)). The policy engine emits events that the orchestrator consumes.

```typescript
function resolveException(
  request: ExceptionRequest,
  decision: 'allow' | 'deny',
  operator: string,
  justification: string,
  scope: OverrideScope,
  constraints?: OverrideConstraints
): void {
  if (decision === 'allow') {
    // Create override record with constraints
    const override = createOverride({
      run_id: request.run_id,
      kind: 'policy_exception',
      target_id: request.policy_id,
      scope,
      constraints,  // Limits what the exception permits
      operator,
      justification,
    });

    // Link violation to override
    updateViolation(request.violation_id, {
      resolved_by_override_id: override.override_id,
    });

    // Emit event for orchestrator to consume
    // Orchestrator will transition phase from 'blocked' to prior phase
    emitEvent({
      type: 'policy.exception_granted',
      run_id: request.run_id,
      payload: {
        violation_id: request.violation_id,
        override_id: override.override_id,
        policy_id: request.policy_id,
        operator,
        scope,
      },
    });

    // Mirror to GitHub (redacted evidence only)
    postAuditComment(run, {
      type: 'policy_exception_granted',
      violation_id: request.violation_id,  // Reference, not raw evidence
      policy_id: request.policy_id,
      operator,
      justification,
      scope,
    });
  } else {
    // Emit denial event for orchestrator
    // Orchestrator will transition to 'cancelled'
    emitEvent({
      type: 'policy.exception_denied',
      run_id: request.run_id,
      payload: {
        violation_id: request.violation_id,
        policy_id: request.policy_id,
        operator,
        reason: justification,
      },
    });

    postAuditComment(run, {
      type: 'policy_exception_denied',
      violation_id: request.violation_id,
      policy_id: request.policy_id,
      operator,
      justification,
    });
  }
}
```

### Scope Propagation

When an override is granted with broader scope:

```typescript
function checkPolicyWithOverrides(
  run: Run,
  policy_id: string
): boolean {
  // Check run-level overrides
  if (hasOverride(run.run_id, policy_id, 'this_run')) return true;

  // Check task-level overrides
  if (hasOverride(run.task_id, policy_id, 'this_task')) return true;

  // Check repo-level overrides
  if (hasOverride(run.repo_id, policy_id, 'this_repo')) return true;

  // Check project-level overrides
  if (hasOverride(run.project_id, policy_id, 'project_wide')) return true;

  return false;
}
```

---

## Redaction Strategy

Conductor logs all tool invocations but redacts sensitive data before storage.

### What Gets Redacted

| Data Type | Example | Stored As |
|-----------|---------|-----------|
| API keys | `AKIA1234567890ABCDEF` | `[REDACTED:aws_key]` |
| Tokens | `ghp_abc123...` | `[REDACTED:github_token]` |
| Passwords | `password=secret123` | `password=[REDACTED]` |
| Private keys | `-----BEGIN RSA...` | `[REDACTED:private_key]` |
| High-entropy strings | `aK9x2mP...` (> threshold) | `[REDACTED:entropy]` |
| Environment variables | `$SECRET_KEY` | `[REDACTED:env_var]` |

### Redaction in Tool Invocations

```typescript
interface ToolInvocation {
  tool_invocation_id: string;
  agent_invocation_id: string;
  run_id: string;

  tool: string;
  target?: string;

  // Redacted versions for storage
  args_redacted_json: string;
  result_meta_json: string;

  // Full payload stored separately (encrypted, short retention)
  full_payload_ref?: string;

  policy: {
    decision: 'allowed' | 'blocked';
    policy_id?: string;
    violation_id?: string;
  };

  status: 'success' | 'error';
  duration_ms: number;
  created_at: string;
}
```

### Redaction Implementation

```typescript
interface RedactionConfig {
  // Built-in patterns (always applied, cannot be disabled)
  builtin_patterns: true;  // Immutable

  // Custom patterns (validated at config time)
  custom_patterns?: ValidatedRedactionPattern[];

  // Entropy-based detection
  entropy_threshold: number;  // Default: 4.5
  min_entropy_length: number; // Default: 16

  // Context-aware redaction
  redact_env_vars: boolean;   // Default: true
  redact_file_paths: boolean; // Default: false (usually safe)
}

interface RedactionPattern {
  name: string;
  regex: string;
  replacement: string;  // e.g., "[REDACTED:aws_key]"
}

// Custom patterns are validated at configuration time
interface ValidatedRedactionPattern extends RedactionPattern {
  compiled_regex: RegExp;  // Pre-compiled with 'g' flag
  validated_at: string;
}

// Validation happens when policy is saved, not at runtime
function validateRedactionPattern(pattern: RedactionPattern): ValidatedRedactionPattern {
  // Reject patterns that could cause ReDoS or crash
  if (pattern.regex.length > 500) {
    throw new Error(`Pattern ${pattern.name}: regex too long (max 500 chars)`);
  }

  // Test compilation
  let compiled: RegExp;
  try {
    compiled = new RegExp(pattern.regex, 'g');
  } catch (e) {
    throw new Error(`Pattern ${pattern.name}: invalid regex: ${e.message}`);
  }

  // Test against sample input to catch catastrophic backtracking
  const testInput = 'a'.repeat(1000);
  const startTime = Date.now();
  compiled.test(testInput);
  if (Date.now() - startTime > 100) {
    throw new Error(`Pattern ${pattern.name}: regex too slow (potential ReDoS)`);
  }

  return {
    ...pattern,
    compiled_regex: compiled,
    validated_at: new Date().toISOString(),
  };
}

function redact(input: string, config: RedactionConfig): string {
  let result = input;

  // Apply built-in patterns first (always, with global flag)
  for (const pattern of BUILTIN_PATTERNS) {
    // Built-in patterns are pre-compiled with 'g' flag
    result = result.replace(pattern.compiled_regex, pattern.replacement);
  }

  // Apply validated custom patterns (already compiled with 'g' flag)
  for (const pattern of config.custom_patterns ?? []) {
    // Reset lastIndex to ensure global search starts from beginning
    pattern.compiled_regex.lastIndex = 0;
    result = result.replace(pattern.compiled_regex, pattern.replacement);
  }

  // Entropy-based detection
  if (config.entropy_threshold > 0) {
    result = redactHighEntropyStrings(result, config);
  }

  // Environment variable redaction
  if (config.redact_env_vars) {
    result = result.replace(/\$[A-Z_][A-Z0-9_]*/g, '[REDACTED:env_var]');
  }

  return result;
}
```

### Full Payload Storage

For debugging, the full (unredacted) payload may be stored:

```typescript
interface FullPayloadStorage {
  // Encryption at rest
  encryption: 'aes-256-gcm';

  // Short retention (debugging window)
  retention_hours: number;  // Default: 24

  // Access control
  requires_role: 'admin';

  // Audit logging
  log_access: true;
}
```

Access to full payloads:
- Requires admin role
- Logged with accessor identity
- Auto-deleted after retention period
- Never exposed in UI (CLI only)

---

## Configuration

### Project-Level Policy Configuration

```yaml
# Stored in Conductor DB
project: acme-platform
policies:
  # File scope
  sensitive_paths:
    - "src/payments/**"
    - "src/auth/**"
    - "**/secrets.*"
    - ".env*"

  protected_files:
    - "*.lock"
    - "package-lock.json"
    - "pnpm-lock.yaml"
    - ".github/workflows/*"

  max_file_changes: 20

  # Secrets
  secret_detection:
    enabled: true
    custom_patterns:
      - name: "internal_token"
        regex: "INT_[A-Z0-9]{32}"
        severity: blocking

  # Execution
  blocked_commands:
    - "rm -rf /"
    - "sudo"
    - "chmod 777"

  network_access:
    allowed: false
    exceptions:
      - "registry.npmjs.org"
      - "pypi.org"

  # Dependencies
  dependency_policy:
    severity: warning  # Flag but don't block

  # Quality
  require_tests: true

  # Warnings
  warning_threshold:
    max_per_run: 10
    max_per_policy: 3
```

### Per-Repo Overrides

```yaml
# Stored in Conductor DB
repo: acme/scripts
policy_overrides:
  # Relax for utility repo
  require_tests: false
  max_file_changes: 50

  # Different sensitive paths
  sensitive_paths:
    - "credentials/**"
```

### Profile-Based Policies

Profiles can include policy defaults:

```yaml
profile: node-pnpm
policies:
  protected_files:
    - "pnpm-lock.yaml"
  blocked_commands:
    - "npm install"  # Enforce pnpm
```

---

## Audit and Compliance

### Policy Set Versioning

Policies are versioned to ensure audit trails reflect the exact rules in effect at evaluation time:

```typescript
interface PolicySet {
  policy_set_id: string;  // e.g., "ps_abc123"
  project_id: string;

  // Snapshot of all active policies
  policies: PolicyConfig[];

  // Immutable once created
  created_at: string;
  created_by: string;  // Operator who saved changes

  // Replaces previous version
  replaces_policy_set_id?: string;
}
```

When policies are modified, a new `PolicySet` is created. Previous versions are retained for audit purposes. All evaluations reference the `policy_set_id` that was active at evaluation time.

### Policy Audit Log

Every policy evaluation is logged with the policy version:

```typescript
interface PolicyAuditEntry {
  audit_id: string;
  run_id: string;

  // Policy versioning - REQUIRED
  policy_id: string;
  policy_set_id: string;  // Which version of policies was in effect

  enforcement_point: 'tool_invocation' | 'pre_push' | 'artifact_validation';

  // What was evaluated
  target: string;  // File path, command name, artifact type (never sensitive content)

  // Result
  decision: 'allowed' | 'blocked';

  // If blocked
  violation_id?: string;

  evaluated_at: string;
}
```

### Compliance Reporting

Conductor can generate compliance reports:

```typescript
interface ComplianceReport {
  period: { start: string; end: string };
  project_id: string;

  summary: {
    total_runs: number;
    runs_with_violations: number;
    total_violations: number;
    violations_by_severity: { warning: number; blocking: number };
    exceptions_granted: number;
  };

  by_policy: Array<{
    policy_id: string;
    violations: number;
    exceptions: number;
    top_triggers: string[];
  }>;

  exceptions_detail: Array<{
    override_id: string;
    run_id: string;
    policy_id: string;
    operator: string;
    justification: string;
    scope: OverrideScope;
    timestamp: string;
  }>;
}
```

### GitHub Audit Trail

All blocking violations and exceptions are mirrored to GitHub.

**Critical:** GitHub comments **never contain actual secret values**. Evidence is always redacted, and comments reference `violation_id` for operators to view full (redacted) details in Conductor UI.

```markdown
<!-- conductor:policy {"run_id":"abc123","violation_id":"v_xyz789","policy":"no_secrets_in_code","action":"violation"} -->

**[Conductor | Policy Violation | run:abc123]**

## 🚫 Policy Violation: `no_secrets_in_code`

A potential secret was detected in the proposed changes.

**Location:** `src/config.ts:42`
**Pattern matched:** `api_key_assignment`
**Violation ID:** `v_xyz789`

Evidence details available in [Conductor UI](https://conductor.example.com/runs/abc123/violations/v_xyz789) (requires operator access).

**Status:** Awaiting operator decision

[Grant Exception](https://conductor.example.com/runs/abc123/violations/v_xyz789) | [Cancel Run](https://conductor.example.com/runs/abc123/cancel)
```

And when resolved:

```markdown
<!-- conductor:policy {"run_id":"abc123","violation_id":"v_xyz789","policy":"no_secrets_in_code","action":"exception_granted"} -->

**[Conductor | Policy Exception | run:abc123]**

## ✅ Exception Granted: `no_secrets_in_code`

**Violation ID:** `v_xyz789`
**Operator:** @alice
**Scope:** this_run
**Constraints:** Location `src/config.ts:42` only
**Justification:** "This is a test API key for the sandbox environment, safe to commit."

Run resuming...
```

**Note:** Even justifications should not contain secret values. If an operator includes a secret in their justification, the comment is rejected with an error.

---

## Non-Overridable Policies

Some policies cannot be overridden, even by operators:

| Policy | Enforcement Level | Why |
|--------|-------------------|-----|
| `no_credential_exposure` | Architecture | Agent must never see GitHub tokens or Conductor secrets |
| `worktree_scope_hard` | Architecture | Agent cannot write outside worktree (security boundary) |
| `no_merge_by_agent` | Architecture | Agents cannot merge PRs |
| `audit_logging` | Architecture | All actions must be logged |
| `no_shell_default` | Policy (non-overridable) | Commands use argv-style execution unless explicitly allowlisted |

**Enforcement Levels:**

| Level | Overridable | Where Enforced |
|-------|-------------|----------------|
| Architecture | Never | Code-level, not configurable |
| Policy (non-overridable) | Never | Policy engine, but UI doesn't offer override option |
| Policy (overridable) | By operator | Policy engine, exception flow available |

Architecture-level policies are not represented in the policy configuration at all—they're hardcoded constraints that exist regardless of configuration.

---

## Further Reading

- [DATA_MODEL.md](DATA_MODEL.md) — Database schema for policies and violations
- [ROUTING_AND_GATES.md](ROUTING_AND_GATES.md) — Policy Engine vs Policy Exception Gate
- [ARCHITECTURE.md](ARCHITECTURE.md) — MCP Tool Layer and enforcement boundaries
- [PROTOCOL.md](PROTOCOL.md) — Event schema for policy violations
