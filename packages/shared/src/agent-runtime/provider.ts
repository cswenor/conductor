/**
 * Agent Invocation Framework
 *
 * AI provider abstraction, executor, and error normalization.
 * WP6 scope: Anthropic only. Other providers throw AgentUnsupportedProviderError.
 */

import Anthropic from '@anthropic-ai/sdk';
import type { Database } from 'better-sqlite3';
import { createLogger } from '../logger/index.js';
import type { ApiKeyProvider } from '../api-keys/index.js';
import type { RunStep } from '../types/index.js';
import { resolveCredentials } from './resolver.js';
import {
  createAgentInvocation,
  markAgentRunning,
  completeAgentInvocation,
  failAgentInvocation,
} from './invocations.js';

const log = createLogger({ name: 'conductor:agent-runtime' });

// =============================================================================
// Error Classes
// =============================================================================

export class AgentError extends Error {
  constructor(message: string, public readonly code: string = 'agent_error') {
    super(message);
    this.name = 'AgentError';
  }
}

export class AgentAuthError extends AgentError {
  constructor(message: string) {
    super(message, 'auth_error');
    this.name = 'AgentAuthError';
  }
}

export class AgentRateLimitError extends AgentError {
  public readonly retryAfterMs?: number;
  constructor(message: string, retryAfterMs?: number) {
    super(message, 'rate_limit');
    this.name = 'AgentRateLimitError';
    this.retryAfterMs = retryAfterMs;
  }
}

export class AgentContextLengthError extends AgentError {
  constructor(message: string) {
    super(message, 'context_length');
    this.name = 'AgentContextLengthError';
  }
}

export class AgentUnsupportedProviderError extends AgentError {
  constructor(provider: string) {
    super(
      `Provider '${provider}' is not yet supported. Only 'anthropic' is available.`,
      'unsupported_provider'
    );
    this.name = 'AgentUnsupportedProviderError';
  }
}

export class AgentTimeoutError extends AgentError {
  public readonly timeoutMs: number;
  public readonly agent: string;
  public readonly action: string;
  constructor(timeoutMs: number, agent: string, action: string) {
    super(
      `Agent '${agent}' timed out after ${Math.round(timeoutMs / 1000)}s (action: ${action})`,
      'timeout'
    );
    this.name = 'AgentTimeoutError';
    this.timeoutMs = timeoutMs;
    this.agent = agent;
    this.action = action;
  }
}

// =============================================================================
// Provider Abstraction
// =============================================================================

export interface AgentInput {
  systemPrompt: string;
  userPrompt: string;
  maxTokens?: number;
  temperature?: number;
  timeoutMs?: number;
}

export interface AgentOutput {
  content: string;
  tokensInput: number;
  tokensOutput: number;
  stopReason: string;
  durationMs: number;
}

export interface AgentProvider {
  invoke(input: AgentInput): Promise<AgentOutput>;
}

// =============================================================================
// Default Timeouts (per agent type)
// =============================================================================

const DEFAULT_TIMEOUTS: Record<string, number> = {
  planner: 300_000,     // 5 min
  reviewer: 180_000,    // 3 min
  implementer: 600_000, // 10 min
};

const DEFAULT_TIMEOUT_MS = 300_000; // 5 min fallback

export function getDefaultTimeout(agent: string): number {
  return DEFAULT_TIMEOUTS[agent] ?? DEFAULT_TIMEOUT_MS;
}

// =============================================================================
// Anthropic Provider
// =============================================================================

const DEFAULT_MODEL = 'claude-sonnet-4-20250514';

export class AnthropicProvider implements AgentProvider {
  private readonly client: Anthropic;
  private readonly model: string;

  constructor(apiKey: string, model?: string) {
    this.client = new Anthropic({ apiKey });
    this.model = model ?? DEFAULT_MODEL;
  }

  async invoke(input: AgentInput): Promise<AgentOutput> {
    const start = Date.now();
    const maxTokens = input.maxTokens ?? 16384;
    const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    // Set up AbortController for timeout
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await this.client.messages.create(
        {
          model: this.model,
          max_tokens: maxTokens,
          temperature: input.temperature ?? 0.3,
          system: input.systemPrompt,
          messages: [{ role: 'user', content: input.userPrompt }],
        },
        { signal: controller.signal }
      );

      const durationMs = Date.now() - start;

      const content = response.content
        .filter((block): block is Anthropic.TextBlock => block.type === 'text')
        .map((block) => block.text)
        .join('\n');

      return {
        content,
        tokensInput: response.usage.input_tokens,
        tokensOutput: response.usage.output_tokens,
        stopReason: response.stop_reason ?? 'unknown',
        durationMs,
      };
    } catch (err) {
      const durationMs = Date.now() - start;

      // Timeout (AbortError) — agent/action filled in by executeAgent catch block
      if (err instanceof Error && err.name === 'AbortError') {
        throw new AgentTimeoutError(timeoutMs, 'provider', 'invoke');
      }

      // Anthropic SDK errors
      if (err instanceof Anthropic.AuthenticationError) {
        throw new AgentAuthError(
          `Anthropic authentication failed: ${err.message}`
        );
      }
      if (err instanceof Anthropic.RateLimitError) {
        throw new AgentRateLimitError(
          `Anthropic rate limited: ${err.message}`
        );
      }
      if (err instanceof Anthropic.BadRequestError && /context|token/i.test(err.message)) {
        throw new AgentContextLengthError(
          `Anthropic context length exceeded: ${err.message}`
        );
      }

      throw new AgentError(
        `Anthropic API error (${durationMs}ms): ${err instanceof Error ? err.message : 'Unknown error'}`
      );
    } finally {
      clearTimeout(timer);
    }
  }
}

// =============================================================================
// Provider Factory
// =============================================================================

/**
 * Create a provider instance for the given AI provider.
 * WP6 only supports Anthropic. Other providers throw AgentUnsupportedProviderError.
 */
export function createProvider(provider: ApiKeyProvider, apiKey: string, model?: string): AgentProvider {
  switch (provider) {
    case 'anthropic':
      return new AnthropicProvider(apiKey, model);
    case 'openai':
    case 'google':
    case 'mistral':
      throw new AgentUnsupportedProviderError(provider);
    default:
      throw new AgentUnsupportedProviderError(String(provider));
  }
}

// =============================================================================
// Agent Executor
// =============================================================================

export interface ExecuteAgentInput {
  runId: string;
  agent: string;
  action: string;
  systemPrompt: string;
  userPrompt: string;
  step: RunStep;
  maxTokens?: number;
  temperature?: number;
  timeoutMs?: number;
}

export interface ExecuteAgentResult {
  agentInvocationId: string;
  content: string;
  tokensInput: number;
  tokensOutput: number;
  durationMs: number;
}

/**
 * Execute an agent invocation end-to-end:
 * 1. Create invocation record
 * 2. Resolve credentials
 * 3. Call provider
 * 4. Record result or failure
 */
export async function executeAgent(
  db: Database,
  input: ExecuteAgentInput
): Promise<ExecuteAgentResult> {
  // 1. Create invocation record
  const invocation = createAgentInvocation(db, {
    runId: input.runId,
    agent: input.agent,
    action: input.action,
    contextSummary: `step=${input.step}`,
  });

  // 2. Mark running
  markAgentRunning(db, invocation.agentInvocationId);

  try {
    // 3. Resolve credentials
    const creds = await resolveCredentials(db, {
      runId: input.runId,
      step: input.step,
    });

    if (creds.mode !== 'ai_provider') {
      throw new AgentError(`Step ${input.step} does not use AI provider credentials (mode: ${creds.mode})`);
    }

    // 4. Create provider and invoke
    const provider = createProvider(creds.provider, creds.apiKey);
    const timeoutMs = input.timeoutMs ?? getDefaultTimeout(input.agent);

    const output = await provider.invoke({
      systemPrompt: input.systemPrompt,
      userPrompt: input.userPrompt,
      maxTokens: input.maxTokens,
      temperature: input.temperature,
      timeoutMs,
    });

    // 5. Record success
    completeAgentInvocation(db, invocation.agentInvocationId, {
      tokensInput: output.tokensInput,
      tokensOutput: output.tokensOutput,
      durationMs: output.durationMs,
    });

    log.info(
      {
        agentInvocationId: invocation.agentInvocationId,
        agent: input.agent,
        action: input.action,
        tokensInput: output.tokensInput,
        tokensOutput: output.tokensOutput,
        durationMs: output.durationMs,
      },
      'Agent invocation completed'
    );

    return {
      agentInvocationId: invocation.agentInvocationId,
      content: output.content,
      tokensInput: output.tokensInput,
      tokensOutput: output.tokensOutput,
      durationMs: output.durationMs,
    };
  } catch (err) {
    // Re-throw timeout with correct agent/action metadata
    if (err instanceof AgentTimeoutError && err.agent !== input.agent) {
      const corrected = new AgentTimeoutError(err.timeoutMs, input.agent, input.action);

      try {
        failAgentInvocation(db, invocation.agentInvocationId, {
          errorCode: corrected.code,
          errorMessage: corrected.message,
          durationMs: err.timeoutMs,
        });
      } catch {
        // Invocation may already be in terminal state; ignore
      }

      log.error(
        {
          agentInvocationId: invocation.agentInvocationId,
          agent: input.agent,
          action: input.action,
          errorCode: corrected.code,
          timeoutMs: err.timeoutMs,
        },
        'Agent invocation timed out'
      );

      throw corrected;
    }

    // Record failure
    const errorCode = err instanceof AgentError ? err.code : 'unknown';
    const errorMessage = err instanceof Error ? err.message : 'Unknown error';

    try {
      failAgentInvocation(db, invocation.agentInvocationId, {
        errorCode,
        errorMessage,
      });
    } catch {
      // Invocation may already be in terminal state; ignore
    }

    log.error(
      {
        agentInvocationId: invocation.agentInvocationId,
        agent: input.agent,
        action: input.action,
        errorCode,
        errorMessage,
      },
      'Agent invocation failed'
    );

    throw err;
  }
}
