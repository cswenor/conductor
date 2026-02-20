# AI Providers

Status: Normative specification
Audience: Engineering, platform integrators
Updated: 2026-02-19

This document specifies the provider abstraction layer in detail. For the high-level provider model, see `OVERVIEW.md § 4`.

---

## 1. Provider Adapter Architecture

Every LLM API speaks a different dialect. The Provider Adapter normalizes them into one internal format so the worker runtime never touches provider-specific HTTP.

```
Worker Runtime (provider-agnostic)
    │
    │ InternalRequest { messages, tools, config }
    ▼
Provider Adapter (per provider_type)
    │
    │ Translates to provider-specific format
    │ Handles auth, retries, rate limits, streaming
    ▼
Provider API (Anthropic, OpenAI, Google, Ollama, custom)
    │
    │ Provider-specific response
    ▼
Provider Adapter
    │
    │ Normalizes to InternalResponse { content, tool_calls, usage, stop_reason }
    ▼
Worker Runtime (sees only normalized response)
```

### 1.1 Internal Request Format

```typescript
interface InternalRequest {
  messages: InternalMessage[];
  tools?: InternalTool[];
  config: {
    model_id: string;
    temperature: number;
    max_tokens: number;
    stop_sequences?: string[];
    // Provider-specific extensions (passed through)
    extensions?: Record<string, unknown>;
  };
  // Streaming control
  stream: boolean;
  // Optional: force tool use
  tool_choice?: 'auto' | 'required' | { tool_name: string };
}

interface InternalMessage {
  role: 'system' | 'user' | 'assistant' | 'tool_result';
  content: ContentBlock[];
}

type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: ImageSource }
  | { type: 'tool_use'; tool_use_id: string; tool_name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean }
  | { type: 'thinking'; thinking: string };  // Extended thinking output
```

### 1.2 Internal Response Format

```typescript
interface InternalResponse {
  content: ContentBlock[];
  stop_reason: 'end_turn' | 'max_tokens' | 'tool_use' | 'stop_sequence';
  usage: TokenUsage;
  model_id: string;             // Actual model used (may differ from requested)
  latency_ms: number;
  provider_request_id?: string; // For debugging
}

interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens?: number;   // Anthropic prompt caching
  cache_write_tokens?: number;
  thinking_tokens?: number;     // Extended thinking tokens
  total_tokens: number;         // input + output (for budget tracking)
}
```

---

## 2. Provider Adapters

### 2.1 Anthropic Adapter

**API:** Messages API (`POST /v1/messages`)

**Translation:**

| Internal | Anthropic |
| --- | --- |
| `messages[role=system]` | `system` parameter (extracted from messages) |
| `messages[role=user]` | `messages[].role = "user"` |
| `messages[role=assistant]` | `messages[].role = "assistant"` |
| `messages[role=tool_result]` | `messages[].content[].type = "tool_result"` |
| `tools[]` | `tools[]` (same schema — Anthropic's tool format is the reference) |
| `config.temperature` | `temperature` |
| `config.max_tokens` | `max_tokens` |
| `tool_choice` | `tool_choice: { type: "auto" | "any" | "tool", name?: string }` |

**Anthropic-specific extensions:**

| Extension | Maps To | When Used |
| --- | --- | --- |
| `extensions.thinking_enabled` | `thinking: { type: "enabled", budget_tokens: N }` | Planner/reviewer roles where reasoning helps |
| `extensions.cache_control` | `cache_control: { type: "ephemeral" }` on system message | Large context injection (project docs, codebase) |
| `extensions.batch_mode` | Use Batch API instead of Messages API | Non-urgent tasks (triage, classification, analytics) |

**Prompt caching strategy:**
- System prompt with project docs → mark with `cache_control` (reused across tasks in same run)
- Tool definitions → cached automatically by Anthropic
- Cache savings are tracked in `TokenUsage.cache_read_tokens`

**Error mapping:**

| Anthropic Error | Internal Error | Retry? |
| --- | --- | --- |
| 400 `invalid_request_error` | `VALIDATION_ERROR` | No |
| 401 `authentication_error` | `PROVIDER_AUTH_ERROR` | No |
| 429 `rate_limit_error` | `RATE_LIMITED` | Yes (exponential backoff) |
| 500 `api_error` | `PROVIDER_ERROR` | Yes (3 attempts) |
| 529 `overloaded_error` | `PROVIDER_OVERLOADED` | Yes (longer backoff) |

### 2.2 OpenAI Adapter

**API:** Chat Completions (`POST /v1/chat/completions`)

**Translation:**

| Internal | OpenAI |
| --- | --- |
| `messages[role=system]` | `messages[].role = "system"` (stays in array, not extracted) |
| `messages[role=user]` | `messages[].role = "user"` |
| `messages[role=assistant]` | `messages[].role = "assistant"` |
| `messages[role=tool_result]` | `messages[].role = "tool"` with `tool_call_id` |
| `tools[]` | `tools[].type = "function"` with `function: { name, description, parameters }` |
| `config.temperature` | `temperature` |
| `config.max_tokens` | `max_completion_tokens` (NOT `max_tokens` — deprecated) |
| `tool_choice = 'required'` | `tool_choice: "required"` |
| `tool_choice = { tool_name }` | `tool_choice: { type: "function", function: { name } }` |

**OpenAI-specific extensions:**

| Extension | Maps To | When Used |
| --- | --- | --- |
| `extensions.reasoning_effort` | `reasoning_effort: "low" | "medium" | "high"` | o-series models (o3, o4-mini) |
| `extensions.json_mode` | `response_format: { type: "json_object" }` | Structured output extraction |

**Tool format translation:**

```
Internal tool:                        OpenAI tool:
{                                     {
  name: "read_file",                    type: "function",
  description: "...",                   function: {
  input_schema: { ... }                   name: "read_file",
}                                         description: "...",
                                          parameters: { ... }
                                        }
                                      }
```

**Error mapping:**

| OpenAI Error | Internal Error | Retry? |
| --- | --- | --- |
| 400 `invalid_request_error` | `VALIDATION_ERROR` | No |
| 401 `invalid_api_key` | `PROVIDER_AUTH_ERROR` | No |
| 429 `rate_limit_exceeded` | `RATE_LIMITED` | Yes (respect `Retry-After` header) |
| 500 `server_error` | `PROVIDER_ERROR` | Yes (3 attempts) |
| 503 `service_unavailable` | `PROVIDER_OVERLOADED` | Yes (longer backoff) |

### 2.3 Google Adapter

**API:** GenerateContent (`POST /v1beta/models/{model}:generateContent`)

**Translation:**

| Internal | Google |
| --- | --- |
| `messages[role=system]` | `systemInstruction.parts[].text` |
| `messages[role=user]` | `contents[].role = "user"` |
| `messages[role=assistant]` | `contents[].role = "model"` |
| `messages[role=tool_result]` | `contents[].parts[].functionResponse` |
| `tools[]` | `tools[].functionDeclarations[]` |
| `config.temperature` | `generationConfig.temperature` |
| `config.max_tokens` | `generationConfig.maxOutputTokens` |

**Google-specific extensions:**

| Extension | Maps To | When Used |
| --- | --- | --- |
| `extensions.thinking_enabled` | `generationConfig.thinkingConfig.thinkingBudget` | Gemini 2.5 models |
| `extensions.grounding` | `tools[].googleSearchRetrieval` | Research roles needing web access |

**Error mapping:**

| Google Error | Internal Error | Retry? |
| --- | --- | --- |
| 400 `INVALID_ARGUMENT` | `VALIDATION_ERROR` | No |
| 403 `PERMISSION_DENIED` | `PROVIDER_AUTH_ERROR` | No |
| 429 `RESOURCE_EXHAUSTED` | `RATE_LIMITED` | Yes |
| 500 `INTERNAL` | `PROVIDER_ERROR` | Yes |

### 2.4 Ollama Adapter

**API:** Chat (`POST /api/chat`)

**Translation:** Ollama's API is a subset of OpenAI's format. The adapter reuses the OpenAI adapter with these differences:

| Difference | Handling |
| --- | --- |
| No API key required | Skip auth header |
| Model names are local | Pass through as-is (e.g., `llama3.3:70b`) |
| Limited tool support | Check model capabilities before sending tools |
| No streaming token counts | Estimate from response length |
| Variable context windows | Query `/api/show` for model metadata |

**Model discovery:** On startup, query `GET /api/tags` to populate the available model list. Re-query every 5 minutes.

### 2.5 Custom (OpenAI-Compatible) Adapter

Reuses the OpenAI adapter with configurable `base_url`. Covers: vLLM, Together AI, Fireworks, Groq, Azure OpenAI, AWS Bedrock (via compatibility layer), and any endpoint implementing the OpenAI chat completions format.

**Configuration:**

```yaml
provider_id: custom-vllm
provider_type: openai_compatible
base_url: https://vllm.internal.company.com/v1
api_key_env: VLLM_API_KEY
# Optional: override capabilities that the endpoint doesn't advertise
capabilities_override:
  supports_tools: false
  supports_vision: false
```

---

## 3. Error Normalization

All provider errors are normalized to a standard error type:

```typescript
interface ProviderError {
  code: ProviderErrorCode;
  message: string;
  provider_id: string;
  provider_error_code?: string;     // Original error code from provider
  provider_error_message?: string;  // Original error message
  retryable: boolean;
  retry_after_ms?: number;          // From provider's Retry-After header
}

type ProviderErrorCode =
  | 'VALIDATION_ERROR'       // Bad request (prompt too long, invalid tool, etc.)
  | 'PROVIDER_AUTH_ERROR'    // Invalid or expired API key
  | 'RATE_LIMITED'           // Provider rate limit hit
  | 'PROVIDER_ERROR'        // Provider internal error
  | 'PROVIDER_OVERLOADED'   // Provider capacity exceeded
  | 'CONTEXT_LENGTH_EXCEEDED' // Input too long for model
  | 'CONTENT_FILTERED'      // Content policy violation
  | 'TIMEOUT'               // Request timed out
  | 'NETWORK_ERROR';        // Connection failed
```

### 3.1 Retry Strategy

```
Error occurs
    │
    ├── retryable = false → return error to worker
    │
    └── retryable = true
        │
        ├── retry_after_ms set → wait that long, then retry
        │
        └── retry_after_ms not set → exponential backoff
            attempt 1: 1s
            attempt 2: 2s
            attempt 3: 4s
            max 3 attempts, then return error to worker
```

### 3.2 Failover

When a provider fails and the worker has a failover provider configured:

```
Primary provider fails (3 retries exhausted)
    │
    ▼
Check worker config for failover_provider_id
    │
    ├── No failover → return error
    │
    └── Has failover
        │
        ▼
    Translate request for failover provider
        │
        ▼
    Send to failover provider
        │
        ├── Success → return response (with failover flag in metadata)
        └── Failure → return error (both providers failed)
```

Failover is transparent to the worker runtime. The adapter handles the switchover.

---

## 4. Token Counting

Each provider counts tokens differently. The adapter normalizes token counts for budget tracking.

### 4.1 Provider-Specific Tokenizers

| Provider | Tokenizer | Available Locally? |
| --- | --- | --- |
| Anthropic | Claude tokenizer | Yes (via `@anthropic-ai/tokenizer`) |
| OpenAI | `tiktoken` | Yes (via `tiktoken` package) |
| Google | SentencePiece (model-specific) | Partially (via API `countTokens` endpoint) |
| Ollama | Model-specific | No (estimate from response) |

### 4.2 Pre-Request Estimation

Before sending a request, estimate token count to check budget:

```
estimated_input = tokenize(messages + tools + system_prompt)
estimated_output = config.max_tokens  // worst case

if (budget_used + estimated_input + estimated_output > token_budget):
    return BUDGET_EXCEEDED error (don't send the request)
```

This prevents wasting money on requests that will push the task over budget.

### 4.3 Post-Response Tracking

After receiving a response, record actual token usage:

```
actual_input = response.usage.input_tokens
actual_output = response.usage.output_tokens
actual_total = actual_input + actual_output

// Update task-level budget
task.tokens_used += actual_total

// Update run-level budget
run.tokens_used += actual_total

// Update project-level budget
project.tokens_used_this_period += actual_total
```

---

## 5. Cost Calculation

Token costs vary by provider, model, and token type.

### 5.1 Cost Model

```typescript
interface ModelPricing {
  provider_id: string;
  model_id: string;
  input_per_million: number;     // USD per 1M input tokens
  output_per_million: number;    // USD per 1M output tokens
  cache_read_per_million?: number;   // Anthropic cache reads
  cache_write_per_million?: number;  // Anthropic cache writes
  thinking_per_million?: number;     // Extended thinking tokens
  batch_discount?: number;           // Multiplier for batch API (e.g., 0.5 = 50% off)
}
```

### 5.2 Built-in Pricing (Updated 2026-02-19)

| Provider | Model | Input $/1M | Output $/1M |
| --- | --- | --- | --- |
| Anthropic | claude-opus-4-6 | $15.00 | $75.00 |
| Anthropic | claude-sonnet-4-6 | $3.00 | $15.00 |
| Anthropic | claude-haiku-4-5 | $0.80 | $4.00 |
| OpenAI | gpt-4.1 | $2.00 | $8.00 |
| OpenAI | gpt-4.1-mini | $0.40 | $1.60 |
| OpenAI | o3 | $10.00 | $40.00 |
| Google | gemini-2.5-pro | $1.25 | $10.00 |
| Google | gemini-2.5-flash | $0.15 | $0.60 |
| Ollama | (any) | $0.00 | $0.00 |

Pricing is stored in configuration and updated by the operator. Conductor does not auto-update prices.

### 5.3 Per-Task Cost Computation

```
task_cost = (input_tokens * input_per_million / 1_000_000)
          + (output_tokens * output_per_million / 1_000_000)
          + (cache_read_tokens * cache_read_per_million / 1_000_000)
          + (thinking_tokens * thinking_per_million / 1_000_000)

// Apply batch discount if using batch API
if (batch_mode):
    task_cost *= batch_discount
```

---

## 6. Rate Limit Management

### 6.1 Per-Provider Rate Limiting

Each provider has different rate limits. The adapter tracks usage and throttles requests proactively.

```typescript
interface ProviderRateLimits {
  requests_per_minute: number;
  tokens_per_minute: number;
  tokens_per_day?: number;
  concurrent_requests?: number;
}
```

**Enforcement:** Token bucket algorithm per provider. Workers that exceed the rate are queued, not rejected. The adapter handles backpressure transparently.

### 6.2 Cross-Worker Coordination

Multiple workers may share the same provider. Rate limits are tracked at the provider level, not the worker level. A centralized rate limiter (Redis-backed) ensures all workers respect the same limits.

```
Worker A (planner, Anthropic) ──┐
                                ├──► Rate Limiter (Anthropic) ──► Anthropic API
Worker B (reviewer, Anthropic) ─┘
```

---

## 7. Provider Health Monitoring

### 7.1 Health Checks

Each provider adapter periodically checks provider health:

| Check | Frequency | Method |
| --- | --- | --- |
| Connectivity | Every 60s | Lightweight API call (list models or similar) |
| Latency | Per request | Tracked in `InternalResponse.latency_ms` |
| Error rate | Rolling 5-min window | Count of errors / total requests |

### 7.2 Provider Status

```typescript
type ProviderStatus = 'healthy' | 'degraded' | 'down';

// degraded: error rate > 10% or p95 latency > 30s
// down: 3 consecutive health check failures or error rate > 50%
```

Provider status feeds into the worker assignment algorithm (see `../orchestrator/WORKFLOW_ENGINE.md § 3`). Workers backed by a `degraded` provider get a ranking penalty. Workers backed by a `down` provider are excluded from assignment.

---

## 8. Custom Provider Authoring

To add a provider that doesn't follow the OpenAI-compatible format:

### 8.1 Implement the Adapter Interface

```typescript
interface ProviderAdapter {
  provider_type: string;

  // Translate internal format to provider-specific request
  translateRequest(req: InternalRequest): ProviderSpecificRequest;

  // Translate provider-specific response to internal format
  translateResponse(res: ProviderSpecificResponse): InternalResponse;

  // Translate provider-specific error to normalized error
  translateError(err: ProviderSpecificError): ProviderError;

  // Health check
  checkHealth(): Promise<ProviderStatus>;

  // Token counting (optional — falls back to estimation)
  countTokens?(messages: InternalMessage[]): Promise<number>;

  // Streaming support (optional)
  translateStreamChunk?(chunk: unknown): Partial<InternalResponse>;
}
```

### 8.2 Register the Provider

```yaml
# conductor.providers.yaml
providers:
  - provider_id: my-custom-api
    provider_type: my_custom_adapter    # Matches adapter implementation
    base_url: https://api.custom.com
    api_key_env: CUSTOM_API_KEY
    models:
      - model_id: custom-v1
        context_window: 32000
        max_output_tokens: 8192
        supports_tools: true
        supports_vision: false
        supports_thinking: false
```

### 8.3 Testing

Conductor provides a test harness for provider adapters:

```bash
conductor test-provider --provider my-custom-api --model custom-v1
```

This runs a standard suite: basic completion, tool use, streaming, error handling, token counting. Pass all tests to certify the adapter.
