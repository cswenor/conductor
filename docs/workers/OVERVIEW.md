# Workers & Agents

Status: Normative specification
Audience: Engineering, platform integrators, AI agent developers
Updated: 2026-02-19

---

## 1. The Worker Model

Conductor separates **what needs to be done** (roles) from **who does it** (workers) from **how they do it** (providers and runtimes).

```
Role (abstract)          Worker (instance)           Provider (backend)
─────────────           ──────────────────          ─────────────────
"planner"         →     planner-claude-opus    →    Anthropic API
                        planner-gpt-4          →    OpenAI API
                        planner-local-llama    →    Ollama (local)

"implementer"     →     impl-claude-sonnet     →    Anthropic API
                        impl-codex             →    OpenAI Codex API

"reviewer"        →     reviewer-gpt-4         →    OpenAI API
                        reviewer-gemini        →    Google Gemini API

"linter"          →     eslint-worker          →    (no provider — script)
"tester"          →     vitest-worker          →    (no provider — script)
"deployer"        →     deploy-vercel          →    (no provider — script)
```

**The orchestrator only sees roles and capabilities.** It requests "I need a planner" — not "I need Claude Opus." The provider, model, temperature, and token budget are configuration details hidden behind the worker instance.

This means:
- Teams choose which LLM fills each role
- Different roles can use different providers
- Multiple workers can fill the same role (with different models/configs)
- Script workers don't need providers at all
- Swapping providers requires zero orchestrator changes

---

## 2. Core Concepts

### 2.1 Roles

A **role** defines what a worker can do. It is a named set of capabilities that the orchestrator routes tasks to.

```typescript
interface Role {
  role_id: string;                    // e.g., 'planner', 'implementer', 'reviewer'
  display_name: string;
  description: string;

  // What this role can do
  capabilities: string[];             // Operations: 'planning.create', 'planning.revise', etc.

  // What kind of worker fills this role
  worker_class: 'ai' | 'script' | 'human' | 'service';

  // Constraints
  requires_llm: boolean;
  requires_code_access: boolean;      // Needs filesystem / git access?
  requires_network: boolean;          // Needs external API access?

  // Defaults (overridable per worker instance)
  default_timeout_ms: number;
  default_max_parallel: number;
  default_sandbox_mode: 'read-only' | 'workspace-write' | 'full-access';
}
```

Roles are abstract. "Planner" doesn't say anything about Claude vs GPT vs Gemini. It says "this worker can create and revise implementation plans."

### 2.2 Workers

A **worker** is a concrete instance that fills a role. It combines a role with a specific provider, model, and configuration.

```typescript
interface WorkerConfig {
  worker_id: string;                  // e.g., 'planner-claude-opus'
  role_id: string;                    // e.g., 'planner'
  display_name: string;

  // Provider (null for script/human workers)
  provider_id?: string;               // e.g., 'anthropic', 'openai', 'google', 'ollama'
  model_id?: string;                  // e.g., 'claude-opus-4-6', 'gpt-4.1', 'gemini-2.5-pro'

  // AI configuration (null for script/human workers)
  ai_config?: {
    temperature: number;              // 0.0 - 1.0
    max_tokens: number;               // Per-request token limit
    token_budget: number;             // Per-task total token budget
    system_prompt?: string;           // Role-specific system prompt override
    thinking_enabled?: boolean;       // Extended thinking (Anthropic-specific)
    reasoning_effort?: string;        // Reasoning effort level (provider-specific)
  };

  // Script configuration (null for AI/human workers)
  script_config?: {
    script_path: string;              // Path to executable
    runtime: 'bash' | 'node' | 'python' | 'deno' | 'binary';
    args?: string[];                  // Default arguments
    env?: Record<string, string>;     // Environment variables
  };

  // Common configuration
  sandbox_mode: 'read-only' | 'workspace-write' | 'full-access';
  max_parallel: number;
  timeout_ms: number;
  retry_config: {
    max_attempts: number;
    backoff_ms: number;
    backoff_multiplier: number;
  };

  // Scheduling
  enabled: boolean;
  priority_boost: number;             // Preference over other workers with same role
}
```

Multiple workers can fill the same role. If a team registers both `planner-claude-opus` and `planner-gpt-4` for the `planner` role, the orchestrator picks one based on availability, priority boost, and success rate.

### 2.3 Providers

A **provider** is an API backend that AI workers call to run LLM inference.

```typescript
interface ProviderConfig {
  provider_id: string;                // e.g., 'anthropic', 'openai', 'google', 'ollama', 'custom'
  display_name: string;
  provider_type: 'anthropic' | 'openai_compatible' | 'google' | 'ollama' | 'custom';

  // Connection
  base_url: string;                   // API endpoint
  api_key_ref: string;                // Reference to secret store (never stored in plain text)

  // Available models
  models: ProviderModel[];

  // Rate limits
  rate_limit: {
    requests_per_minute: number;
    tokens_per_minute: number;
    concurrent_requests: number;
  };

  // Cost tracking
  cost_tracking: {
    enabled: boolean;
    input_cost_per_1k: number;        // USD per 1K input tokens
    output_cost_per_1k: number;       // USD per 1K output tokens
  };
}

interface ProviderModel {
  model_id: string;                   // e.g., 'claude-opus-4-6'
  display_name: string;
  context_window: number;             // Max tokens
  supports_tools: boolean;
  supports_vision: boolean;
  supports_thinking: boolean;         // Extended thinking / chain-of-thought
  max_output_tokens: number;
}
```

Conductor ships with built-in provider definitions for Anthropic, OpenAI, and Google. Users add their API keys and optionally configure custom providers (any OpenAI-compatible API, local Ollama instances, etc.).

### 2.4 Configuration Hierarchy

Configuration flows from broad defaults to specific overrides:

```
Provider defaults (rate limits, base URL)
    └── Role defaults (timeout, sandbox, capabilities)
        └── Worker instance config (model, temperature, token budget)
            └── Project overrides (per-project worker settings)
                └── Run overrides (per-run priority, timeout)
```

Each level can override the one above it. The most specific setting wins.

**Example:** The `planner` role defaults to `timeout_ms: 300000` (5 min). A specific worker `planner-claude-opus` overrides to `timeout_ms: 600000` (10 min) because Opus is thorough but slow. A specific project overrides to `timeout_ms: 180000` (3 min) because they want fast iteration. A specific high-priority run overrides to `timeout_ms: 900000` (15 min) because this is a complex epic.

---

## 3. Worker Classes

### 3.1 AI Workers

AI workers use LLM inference to perform tasks that require reasoning. They are the most flexible but most expensive worker class.

**What makes an AI worker:**
- Requires an LLM provider (Claude, GPT, Gemini, local model, etc.)
- Non-deterministic (same input may produce different output)
- Stateless between tasks (context injected per-task, not carried over)
- Token-budgeted (cost per task is tracked and limited)
- Can use tools (file read/write, search, terminal, MCP tools)

**Built-in AI roles:**

| Role | Capabilities | Typical Models | Notes |
| --- | --- | --- | --- |
| `planner` | `planning.create`, `planning.revise`, `planning.scope_map` | Claude Opus, GPT-4.1, Gemini 2.5 Pro | Highest reasoning capability needed |
| `implementer` | `implementation.execute`, `implementation.test`, `implementation.prepare_pr` | Claude Sonnet, GPT-4.1, Codex | Needs code access (workspace-write) |
| `reviewer` | `review.plan`, `review.code`, `review.scope` | Claude Opus, GPT-4.1 | Read-only sandbox sufficient |
| `researcher` | `research.investigate`, `research.document` | Any capable model | Read-only, may need web access |
| `documenter` | `docs.generate`, `docs.update` | Claude Sonnet, GPT-4.1-mini | Lower cost model often sufficient |

**Model selection guidance:**

| Need | Recommended Approach |
| --- | --- |
| Best quality planning | Highest-capability model (Opus, GPT-4.1) |
| Fast implementation | Balance of speed and quality (Sonnet, GPT-4.1) |
| Cost-sensitive review | Capable but cheaper model (Sonnet, GPT-4.1-mini) |
| High-volume triage | Fast, cheap model (Haiku, GPT-4.1-mini, Gemini Flash) |
| Privacy-sensitive | Local model (Ollama + Llama, vLLM) |

Teams configure this based on their budget, quality requirements, and privacy needs. There is no "right" answer — Conductor doesn't prefer any provider.

### 3.2 Script Workers

Script workers are executables that perform deterministic tasks. They don't need LLM inference.

**What makes a script worker:**
- No LLM provider needed
- Deterministic (same input → same output, modulo external state)
- Fast (seconds, not minutes)
- Cheap (compute only, no token costs)
- Highly parallelizable

**Built-in script roles:**

| Role | Capabilities | Runtime | Notes |
| --- | --- | --- | --- |
| `linter` | `script.lint` | Node (ESLint), Python (ruff), etc. | Read-only |
| `formatter` | `script.format` | Node (Prettier), Python (black), etc. | Workspace-write |
| `tester` | `script.test` | Node (vitest/jest), Python (pytest), etc. | Read-only (workspace-write for coverage) |
| `builder` | `script.build` | Node (tsc/esbuild), Rust (cargo), etc. | Workspace-write |
| `deployer` | `script.deploy` | Bash/Node (Vercel, fly.io, etc.) | Full-access (needs network) |
| `migrator` | `script.migrate` | Node/Python (DB migration tools) | Full-access |
| `notifier` | `script.notify` | Bash/Node (Slack, email, etc.) | Read-only + network |
| `metrics` | `script.metrics` | Node/Python (collectors, reporters) | Read-only |
| `validator` | `script.validate` | Node/Python (schema validation, etc.) | Read-only |

**Packaging a script worker:**

Any executable can be a script worker. Conductor provides a thin wrapper that handles:
1. Reading the task request from stdin (JSON)
2. Running the script
3. Writing the task result to stdout (JSON)
4. Handling timeouts and signals

```bash
# Minimal script worker (reads JSON from stdin, writes JSON to stdout)
#!/bin/bash
INPUT=$(cat)
OPERATION=$(echo "$INPUT" | jq -r '.operation')

case "$OPERATION" in
  "script.lint")
    RESULT=$(eslint --format json src/)
    EXIT=$?
    echo "{\"state\": \"$([ $EXIT -eq 0 ] && echo completed || echo failed)\", \"output\": $RESULT}"
    ;;
  *)
    echo '{"state": "failed", "output": {"error": "unknown operation"}}'
    ;;
esac
```

See `PROTOCOL.md` for the full task request/result schema.

### 3.3 Human Workers

Human workers are people who perform tasks through Conductor's interfaces.

**What makes a human worker:**
- No LLM, no script — a real person
- Routed through interfaces (Web UI, OpenClaw, email, Slack)
- Slowest (minutes to hours/days)
- Most expensive (human attention)
- Best for judgment calls that AI and scripts can't make

**Built-in human roles:**

| Role | Capabilities | Typical Assignment |
| --- | --- | --- |
| `human_reviewer` | `review.code`, `review.plan` | Named reviewer or team queue |
| `plan_approver` | `gate.plan_approval` | Project owner or designated approver |
| `merge_approver` | `gate.merge_approval` | Project owner or designated approver |
| `human_security` | `review.code`, `review.security` | Security team member |
| `human_product` | `review.requirements`, `gate.scope_approval` | Product owner |

Human workers don't register via the protocol the way AI and script workers do. Instead, the orchestrator creates human tasks and routes them through notification channels. The human responds via the interface, and the response is translated into a task result.

### 3.4 Service Workers

Service workers are long-running processes that accept tasks continuously.

**What makes a service worker:**
- Always running (not spawned per-task)
- Stateful (may maintain internal state across tasks)
- Registered once, serves indefinitely
- May or may not use LLM

**Built-in service roles:**

| Role | Capabilities | Notes |
| --- | --- | --- |
| `pm_engine` | All `conductor_*` PM intelligence tools | Singleton, SQLite-backed |
| `ci_service` | `script.ci_trigger`, `script.ci_status` | Wraps GitHub Actions / GitLab CI / etc. |

---

## 4. Provider System

### 4.1 Built-in Providers

Conductor ships with provider definitions for major LLM APIs. Users supply their own API keys.

#### Anthropic

```yaml
provider_id: anthropic
provider_type: anthropic
base_url: https://api.anthropic.com
models:
  - model_id: claude-opus-4-6
    context_window: 200000
    max_output_tokens: 32000
    supports_tools: true
    supports_vision: true
    supports_thinking: true
  - model_id: claude-sonnet-4-6
    context_window: 200000
    max_output_tokens: 16000
    supports_tools: true
    supports_vision: true
    supports_thinking: true
  - model_id: claude-haiku-4-5
    context_window: 200000
    max_output_tokens: 8192
    supports_tools: true
    supports_vision: true
    supports_thinking: false
```

**Anthropic-specific features:**
- Extended thinking (`thinking_enabled: true`) — lets the model reason before responding
- Tool use with forced tool choice
- Prompt caching for repeated context
- Batch API for non-urgent tasks (lower cost)

#### OpenAI

```yaml
provider_id: openai
provider_type: openai_compatible
base_url: https://api.openai.com/v1
models:
  - model_id: gpt-4.1
    context_window: 1000000
    max_output_tokens: 32768
    supports_tools: true
    supports_vision: true
    supports_thinking: true
  - model_id: gpt-4.1-mini
    context_window: 1000000
    max_output_tokens: 16384
    supports_tools: true
    supports_vision: true
    supports_thinking: true
  - model_id: gpt-4.1-nano
    context_window: 1000000
    max_output_tokens: 16384
    supports_tools: true
    supports_vision: false
    supports_thinking: false
  - model_id: o3
    context_window: 200000
    max_output_tokens: 100000
    supports_tools: true
    supports_vision: true
    supports_thinking: true
```

**OpenAI-specific features:**
- Reasoning effort parameter for o-series models
- Structured outputs (JSON mode)
- Function calling with parallel tool use

#### Google

```yaml
provider_id: google
provider_type: google
base_url: https://generativelanguage.googleapis.com/v1beta
models:
  - model_id: gemini-2.5-pro
    context_window: 1000000
    max_output_tokens: 65536
    supports_tools: true
    supports_vision: true
    supports_thinking: true
  - model_id: gemini-2.5-flash
    context_window: 1000000
    max_output_tokens: 65536
    supports_tools: true
    supports_vision: true
    supports_thinking: true
```

#### Local (Ollama)

```yaml
provider_id: ollama
provider_type: ollama
base_url: http://localhost:11434
models: []  # Discovered dynamically from Ollama API
```

Local models are discovered at runtime by querying the Ollama API. Users pull models separately (`ollama pull llama3.3`).

**When to use local models:**
- Privacy-sensitive environments (no data leaves the network)
- Cost-sensitive high-volume tasks (triage, classification)
- Development/testing (fast iteration without API costs)
- Airgapped environments

#### Custom (OpenAI-Compatible)

Any API that implements the OpenAI chat completions format:

```yaml
provider_id: custom-internal
provider_type: openai_compatible
base_url: https://llm.internal.company.com/v1
models:
  - model_id: internal-codegen-v3
    context_window: 32000
    max_output_tokens: 8192
    supports_tools: true
    supports_vision: false
    supports_thinking: false
```

This covers vLLM, Together AI, Fireworks, Groq, Azure OpenAI, AWS Bedrock (via compatibility layer), and any other OpenAI-compatible endpoint.

### 4.2 Provider Abstraction Layer

The orchestrator never calls provider APIs directly. A **Provider Adapter** translates between Conductor's internal format and each provider's API:

```
Worker receives task
    │
    ▼
Worker runtime prepares prompt (system prompt + task context + tools)
    │
    ▼
Provider Adapter translates to provider-specific format:
    ├── Anthropic: Messages API format, tool_use blocks
    ├── OpenAI: Chat completions format, function_call
    ├── Google: GenerateContent format, function_declarations
    └── Ollama: Chat API format (subset of OpenAI)
    │
    ▼
Provider API call (with retry, rate limiting, timeout)
    │
    ▼
Provider Adapter normalizes response back to internal format
    │
    ▼
Worker produces task result
```

**What the adapter handles:**
- Request format translation (messages, tools, system prompts)
- Response format normalization (content, tool calls, token usage)
- Provider-specific features (thinking for Anthropic, reasoning_effort for OpenAI)
- Error normalization (rate limits, auth failures, model errors → standard error codes)
- Token counting (provider-specific tokenizers for accurate budget tracking)
- Cost tracking (provider-specific pricing applied to usage)

### 4.3 Multi-Provider Strategies

Teams can configure different providers for different roles or contexts:

**Strategy: Best-of-breed**
```
planner    → Anthropic Claude Opus (best reasoning)
implementer → Anthropic Claude Sonnet (good code, reasonable cost)
reviewer   → OpenAI GPT-4.1 (different perspective from implementer)
triage     → Google Gemini Flash (cheap, fast, good enough)
```

**Strategy: Single provider**
```
planner    → Anthropic Claude Opus
implementer → Anthropic Claude Sonnet
reviewer   → Anthropic Claude Opus
triage     → Anthropic Claude Haiku
```

**Strategy: Cost-optimized**
```
planner    → OpenAI GPT-4.1-mini (cheaper planning)
implementer → Local Ollama Llama (free, privacy)
reviewer   → OpenAI GPT-4.1-mini (cheaper review)
triage     → Local Ollama Llama (free, fast)
```

**Strategy: Failover**
```
planner    → Anthropic Claude Opus
             ↓ (if Anthropic API is down)
             OpenAI GPT-4.1 (fallback)
```

Provider failover is configured per-worker:

```typescript
interface WorkerFailover {
  primary_provider: string;
  primary_model: string;
  fallback_provider?: string;
  fallback_model?: string;
  failover_trigger: 'api_error' | 'rate_limit' | 'timeout';
  failover_cooldown_ms: number;       // How long to stay on fallback
}
```

---

## 5. Role Configuration

### 5.1 Default Role Assignments

Conductor ships with a default configuration that works out of the box with an Anthropic API key:

```yaml
# Default role → worker mapping (conductor.defaults.yaml)
roles:
  planner:
    provider: anthropic
    model: claude-sonnet-4-6
    temperature: 0.7
    token_budget: 100000
    sandbox: read-only

  implementer:
    provider: anthropic
    model: claude-sonnet-4-6
    temperature: 0.3
    token_budget: 200000
    sandbox: workspace-write

  reviewer:
    provider: anthropic
    model: claude-sonnet-4-6
    temperature: 0.2
    token_budget: 50000
    sandbox: read-only

  researcher:
    provider: anthropic
    model: claude-sonnet-4-6
    temperature: 0.5
    token_budget: 80000
    sandbox: read-only

  # Script workers (no provider needed)
  linter:
    runtime: node
    script: eslint

  tester:
    runtime: node
    script: vitest

  builder:
    runtime: node
    script: tsc
```

Users override any of these in their project configuration:

```yaml
# Project-specific overrides (conductor.project.yaml)
roles:
  planner:
    provider: openai
    model: gpt-4.1
    temperature: 0.5

  reviewer:
    provider: anthropic
    model: claude-opus-4-6     # Upgrade reviewer to Opus for this project
    token_budget: 80000

  tester:
    script: pytest              # This project uses Python
    runtime: python
```

### 5.2 Custom Roles

Teams can define custom roles for domain-specific tasks:

```yaml
# Custom role definition
custom_roles:
  security_scanner:
    display_name: "Security Scanner"
    worker_class: script
    capabilities: ["script.security_scan"]
    runtime: python
    script: bandit
    sandbox: read-only

  api_tester:
    display_name: "API Integration Tester"
    worker_class: script
    capabilities: ["script.api_test"]
    runtime: node
    script: ./scripts/api-test-runner.sh
    sandbox: full-access       # Needs network for API calls

  compliance_reviewer:
    display_name: "Compliance Reviewer"
    worker_class: ai
    capabilities: ["review.compliance"]
    provider: anthropic
    model: claude-opus-4-6
    system_prompt: |
      You are a compliance reviewer for a regulated financial services company.
      Check all code changes against SOC2 controls and PCI-DSS requirements.
      Flag any changes that touch authentication, authorization, logging, or data storage.
    temperature: 0.1
    token_budget: 60000
    sandbox: read-only
```

Custom roles are registered with the orchestrator and can be used in workflow templates just like built-in roles.

### 5.3 Role Specialization

A role can be specialized for specific areas or work item types:

```yaml
roles:
  implementer:
    provider: anthropic
    model: claude-sonnet-4-6

    # Area-specific overrides
    area_overrides:
      frontend:
        system_prompt_append: |
          This project uses React 19 with TypeScript. Follow the project's component patterns.
          Always use server components unless client interactivity is needed.
        temperature: 0.3

      contracts:
        model: claude-opus-4-6   # Upgrade to Opus for smart contract work
        system_prompt_append: |
          This is Solidity smart contract work. Security is paramount.
          Always check for reentrancy, overflow, and access control issues.
        temperature: 0.1
        token_budget: 300000     # Smart contracts need more thorough work

      infra:
        system_prompt_append: |
          This is infrastructure code (Terraform, Docker, CI/CD).
          Always consider idempotency and rollback procedures.
        sandbox: full-access     # Infra changes may need broader access
```

Area overrides are applied when the orchestrator assigns a task. The orchestrator knows the work item's area label and passes the relevant overrides to the worker.

---

## 6. Worker Lifecycle

### 6.1 AI Worker Lifecycle

```
1. Orchestrator determines: need a planner for issue #42
    │
    ▼
2. Orchestrator finds worker: planner-claude-opus (role=planner, available)
    │
    ▼
3. Orchestrator builds task request:
    - Operation: planning.create
    - Input: work item details, acceptance criteria, context
    - Constraints: token_budget, timeout, sandbox_mode
    - Provider config: model, temperature, system_prompt
    │
    ▼
4. Task enqueued to conductor:task:plan queue
    │
    ▼
5. Worker runtime picks up task:
    a. Load provider adapter (Anthropic)
    b. Build prompt (system prompt + task context + tools)
    c. Call provider API (with retry, rate limiting)
    d. Stream progress updates to orchestrator
    e. Collect result (plan artifact)
    │
    ▼
6. Worker reports task result:
    - State: completed
    - Output: plan summary
    - Artifacts: PLAN document
    - Metrics: tokens_used, duration_ms, cost_usd
    │
    ▼
7. Orchestrator evaluates transition based on result
```

**Key detail:** The worker runtime manages the LLM conversation, not the orchestrator. The orchestrator sends a task request and gets a task result. It does not see the individual LLM messages, tool calls, or intermediate reasoning. The worker is a black box.

This is important for provider independence. If the planner uses Claude's extended thinking, the orchestrator doesn't know or care. If it uses GPT's function calling, same thing. The task protocol is the abstraction boundary.

### 6.2 Script Worker Lifecycle

```
1. Orchestrator determines: need to run tests for issue #42
    │
    ▼
2. Orchestrator finds worker: vitest-worker (role=tester, available)
    │
    ▼
3. Orchestrator builds task request:
    - Operation: script.test
    - Input: { test_command: "vitest run", working_dir: "/path/to/worktree" }
    - Constraints: timeout_ms: 120000
    │
    ▼
4. Task enqueued to conductor:task:script:test queue
    │
    ▼
5. Script worker runtime picks up task:
    a. Spawn subprocess: vitest run
    b. Capture stdout/stderr
    c. Parse exit code
    │
    ▼
6. Worker reports task result:
    - State: completed (exit 0) or failed (non-zero exit)
    - Output: test report
    - Artifacts: TEST_REPORT (JSON test results)
    - Metrics: duration_ms
    │
    ▼
7. Orchestrator evaluates gate: tests_pass
```

Script workers are simpler than AI workers. No LLM, no token budget, no provider. Just run a command, capture output, report result.

### 6.3 Human Worker Lifecycle

```
1. Orchestrator determines: need plan approval for issue #42
    │
    ▼
2. Orchestrator creates human task:
    - Operation: gate.plan_approval
    - Assigned to: project owner (or designated approver)
    │
    ▼
3. Notification sent via configured channels:
    - Web UI: approval card appears in dashboard
    - Slack: message with "Approve" / "Reject" buttons
    - Email: approval link
    │
    ▼
4. Human reviews plan and responds:
    - Via Web UI: clicks Approve/Reject, optionally adds comment
    - Via Slack: clicks button
    - Via OpenClaw: `openclaw approve plan --run <id>`
    │
    ▼
5. Interface translates response to task result:
    - State: completed
    - Output: { decision: "approved", comment: "Looks good" }
    │
    ▼
6. Orchestrator evaluates gate: plan_approval passed
```

### 6.4 Service Worker Lifecycle

```
1. PM Engine starts up
    │
    ▼
2. PM Engine registers with orchestrator:
    - Worker ID: pm-engine-1
    - Role: pm_engine
    - Capabilities: all conductor_* tools
    - Max parallel: 10 (can handle concurrent queries)
    │
    ▼
3. PM Engine begins heartbeat cycle (every 30s)
    │
    ▼
4. Orchestrator routes PM queries to PM Engine as tasks:
    - conductor_predict_rework → task on conductor:pm queue
    - PM Engine processes, returns result
    │
    ▼
5. PM Engine runs indefinitely until shutdown
    │
    ▼
6. On graceful shutdown: deregistration, drain active tasks
```

---

## 7. Context Injection

AI workers receive context with each task. How that context is assembled is critical to output quality.

### 7.1 Context Components

Every AI task includes:

| Component | Source | Priority |
| --- | --- | --- |
| **System prompt** | Role config + area override + project override | Always included |
| **Work item details** | PM Engine (title, body, acceptance criteria, non-goals) | Always included |
| **Relevant comments** | Source system (GitHub comments, review feedback) | Always included |
| **Plan** (if exists) | Previous planning phase artifact | If available |
| **Approach suggestion** | PM Engine `conductor_suggest_approach` | If available |
| **Code context** | Files referenced in work item, recent changes | Task-dependent |
| **Project docs** | CLAUDE.md, architecture docs, style guides | Loaded by role config |
| **History insights** | PM Engine `conductor_get_history_insights` | If available |

### 7.2 Context Budget Management

LLMs have finite context windows. The orchestrator manages a context budget per task:

```
Total context window (e.g., 200K tokens for Claude Opus)
    │
    ├── System prompt + role instructions:     ~2K tokens (reserved)
    ├── Work item + comments:                  ~5K tokens (reserved)
    ├── Plan/artifacts:                        ~10K tokens (reserved)
    ├── Code context:                          ~50K tokens (variable)
    ├── Project docs:                          ~20K tokens (variable)
    └── Working space (for output + reasoning): remaining
```

The worker runtime manages this budget:
1. Reserved components always included (system prompt, work item).
2. Variable components included in priority order until budget is spent.
3. Working space is always at least 30% of the context window.

### 7.3 Tool Access

AI workers can use tools during execution. Which tools are available depends on the role and sandbox mode:

| Tool Category | read-only | workspace-write | full-access |
| --- | --- | --- | --- |
| File read (glob, grep, read) | Yes | Yes | Yes |
| File write (edit, write) | No | Yes | Yes |
| Terminal (bash) | Limited (read-only commands) | Yes (project dir only) | Yes |
| Git operations | Read-only (log, diff, blame) | Branch, commit, push | All |
| MCP tools (PM Engine, etc.) | Read-only tools | Read + write tools | All tools |
| Network (fetch, API calls) | No | No | Yes |

---

## 8. Checkpointing and Recovery

AI workers can checkpoint their progress so that if they crash or timeout, work is not lost.

### 8.1 Checkpoint Model

```typescript
interface Checkpoint {
  task_id: string;
  checkpoint_id: string;
  created_at: string;

  // What was accomplished
  completed_steps: string[];          // e.g., ['read_issue', 'create_plan', 'write_auth_module']
  remaining_steps: string[];          // e.g., ['write_tests', 'run_tests']

  // State to restore
  artifacts_so_far: ArtifactRef[];    // Files created, plans written
  conversation_summary: string;       // Compressed context for resumption

  // Where to resume
  resume_from: string;                // Step ID to resume from
}
```

### 8.1.1 Checkpoint Ownership and Storage

Checkpoints follow a **worker-writes, orchestrator-owns** model:

1. **Worker writes:** The worker emits `task.checkpoint` messages during execution. The worker holds an ephemeral copy in memory.
2. **Orchestrator persists:** The orchestrator receives the checkpoint via the protocol transport and persists it to PostgreSQL (`run_events` table with `event_type='checkpoint'`). This is the durable copy.
3. **Orchestrator injects:** When creating a retry/resume task, the orchestrator reads the latest valid checkpoint from the database and injects it into the `task.request` as the `checkpoint` field (see `PROTOCOL.md § 1.5`).

Workers MUST NOT rely on their own in-memory checkpoint state for resumption — they may be assigned to a different worker instance. The `task.request.checkpoint` field is the sole resumption input.

### 8.1.2 Failover Restart Semantics

When a worker fails mid-task (crash, timeout, context overflow), the restart follows this sequence:

```
Worker dies / times out
    │
    ▼
Orchestrator detects (heartbeat timeout or error result)
    │
    ▼
Load latest checkpoint from DB for this task
    │
    ├── Checkpoint exists AND valid (anchors still hold)
    │   → Create new task.request with checkpoint field populated
    │   → resume_from tells new worker where to continue
    │   → Artifacts from checkpoint are assumed present (verified by hash)
    │
    ├── Checkpoint exists BUT invalid (anchors broken, e.g., branch force-pushed)
    │   → Discard checkpoint
    │   → Create fresh task.request (checkpoint: null)
    │   → Worker starts from scratch
    │
    └── No checkpoint
        → Create fresh task.request (checkpoint: null)
        → Worker starts from phase beginning
    │
    ▼
Increment attempt_number
If attempt_number > max_attempts → block run, escalate
```

**Artifact verification:** When resuming from a checkpoint, the orchestrator verifies that each artifact in `artifacts_so_far` exists at its declared path with the expected hash. If any artifact is missing or corrupted, the checkpoint is treated as invalid.

**Context overflow special case:** When a worker reports `CONTEXT_TOO_LARGE`, the orchestrator creates a resume task with the checkpoint AND a directive to the worker to use `conversation_summary` instead of loading the full conversation history. This prevents the same overflow from recurring.

### 8.2 Checkpoint Frequency

- **AI workers:** Checkpoint after each significant step (plan completed, file written, test run).
- **Script workers:** No checkpointing (they're fast and idempotent — just re-run).
- **Human workers:** No checkpointing (the human's state is in their head).
- **Service workers:** Internal state management (PM Engine uses SQLite).

---

## 9. Cost Tracking

### 9.1 Per-Task Cost

Every AI task tracks:

```typescript
interface TaskCost {
  task_id: string;
  provider_id: string;
  model_id: string;

  input_tokens: number;
  output_tokens: number;
  thinking_tokens?: number;           // Anthropic extended thinking
  cached_tokens?: number;             // Anthropic prompt caching

  cost_usd: number;                   // Calculated from provider pricing
  duration_ms: number;
}
```

### 9.2 Budget Enforcement

Budgets are enforced at multiple levels:

| Level | Budget | Enforcement |
| --- | --- | --- |
| Per-task | `token_budget` in worker config | Worker runtime stops if exceeded |
| Per-run | Sum of all task budgets | Orchestrator blocks run if exceeded |
| Per-project monthly | `monthly_token_budget` in project config | Orchestrator blocks new runs if exceeded |
| Per-provider | Rate limits from provider config | Provider adapter enforces |

When a budget is hit, the orchestrator emits a `budget.exhausted` event and blocks the affected entity (task, run, or project). A human can increase the budget via the interface.

### 9.2.1 Budget Storage and Locking

Budget tracking uses PostgreSQL with row-level locking to prevent concurrent task starts from exceeding limits:

```typescript
interface BudgetRecord {
  scope: 'task' | 'run' | 'project';   // Budget level
  scope_id: string;                      // task_id, run_id, or project_id

  // Configured limits (set by human, immutable during execution)
  token_limit: number;                   // Max tokens allowed
  cost_limit_usd: number;               // Max cost allowed (0 = unlimited)

  // Running totals (updated by orchestrator after each task completes)
  tokens_consumed: number;               // Tokens used so far
  cost_consumed_usd: number;             // Cost incurred so far

  // Derived (NOT stored — computed on read)
  // tokens_remaining = token_limit - tokens_consumed
  // cost_remaining = cost_limit_usd - cost_consumed_usd

  updated_at: string;                    // Last update timestamp
}
```

**Locking protocol:**

```
Before dispatching a task:
    │
    ▼
SELECT ... FROM budgets WHERE scope_id = <run_id> FOR UPDATE
    │
    ├── tokens_consumed + estimated_tokens > token_limit
    │   → Reject dispatch, emit budget.exhausted event
    │
    └── Within budget
        → Reserve estimated_tokens (optimistic)
        → Dispatch task
        │
        ▼
On task completion:
    → UPDATE budgets SET tokens_consumed = tokens_consumed + actual_tokens,
      cost_consumed_usd = cost_consumed_usd + actual_cost
      WHERE scope_id = <run_id>
    → Release reservation difference
```

**Key invariant:** `token_limit` and `cost_limit_usd` are configuration values set by the human. `tokens_consumed` and `cost_consumed_usd` are running counters updated by the orchestrator. These are never conflated — the budget check always compares consumed against limit.

### 9.3 Cost Optimization

The orchestrator can optimize costs by:
- **Routing cheap tasks to cheap models:** Triage and classification to Haiku/GPT-4.1-nano/Flash.
- **Batching non-urgent tasks:** Use Anthropic's Batch API or similar for tasks that don't need real-time results.
- **Caching repeated context:** Prompt caching for system prompts and project docs that don't change between tasks.
- **Using local models:** Route privacy-sensitive or high-volume tasks to Ollama.

---

## 10. Further Reading

| Document | Content |
| --- | --- |
| `PROTOCOL.md` | Wire protocol — task request/result format, registration, heartbeat |
| `AI_PROVIDERS.md` | Provider adapter details, API format translation, error handling |
| `ROLES.md` | Complete built-in role specifications, custom role authoring guide |
| `../orchestrator/OVERVIEW.md` | How the orchestrator assigns work to workers |
| `../orchestrator/WORKFLOW_ENGINE.md` | How roles map to workflow phases |
| `../pm-engine/INTERFACES.md` | PM Engine tool catalog (what service workers expose) |
