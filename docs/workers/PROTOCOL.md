# Worker Protocol

Status: Normative specification
Audience: Engineering, worker implementors
Updated: 2026-02-19

This document specifies the wire protocol between the orchestrator and workers. Every worker — AI, script, human, or service — uses this protocol. The transport varies (in-process, HTTP, MCP, subprocess), but the message format is identical.

---

## 1. Messages

### 1.1 Registration Request

Worker → Orchestrator (on startup):

```json
{
  "type": "worker.register",
  "worker_id": "planner-claude-opus-1",
  "role_id": "planner",
  "worker_class": "ai",
  "display_name": "Planner (Claude Opus)",
  "capabilities": [
    { "operation": "planning.create", "priority_boost": 0 },
    { "operation": "planning.revise", "priority_boost": 0 },
    { "operation": "planning.scope_map", "priority_boost": 0 }
  ],
  "max_parallel": 1,
  "config": {
    "provider_id": "anthropic",
    "model_id": "claude-opus-4-6",
    "sandbox_mode": "read-only",
    "timeout_ms": 600000,
    "token_budget": 100000
  }
}
```

Orchestrator responds:

```json
{
  "type": "worker.registered",
  "worker_id": "planner-claude-opus-1",
  "heartbeat_interval_ms": 30000,
  "assigned_queues": ["conductor:task:plan"]
}
```

### 1.2 Registration Request (Script Worker)

```json
{
  "type": "worker.register",
  "worker_id": "eslint-worker-1",
  "role_id": "linter",
  "worker_class": "script",
  "display_name": "ESLint Linter",
  "capabilities": [
    { "operation": "script.lint", "priority_boost": 0 }
  ],
  "max_parallel": 8,
  "config": {
    "runtime": "node",
    "script_path": "/usr/local/bin/eslint-worker",
    "sandbox_mode": "read-only",
    "timeout_ms": 60000
  }
}
```

### 1.3 Heartbeat

Worker → Orchestrator (every `heartbeat_interval_ms`):

```json
{
  "type": "worker.heartbeat",
  "worker_id": "planner-claude-opus-1",
  "status": "active",
  "current_task_count": 1,
  "current_task_ids": ["task-uuid-1"],
  "resource_usage": {
    "cpu_percent": 45,
    "memory_mb": 512,
    "tokens_used_session": 23500
  }
}
```

Orchestrator responds with acknowledgment (or silence — heartbeat is fire-and-forget if no response needed).

**Heartbeat timeout:** If the orchestrator receives no heartbeat for 60 seconds, the worker is marked `dead` and its active tasks are reassigned (see `../orchestrator/WORKFLOW_ENGINE.md § 6.2`).

### 1.4 Deregistration

Worker → Orchestrator (graceful shutdown):

```json
{
  "type": "worker.deregister",
  "worker_id": "planner-claude-opus-1",
  "reason": "shutdown",
  "drain": true
}
```

If `drain: true`, the orchestrator waits for active tasks to complete before removing the worker. If `drain: false`, active tasks are reassigned immediately.

### 1.5 Task Request

Orchestrator → Worker:

```json
{
  "type": "task.request",
  "task_id": "uuid-task-1",
  "run_id": "uuid-run-1",
  "correlation_id": "uuid-corr-1",
  "operation": "planning.create",
  "input": {
    "work_item": {
      "id": 42,
      "source_ref": "github:acme/webapp#42",
      "title": "Add JWT authentication to API endpoints",
      "type": "feature",
      "area": "backend",
      "body": "...",
      "acceptance_criteria": [
        "All /api/* routes require valid JWT",
        "Token refresh endpoint at /api/auth/refresh",
        "Rate limiting on auth endpoints (10 req/min)"
      ],
      "non_goals": [
        "OAuth/SSO integration (separate issue)",
        "Frontend auth UI (separate issue)"
      ]
    },
    "context": {
      "approach_suggestion": "...",
      "history_insights": "...",
      "related_decisions": [],
      "comments": []
    },
    "artifacts": []
  },
  "constraints": {
    "timeout_ms": 600000,
    "token_budget": 100000,
    "sandbox_mode": "read-only",
    "autonomy_level": 2,
    "max_output_tokens": 32000
  },
  "provider_config": {
    "provider_id": "anthropic",
    "model_id": "claude-opus-4-6",
    "temperature": 0.7,
    "system_prompt": "You are a senior software architect...",
    "thinking_enabled": true
  }
}
```

**Note:** `provider_config` is only present for AI workers. Script workers receive `script_config` instead. Human workers receive `notification_config`.

### 1.6 Task Progress (Streaming)

Worker → Orchestrator (optional, during execution):

```json
{
  "type": "task.progress",
  "task_id": "uuid-task-1",
  "progress": {
    "percent": 60,
    "phase": "writing_implementation_plan",
    "message": "Designing the JWT middleware approach",
    "tokens_used": 15000,
    "estimated_remaining_ms": 120000
  }
}
```

Progress updates are optional. AI workers should send them to keep the UI responsive. Script workers typically don't (they're fast enough that progress isn't needed).

### 1.7 Task Checkpoint

Worker → Orchestrator (optional, for crash recovery):

```json
{
  "type": "task.checkpoint",
  "task_id": "uuid-task-1",
  "checkpoint": {
    "checkpoint_id": "chk-uuid-1",
    "completed_steps": ["read_requirements", "analyze_codebase", "draft_plan"],
    "remaining_steps": ["finalize_plan", "generate_traceability_table"],
    "artifacts_so_far": [
      { "type": "PLAN", "path": ".conductor/plans/42-draft.md", "hash": "sha256:..." }
    ],
    "conversation_summary": "Analyzed JWT auth requirements. Decided on middleware approach with RS256 signing. Draft plan covers 3 ACs. Need to add traceability table.",
    "resume_from": "finalize_plan"
  }
}
```

### 1.8 Task Result

Worker → Orchestrator (on completion):

```json
{
  "type": "task.result",
  "task_id": "uuid-task-1",
  "state": "completed",
  "output": {
    "summary": "Created implementation plan for JWT authentication",
    "details": "Plan covers middleware approach, token refresh, and rate limiting. 3 acceptance criteria mapped to 5 implementation files.",
    "files_changed": []
  },
  "artifacts": [
    {
      "type": "PLAN",
      "path": ".conductor/plans/42-jwt-auth.md",
      "hash": "sha256:abc123..."
    }
  ],
  "metrics": {
    "duration_ms": 45000,
    "input_tokens": 12000,
    "output_tokens": 8500,
    "thinking_tokens": 15000,
    "cached_tokens": 3000,
    "cost_usd": 0.42,
    "checkpoint_count": 2
  }
}
```

### 1.9 Task Result (Failure)

```json
{
  "type": "task.result",
  "task_id": "uuid-task-1",
  "state": "failed",
  "output": {
    "error_code": "CONTEXT_TOO_LARGE",
    "error_message": "Work item body + comments exceed model context window",
    "recoverable": true,
    "suggestion": "Summarize comments before retrying"
  },
  "artifacts": [],
  "metrics": {
    "duration_ms": 5000,
    "input_tokens": 250000,
    "output_tokens": 0,
    "cost_usd": 0.0
  }
}
```

**`state` values (aligned with A2A `A2ATaskState`):**

| State | Meaning | Orchestrator Action |
| --- | --- | --- |
| `completed` | Task succeeded | Evaluate workflow transitions |
| `failed` | Task failed | Check `recoverable`: if true, retry; if false, block run |
| `input-required` | Worker needs human input | Route to human, run enters `blocked` |

### 1.10 Task Result (Script Worker)

Script workers produce simpler results:

```json
{
  "type": "task.result",
  "task_id": "uuid-task-2",
  "state": "completed",
  "output": {
    "exit_code": 0,
    "stdout": "✓ 42 tests passed\n",
    "stderr": "",
    "summary": "All 42 tests passed"
  },
  "artifacts": [
    {
      "type": "TEST_REPORT",
      "path": ".conductor/test-report.json",
      "hash": "sha256:def456..."
    }
  ],
  "metrics": {
    "duration_ms": 12000
  }
}
```

---

## 2. Transport Layer

The same messages flow over different transports depending on how the worker is deployed.

### 2.1 In-Process (Local Mode)

Workers running in the same Node.js process as the orchestrator. Messages are passed via BullMQ jobs (Redis-backed).

```
Orchestrator ──── BullMQ enqueue ────► Worker process
Worker process ──── BullMQ result ────► Orchestrator
```

**Use for:** Built-in script workers, embedded PM Engine, development mode.

### 2.2 HTTP (Remote Mode)

Workers running as separate services. Messages are sent as HTTP POST requests.

```
Orchestrator ──── POST /tasks ────► Worker HTTP server
Worker HTTP server ──── POST /results ────► Orchestrator callback URL
```

**Endpoints (Worker side):**

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/tasks` | Receive task request |
| `GET` | `/health` | Health check |
| `POST` | `/deregister` | Graceful shutdown signal |

**Endpoints (Orchestrator callback):**

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/api/workers/results` | Receive task result |
| `POST` | `/api/workers/progress` | Receive progress update |
| `POST` | `/api/workers/checkpoint` | Receive checkpoint |

**Use for:** Remote workers, third-party workers, scale-out deployments.

### 2.3 MCP (AI Tool Mode)

AI coding tools (Claude Code, Cursor) that act as workers via MCP.

```
Orchestrator ──── MCP tool call ────► AI Tool (Claude Code)
AI Tool ──── MCP tool response ────► Orchestrator
```

The MCP transport maps protocol messages to MCP tool calls:
- `task.request` → `conductor_receive_task` tool call
- `task.result` → `conductor_submit_result` tool call
- `task.progress` → `conductor_report_progress` tool call

**Use for:** Interactive AI coding tools that want to participate as Conductor workers.

### 2.4 Subprocess (Script Runner Mode)

Script workers spawned by the orchestrator as child processes.

```
Orchestrator ──── stdin (JSON) ────► Script process
Script process ──── stdout (JSON) ────► Orchestrator
Script process ──── stderr ────► Orchestrator (captured for logging)
```

The orchestrator writes the task request as a single JSON line to stdin and reads the task result as a single JSON line from stdout. Stderr is captured for diagnostic logging.

**Use for:** Simple script workers that don't need their own HTTP server.

### 2.5 Transport Selection

The transport is determined by worker configuration:

| `worker_class` | Default Transport | Alternatives |
| --- | --- | --- |
| `ai` | HTTP (remote worker runtime) | MCP (AI coding tool), In-process (embedded) |
| `script` | Subprocess (spawned by orchestrator) | In-process (built-in), HTTP (remote) |
| `human` | N/A (routed through interfaces) | N/A |
| `service` | In-process (embedded) | HTTP (remote service) |

---

## 3. Authentication

### 3.1 Worker Authentication

Workers authenticate with the orchestrator using a worker token:

```
POST /api/workers/register
Authorization: Bearer <worker-token>
```

Worker tokens are generated by the orchestrator when a worker is configured. They are scoped to a specific worker ID and have limited permissions (can only interact with tasks assigned to that worker).

### 3.2 Provider Authentication

AI workers authenticate with LLM providers using provider API keys:

```
POST https://api.anthropic.com/v1/messages
x-api-key: <anthropic-api-key>
```

Provider API keys are stored in the orchestrator's secret store (encrypted at rest). Workers receive the key reference in their config and resolve it at runtime. API keys never appear in task requests, results, or logs.

### 3.3 Webhook Verification

For workers that receive tasks via HTTP webhook, the orchestrator signs the request:

```
POST /tasks
X-Conductor-Signature: sha256=<hmac>
X-Conductor-Timestamp: <unix-timestamp>
```

Workers verify the signature using a shared secret established during registration.

---

## 4. Error Handling

### 4.1 Error Categories

| Category | Examples | Worker Action | Orchestrator Action |
| --- | --- | --- | --- |
| **Transient** | Rate limit, network timeout, 503 | Retry with backoff | Wait for retry |
| **Input** | Invalid task request, missing context | Return `failed` with `recoverable: true` | Re-build context and retry |
| **Model** | Context too large, safety filter, refused | Return `failed` with specific error code | Adjust parameters and retry, or block |
| **Infrastructure** | Disk full, OOM, process crash | Worker dies | Heartbeat timeout → reassign |
| **Permanent** | Invalid API key, model deprecated | Return `failed` with `recoverable: false` | Block run, alert human |

### 4.2 Error Codes

Standard error codes that workers return in `output.error_code`:

| Code | Meaning | Recoverable |
| --- | --- | --- |
| `CONTEXT_TOO_LARGE` | Input exceeds model context window | Yes (summarize and retry) |
| `TOKEN_BUDGET_EXCEEDED` | Task would exceed token budget | Yes (increase budget) |
| `RATE_LIMITED` | Provider rate limit hit | Yes (retry after cooldown) |
| `MODEL_REFUSED` | Model refused to generate (safety) | No |
| `PROVIDER_ERROR` | Provider API returned error | Depends on error |
| `PROVIDER_UNAVAILABLE` | Provider API unreachable | Yes (retry or failover) |
| `INVALID_INPUT` | Task request is malformed | No (fix input) |
| `TIMEOUT` | Task exceeded timeout_ms | Yes (increase timeout) |
| `SCRIPT_ERROR` | Script exited with non-zero code | Yes (fix and retry) |
| `SANDBOX_VIOLATION` | Worker attempted disallowed action | No |
| `CHECKPOINT_CORRUPT` | Cannot resume from checkpoint | Yes (start from scratch) |

### 4.3 Retry Behavior

Workers handle transient errors internally (provider rate limits, network blips). The orchestrator handles task-level retries (worker failures, timeouts).

**Worker-level retry (internal):**
```
Provider returns 429 (rate limited)
    → Wait for Retry-After header duration
    → Retry same request
    → Max 3 internal retries before returning failed to orchestrator
```

**Orchestrator-level retry (external):**
```
Worker returns failed (recoverable: true)
    → Check attempt_number vs max_attempts
    → If under limit: create new task with checkpoint context
    → If over limit: block run
```

---

## 5. Schema Reference

### 5.1 Operation Names

Operations follow the pattern `<domain>.<action>`:

**AI operations:**
- `planning.create` — Create implementation plan
- `planning.revise` — Revise plan based on feedback
- `planning.scope_map` — Map scope and identify dependencies
- `implementation.execute` — Write code implementation
- `implementation.test` — Write tests
- `implementation.prepare_pr` — Prepare PR description and metadata
- `review.plan` — Review implementation plan
- `review.code` — Review code changes
- `review.scope` — Review scope compliance
- `review.security` — Security-focused review
- `review.compliance` — Compliance/regulatory review
- `research.investigate` — Investigate technical question
- `research.document` — Produce research document
- `docs.generate` — Generate documentation
- `docs.update` — Update existing documentation

**Script operations:**
- `script.lint` — Run linter
- `script.format` — Run formatter
- `script.test` — Run tests
- `script.build` — Run build
- `script.deploy` — Run deployment
- `script.migrate` — Run database migration
- `script.notify` — Send notification
- `script.metrics` — Collect/report metrics
- `script.validate` — Run validation checks
- `script.security_scan` — Run security scanner
- `script.ci_trigger` — Trigger CI pipeline
- `script.ci_status` — Check CI status
- `script.custom` — Custom script (user-defined)

**Human operations:**
- `gate.plan_approval` — Approve/reject plan
- `gate.merge_approval` — Approve/reject merge
- `gate.scope_approval` — Approve/reject scope change

**Service operations:**
- All `conductor_*` PM Engine tools (see `../pm-engine/INTERFACES.md`)

### 5.2 Artifact Types

| Type | Producer | Consumer | Format |
| --- | --- | --- | --- |
| `PLAN` | Planner | Implementer, Reviewer | Markdown |
| `CODE` | Implementer | Reviewer, Tester | Source files |
| `TEST_REPORT` | Tester | Orchestrator (gate), Reviewer | JSON |
| `REVIEW` | Reviewer | Implementer (rework), Human | Markdown + structured |
| `RESEARCH` | Researcher | Planner, Human | Markdown |
| `DEPLOY_LOG` | Deployer | Human, Orchestrator | Text |
| `METRICS` | Metrics collector | PM Engine, Dashboard | JSON |
| `CUSTOM` | Any | Any | Any |

---

## 6. Implementing a Worker

### 6.1 Minimal Script Worker (Bash)

```bash
#!/bin/bash
# conductor-eslint-worker.sh
# Reads task from stdin, runs ESLint, writes result to stdout

set -euo pipefail

INPUT=$(cat)
WORKING_DIR=$(echo "$INPUT" | jq -r '.input.working_dir')
OPERATION=$(echo "$INPUT" | jq -r '.operation')

if [ "$OPERATION" != "script.lint" ]; then
  echo '{"type":"task.result","state":"failed","output":{"error_code":"INVALID_INPUT","error_message":"Unknown operation","recoverable":false}}'
  exit 0
fi

cd "$WORKING_DIR"

START_MS=$(date +%s%3N)
if LINT_OUTPUT=$(npx eslint --format json src/ 2>&1); then
  STATE="completed"
else
  STATE="failed"
fi
END_MS=$(date +%s%3N)
DURATION=$((END_MS - START_MS))

jq -n \
  --arg state "$STATE" \
  --argjson output "$LINT_OUTPUT" \
  --argjson duration "$DURATION" \
  '{type:"task.result", state:$state, output:{lint_results:$output}, metrics:{duration_ms:$duration}}'
```

### 6.2 Minimal AI Worker (TypeScript)

```typescript
// conductor-planner-worker.ts
import { ConductorWorkerSDK } from '@conductor/worker-sdk';

const worker = new ConductorWorkerSDK({
  workerId: 'planner-claude-opus-1',
  roleId: 'planner',
  orchestratorUrl: process.env.CONDUCTOR_URL,
  workerToken: process.env.CONDUCTOR_WORKER_TOKEN,
});

worker.on('task', async (task) => {
  const { operation, input, constraints, provider_config } = task;

  // The SDK handles provider abstraction
  const llm = worker.createLLMClient(provider_config);

  const plan = await llm.chat({
    system: provider_config.system_prompt,
    messages: [
      { role: 'user', content: buildPlanningPrompt(input) }
    ],
    tools: worker.getAvailableTools(constraints.sandbox_mode),
    maxTokens: constraints.max_output_tokens,
  });

  // Report progress
  await task.progress({ percent: 100, message: 'Plan complete' });

  // Return result
  return {
    state: 'completed',
    output: { summary: plan.summary, details: plan.content },
    artifacts: [{ type: 'PLAN', path: plan.savedPath, hash: plan.hash }],
  };
});

worker.start();
```

### 6.3 Worker SDK

Conductor provides a Worker SDK (`@conductor/worker-sdk`) that handles:
- Registration and heartbeat
- Task queue polling
- Provider abstraction (LLM client creation)
- Checkpoint management
- Progress reporting
- Error handling and retry
- Token tracking and budget enforcement
- Sandbox enforcement

The SDK is optional. Workers can implement the protocol directly if they prefer (script workers typically do).
