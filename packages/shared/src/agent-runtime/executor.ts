/**
 * Tool Execution Loop
 *
 * The core of WP7. Manages the multi-turn conversation loop where
 * the agent can invoke tools and receive results before continuing.
 */

import { createHash } from 'node:crypto';
import type { Database } from 'better-sqlite3';
import type Anthropic from '@anthropic-ai/sdk';
import { createLogger } from '../logger/index.js';
import { redact } from '../redact/index.js';
import { createEvent } from '../events/index.js';
import type { AgentProvider } from './provider.js';
import { AgentError } from './provider.js';
import type { ToolRegistry } from './tools/registry.js';
import type { PolicyRule } from './tools/policy.js';
import { evaluatePolicy } from './tools/policy.js';
import type { ToolExecutionContext, ToolCall } from './tools/types.js';
import {
  createToolInvocation,
  completeToolInvocation,
  failToolInvocation,
  blockToolInvocation,
} from './tool-invocations.js';
import { ensureBuiltInPolicyDefinitions } from './policy-definitions.js';

const log = createLogger({ name: 'conductor:executor' });

// =============================================================================
// Constants
// =============================================================================

export const MAX_TOOL_ITERATIONS = 50;

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

function redactToolArgs(
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

function emitToolEvent(
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

async function executeToolCall(
  toolCall: ToolCall,
  input: ExecutorInput
): Promise<Anthropic.ToolResultBlockParam> {
  const { db, registry, policyRules, context } = input;
  const tool = registry.get(toolCall.name);

  // Unknown tool → log invocation then error result
  if (tool === undefined) {
    const unknownStart = Date.now();
    const argsForRedaction = redactToolArgs(toolCall.name, toolCall.input);
    const redacted = redact(argsForRedaction);

    const invocation = createToolInvocation(db, {
      agentInvocationId: context.agentInvocationId,
      runId: context.runId,
      tool: toolCall.name,
      argsRedactedJson: redacted.json,
      argsFieldsRemovedJson: JSON.stringify(redacted.fieldsRemoved),
      argsSecretsDetected: redacted.secretsDetected,
      argsPayloadHash: redacted.payloadHash,
      argsPayloadHashScheme: redacted.payloadHashScheme,
      policyDecision: 'allow',
    });

    failToolInvocation(db, invocation.toolInvocationId, {
      resultMeta: { errorCode: 'unknown_tool', toolName: toolCall.name },
      durationMs: Date.now() - unknownStart,
    });

    return {
      type: 'tool_result',
      tool_use_id: toolCall.id,
      content: `Error: Unknown tool '${toolCall.name}'`,
      is_error: true,
    };
  }

  const start = Date.now();

  // Redact args for logging
  const argsForRedaction = redactToolArgs(toolCall.name, toolCall.input);
  const redacted = redact(argsForRedaction);

  // Extract target
  const target = tool.extractTarget?.(toolCall.input);

  // Evaluate policy
  const policyResult = evaluatePolicy(policyRules, toolCall.name, toolCall.input, context);

  if (policyResult.decision === 'block') {
    const durationMs = Date.now() - start;

    const blockedInvocation = createToolInvocation(db, {
      agentInvocationId: context.agentInvocationId,
      runId: context.runId,
      tool: toolCall.name,
      target,
      argsRedactedJson: redacted.json,
      argsFieldsRemovedJson: JSON.stringify(redacted.fieldsRemoved),
      argsSecretsDetected: redacted.secretsDetected,
      argsPayloadHash: redacted.payloadHash,
      argsPayloadHashScheme: redacted.payloadHashScheme,
      policyDecision: 'block',
      policyId: policyResult.policyId,
    });

    // Store completion metadata (policyId, reason) on the blocked invocation
    blockToolInvocation(db, blockedInvocation.toolInvocationId, {
      resultMeta: {
        policyId: policyResult.policyId,
        reason: policyResult.reason,
      },
      durationMs,
    });

    emitToolEvent(db, context, 'tool.policy_blocked', toolCall.name, {
      policyId: policyResult.policyId,
      reason: policyResult.reason,
      durationMs,
    });

    return {
      type: 'tool_result',
      tool_use_id: toolCall.id,
      content: `Error: Policy blocked - ${policyResult.reason ?? 'access denied'}`,
      is_error: true,
    };
  }

  // Create invocation record (status: started)
  const invocation = createToolInvocation(db, {
    agentInvocationId: context.agentInvocationId,
    runId: context.runId,
    tool: toolCall.name,
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
    const result = await tool.execute(toolCall.input, context);
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

    emitToolEvent(db, context, 'tool.invoked', toolCall.name, {
      toolInvocationId: invocation.toolInvocationId,
      isError: result.isError ?? false,
      durationMs,
    });

    return {
      type: 'tool_result',
      tool_use_id: toolCall.id,
      content: result.content,
      is_error: result.isError,
    };
  } catch (err) {
    const durationMs = Date.now() - start;
    const errorMessage = err instanceof Error ? err.message : 'Unknown error';

    failToolInvocation(db, invocation.toolInvocationId, {
      resultMeta: { error: errorMessage },
      durationMs,
    });

    emitToolEvent(db, context, 'tool.invoked', toolCall.name, {
      toolInvocationId: invocation.toolInvocationId,
      isError: true,
      error: errorMessage,
      durationMs,
    });

    return {
      type: 'tool_result',
      tool_use_id: toolCall.id,
      content: `Error: ${errorMessage}`,
      is_error: true,
    };
  }
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

  for (let i = 0; i < maxIterations; i++) {
    const response = await input.provider.invoke({
      systemPrompt: input.systemPrompt,
      userPrompt: input.userPrompt,
      messages,
      tools: tools.length > 0 ? tools : undefined,
      maxTokens: input.maxTokens,
      temperature: input.temperature,
      timeoutMs: input.timeoutMs,
    });

    totalTokensInput += response.tokensInput;
    totalTokensOutput += response.tokensOutput;
    lastStopReason = response.stopReason;

    if (response.content.length > 0) {
      lastContent = response.content;
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
      const result = await executeToolCall(toolCall, input);
      toolResults.push(result);
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
