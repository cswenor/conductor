/**
 * Tool Execution Loop
 *
 * The core of WP7. Manages the multi-turn conversation loop where
 * the agent can invoke tools and receive results before continuing.
 */

import { createHash } from 'node:crypto';
import type { Database } from 'better-sqlite3';
import type Anthropic from '@anthropic-ai/sdk';
import { createLogger } from '../logger/index.ts';
import { redact } from '../redact/index.ts';
import { createEvent } from '../events/index.ts';
import type { AgentProvider, AgentOutput } from './provider.ts';
import { AgentError, AgentCancelledError, AgentBudgetExceededError, AgentRateLimitError } from './provider.ts';
import type { ToolRegistry } from './tools/registry.ts';
import type { PolicyRule } from './tools/policy.ts';
import { evaluatePolicy } from './tools/policy.ts';
import type { ToolExecutionContext, ToolCall } from './tools/types.ts';
import {
  createToolInvocation,
  completeToolInvocation,
  failToolInvocation,
  blockToolInvocation,
} from './tool-invocations.ts';
import { ensureBuiltInPolicyDefinitions } from './policy-definitions.ts';
import { createAgentMessage } from './agent-messages.ts';

const log = createLogger({ name: 'conductor:executor' });

// =============================================================================
// Constants
// =============================================================================

export const MAX_TOOL_ITERATIONS = 50;

const DEFAULT_CONTEXT_WINDOW = 200_000;
const CONTEXT_BUDGET_FRACTION = 0.65;
const DEFAULT_BACKOFF_FACTOR = 0.8;
const DEFAULT_RECOVERY_FACTOR = 1.05;
const DEFAULT_MIN_BUDGET_FLOOR = 10_000;
const DEFAULT_MAX_RATE_LIMIT_RETRIES = 3;
const MIN_RECENT_TURNS = 2;
const DEFAULT_KEEP_RECENT_TURNS = 4;
const ESTIMATION_SAFETY_FACTOR = 1.15;
const RETRY_BASE_DELAY_MS = 1_000;
const RETRY_JITTER_MS = 500;

// =============================================================================
// Budget Config
// =============================================================================

interface BudgetConfig {
  contextCap: number;
  backoffFactor: number;
  recoveryFactor: number;
  minBudgetFloor: number;
  maxRateLimitRetries: number;
}

function readEnvFloat(key: string, fallback: number, min: number, max: number): number {
  const raw = process.env[key];
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (Number.isFinite(parsed) && parsed >= min && parsed <= max) return parsed;
  log.warn({ envKey: key, envValue: raw }, `Invalid ${key}, using default ${fallback}`);
  return fallback;
}

function readEnvInt(key: string, fallback: number, min: number): number {
  const raw = process.env[key];
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (Number.isInteger(parsed) && parsed >= min) return parsed;
  log.warn({ envKey: key, envValue: raw }, `Invalid ${key}, using default ${fallback}`);
  return fallback;
}

/** Single precedence chain: valid explicit → valid env cap → window * fraction. */
function resolveContextCap(explicitCap: number | undefined): number {
  // 1. Explicit caller value
  if (explicitCap !== undefined && Number.isInteger(explicitCap) && explicitCap > 0) {
    return explicitCap;
  }
  if (explicitCap !== undefined) {
    log.warn({ maxInputTokens: explicitCap }, 'Invalid maxInputTokens, falling through to env/defaults');
  }

  // 2. CONDUCTOR_MAX_INPUT_TOKENS env
  const envCap = process.env['CONDUCTOR_MAX_INPUT_TOKENS'];
  if (envCap !== undefined) {
    const parsed = Number(envCap);
    if (Number.isInteger(parsed) && parsed > 0) return parsed;
    log.warn({ envValue: envCap }, 'Invalid CONDUCTOR_MAX_INPUT_TOKENS, ignoring');
  }

  // 3. Window * fraction (warn if using hardcoded default)
  const window = readEnvInt('CONDUCTOR_CONTEXT_WINDOW', DEFAULT_CONTEXT_WINDOW, 1);
  if (process.env['CONDUCTOR_CONTEXT_WINDOW'] === undefined) {
    log.warn(
      { defaultWindow: DEFAULT_CONTEXT_WINDOW },
      'CONDUCTOR_CONTEXT_WINDOW not set, using default. Set this to match your model context window.',
    );
  }
  return Math.floor(window * CONTEXT_BUDGET_FRACTION);
}

function resolveBudgetConfig(explicitCap: number | undefined): BudgetConfig {
  const contextCap = resolveContextCap(explicitCap);

  // Clamp floor to contextCap so backoff can never increase budget above cap
  const rawFloor = readEnvInt('CONDUCTOR_BUDGET_FLOOR', DEFAULT_MIN_BUDGET_FLOOR, 1);

  return {
    contextCap,
    backoffFactor: readEnvFloat('CONDUCTOR_BUDGET_BACKOFF', DEFAULT_BACKOFF_FACTOR, 0.1, 0.99),
    recoveryFactor: readEnvFloat('CONDUCTOR_BUDGET_RECOVERY', DEFAULT_RECOVERY_FACTOR, 1.0, 2.0),
    minBudgetFloor: Math.min(rawFloor, contextCap),
    maxRateLimitRetries: readEnvInt('CONDUCTOR_BUDGET_MAX_RETRIES', DEFAULT_MAX_RATE_LIMIT_RETRIES, 0),
  };
}

// =============================================================================
// Types
// =============================================================================

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
  /** Abort signal for cancellation */
  abortSignal?: AbortSignal;
  /** Hard cap on estimated input tokens per provider call.
   *  If unset, derived from context window: (CONDUCTOR_CONTEXT_WINDOW ?? 200k) * 0.65.
   *  Operator override: env CONDUCTOR_MAX_INPUT_TOKENS. */
  maxInputTokens?: number;
}

export interface ExecutorResult {
  content: string;
  totalTokensInput: number;
  totalTokensOutput: number;
  totalDurationMs: number;
  iterations: number;
  stopReason: string;
}

// =============================================================================
// Internal Helpers
// =============================================================================

/**
 * Check if a signal is aborted. Extracted to a helper to prevent TypeScript's
 * control-flow narrowing from eliminating the check when it follows an earlier
 * guard on the same signal in the same block.
 */
function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

export function redactToolArgs(
  toolName: string,
  args: Record<string, unknown>
): Record<string, unknown> {
  // Special-case write_file: replace content with hash+size before redacting
  if (toolName === 'write_file' && typeof args['content'] === 'string') {
    const content = args['content'];
    const contentHash = createHash('sha256').update(content).digest('hex');
    const contentSizeBytes = Buffer.byteLength(content, 'utf8');
    return { ...args, content: { contentHash, contentSizeBytes } };
  }
  return args;
}

export function emitToolEvent(
  db: Database,
  context: ToolExecutionContext,
  type: 'tool.invoked' | 'tool.policy_blocked',
  toolName: string,
  meta: Record<string, unknown>
): void {
  try {
    // Look up projectId from the run
    const run = db.prepare('SELECT project_id FROM runs WHERE run_id = ?').get(context.runId) as
      | { project_id: string }
      | undefined;
    const projectId = run?.project_id ?? context.projectId;

    createEvent(db, {
      projectId,
      runId: context.runId,
      type,
      class: 'fact',
      payload: { tool: toolName, agentInvocationId: context.agentInvocationId, ...meta },
      idempotencyKey: `tool:${context.agentInvocationId}:${toolName}:${Date.now()}:${Math.random().toString(36).substring(2, 8)}`,
      source: 'worker',
    });
  } catch (err) {
    // Non-fatal — don't let event emission break the tool loop
    log.warn(
      { err, toolName, type },
      'Failed to emit tool event'
    );
  }
}

// =============================================================================
// Shared Audited Tool Call
// =============================================================================

export interface AuditedToolResult {
  content: string;
  isError?: boolean;
}

/**
 * Execute a tool call with full audit trail: redaction, policy enforcement,
 * tool_invocations CRUD, and event emission.
 *
 * Shared by both the raw tool loop (`runToolLoop`) and the Agent SDK MCP adapter.
 */
export async function executeAuditedToolCall(
  toolName: string,
  toolInput: Record<string, unknown>,
  registry: ToolRegistry,
  policyRules: PolicyRule[],
  context: ToolExecutionContext,
  db: Database,
): Promise<AuditedToolResult> {
  const tool = registry.get(toolName);

  // Unknown tool → log invocation then error result
  if (tool === undefined) {
    const unknownStart = Date.now();
    const argsForRedaction = redactToolArgs(toolName, toolInput);
    const redacted = redact(argsForRedaction);

    const invocation = createToolInvocation(db, {
      agentInvocationId: context.agentInvocationId,
      runId: context.runId,
      tool: toolName,
      argsRedactedJson: redacted.json,
      argsFieldsRemovedJson: JSON.stringify(redacted.fieldsRemoved),
      argsSecretsDetected: redacted.secretsDetected,
      argsPayloadHash: redacted.payloadHash,
      argsPayloadHashScheme: redacted.payloadHashScheme,
      policyDecision: 'allow',
    });

    failToolInvocation(db, invocation.toolInvocationId, {
      resultMeta: { errorCode: 'unknown_tool', toolName },
      durationMs: Date.now() - unknownStart,
    });

    return {
      content: `Error: Unknown tool '${toolName}'`,
      isError: true,
    };
  }

  const start = Date.now();

  // Redact args for logging
  const argsForRedaction = redactToolArgs(toolName, toolInput);
  const redacted = redact(argsForRedaction);

  // Extract target
  const target = tool.extractTarget?.(toolInput);

  // Evaluate policy
  const policyResult = evaluatePolicy(policyRules, toolName, toolInput, context);

  if (policyResult.decision === 'block') {
    const durationMs = Date.now() - start;

    const blockedInvocation = createToolInvocation(db, {
      agentInvocationId: context.agentInvocationId,
      runId: context.runId,
      tool: toolName,
      target,
      argsRedactedJson: redacted.json,
      argsFieldsRemovedJson: JSON.stringify(redacted.fieldsRemoved),
      argsSecretsDetected: redacted.secretsDetected,
      argsPayloadHash: redacted.payloadHash,
      argsPayloadHashScheme: redacted.payloadHashScheme,
      policyDecision: 'block',
      policyId: policyResult.policyId,
    });

    blockToolInvocation(db, blockedInvocation.toolInvocationId, {
      resultMeta: {
        policyId: policyResult.policyId,
        reason: policyResult.reason,
      },
      durationMs,
    });

    emitToolEvent(db, context, 'tool.policy_blocked', toolName, {
      policyId: policyResult.policyId,
      reason: policyResult.reason,
      durationMs,
    });

    return {
      content: `Error: Policy blocked - ${policyResult.reason ?? 'access denied'}`,
      isError: true,
    };
  }

  // Create invocation record (status: started)
  const invocation = createToolInvocation(db, {
    agentInvocationId: context.agentInvocationId,
    runId: context.runId,
    tool: toolName,
    target,
    argsRedactedJson: redacted.json,
    argsFieldsRemovedJson: JSON.stringify(redacted.fieldsRemoved),
    argsSecretsDetected: redacted.secretsDetected,
    argsPayloadHash: redacted.payloadHash,
    argsPayloadHashScheme: redacted.payloadHashScheme,
    policyDecision: 'allow',
  });

  // Execute tool
  try {
    const result = await tool.execute(toolInput, context);
    const durationMs = Date.now() - start;

    if (result.isError === true) {
      failToolInvocation(db, invocation.toolInvocationId, {
        resultMeta: result.meta,
        durationMs,
      });
    } else {
      completeToolInvocation(db, invocation.toolInvocationId, {
        resultMeta: result.meta,
        durationMs,
      });
    }

    emitToolEvent(db, context, 'tool.invoked', toolName, {
      toolInvocationId: invocation.toolInvocationId,
      isError: result.isError ?? false,
      durationMs,
    });

    return {
      content: result.content,
      isError: result.isError,
    };
  } catch (err) {
    const durationMs = Date.now() - start;
    const errorMessage = err instanceof Error ? err.message : 'Unknown error';

    failToolInvocation(db, invocation.toolInvocationId, {
      resultMeta: { error: errorMessage },
      durationMs,
    });

    emitToolEvent(db, context, 'tool.invoked', toolName, {
      toolInvocationId: invocation.toolInvocationId,
      isError: true,
      error: errorMessage,
      durationMs,
    });

    return {
      content: `Error: ${errorMessage}`,
      isError: true,
    };
  }
}

// =============================================================================
// Token Budget Helpers
// =============================================================================

function abortableSleep(ms: number, signal: AbortSignal | undefined, runId: string): Promise<void> {
  if (signal?.aborted === true) return Promise.reject(new AgentCancelledError(runId));
  if (ms <= 0) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(new AgentCancelledError(runId));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function estimateTokens(
  systemPrompt: string,
  messages: Anthropic.MessageParam[],
  tools: Anthropic.Tool[] | undefined,
): number {
  let chars = systemPrompt.length;
  for (const msg of messages) {
    if (typeof msg.content === 'string') {
      chars += msg.content.length;
    } else {
      chars += JSON.stringify(msg.content).length;
    }
  }
  if (tools !== undefined) {
    chars += JSON.stringify(tools).length;
  }
  return Math.ceil((chars / 4) * ESTIMATION_SAFETY_FACTOR);
}

function compactMessages(
  messages: Anthropic.MessageParam[],
  keepRecentTurns: number,
): Anthropic.MessageParam[] | null {
  const totalPairs = (messages.length - 1) / 2;
  if (totalPairs <= keepRecentTurns) return null;
  const initial = messages[0];
  if (initial === undefined) return null;
  const recentStart = messages.length - keepRecentTurns * 2;
  return [initial, ...messages.slice(recentStart)];
}

function applyCompaction(
  systemPrompt: string,
  messages: Anthropic.MessageParam[],
  tools: Anthropic.Tool[] | undefined,
  budget: number,
): { resolved: boolean; finalEstimate: number; keptTurns: number } {
  let keepTurns = DEFAULT_KEEP_RECENT_TURNS;
  let compacted: Anthropic.MessageParam[] | null = null;
  let estimate = estimateTokens(systemPrompt, messages, tools);

  while (keepTurns >= MIN_RECENT_TURNS) {
    compacted = compactMessages(messages, keepTurns);
    if (compacted === null) {
      keepTurns--;
      continue;
    }
    estimate = estimateTokens(systemPrompt, compacted, tools);
    if (estimate <= budget) {
      messages.length = 0;
      messages.push(...compacted);
      return { resolved: true, finalEstimate: estimate, keptTurns: keepTurns };
    }
    keepTurns--;
  }

  return { resolved: false, finalEstimate: estimate, keptTurns: keepTurns };
}

// =============================================================================
// Private wrapper for raw tool loop (adds tool_use_id)
// =============================================================================

async function executeToolCall(
  toolCall: ToolCall,
  input: ExecutorInput
): Promise<Anthropic.ToolResultBlockParam> {
  const result = await executeAuditedToolCall(
    toolCall.name,
    toolCall.input,
    input.registry,
    input.policyRules,
    input.context,
    input.db,
  );
  return {
    type: 'tool_result',
    tool_use_id: toolCall.id,
    content: result.content,
    is_error: result.isError,
  };
}

// =============================================================================
// Main Loop
// =============================================================================

export async function runToolLoop(input: ExecutorInput): Promise<ExecutorResult> {
  ensureBuiltInPolicyDefinitions(input.db);
  const maxIterations = input.maxIterations ?? MAX_TOOL_ITERATIONS;
  const tools = input.registry.toAnthropicTools();

  let totalTokensInput = 0;
  let totalTokensOutput = 0;
  const loopStart = Date.now();
  let lastContent = '';
  let lastStopReason = 'unknown';

  const messages: Anthropic.MessageParam[] = [
    { role: 'user', content: input.userPrompt },
  ];

  const budgetCfg = resolveBudgetConfig(input.maxInputTokens);
  let effectiveBudget = budgetCfg.contextCap;
  log.info(
    { contextCap: budgetCfg.contextCap, backoffFactor: budgetCfg.backoffFactor,
      recoveryFactor: budgetCfg.recoveryFactor, minBudgetFloor: budgetCfg.minBudgetFloor,
      maxRateLimitRetries: budgetCfg.maxRateLimitRetries },
    'Token budget config resolved',
  );

  // Persist system and user prompts (non-fatal)
  let turnIndex = 0;
  try {
    createAgentMessage(input.db, {
      agentInvocationId: input.context.agentInvocationId,
      turnIndex: turnIndex++,
      role: 'system',
      contentJson: JSON.stringify(input.systemPrompt),
    });
  } catch (err) {
    log.warn({ err }, 'Failed to persist system prompt message');
  }
  try {
    createAgentMessage(input.db, {
      agentInvocationId: input.context.agentInvocationId,
      turnIndex: turnIndex++,
      role: 'user',
      contentJson: JSON.stringify(input.userPrompt),
    });
  } catch (err) {
    log.warn({ err }, 'Failed to persist user prompt message');
  }

  for (let i = 0; i < maxIterations; i++) {
    // Check abort signal (in-process cancellation)
    if (input.abortSignal?.aborted === true) {
      throw new AgentCancelledError(input.context.runId);
    }

    // DB phase check fallback (cross-process cancellation)
    const phaseRow = input.db.prepare('SELECT phase FROM runs WHERE run_id = ?')
      .get(input.context.runId) as { phase: string } | undefined;
    if (phaseRow !== undefined && (phaseRow.phase === 'cancelled' || phaseRow.phase === 'completed')) {
      throw new AgentCancelledError(input.context.runId);
    }

    // --- Token budget preflight ---
    const toolDefs = tools.length > 0 ? tools : undefined;
    const estimated = estimateTokens(input.systemPrompt, messages, toolDefs);

    if (estimated > effectiveBudget) {
      const { resolved, finalEstimate, keptTurns } = applyCompaction(
        input.systemPrompt, messages, toolDefs, effectiveBudget,
      );
      if (resolved) {
        log.info(
          { iteration: i, estimatedTokens: estimated, compactedTokens: finalEstimate,
            keptTurns, effectiveBudget },
          'Token budget preflight: compacted message history',
        );
      } else {
        log.warn(
          { iteration: i, estimatedTokens: finalEstimate, effectiveBudget,
            messageCount: messages.length },
          'Token budget preflight: compaction insufficient',
        );
        throw new AgentBudgetExceededError(finalEstimate, effectiveBudget);
      }
    }

    // --- Provider call with inner rate-limit retry ---
    let response: AgentOutput;
    for (let retry = 0; ; retry++) {
      try {
        response = await input.provider.invoke({
          systemPrompt: input.systemPrompt,
          userPrompt: input.userPrompt,
          messages,
          tools: toolDefs,
          maxTokens: input.maxTokens,
          temperature: input.temperature,
          timeoutMs: input.timeoutMs,
          abortSignal: input.abortSignal,
          runId: input.context.runId,
        });
        break;
      } catch (err) {
        if (err instanceof AgentRateLimitError && retry < budgetCfg.maxRateLimitRetries) {
          const prevBudget = effectiveBudget;
          effectiveBudget = Math.max(
            budgetCfg.minBudgetFloor,
            Math.floor(effectiveBudget * budgetCfg.backoffFactor),
          );
          const delay = err.retryAfterMs ?? (RETRY_BASE_DELAY_MS * Math.pow(2, retry) + Math.random() * RETRY_JITTER_MS);
          log.warn(
            { iteration: i, retry, prevBudget, effectiveBudget, delayMs: delay,
              estimatedTokens: estimated },
            'Rate limit hit, backing off token budget',
          );
          await abortableSleep(delay, input.abortSignal, input.context.runId);

          // Best-effort re-compact with reduced budget; if it fails,
          // re-throw original rate limit error (rate limit is the root cause,
          // not payload size — compaction is just a mitigation attempt).
          const reEstimated = estimateTokens(input.systemPrompt, messages, toolDefs);
          if (reEstimated > effectiveBudget) {
            const compResult = applyCompaction(
              input.systemPrompt, messages, toolDefs, effectiveBudget,
            );
            if (compResult.resolved) {
              log.info(
                { iteration: i, retry, compactedTokens: compResult.finalEstimate,
                  effectiveBudget, keptTurns: compResult.keptTurns },
                'Re-compacted after rate limit backoff',
              );
            } else {
              log.warn(
                { iteration: i, retry, estimatedTokens: compResult.finalEstimate,
                  effectiveBudget },
                'Re-compaction failed after rate limit, re-throwing rate limit error',
              );
              throw err;
            }
          }
          continue;
        }
        throw err;
      }
    }

    // Successful call — gradual recovery toward contextCap
    if (effectiveBudget < budgetCfg.contextCap) {
      effectiveBudget = Math.min(
        budgetCfg.contextCap,
        Math.ceil(effectiveBudget * budgetCfg.recoveryFactor),
      );
    }

    totalTokensInput += response.tokensInput;
    totalTokensOutput += response.tokensOutput;
    lastStopReason = response.stopReason;

    if (response.content.length > 0) {
      lastContent = response.content;
    }

    // Persist assistant response (non-fatal)
    try {
      createAgentMessage(input.db, {
        agentInvocationId: input.context.agentInvocationId,
        turnIndex: turnIndex++,
        role: 'assistant',
        contentJson: JSON.stringify(response.rawContentBlocks ?? [{ type: 'text', text: response.content }]),
        tokensInput: response.tokensInput,
        tokensOutput: response.tokensOutput,
        stopReason: response.stopReason,
      });
    } catch (err) {
      log.warn({ err }, 'Failed to persist assistant message');
    }

    // If no tool use, we're done
    if (response.stopReason !== 'tool_use' || response.toolCalls === undefined || response.toolCalls.length === 0) {
      return {
        content: lastContent,
        totalTokensInput,
        totalTokensOutput,
        totalDurationMs: Date.now() - loopStart,
        iterations: i + 1,
        stopReason: lastStopReason,
      };
    }

    // Append assistant message with raw content blocks
    messages.push({
      role: 'assistant',
      content: response.rawContentBlocks ?? [],
    });

    // Execute each tool call and collect results
    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const toolCall of response.toolCalls) {
      // Re-check abort signal before each tool call. Signal may flip async
      // between loop top and here, so we call a helper to bypass narrowing.
      if (isAborted(input.abortSignal)) {
        throw new AgentCancelledError(input.context.runId);
      }
      const result = await executeToolCall(toolCall, input);
      toolResults.push(result);
    }

    // Persist tool results (non-fatal)
    try {
      createAgentMessage(input.db, {
        agentInvocationId: input.context.agentInvocationId,
        turnIndex: turnIndex++,
        role: 'tool_result',
        contentJson: JSON.stringify(toolResults),
      });
    } catch (err) {
      log.warn({ err }, 'Failed to persist tool result message');
    }

    // Append user message with tool results
    messages.push({
      role: 'user',
      content: toolResults,
    });
  }

  throw new AgentError(
    `Tool loop exceeded maximum iterations (${maxIterations})`,
    'max_iterations'
  );
}
