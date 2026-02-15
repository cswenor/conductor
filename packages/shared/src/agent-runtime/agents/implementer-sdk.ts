/**
 * Implementer Agent — Agent SDK Backend
 *
 * Runs the implementer via the Claude Agent SDK `query()` function.
 * The SDK manages the conversation loop, context compaction, and
 * automatic rate-limit retries. Our custom tools are exposed as MCP
 * tools via the shared `executeAuditedToolCall()` function so audit,
 * policy, and telemetry contracts are preserved.
 */

import { execFileSync } from 'node:child_process';
import type { Database } from 'better-sqlite3';
import { query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { createLogger } from '../../logger/index.ts';
import type { ImplementerBackend, Run } from '../../runs/index.ts';
import { getRun } from '../../runs/index.ts';
import { getAbortSignal } from '../../cancellation/index.ts';
import { publishAgentInvocationEvent } from '../../pubsub/index.ts';
import { assembleContext, formatContextForPrompt } from '../context.ts';
import { createAgentInvocation, markAgentRunning, completeAgentInvocation, failAgentInvocation } from '../invocations.ts';
import { createArtifact } from '../artifacts.ts';
import { createAgentMessage } from '../agent-messages.ts';
import { listToolInvocations } from '../tool-invocations.ts';
import { createToolRegistry } from '../tools/registry.ts';
import { registerFilesystemTools } from '../tools/filesystem.ts';
import { registerTestRunnerTool } from '../tools/test-runner.ts';
import { DEFAULT_POLICY_RULES } from '../tools/policy.ts';
import { ensureBuiltInPolicyDefinitions } from '../policy-definitions.ts';
import { createImplementerMcpServer, getAllowedToolNames } from '../tools/mcp-adapter.ts';
import type { ToolResultEntry } from '../tools/mcp-adapter.ts';
import { AgentError, AgentAuthError, AgentRateLimitError, AgentContextLengthError, AgentCancelledError } from '../provider.ts';
import type { FileOperation, ImplementerInput, ImplementerResult } from './implementer.ts';

const log = createLogger({ name: 'conductor:implementer-sdk' });

// =============================================================================
// System Prompt (same as raw path)
// =============================================================================

const IMPLEMENTER_TOOLS_SYSTEM_PROMPT = `You are a software implementer working as part of an automated orchestration system.

Your task is to implement the approved plan by producing file changes.

## Available Tools

You have access to the following tools:
- **read_file**: Read the contents of a file to understand existing code.
- **write_file**: Write or overwrite a file with complete content.
- **delete_file**: Delete a file that is no longer needed.
- **list_files**: List files in the repository to understand its structure.
- **run_tests**: Run test commands to verify your changes work.

## Rules
- Follow the plan exactly. Implement all planned changes.
- Write COMPLETE files, not diffs or patches.
- Use relative paths from the repository root. No absolute paths.
- Include all necessary imports and type declarations.
- Follow existing code patterns and conventions in the repository.
- Do not modify files outside the scope of the plan.
- Do not create or modify .git/ directory files.
- Ensure all code compiles/parses correctly.
- Use read_file and list_files to understand existing code before making changes.
- After writing files, consider running tests to verify your changes.`;

// =============================================================================
// Backend Resolver
// =============================================================================

export function resolveImplementerBackend(run: Run): ImplementerBackend {
  return run.implementerBackend;
}

// =============================================================================
// Retry-After Extraction
// =============================================================================

export function extractRetryAfterMs(err: unknown): number | undefined {
  if (err === null || typeof err !== 'object' || !('headers' in err)) return undefined;
  const headers = (err as { headers: unknown }).headers;
  let value: string | null = null;

  // Handle Headers-like API (has .get())
  if (
    headers !== null &&
    typeof headers === 'object' &&
    'get' in headers &&
    typeof (headers as { get: unknown }).get === 'function'
  ) {
    value = (headers as { get: (k: string) => string | null }).get('retry-after');
  }
  // Handle plain Record<string, string>
  else if (headers !== null && typeof headers === 'object') {
    value = (headers as Record<string, string>)['retry-after'] ?? null;
  }

  if (value === null) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds > 0 && seconds < 3600) {
    return Math.ceil(seconds * 1000);
  }
  return undefined;
}

// =============================================================================
// Main Entry Point
// =============================================================================

export async function runImplementerWithAgentSDK(
  db: Database,
  input: ImplementerInput & { apiKey: string },
): Promise<ImplementerResult> {
  ensureBuiltInPolicyDefinitions(db);

  const runRecord = getRun(db, input.runId);
  if (runRecord === null) throw new Error(`Run not found: ${input.runId}`);
  const projectId = runRecord.projectId;

  // Assemble context
  const assembledContext = assembleContext(db, {
    runId: input.runId,
    worktreePath: input.worktreePath,
  });
  const userPrompt = formatContextForPrompt(assembledContext);

  // Create agent invocation
  const invocation = createAgentInvocation(db, {
    runId: input.runId,
    agent: 'implementer',
    action: 'apply_changes',
    contextSummary: 'step=implementer_apply_changes (agent-sdk mode)',
  });
  const agentInvocationId = invocation.agentInvocationId;
  publishAgentInvocationEvent(db, projectId, input.runId, agentInvocationId, 'implementer', 'apply_changes', 'pending');

  markAgentRunning(db, agentInvocationId);
  publishAgentInvocationEvent(db, projectId, input.runId, agentInvocationId, 'implementer', 'apply_changes', 'running');

  // Snapshot existing files for create-vs-edit detection
  const existingFiles = new Set<string>();
  try {
    const output = execFileSync('git', ['ls-files'], { cwd: input.worktreePath, encoding: 'utf8' });
    for (const f of output.split('\n')) {
      if (f.length > 0) existingFiles.add(f);
    }
  } catch {
    // If git ls-files fails, all writes treated as 'create'
  }

  // Set up tool registry + MCP server
  const registry = createToolRegistry();
  registerFilesystemTools(registry);
  registerTestRunnerTool(registry);

  const abortSignal = getAbortSignal(input.runId);
  const abortController = new AbortController();

  // Forward existing abort signal
  if (abortSignal?.aborted === true) {
    abortController.abort();
  } else if (abortSignal !== undefined) {
    abortSignal.addEventListener('abort', () => abortController.abort(), { once: true });
  }

  const toolContext = {
    runId: input.runId,
    agentInvocationId,
    worktreePath: input.worktreePath,
    db,
    projectId,
    abortSignal: abortController.signal,
  };

  // Shared state between stream iterator and MCP adapter
  const pendingToolUseIds: string[] = [];
  const pendingToolResults: ToolResultEntry[] = [];

  const mcpServer = createImplementerMcpServer(
    registry,
    DEFAULT_POLICY_RULES,
    toolContext,
    db,
    pendingToolResults,
    pendingToolUseIds,
  );

  // DB phase polling interval
  const phaseCheckInterval = setInterval(() => {
    try {
      const phaseRow = db.prepare('SELECT phase FROM runs WHERE run_id = ?')
        .get(input.runId) as { phase: string } | undefined;
      if (phaseRow !== undefined && (phaseRow.phase === 'cancelled' || phaseRow.phase === 'completed')) {
        abortController.abort();
      }
    } catch {
      // Non-fatal
    }
  }, 5000);

  // Turn index allocator
  let turnIndex = 0;
  const nextTurnIndex = () => turnIndex++;

  // Persist system + user prompts
  try {
    createAgentMessage(db, {
      agentInvocationId,
      turnIndex: nextTurnIndex(),
      role: 'system',
      contentJson: JSON.stringify(IMPLEMENTER_TOOLS_SYSTEM_PROMPT),
    });
  } catch (e) {
    log.warn({ err: e }, 'Failed to persist system prompt message');
  }
  try {
    createAgentMessage(db, {
      agentInvocationId,
      turnIndex: nextTurnIndex(),
      role: 'user',
      contentJson: JSON.stringify(userPrompt),
    });
  } catch (e) {
    log.warn({ err: e }, 'Failed to persist user prompt message');
  }

  // Flush accumulated tool results as one agent_message
  function flushToolResults(): void {
    if (pendingToolResults.length === 0) return;
    if (pendingToolUseIds.length > 0) {
      log.warn({ remaining: pendingToolUseIds.length }, 'Stale tool_use_ids remaining after batch');
      pendingToolUseIds.length = 0;
    }
    try {
      createAgentMessage(db, {
        agentInvocationId,
        turnIndex: nextTurnIndex(),
        role: 'tool_result',
        contentJson: JSON.stringify(pendingToolResults),
      });
    } catch (e) {
      log.warn({ err: e }, 'Failed to persist tool_result message');
    }
    pendingToolResults.length = 0;
  }

  const startTime = Date.now();
  let totalTokensInput = 0;
  let totalTokensOutput = 0;

  try {
    const queryStream = sdkQuery({
      prompt: userPrompt,
      options: {
        systemPrompt: IMPLEMENTER_TOOLS_SYSTEM_PROMPT,
        model: 'claude-sonnet-4-20250514',
        maxTurns: 50,
        cwd: input.worktreePath,
        env: { ...process.env, ANTHROPIC_API_KEY: input.apiKey },
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        tools: [],
        allowedTools: getAllowedToolNames(registry),
        mcpServers: {
          'conductor-tools': mcpServer,
        },
        abortController,
        persistSession: false,
        settingSources: [],
      },
    });

    for await (const message of queryStream as AsyncIterable<SDKMessage>) {
      if (message.type === 'assistant') {
        // Flush tool results from the PREVIOUS turn (batch boundary)
        flushToolResults();

        // Extract tool_use IDs for the MCP adapter to dequeue
        pendingToolUseIds.length = 0;
        for (const block of message.message.content) {
          if (block.type === 'tool_use') {
            pendingToolUseIds.push(block.id);
          }
        }

        // Persist assistant message
        try {
          const usage = message.message.usage;
          totalTokensInput += usage?.input_tokens ?? 0;
          totalTokensOutput += usage?.output_tokens ?? 0;

          createAgentMessage(db, {
            agentInvocationId,
            turnIndex: nextTurnIndex(),
            role: 'assistant',
            contentJson: JSON.stringify(message.message.content),
            tokensInput: usage?.input_tokens,
            tokensOutput: usage?.output_tokens,
            stopReason: message.message.stop_reason ?? undefined,
          });
        } catch (e) {
          log.warn({ err: e }, 'Failed to persist assistant message');
        }
      } else if (message.type === 'result') {
        // Flush remaining tool results (final turn)
        flushToolResults();

        // Capture usage from result
        if (message.usage !== undefined) {
          totalTokensInput = message.usage.input_tokens ?? totalTokensInput;
          totalTokensOutput = message.usage.output_tokens ?? totalTokensOutput;
        }

        // Check for error results
        if (message.subtype !== 'success') {
          const errors = 'errors' in message ? (message.errors ?? []) : [];
          throw new AgentError(
            `SDK query ended with ${message.subtype}: ${errors.join('; ')}`,
            message.subtype,
          );
        }
      }
      // Ignore other message types (system, stream_event, tool_progress, etc.)
    }

    const durationMs = Date.now() - startTime;

    // Record success
    completeAgentInvocation(db, agentInvocationId, {
      tokensInput: totalTokensInput,
      tokensOutput: totalTokensOutput,
      durationMs,
    });
    publishAgentInvocationEvent(db, projectId, input.runId, agentInvocationId, 'implementer', 'apply_changes', 'completed');

    // Derive file operations from tool invocation records
    const toolInvocations = listToolInvocations(db, agentInvocationId);
    const files: FileOperation[] = [];

    for (const ti of toolInvocations) {
      if (ti.status !== 'completed') continue;
      if (ti.tool === 'write_file' && ti.target !== undefined) {
        files.push({
          op: existingFiles.has(ti.target) ? 'edit' : 'create',
          path: ti.target,
          content: '',
        });
      } else if (ti.tool === 'delete_file' && ti.target !== undefined) {
        files.push({ op: 'delete', path: ti.target });
      }
    }

    // Store summary as artifact
    const summary = files.map((f) => `${f.op}: ${f.path}`).join('\n');
    const artifact = createArtifact(db, {
      runId: input.runId,
      type: 'other',
      contentMarkdown: `# Implementation Changes (Agent SDK Mode)\n\n${summary}\n\nTokens: ${totalTokensInput} in / ${totalTokensOutput} out\nDuration: ${Math.round(durationMs / 1000)}s`,
      createdBy: 'implementer',
    });

    log.info(
      { runId: input.runId, agentInvocationId, fileCount: files.length },
      'Implementer (agent-sdk) completed',
    );

    return {
      agentInvocationId,
      artifactId: artifact.artifactId,
      files,
    };
  } catch (err) {
    // Best-effort: persist any pending tool results before failing
    flushToolResults();

    // Error mapping
    if (abortController.signal.aborted) {
      const cancelErr = new AgentCancelledError(input.runId);
      try {
        failAgentInvocation(db, agentInvocationId, {
          errorCode: 'cancelled',
          errorMessage: cancelErr.message,
        });
      } catch {
        // May already be terminal
      }
      publishAgentInvocationEvent(db, projectId, input.runId, agentInvocationId, 'implementer', 'apply_changes', 'failed', 'cancelled');
      throw cancelErr;
    }

    // Check SDK error structure
    let mappedError: AgentError | undefined;
    if (err instanceof Error && 'status' in err) {
      const status = (err as { status: number }).status;
      if (status === 401 || status === 403) {
        mappedError = new AgentAuthError(err.message);
      } else if (status === 429) {
        const retryAfter = extractRetryAfterMs(err);
        mappedError = new AgentRateLimitError(err.message, retryAfter);
      } else if (status === 400) {
        mappedError = new AgentContextLengthError(err.message);
      }
    }

    if (mappedError === undefined && err instanceof AgentError) {
      mappedError = err;
    }

    const finalError = mappedError ?? new AgentError(
      err instanceof Error ? err.message : 'Unknown SDK error',
    );

    const errorCode = finalError.code;
    const errorMessage = finalError.message;

    try {
      failAgentInvocation(db, agentInvocationId, { errorCode, errorMessage });
    } catch {
      // May already be terminal
    }
    publishAgentInvocationEvent(db, projectId, input.runId, agentInvocationId, 'implementer', 'apply_changes', 'failed', errorCode);

    throw finalError;
  } finally {
    clearInterval(phaseCheckInterval);
  }
}
