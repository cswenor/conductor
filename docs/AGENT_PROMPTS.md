# Agent Prompt Construction and Management

> **Status:** Normative. This is the single source of truth for how Conductor constructs, customizes, stores, and secures agent prompts. All other documentation MUST reference this document for prompt-related information.

## 1. Prompt Construction Pipeline

### 1.1 Overview

Conductor has **two execution pipelines**, selected by the `backend` field in `ResolvedStepConfig`:

**Raw backend pipeline** (`backend: 'raw'`):

```
WorkflowConfig resolution (snapshot + overlay)
  → System prompt selection (per agent type & action)
  → Context assembly (issue, plan, review, file tree, relevant files)
  → Context formatting with section budgets
  → Provider invocation (AnthropicProvider → Anthropic API)
  → Tool loop (runToolLoop) for implementer, single-call for planner/reviewer
  → Response parsing (text extraction or tool result collection)
  → Message persistence (agent_messages table)
```

**Agent SDK pipeline** (`backend: 'agent_sdk'`):

```
WorkflowConfig resolution (snapshot + overlay)
  → System prompt selection (per agent type & action, SDK-specific constants)
  → Context assembly (same as raw)
  → Context formatting with section budgets
  → SDK streaming invocation (sdkQuery() → Claude Agent SDK)
  → MCP tool serving (tools exposed as MCP server to SDK)
  → Message persistence (agent_messages table)
```

> **Key difference:** The Agent SDK pipeline bypasses `AgentProvider` and `runToolLoop()` entirely. It uses `@anthropic-ai/claude-agent-sdk` for multi-turn streaming conversations with built-in tool orchestration.

### 1.2 Pipeline Stages

| Stage | Input | Output | Location |
|-------|-------|--------|----------|
| 1. Config resolution | Run snapshot + run overlay | `ResolvedStepConfig` | `packages/shared/src/workflow-config/index.ts` |
| 2. System prompt selection | Agent type + action + backend | Static prompt string | `packages/shared/src/agent-runtime/agents/*.ts` |
| 3. Context assembly | Run ID, worktree path, file paths | `AgentContext` object | `packages/shared/src/agent-runtime/context.ts` |
| 4. Context formatting | `AgentContext` + section budgets | User prompt string | `packages/shared/src/agent-runtime/context.ts` |
| 5a. Provider invocation (raw) | System prompt + user prompt + tools | `AgentOutput` | `packages/shared/src/agent-runtime/provider.ts` |
| 5b. SDK invocation (agent_sdk) | System prompt + user prompt + MCP tools | SDK stream | `packages/shared/src/agent-runtime/agents/*-sdk.ts` |
| 6. Response parsing | Content from step 5 | File operations or verdict | `packages/shared/src/agent-runtime/agents/*.ts` |
| 7. Message persistence | All messages exchanged | `agent_messages` rows | `packages/shared/src/agent-runtime/agent-messages.ts` |

> **Note:** Config resolution at runtime uses the `workflow_snapshot_json` persisted at run creation time (which already merges MVP defaults + project config), plus any run-level overlay. The `resolveWorkflowConfig()` function that merges defaults + project config runs at run creation, not at each agent invocation.

---

## 2. Agent Types and System Prompts

### 2.1 Agent Registry

Conductor defines **three agent types** with system prompts for both `raw` and `agent_sdk` backends:

| Agent Type | Action | Backend | System Prompt Constant | Source File |
|-----------|--------|---------|----------------------|-------------|
| Planner | `create_plan` | `raw` | `PLANNER_SYSTEM_PROMPT` | `agents/planner.ts` |
| Planner | `create_plan` | `agent_sdk` | SDK-specific system prompt | `agents/planner-sdk.ts` |
| Implementer | `apply_changes` | `raw` (legacy) | `IMPLEMENTER_SYSTEM_PROMPT` | `agents/implementer.ts` |
| Implementer | `apply_changes` | `raw` (tool-use) | `IMPLEMENTER_TOOLS_SYSTEM_PROMPT` | `agents/implementer.ts` |
| Implementer | `apply_changes` | `agent_sdk` | SDK-specific system prompt | `agents/implementer-sdk.ts` |
| Reviewer | `review_plan` | `raw` | `PLAN_REVIEWER_SYSTEM_PROMPT` | `agents/reviewer.ts` |
| Reviewer | `review_code` | `raw` | `CODE_REVIEWER_SYSTEM_PROMPT` | `agents/reviewer.ts` |
| Reviewer | `review_plan` | `agent_sdk` | SDK-specific plan review prompt | `agents/reviewer-sdk.ts` |
| Reviewer | `review_code` | `agent_sdk` | SDK-specific code review prompt | `agents/reviewer-sdk.ts` |

All system prompts are **hardcoded as module-level string constants** in their respective agent files under `packages/shared/src/agent-runtime/agents/`. There is no database storage or file-system template loading for prompt definitions. However, runtime prompt instances (the actual messages sent to the model) are persisted to the `agent_messages` table for audit and debugging purposes.

### 2.2 Planner System Prompt

**Source:** `packages/shared/src/agent-runtime/agents/planner.ts`, lines 35–69

**Constant:** `PLANNER_SYSTEM_PROMPT`

**Role:** Analyze a GitHub issue and produce a structured implementation plan.

**Required output structure:**

```markdown
### Approach
High-level strategy (1-3 sentences)

### Files to Change
- `path/to/file.ts` — Description of changes

### Steps
1. Concrete implementation steps

### Risks & Considerations
- Edge cases, breaking changes, security

### Testing Strategy
- Verification approach and test modifications
```

**Key rules enforced in prompt:**
- Reference exact file paths, function names, and types
- Be complete enough for an implementer agent to follow without additional context
- Address every point from review feedback if this is a revision

### 2.3 Implementer System Prompts

The implementer has **two system prompts**, selected by backend mode.

#### 2.3.1 Legacy Marker-Parsing: `IMPLEMENTER_SYSTEM_PROMPT`

**Source:** `agents/implementer.ts`, lines 78–102

**Used when:** Called via `runImplementer()` — a legacy code path that is **not routed by the worker**. The worker's raw implementer path uses `runImplementerWithTools()` instead (see § 2.3.2).

**Output format:** File blocks with sentinel markers:

```
=== FILE: path/to/file.ts ===
[complete file content]
=== END FILE ===

=== DELETE: path/to/old-file.ts ===
```

**Key rules:** Write complete files (not diffs), use relative paths, follow existing patterns, no `.git/` modifications.

> **Note:** This prompt and its parsing logic exist in the codebase but are not invoked by the production worker. The worker always routes `backend: 'raw'` implementer calls to the tool-use path.

#### 2.3.2 Tool-Use Backend: `IMPLEMENTER_TOOLS_SYSTEM_PROMPT`

**Source:** `agents/implementer.ts`, lines 284–317

**Used when:** `backend: 'raw'` via the worker (the primary execution path). Also used as a reference by the Agent SDK implementer backend (`agents/implementer-sdk.ts`).

**Available tools listed in prompt:**
- `read_file` — Read entire file contents
- `read_file_range` — Read specific line ranges
- `search_in_file` — Search for literal strings or regex patterns
- `write_file` — Write or overwrite files with complete content
- `delete_file` — Delete files
- `list_files` — List repository file structure
- `run_tests` — Run test commands

**Additional guidance:** Prefer `read_file_range` and `search_in_file` over `read_file` to reduce token usage. Use tools to fetch details when context is truncated.

### 2.4 Reviewer System Prompts

Both reviewer prompts require a verdict on the **first line** of the response.

#### 2.4.1 Plan Reviewer: `PLAN_REVIEWER_SYSTEM_PROMPT`

**Source:** `agents/reviewer.ts`, lines 41–68

**Verdict format:**
```
APPROVED — The plan is ready for implementation.
CHANGES_REQUESTED — The plan needs revisions.
```

**Required sections:** Strengths, Issues (if CHANGES_REQUESTED), Suggestions (optional).

**Default behavior:** If borderline, default to `CHANGES_REQUESTED`.

#### 2.4.2 Code Reviewer: `CODE_REVIEWER_SYSTEM_PROMPT`

**Source:** `agents/reviewer.ts`, lines 70–98

**Verdict format:**
```
APPROVED — The code is ready for PR.
CHANGES_REQUESTED — The code needs revisions.
```

**Required sections:** Correctness, Completeness, Issues (if CHANGES_REQUESTED).

**Checks enforced:** Correctness, completeness, security issues, missing error handling.

### 2.5 System Prompt vs User Prompt

| Aspect | System Prompt | User Prompt |
|--------|--------------|-------------|
| **Source** | Hardcoded constant per agent type | Dynamically assembled from `AgentContext` |
| **Content** | Role definition, output format, rules | Issue body, plan, review, file tree, relevant files |
| **Mutability** | Code change required | Per-run context varies |
| **Customization** | Only via code modification | Via `SectionBudgets` and context inputs |

---

## 3. Context Assembly

### 3.1 AgentContext Interface

**Source:** `packages/shared/src/agent-runtime/context.ts`, lines 28–54

```typescript
export interface AgentContext {
  issue: {
    number: number;
    title: string;
    body: string;
    type: string;
    state: string;
    labels: string[];
  };
  repository: {
    fullName: string;
    defaultBranch: string;
  };
  run: {
    runId: string;
    baseBranch: string;
    branch: string;
    planRevisions: number;
    testFixAttempts: number;
    reviewRounds: number;
  };
  plan?: string;
  review?: string;
  fileTree?: string;
  relevantFiles?: Array<{ path: string; content: string }>;
  rewindContextSummary?: string;
}
```

### 3.2 Assembly Function

**Signature:** `assembleContext(db: Database, input: AssembleContextInput): AgentContext`

**Source:** `context.ts`, lines 285–365

**Input:**

```typescript
export interface AssembleContextInput {
  runId: string;
  worktreePath?: string;
  relevantFilePaths?: string[];
}
```

**Assembly steps:**

1. Load run record from database
2. Load associated task, repository, and project
3. Populate `issue` from task's GitHub metadata (number, title, body, type, state, labels)
4. Populate `repository` from repo record (fullName) and project settings (`defaultBranch` from `project.defaultBaseBranch ?? 'main'`)
5. Populate `run` from run record (runId, baseBranch, branch, planRevisions, testFixAttempts, reviewRounds)
6. Load latest plan artifact (if present) → `plan`
7. Load latest review artifact (if present) → `review`
8. Assemble file tree from worktree (if `worktreePath` provided) → `fileTree`
9. Read relevant files (if `relevantFilePaths` provided) → `relevantFiles`
10. Attach rewind context summary (if present) → `rewindContextSummary`

### 3.3 File Tree Assembly

**Signature:** `assembleFileTree(worktreePath: string): string`

**Source:** `context.ts`, lines 183–212

| Constraint | Value |
|-----------|-------|
| Source | `git ls-files` output |
| Sensitive file filter | Excluded via `isSensitiveFile()` |
| Max entries | `MAX_FILE_TREE_ENTRIES = 2000` |
| Max bytes | `MAX_FILE_TREE_BYTES = 100_000` |

### 3.4 Relevant File Reading

**Signature:** `readRelevantFiles(worktreePath: string, paths: string[]): Array<{ path: string; content: string }>`

**Source:** `context.ts`, lines 223–274

**Validation pipeline per file:**

1. Reject paths containing `..` (directory traversal)
2. Reject absolute paths
3. Check against `SENSITIVE_FILE_PATTERNS` and `SENSITIVE_EXTENSIONS` via `isSensitiveFile()` → exclude with error placeholder
4. Verify resolved path stays within worktree boundary
5. Read file content
6. Truncate to `MAX_FILE_CONTENT_CHARS = 10_000` characters
7. Apply `redactSecretPatterns()` to content
8. Return content or error placeholder for missing/excluded files

---

## 4. Token Budget Allocation

### 4.1 Section Budgets

**Source:** `context.ts`, lines 62–68

```typescript
export interface SectionBudgets {
  issueBody?: number;
  plan?: number;
  review?: number;
  fileTree?: number;
  fileTreeEntries?: number;
}
```

### 4.2 Implementer Budget Defaults

**Source:** `resolveImplementerBudgets()` in `context.ts`, lines 90–98

| Section | Default | Minimum | Env Var Override |
|---------|---------|---------|-----------------|
| Issue body | 5,000 chars | 500 | `CONDUCTOR_CTX_BUDGET_ISSUE` |
| Plan | 10,000 chars | 1,000 | `CONDUCTOR_CTX_BUDGET_PLAN` |
| Review | 10,000 chars | 1,000 | `CONDUCTOR_CTX_BUDGET_REVIEW` |
| File tree | 10,000 chars | 1,000 | `CONDUCTOR_CTX_BUDGET_FILE_TREE` |
| File tree entries | 500 entries | 50 | `CONDUCTOR_CTX_BUDGET_FILE_TREE_ENTRIES` |

### 4.3 Truncation Mechanism

**Signature:** `truncateSection(content: string, budget: number | undefined): string`

**Source:** `context.ts`, lines 106–114

**Behavior:**
- If budget is undefined or content fits within budget: return content unchanged
- If budget ≤ 0: return empty string
- If budget is smaller than the hint length: slice the hint itself to fit the budget
- Otherwise: slice content to `budget - hintLength` and append:

```
[...truncated — use read_file, search_in_file, or list_files to inspect details on demand]
```

This hint is defined as the constant `TRUNCATION_HINT` at `context.ts`, line 104.

### 4.4 Context Formatting

**Signature:** `formatContextForPrompt(context: AgentContext, budgets?: SectionBudgets): string`

**Source:** `context.ts`, lines 371–491

**Output format:** Markdown-formatted string with labeled sections. Actual heading format:

```markdown
## Issue #42: Add rate limiting to webhook handler
Type: feature | State: open
Labels: enhancement, backend

<issue body — possibly truncated>

## Repository: org/conductor
Default branch: main

## Run: run_abc123
Base branch: main
Working branch: feat/rate-limiting
Plan revision: 1
Review round: 0

## Prior Context (from rewind)
<rewind context summary — if present>

## Current Plan
<plan content — possibly truncated>

## Latest Review Feedback
<review content — possibly truncated>

## Repository File Tree
<file listing — possibly truncated>

## Relevant Files
### path/to/file.ts
<content — redacted>
```

Each section is independently truncated based on its budget. After per-section truncation, a **global safety cap** (`MAX_TOTAL_CONTEXT_CHARS = 100,000`) truncates the entire assembled prompt if it still exceeds the limit. The function logs telemetry on section sizes.

---

## 5. Executor Token Budget and Tool Loop

### 5.1 Token Budget Configuration

**Source:** `packages/shared/src/agent-runtime/executor.ts`, lines 37–48

| Constant | Value | Description |
|----------|-------|-------------|
| `DEFAULT_CONTEXT_WINDOW` | 200,000 | Assumed context window size |
| `CONTEXT_BUDGET_FRACTION` | 0.65 | Fraction of window for input (130K tokens) |
| `DEFAULT_BACKOFF_FACTOR` | 0.8 | Budget reduction on rate limit |
| `DEFAULT_RECOVERY_FACTOR` | 1.05 | Budget recovery on success |
| `DEFAULT_MIN_BUDGET_FLOOR` | 10,000 | Minimum budget after backoff |
| `DEFAULT_MAX_RATE_LIMIT_RETRIES` | 3 | Max retries on rate limit |
| `MIN_RECENT_TURNS` | 2 | Minimum turns kept during compaction |
| `DEFAULT_KEEP_RECENT_TURNS` | 4 | Default turns kept during compaction |
| `ESTIMATION_SAFETY_FACTOR` | 1.15 | Inflation factor for token estimation |
| `RETRY_BASE_DELAY_MS` | 1,000 | Base delay for rate limit retry |
| `RETRY_JITTER_MS` | 500 | Jitter added to retry delay |

### 5.2 Budget Resolution

**Source:** `resolveContextCap()` in `executor.ts`, lines 93–119

Resolution order (first match wins):

1. Explicit `maxInputTokens` parameter passed to `runToolLoop()`
2. `CONDUCTOR_MAX_INPUT_TOKENS` environment variable
3. `(CONDUCTOR_CONTEXT_WINDOW ?? 200,000) * 0.65`

**Source:** `resolveBudgetConfig()` in `executor.ts`, lines 121–134

Additional budget parameters resolved from environment variables:

| Parameter | Env Var | Default | Valid Range |
|-----------|---------|---------|-------------|
| Backoff factor | `CONDUCTOR_BUDGET_BACKOFF` | 0.8 | 0.1–0.99 |
| Recovery factor | `CONDUCTOR_BUDGET_RECOVERY` | 1.05 | 1.0–2.0 |
| Budget floor | `CONDUCTOR_BUDGET_FLOOR` | 10,000 | ≥ 1 |
| Max retries | `CONDUCTOR_BUDGET_MAX_RETRIES` | 3 | — |

### 5.3 Token Estimation

**Signature:** `estimateTokens(systemPrompt: string, messages: Anthropic.MessageParam[], tools: Anthropic.Tool[] | undefined): number`

**Source:** `executor.ts`, lines 419–436

**Method:** Sum character lengths of system prompt, all serialized messages, and tool definitions JSON, then apply formula:

```
estimatedTokens = (totalChars / 4) * ESTIMATION_SAFETY_FACTOR
```

This is an approximate heuristic (1 token ≈ 4 characters, inflated by 15% safety margin). No tokenizer library is used.

### 5.4 Message Compaction

When the estimated input tokens exceed the effective budget, the executor compacts the message history to fit.

#### Compaction Markers

**Source:** `executor.ts`, lines 54–55

```typescript
export const COMPACTION_MARKER = '[COMPACTION_SUMMARY_V1]';
const COMPACTION_BRIDGE = 'The above summarizes earlier tool calls. Continue with the task using the recent context below.';
```

#### Compaction Flow

**Source:** `applyCompaction()` in `executor.ts`, lines 744–782

1. **Attempt 1:** Keep `DEFAULT_KEEP_RECENT_TURNS = 4` most recent turns, summarize dropped turns
2. **Attempt 2:** If still over budget, try naive mode (drop without summarizing)
3. **Attempt 3:** Reduce kept turns toward `MIN_RECENT_TURNS = 2`
4. **Failure:** If compaction cannot bring messages under budget, the executor throws `AgentBudgetExceededError`

#### Summary Generation

**Source:** `summarizeDroppedTurns()` in `executor.ts`, lines 506–693

- Collects prior compaction summaries from synthetic messages
- Walks message history with role-aware state machine (user → assistant → user)
- Extracts tool use calls and their results
- Truncates individual entries
- Renumbers turns sequentially
- Produces a structured summary prefixed with `[COMPACTION_SUMMARY_V1]`

### 5.5 Tool Loop Execution

**Signature:** `runToolLoop(input: ExecutorInput): Promise<ExecutorResult>`

**Source:** `executor.ts`, lines 812–1064

#### ExecutorInput Interface

```typescript
export interface ExecutorInput {
  db: Database;
  provider: AgentProvider;
  systemPrompt: string;
  userPrompt: string;
  registry: ToolRegistry;
  policyRules: PolicyRule[];
  context: ToolExecutionContext;
  maxTokens?: number;
  temperature?: number;
  timeoutMs?: number;
  maxIterations?: number;
  abortSignal?: AbortSignal;
  maxInputTokens?: number;
  totalTimeoutMs?: number;
}
```

#### ExecutorResult Interface

```typescript
export interface ExecutorResult {
  content: string;
  totalTokensInput: number;
  totalTokensOutput: number;
  totalDurationMs: number;
  iterations: number;
  stopReason: string;
}
```

#### Loop algorithm:

```
1. Resolve budget config
2. Persist system prompt + user prompt to agent_messages
3. LOOP (max MAX_TOOL_ITERATIONS = 50):
   a. Check abort signal (in-process cancellation)
   b. Check deadline timeout (wall-clock budget)
   c. Check run phase in DB (cross-process cancellation)
   d. Estimate tokens on current messages
   e. If over budget → applyCompaction()
   f. Call provider.invoke() with timeout clamped to remaining deadline
   g. ON rate limit error:
      - Reduce effectiveBudget by backoffFactor (clamped to floor)
      - Sleep: provider's retryAfterMs if available, else baseDelay * 2^retry + jitter
      - Re-estimate and re-compact if needed
      - Retry (up to maxRateLimitRetries)
   h. ON success:
      - Recover budget toward contextCap using recoveryFactor
   i. Persist assistant response to agent_messages
   j. If stop_reason != "tool_use" → extract content, return
   k. Execute each tool_use block via executeAuditedToolCall()
   l. Persist tool_results to agent_messages
   m. Append assistant + tool_results to messages, continue
4. If loop exceeds 50 iterations → throw error
```

---

## 6. Tool System

### 6.1 Tool Definition Interface

**Source:** `packages/shared/src/agent-runtime/tools/types.ts`, lines 44–51

```typescript
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: ToolInputSchema;
  execute: (
    input: Record<string, unknown>,
    context: ToolExecutionContext
  ) => Promise<ToolResult>;
  extractTarget?: (input: Record<string, unknown>) => string | undefined;
}
```

#### Supporting Types

```typescript
export interface ToolInputSchema {
  type: 'object';
  properties?: Record<string, unknown>;
  required?: string[];
}

export interface ToolExecutionContext {
  runId: string;
  agentInvocationId: string;
  worktreePath: string;
  db: Database;
  projectId: string;
  abortSignal?: AbortSignal;
}

export interface ToolResult {
  content: string;       // Sent back to model as tool_result
  isError?: boolean;     // Marks tool_result as error
  meta: Record<string, unknown>;  // Persisted to tool_invocations (not sent to model)
}
```

### 6.2 Tool Registry

**Source:** `packages/shared/src/agent-runtime/tools/registry.ts`, lines 11–48

```typescript
export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition>();
  register(tool: ToolDefinition): void;   // Throws on duplicate name
  get(name: string): ToolDefinition | undefined;
  has(name: string): boolean;
  names(): string[];
  toAnthropicTools(): Anthropic.Tool[];   // Converts to Anthropic API format
}
```

### 6.3 Tool Profiles

**Source:** `packages/shared/src/agent-runtime/tools/profiles.ts`

Tool profiles control which tools are available to each agent step:

```typescript
export type ToolProfile = 'readonly' | 'inspect' | 'full';
```

| Profile | Tools Available |
|---------|---------------|
| `readonly` | `read_file`, `read_file_range`, `search_in_file`, `list_files` |
| `inspect` | All `readonly` tools + `run_tests` |
| `full` | `read_file`, `read_file_range`, `search_in_file`, `write_file`, `delete_file`, `list_files`, `run_tests` |

#### Step-to-Profile Constraints

**Source:** `STEP_PROFILE_CONSTRAINTS` in `profiles.ts`, lines 46–51

| Step | Allowed Profiles | Reason |
|------|-----------------|--------|
| `planner` | `readonly`, `inspect` | Planner is non-mutating |
| `reviewerPlan` | `readonly`, `inspect` | Plan reviewer is non-mutating |
| `reviewerCode` | `readonly`, `inspect` | Code reviewer is non-mutating |
| `implementer` | `full` only | Implementer requires write capability |

**`validateProfileForStep(profile: ToolProfile, stepName: string): string | null`** returns an error message if the profile is not allowed for the step, or `null` if valid. Unknown steps pass validation (no constraint).

### 6.4 Tool Execution with Auditing

**Source:** `executeAuditedToolCall()` in `executor.ts`, lines 247–397

Each tool call goes through an audited pipeline:

```
1. Unknown tool? → log warning, return error to model
2. Redact args via redactToolArgs()
   - Special handling: write_file content replaced with { contentHash, contentSizeBytes }
3. Extract target from input (e.g., file path)
4. Evaluate policy rules → if any policy rejects:
   - Create tool_invocations record (status: blocked)
   - Emit tool.policy_blocked event
   - Return policy violation message to model
5. Create tool_invocations record (status: started)
6. Execute tool with timeout/abort handling
7. Update invocation record (completed/failed)
8. Emit tool.invoked event
```

### 6.5 Policy Rules

**Source:** `packages/shared/src/agent-runtime/tools/policy.ts`

```typescript
export interface PolicyRule {
  policyId: string;
  description: string;
  evaluate: (
    toolName: string,
    args: Record<string, unknown>,
    context: ToolExecutionContext
  ) => PolicyEvaluation | null;
}
```

**Built-in policies:**

| Export Name | Policy ID | Description |
|------------|-----------|-------------|
| `worktreeBoundaryRule` | `worktree_boundary` | Blocks file operations that escape the worktree via path traversal or symlinks |
| `dotGitProtectionRule` | `dotgit_protection` | Blocks access to `.git/` directory |
| `sensitiveFileWriteRule` | `sensitive_file_write` | Blocks writes to sensitive files (.env, .pem, credentials, etc.) |
| `shellInjectionRule` | `shell_injection` | Blocks shell operators in `run_tests` command arguments |

**Plan-mode policies** (used by planner and reviewer SDK backends):

| Export Name | Policy ID | Description |
|------------|-----------|-------------|
| `planModeWriteBlockRule` | `plan_mode_write_block` | Blocks all write operations during planning/review phases |

The worktree boundary rule validates paths with `isValidFilePath()`, checks worktree containment, and detects symlink escapes via `checkSymlinkEscape()`.

---

## 7. Per-Project Customization

### 7.1 Workflow Config Schema

**Source:** `packages/shared/src/workflow-config/index.ts`

```typescript
export interface StepConfig {
  model?: string;
  maxTokens?: number;
  temperature?: number;
  toolProfile?: string;
  sandboxProfile?: string;
  budgets?: StepBudgets;
  backend?: 'raw' | 'agent_sdk';
}

export interface StepBudgets {
  maxInputTokens?: number;
  maxOutputTokens?: number;
  maxDurationMs?: number;
}

export interface WorkflowConfig {
  planner?: StepConfig;
  reviewerPlan?: StepConfig;
  implementer?: StepConfig;
  reviewerCode?: StepConfig;
}
```

### 7.2 MVP Defaults

**Source:** `MVP_DEFAULTS` in `workflow-config/index.ts`, lines 77–82

| Step | Model | Max Tokens | Temperature | Tool Profile | Backend |
|------|-------|-----------|-------------|-------------|---------|
| Planner | `claude-sonnet-4-20250514` | 8,192 | 0.3 | `inspect` | `raw` |
| Plan Reviewer | `claude-sonnet-4-20250514` | 4,096 | 0.2 | `inspect` | `raw` |
| Implementer | `claude-sonnet-4-20250514` | 8,192 | 0.2 | `full` | `raw` |
| Code Reviewer | `claude-sonnet-4-20250514` | 4,096 | 0.2 | `inspect` | `raw` |

> **Note:** The implementer raw legacy path uses `maxTokens: 16384` (see `implementer.ts` lines 74–76), but tool-use mode (the primary execution path) uses `8192`.

### 7.3 Resolution Hierarchy

**Source:** `resolveWorkflowConfig()` in `workflow-config/index.ts`, lines 408–440

Resolution happens in **two stages**:

**At run creation** (persisted to `workflow_snapshot_json`):

```
MVP_DEFAULTS (base)
  ← merge projectConfig (project-level overrides)
  → stored as workflow_snapshot_json in the run record
```

**At runtime** (each agent invocation):

```
workflow_snapshot_json (from run record)
  ← merge overlay (run-level overrides)
  → ResolvedStepConfig used for this invocation
```

Each layer overrides the previous. Budget fields merge separately across all levels (additive, not replacement).

**Practical effect:** A project can override the model for all steps (e.g., upgrade to Opus), or override temperature for just the implementer, without affecting other defaults. Changes to project config after run creation do not affect in-flight runs.

### 7.4 Customizable Parameters

| Parameter | Raw Backend | Agent SDK Backend | Effect |
|-----------|------------|-------------------|--------|
| `model` | Honored | **Ignored** (SDK logs warning) | Which LLM processes the prompt |
| `maxTokens` | Honored | **Ignored** (SDK logs warning) | Maximum output tokens from the model |
| `temperature` | Honored | **Ignored** (SDK logs warning) | Sampling temperature (lower = more deterministic) |
| `toolProfile` | Honored | Honored | Which tools are registered (affects tool availability, not prompt text) |
| `backend` | — | — | `raw` (provider + tool loop) vs `agent_sdk` (SDK streaming + MCP) |
| `budgets.maxInputTokens` | Implementer only | Not consumed | Hard cap on input tokens (overrides global context budget) |
| `budgets.maxOutputTokens` | **Not consumed** | **Not consumed** | Defined in schema but not enforced at runtime; output cap comes from `maxTokens` |
| `budgets.maxDurationMs` | Honored | Honored | Wall-clock timeout for the step |

> **Note:** `budgets.maxInputTokens` is only passed to the executor by the raw implementer path. Planner and reviewer raw paths do not forward this field. `budgets.maxOutputTokens` is defined in the `StepBudgets` interface but has no runtime consumer — output token limits are controlled by `maxTokens`.

### 7.5 What Is NOT Customizable

The following aspects require code changes to modify:

- **System prompt content** — Hardcoded constants, no template variables or database storage
- **Output format** — File block syntax, verdict format, plan structure are fixed
- **Available tool set** — Tools are registered programmatically per profile, not configurable
- **Security policies** — Worktree boundary, .git protection, sensitive file write blocking, and shell injection blocking are always active
- **Sensitive file patterns** — Compiled into the source code
- **Secret redaction patterns** — Compiled into the source code

---

## 8. Prompt Injection Defense

### 8.1 Defense Layers

Conductor implements defense in depth against prompt injection from untrusted content:

| Layer | Mechanism | Location |
|-------|-----------|----------|
| Sensitive file exclusion | `SENSITIVE_FILE_PATTERNS` filter | `context.ts` |
| Sensitive extension exclusion | `SENSITIVE_EXTENSIONS` filter | `context.ts` |
| Secret redaction | `redactSecretPatterns()` | `packages/shared/src/utils/redact.ts` |
| Path validation | No `..`, no absolute paths | `readRelevantFiles()` |
| Worktree boundary | Resolved path must stay within worktree | `readRelevantFiles()`, `worktree_boundary` policy |
| Symlink escape detection | `checkSymlinkEscape()` | `worktree_boundary` policy |
| Sensitive file write blocking | Blocks writes to .env, credentials, etc. | `sensitive_file_write` policy |
| Shell injection blocking | Blocks shell operators in test commands | `shell_injection` policy |
| Plan-mode write blocking | Blocks all writes during planning/review | `plan_mode_write_block` policy |
| Content truncation | Per-section budgets, per-file limits, global cap | `formatContextForPrompt()`, `readRelevantFiles()` |
| Tool policy enforcement | Every tool call evaluated against policy rules | `executeAuditedToolCall()` |
| Argument redaction | Tool args sanitized before persistence | `redactToolArgs()` |
| Message size limits | 512KB max per persisted message | `agent-messages.ts` |

### 8.2 Sensitive File Patterns

**Source:** `SENSITIVE_FILE_PATTERNS` in `context.ts`, lines 124–139

```typescript
export const SENSITIVE_FILE_PATTERNS = [
  '.env',
  '.env.local',
  '.env.development',
  '.env.production',
  '.env.staging',
  '.env.test',
  '.npmrc',
  '.git/',
  '.ssh/',
  '.aws/',
  'credentials.json',
  'service-account',
  'secrets.yaml',
  'secrets.yml',
];
```

**Source:** `SENSITIVE_EXTENSIONS` in `context.ts`, line 141

```typescript
['.pem', '.key', '.p12', '.pfx', '.jks']
```

**Matching logic** (`isSensitiveFile()` in `context.ts`, lines 146–168):
- Checks file extension against `SENSITIVE_EXTENSIONS`
- Checks basename and path components against `SENSITIVE_FILE_PATTERNS`
- Supports both exact matches and prefix patterns (matched with path separators)

### 8.3 Secret Pattern Redaction

**Source:** `SECRET_PATTERNS` in `packages/shared/src/utils/redact.ts`, lines 12–32

| Label | Pattern Example |
|-------|----------------|
| `anthropic_key` | `sk-ant-...` (20+ chars) |
| `openai_key` | `sk-...` (20+ chars) |
| `google_key` | `AIza...` (30+ chars) |
| `github_pat` | `ghp_...` (30+ chars) |
| `github_server` | `ghs_...` (30+ chars) |
| `github_fine_pat` | `github_pat_...` (30+ chars) |
| `slack_bot` | `xoxb-...` (30+ chars) |
| `slack_user` | `xoxp-...` (30+ chars) |
| `aws_key` | `AKIA...` (16 chars) |
| `config_secret` | `password=...`, `secret:...`, `token=...`, `api_key=...`, `apikey:...` (8+ chars, case-insensitive) |
| `base64_blob` | 40+ chars of base64 at word boundary |

**Redaction function:** `redactSecretPatterns(content: string, filePath?: string): string`

Replaces each match with `[REDACTED:{label}]` and logs a warning with redaction count and file path.

### 8.4 What Is NOT Defended

The following attack vectors are **not currently mitigated**:

| Vector | Status | Notes |
|--------|--------|-------|
| Prompt injection in issue body | **Unmitigated** | Issue body is passed directly to the model as context |
| Prompt injection in file content | **Partially mitigated** | Secrets redacted, but adversarial instructions in code files could influence agent behavior |
| Prompt injection in review feedback | **Unmitigated** | Review text is passed as context |
| Model jailbreaking | **N/A** | Relies on Anthropic's built-in safety |

The primary defense strategy is **structural**: agents have limited tool access (profiles), are confined to worktree boundaries (policies), and operate within token budgets. Even if an injection succeeds in influencing agent behavior, the blast radius is constrained by policy enforcement.

---

## 9. Provider Abstraction

### 9.1 Provider Interface

**Source:** `packages/shared/src/agent-runtime/provider.ts`

```typescript
export interface AgentProvider {
  invoke(input: AgentInput): Promise<AgentOutput>;
}
```

#### AgentInput

```typescript
export interface AgentInput {
  systemPrompt: string;
  userPrompt: string;
  maxTokens?: number;
  temperature?: number;
  timeoutMs?: number;
  tools?: Anthropic.Tool[];
  messages?: Anthropic.MessageParam[];
  abortSignal?: AbortSignal;
  runId?: string;
}
```

#### AgentOutput

```typescript
export interface AgentOutput {
  content: string;
  tokensInput: number;
  tokensOutput: number;
  stopReason: string;
  durationMs: number;
  toolCalls?: Array<{
    id: string;
    name: string;
    input: Record<string, unknown>;
  }>;
  rawContentBlocks?: Anthropic.ContentBlock[];
}
```

### 9.2 AnthropicProvider

**Source:** `provider.ts`, lines 168–278

The only implemented provider for the `raw` backend. Wraps the Anthropic SDK.

> **Important:** The Agent SDK backend (`backend: 'agent_sdk'`) bypasses `AgentProvider` entirely. It uses `sdkQuery()` from `@anthropic-ai/claude-agent-sdk` for multi-turn streaming conversations. The provider abstraction documented here applies only to the `raw` backend path.

**Default model:** `DEFAULT_MODEL = 'claude-sonnet-4-20250514'`

**Default timeouts:**

| Agent Type | Timeout |
|-----------|---------|
| Planner | 300,000ms (5 min) |
| Reviewer | 180,000ms (3 min) |
| Implementer | 600,000ms (10 min) |
| Fallback | 300,000ms (5 min) |

**Invoke flow:**

1. Compose timeout signal + external abort signal
2. Use provided `messages` array, or create single user message from `userPrompt`
3. Build `MessageCreateParams` with model, max_tokens, temperature, system, messages, tools
4. Call `client.messages.create()`
5. Extract text blocks (concatenated) and tool_use blocks
6. Return `AgentOutput` with token counts, stop reason, and optional tool calls

### 9.3 Error Types

**Source:** `provider.ts`

| Error Class | Code | Trigger |
|------------|------|---------|
| `AgentError` | (base) | Generic agent error |
| `AgentAuthError` | `auth_error` | API authentication failure |
| `AgentRateLimitError` | `rate_limit` | 429 response, optionally includes `retryAfterMs` |
| `AgentContextLengthError` | `context_length` | Input exceeds model context window |
| `AgentBudgetExceededError` | `budget_exceeded` | Estimated tokens exceed configured budget |
| `AgentUnsupportedProviderError` | `unsupported_provider` | Non-Anthropic provider requested |
| `AgentTimeoutError` | `timeout` | Operation exceeded timeout |
| `AgentCancelledError` | `cancelled` | Run cancelled via abort signal or DB phase check |

---

## 10. Message Persistence

### 10.1 Agent Messages Table

Every message exchanged during an agent invocation is persisted to the `agent_messages` table.

**Source:** `packages/shared/src/agent-runtime/agent-messages.ts`

```typescript
export interface AgentMessage {
  agentMessageId: string;
  agentInvocationId: string;
  runId: string;
  turnIndex: number;
  role: 'system' | 'user' | 'assistant' | 'tool_result';
  contentJson: string;
  tokensInput?: number;
  tokensOutput?: number;
  stopReason?: string;
  contentSizeBytes: number;
  createdAt: string;
}
```

### 10.2 Message Size Guard

**Source:** `agent-messages.ts`, lines 57–122

| Constraint | Value |
|-----------|-------|
| Max content per message | `MAX_CONTENT_JSON_BYTES = 512 * 1024` (512KB) |

When a message exceeds the size limit, content is replaced with a role-aware truncation stub:

| Role | Replacement |
|------|------------|
| `system` / `user` | Simple string message noting truncation |
| `assistant` | Text block noting truncation |
| `tool_result` | Tool result block noting truncation |

### 10.3 Agent Invocations Table

Each agent call (planner, implementer, reviewer) creates an invocation record that tracks the full lifecycle.

**Source:** `packages/shared/src/agent-runtime/invocations.ts`

```typescript
export interface AgentInvocation {
  agentInvocationId: string;
  runId: string;
  agent: string;
  action: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'timed_out';
  tokensInput: number;
  tokensOutput: number;
  durationMs?: number;
  contextSummary?: string;
  errorCode?: string;
  errorMessage?: string;
  startedAt: string;
  completedAt?: string;
}
```

### 10.4 Tool Invocations Table

Each tool call executed within an agent session is tracked individually.

**Source:** `packages/shared/src/agent-runtime/tool-invocations.ts`

```typescript
export interface ToolInvocation {
  toolInvocationId: string;
  agentInvocationId: string;
  runId: string;
  tool: string;
  target?: string;
  argsRedactedJson: string;
  argsFieldsRemovedJson: string;
  argsSecretsDetected: boolean;
  argsPayloadHash: string;
  argsPayloadHashScheme: string;
  resultMetaJson: string;
  resultPayloadHash: string;
  resultPayloadHashScheme: string;
  policyDecision: string;
  policyId?: string;
  policySetId?: string;
  violationId?: string;
  status: 'started' | 'completed' | 'failed' | 'blocked';
  durationMs: number;
  createdAt: string;
}
```

**Hash scheme:** `sha256:cjson:v1` — args payload uses canonical JSON hashing; result payload uses `JSON.stringify()` (not canonicalized) despite sharing the same scheme label.

---

## 11. Backend Types

### 11.1 Raw Backend (`backend: 'raw'`)

**Routing by step:**

| Step | Function | Execution Mode |
|------|----------|---------------|
| Planner | `runPlanner()` | Single request → single response. Returns markdown plan. |
| Plan Reviewer | `runReviewer()` | Single request → single response. Parses first-line verdict. |
| Code Reviewer | `runReviewer()` | Single request → single response. Parses first-line verdict. |
| Implementer | `runImplementerWithTools()` | **Multi-turn tool loop** via `runToolLoop()` (§ 5.5). This is the primary production path. |

> **Legacy note:** The `runImplementer()` function and `IMPLEMENTER_SYSTEM_PROMPT` with `=== FILE: ... ===` marker parsing exist in the codebase but are **not routed by the worker**. The worker always dispatches raw implementer calls to `runImplementerWithTools()`.

### 11.2 Agent SDK Backend (`backend: 'agent_sdk'`)

**Routing by step:**

| Step | Function | Execution Mode |
|------|----------|---------------|
| Planner | `runPlannerWithAgentSDK()` | SDK streaming via `sdkQuery()` with MCP tools |
| Plan Reviewer | `runReviewerWithAgentSDK()` | SDK streaming via `sdkQuery()` with MCP tools |
| Code Reviewer | `runReviewerWithAgentSDK()` | SDK streaming via `sdkQuery()` with MCP tools |
| Implementer | `runImplementerWithAgentSDK()` | SDK streaming via `sdkQuery()` with MCP tools |

The Agent SDK backend uses `@anthropic-ai/claude-agent-sdk` for multi-turn streaming conversations. Tools are exposed as an MCP server that the SDK connects to, rather than being passed as Anthropic API tool definitions.

**Key differences from raw backend:**
- Bypasses `AgentProvider` and `runToolLoop()` entirely
- Uses SDK-specific system prompt constants (separate from the raw prompt constants)
- `model`, `maxTokens`, and `temperature` overrides from `WorkflowConfig` are **ignored** (SDK logs a warning)
- `toolProfile` is honored (controls which tools the MCP server exposes)
- Uses `PLAN_MODE_POLICY_RULES` for planner/reviewer steps (includes `plan_mode_write_block`)

---

## 12. Prompt Versioning

### 12.1 Current State

There is **no formal prompt versioning system**. Prompts change when the source code changes:

| Aspect | Current Approach |
|--------|-----------------|
| Storage | Hardcoded string constants in TypeScript source |
| Versioning | Implicit via git history of agent source files |
| In-flight handling | Running invocations use the prompt from the deployed binary |
| Rollback | Deploy previous application version |

### 12.2 Implications

- Changing a prompt requires a code change, build, and deploy
- There is no mechanism to A/B test prompts or maintain multiple prompt versions simultaneously
- In-flight runs are not affected by prompt changes until the process restarts
- Prompt changes are tracked through git history of `packages/shared/src/agent-runtime/agents/*.ts`

---

## 13. Complete Prompt Examples

### 13.1 Planner Invocation

**System prompt:** `PLANNER_SYSTEM_PROMPT` (§ 2.2)

**User prompt** (assembled by `formatContextForPrompt()`):

```markdown
## Issue #42: Add rate limiting to GitHub webhook handler
Type: feature | State: open
Labels: enhancement, backend

Implement rate limiting on the webhook endpoint to prevent abuse.
When a single IP exceeds 100 requests per minute, return 429.

## Repository: org/conductor
Default branch: main

## Run: run_abc123
Base branch: main
Working branch: feat/rate-limiting

## Repository File Tree
packages/web/src/app/api/webhooks/github/route.ts
packages/shared/src/config/index.ts
...
```

### 13.2 Implementer Invocation (Tool-Use Mode)

**System prompt:** `IMPLEMENTER_TOOLS_SYSTEM_PROMPT` (§ 2.3.2)

**User prompt:** Same structure as planner, but includes:
- `## Current Plan` section with the approved plan
- `## Latest Review Feedback` section if this is a revision

**Tool definitions passed to API:**

```json
[
  { "name": "read_file", "description": "Read the contents of a file...", "input_schema": { "type": "object", "properties": { "path": { "type": "string" } }, "required": ["path"] } },
  { "name": "write_file", "description": "Write or overwrite a file...", "input_schema": { "type": "object", "properties": { "path": { "type": "string" }, "content": { "type": "string" } }, "required": ["path", "content"] } },
  ...
]
```

### 13.3 Plan Reviewer Invocation

**System prompt:** `PLAN_REVIEWER_SYSTEM_PROMPT` (§ 2.4.1)

**User prompt:** Includes `## Issue #N: ...` and `## Current Plan` sections.

**Expected response:**

```
APPROVED — The plan is ready for implementation.

### Strengths
- Clear file-by-file breakdown
- Testing strategy covers edge cases

### Suggestions
- Consider adding a configuration option for the rate limit threshold
```

### 13.4 Code Reviewer Invocation

**System prompt:** `CODE_REVIEWER_SYSTEM_PROMPT` (§ 2.4.2)

**User prompt:** Includes `## Issue #N: ...`, `## Current Plan`, and `## Code Diff` (with git diff output in a fenced code block).

**Expected response:**

```
CHANGES_REQUESTED — The code needs revisions.

### Correctness
- Rate limiting logic correctly tracks per-IP counts

### Completeness
- Missing: cleanup of expired entries from the rate limit map

### Issues
- `packages/web/src/app/api/webhooks/github/route.ts:45` — Memory leak: rate limit entries are never evicted. Add a TTL sweep or use a Map with expiry.
```

---

## 14. Cross-References

| Topic | Document |
|-------|----------|
| Rate limiting and token budgets | `docs/RATE_LIMITING.md` |
| Workflow engine and run phases | `docs/WORKFLOW_TEMPLATES.md` |
| Data model (agent tables) | `docs/DATA_MODEL_AUTHORITY.md` |
| Event model (agent events) | `docs/EVENT_MODEL.md` |
| API contracts (agent endpoints) | `docs/API_CONTRACTS.md` |
| Deployment configuration | `docs/DEPLOYMENT.md` |

---

## Appendix A: Codex Adversarial Review Resolution

**Review date:** 2026-02-20
**Reviewer:** Codex (read-only sandbox)
**Findings:** 35 total — 10 BLOCKING, 11 HIGH, 14 MEDIUM

| # | Severity | Section | Finding | Resolution |
|---|----------|---------|---------|------------|
| 1 | BLOCKING | §1.1 | Pipeline shows single path; `agent_sdk` bypasses provider.ts via `sdkQuery()` | Documented two pipelines (raw vs agent_sdk) with separate flow diagrams |
| 2 | HIGH | §1.2 | Config resolution input is snapshot + overlay, not project + overlay | Updated stage 1 input; added note about creation-time vs runtime resolution |
| 3 | HIGH | §2.1 | More than 5 system prompts — SDK backends have their own prompt constants | Expanded registry table to include all SDK prompt variants |
| 4 | BLOCKING | §2.3.1 | `IMPLEMENTER_SYSTEM_PROMPT` marker-parsing path not routed by worker | Relabeled as legacy; noted worker uses `runImplementerWithTools()` |
| 5 | HIGH | §2.3.2 | Tool prompt used in both raw tool-loop and `agent_sdk` implementer | Updated "Used when" to note both backends reference this prompt |
| 6 | BLOCKING | §3.2 | defaultBranch from `project.defaultBaseBranch ?? 'main'`, not repo record | Corrected step 4 in assembly steps |
| 7 | MEDIUM | §3.4 | Sensitive check via `isSensitiveFile()` includes both patterns AND extensions | Updated validation step to mention both checks |
| 8 | MEDIUM | §4.3 | Small-budget branch: if budget < hint length, slices the hint | Added small-budget branch behavior |
| 9 | BLOCKING | §4.4 | Section headings wrong: `## Issue #N: Title`, `## Current Plan`, `## Repository File Tree`, etc. | Replaced entire example with actual formatter output format |
| 10 | HIGH | §4.4 | Missing `MAX_TOTAL_CONTEXT_CHARS = 100,000` global safety cap | Documented global truncation after per-section budgets |
| 11 | BLOCKING | §5.4 | Compaction failure throws `AgentBudgetExceededError`, doesn't degrade | Changed "return whatever fits" to "throws error" |
| 12 | MEDIUM | §5.5 | Retry sleep uses provider's `retryAfterMs` when available, then fallback exponential | Added `retryAfterMs` precedence |
| 13 | BLOCKING | §6.4 | write_file content redacted as `{ contentHash, contentSizeBytes }`, not `"[content omitted]"` | Corrected redaction description |
| 14 | MEDIUM | §6.4 | Policy-blocked calls created as `status: blocked` immediately, not `started` | Added separate blocked path in pipeline |
| 15 | BLOCKING | §6.5 | Missing `sensitive_file_write` and `shell_injection` policy rules | Added both policies to built-in table |
| 16 | HIGH | §6.5 | Policy IDs are `worktree_boundary`/`dotgit_protection`, not variable names | Separated export name from policyId in table |
| 17 | HIGH | §6.5 | Missing `plan_mode_write_block` policy used by SDK planner/reviewer | Added plan-mode policies section |
| 18 | MEDIUM | §7.2 | Wrong line citation for implementer maxTokens 16384 | Removed specific line citation (legacy path) |
| 19 | HIGH | §7.3 | Resolution hierarchy: creation-time (defaults + project → snapshot) vs runtime (snapshot + overlay) | Split into two stages with clear descriptions |
| 20 | BLOCKING | §7.4 | Backend types wrong: raw implementer uses tool loop, SDK uses streaming | Replaced with per-backend support matrix |
| 21 | BLOCKING | §7.4 | `budgets.maxOutputTokens` not consumed at runtime | Marked as "Not consumed" with explanation |
| 22 | HIGH | §7.4 | `budgets.maxInputTokens` only consumed by raw implementer path | Scoped to "Implementer only" |
| 23 | HIGH | §7.4 | SDK backends ignore `model`, `maxTokens`, `temperature` overrides (log warning) | Added "Ignored" column for SDK backend |
| 24 | MEDIUM | §7.4 | `toolProfile` affects tool registration, not prompt text | Changed wording to "tool availability, not prompt text" |
| 25 | BLOCKING | §8.3 | Source path is `packages/shared/src/utils/redact.ts`, not `agent-runtime/utils/redact.ts` | Corrected file path |
| 26 | MEDIUM | §8.3 | `config_secret` pattern also matches `token` and `apikey`, case-insensitive | Expanded pattern description |
| 27 | HIGH | §9.2 | SDK backends bypass `AgentProvider` entirely; uses `sdkQuery()` | Added explicit note about SDK bypass |
| 28 | MEDIUM | §10.4 | Result payload hash uses plain `JSON.stringify()`, not canonical JSON | Documented mismatch between label and implementation |
| 29 | BLOCKING | §11.1 | Raw implementer production path is `runImplementerWithTools()`, not marker parsing | Rewrote section with per-step routing table; marked marker parsing as legacy |
| 30 | BLOCKING | §11.2 | `runToolLoop()` only for raw backend; SDK uses streaming | Split into separate sections with per-step routing tables |
| 31 | BLOCKING | §13.1 | Example prompt headings don't match actual formatter output | Regenerated example with correct heading format |
| 32 | HIGH | §13.2 | Section names wrong: `## Current Plan`, `## Latest Review Feedback` | Corrected section names in examples |
| 33 | HIGH | §13.4 | Code reviewer uses `## Code Diff` section, not `## Relevant Files` | Corrected to `## Code Diff` |
| 34 | MEDIUM | §2.1 | Prompt definitions not in DB, but runtime instances ARE persisted for audit | Added clarification about runtime message persistence |
| 35 | HIGH | §8.1 | Defense layer table missing sensitive-write blocking and shell-injection blocking | Added three additional policy layers to defense table |
