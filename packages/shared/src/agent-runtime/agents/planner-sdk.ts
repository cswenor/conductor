/**
 * Planner Agent — Agent SDK Backend
 *
 * Runs the planner via the Claude Agent SDK `query()` function.
 * Unlike the raw path (single-call executeAgent), this runs as a
 * multi-turn SDK conversation with MCP tools — enabling the planner
 * to explore the codebase, run tests, and understand project structure
 * before producing a plan.
 */

import type { Database } from 'better-sqlite3';
import { query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { createLogger } from '../../logger/index.ts';
import { MVP_DEFAULTS } from '../../workflow-config/index.ts';
import { getRun } from '../../runs/index.ts';
import { getAbortSignal } from '../../cancellation/index.ts';
import { publishAgentInvocationEvent } from '../../pubsub/index.ts';
import { assembleContext, formatContextForPrompt } from '../context.ts';
import { createAgentInvocation, markAgentRunning, completeAgentInvocation, failAgentInvocation } from '../invocations.ts';
import { createArtifact } from '../artifacts.ts';
import { createAgentMessage } from '../agent-messages.ts';
import { createToolRegistry } from '../tools/registry.ts';
import { isValidToolProfile, validateProfileForStep, registerToolsForProfile } from '../tools/profiles.ts';
import { DEFAULT_POLICY_RULES } from '../tools/policy.ts';
import { ensureBuiltInPolicyDefinitions } from '../policy-definitions.ts';
import { createAgentMcpServer, getAllowedToolNames } from '../tools/mcp-adapter.ts';
import type { ToolResultEntry } from '../tools/protocol.ts';
import { flushToolResults as flushToolResultsHelper } from '../tools/protocol.ts';
import { AgentError, AgentAuthError, AgentRateLimitError, AgentContextLengthError, AgentCancelledError, AgentTimeoutError } from '../provider.ts';
import { extractRetryAfterMs } from '../retry-after.ts';
import { extractTerminalAssistantText } from './sdk-result.ts';
import type { PlannerInput, PlannerResult } from './planner.ts';

const log = createLogger({ name: 'conductor:planner-sdk' });

// =============================================================================
// System Prompt
// =============================================================================

const PLANNER_SDK_SYSTEM_PROMPT = `You are a software engineering planner working as part of an automated orchestration system.

Your task is to analyze a GitHub issue and produce a detailed, actionable implementation plan.
Use the provided tools to explore the codebase and understand existing patterns before writing your plan.

## Available Tools
- **read_file**: Read file contents to understand existing code.
- **read_file_range**: Read specific lines from a file.
- **search_in_file**: Search for patterns in a file. Use /pattern/flags for regex.
- **list_files**: List repository files. Filter by directory and glob pattern.
- **run_tests**: Run test commands to understand the current test state.

## Process
1. Start by exploring the repository structure with list_files.
2. Read relevant files to understand existing patterns and architecture.
3. Run tests if needed to understand current state.
4. Produce your complete plan as your FINAL response.

## Output Format

Your plan MUST use this exact structure in Markdown:

### Approach
High-level strategy for solving this issue. 1-3 sentences.

### Files to Change
List each file that needs to be created, modified, or deleted:
- \`path/to/file.ts\` — Description of changes

### Steps
Numbered implementation steps. Each step must be concrete and unambiguous:
1. Step description
2. Step description
...

### Risks & Considerations
- Edge cases to handle
- Potential issues or breaking changes
- Security considerations

### Testing Strategy
- How to verify the changes work
- What tests to add or modify

## Rules
- Your FINAL response MUST contain the complete plan in the format above.
- Do NOT produce file changes or write any files. You are a planner only.
- Be specific: reference exact file paths, function names, and types.
- Be complete: an implementer agent must be able to follow this plan without additional context.
- Be concise: no unnecessary prose. Every sentence must be actionable.
- If you have review feedback from a previous revision, address every point raised.`;

// =============================================================================
// Main Entry Point
// =============================================================================

export async function runPlannerWithAgentSDK(
  db: Database,
  input: PlannerInput & { apiKey: string },
): Promise<PlannerResult> {
  ensureBuiltInPolicyDefinitions(db);

  // Require worktree — SDK tools must never operate against the worker process directory
  if (input.worktreePath === undefined || input.worktreePath === '') {
    throw new AgentError('Planner SDK requires a worktree path', 'missing_worktree');
  }

  const runRecord = getRun(db, input.runId);
  if (runRecord === null) throw new Error(`Run not found: ${input.runId}`);
  const projectId = runRecord.projectId;

  // Resolve tool profile with step-specific constraint enforcement
  const profileName = input.stepConfig?.toolProfile ?? 'inspect';
  if (!isValidToolProfile(profileName)) {
    throw new AgentError(`Invalid tool profile: '${profileName}'`, 'invalid_tool_profile');
  }
  const constraintError = validateProfileForStep(profileName, 'planner');
  if (constraintError !== null) {
    throw new AgentError(constraintError, 'invalid_tool_profile');
  }

  // Assemble context
  const assembledContext = assembleContext(db, {
    runId: input.runId,
    worktreePath: input.worktreePath,
  });
  const userPrompt = formatContextForPrompt(assembledContext);

  // Create agent invocation
  const invocation = createAgentInvocation(db, {
    runId: input.runId,
    agent: 'planner',
    action: 'create_plan',
    contextSummary: 'step=planner_create_plan (agent-sdk mode)',
  });
  const agentInvocationId = invocation.agentInvocationId;
  publishAgentInvocationEvent(db, projectId, input.runId, agentInvocationId, 'planner', 'create_plan', 'pending');

  markAgentRunning(db, agentInvocationId);
  publishAgentInvocationEvent(db, projectId, input.runId, agentInvocationId, 'planner', 'create_plan', 'running');

  // Set up tool registry
  const registry = createToolRegistry();
  registerToolsForProfile(registry, profileName);

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

  const mcpServer = createAgentMcpServer(
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
      contentJson: JSON.stringify(PLANNER_SDK_SYSTEM_PROMPT),
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
    flushToolResultsHelper(pendingToolResults, pendingToolUseIds, db, agentInvocationId, nextTurnIndex);
  }

  // Warn if non-default maxTokens/temperature are configured (SDK doesn't support them)
  const defaults = MVP_DEFAULTS.planner;
  if (
    (input.stepConfig?.maxTokens !== undefined && input.stepConfig.maxTokens !== defaults.maxTokens) ||
    (input.stepConfig?.temperature !== undefined && input.stepConfig.temperature !== defaults.temperature)
  ) {
    log.warn(
      { runId: input.runId, maxTokens: input.stepConfig?.maxTokens, temperature: input.stepConfig?.temperature },
      'agent_sdk backend does not support maxTokens/temperature overrides — values ignored',
    );
  }

  // Budget timeout: abort SDK query after maxDurationMs
  let budgetTimedOut = false;
  let budgetTimer: ReturnType<typeof setTimeout> | undefined;
  const budgetDurationMs = input.stepConfig?.budgets?.maxDurationMs;
  if (budgetDurationMs !== undefined) {
    budgetTimer = setTimeout(() => {
      budgetTimedOut = true;
      abortController.abort();
    }, budgetDurationMs);
  }

  const startTime = Date.now();
  let totalTokensInput = 0;
  let totalTokensOutput = 0;

  // Track final assistant message for result extraction
  let lastAssistantSnapshot: { content: unknown[]; stopReason: string | undefined } | undefined;

  try {
    const queryStream = sdkQuery({
      prompt: userPrompt,
      options: {
        systemPrompt: PLANNER_SDK_SYSTEM_PROMPT,
        model: input.stepConfig?.model ?? 'claude-sonnet-4-20250514',
        maxTurns: 30,
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

        // Track last assistant snapshot for result extraction
        lastAssistantSnapshot = {
          content: message.message.content,
          stopReason: message.message.stop_reason ?? undefined,
        };

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
    }

    const durationMs = Date.now() - startTime;

    // Extract plan from terminal assistant message
    const plan = extractTerminalAssistantText(lastAssistantSnapshot, 'Planner');

    // Record success
    completeAgentInvocation(db, agentInvocationId, {
      tokensInput: totalTokensInput,
      tokensOutput: totalTokensOutput,
      durationMs,
    });
    publishAgentInvocationEvent(db, projectId, input.runId, agentInvocationId, 'planner', 'create_plan', 'completed');

    // Store plan as artifact
    const artifact = createArtifact(db, {
      runId: input.runId,
      type: 'plan',
      contentMarkdown: plan,
      createdBy: 'planner',
    });

    // Update plan_revisions counter
    db.prepare(
      'UPDATE runs SET plan_revisions = plan_revisions + 1, updated_at = ? WHERE run_id = ?'
    ).run(new Date().toISOString(), input.runId);

    log.info(
      { runId: input.runId, agentInvocationId, artifactId: artifact.artifactId },
      'Planner (agent-sdk) completed',
    );

    return {
      agentInvocationId,
      artifactId: artifact.artifactId,
      plan,
    };
  } catch (err) {
    // Best-effort: persist any pending tool results before failing
    flushToolResults();

    // Determine final error — budget timeout takes precedence over generic abort
    let finalError: AgentError;

    if (budgetTimedOut) {
      finalError = new AgentTimeoutError(
        budgetDurationMs ?? 0,
        'planner',
        'create_plan',
      );
    } else if (abortController.signal.aborted) {
      finalError = new AgentCancelledError(input.runId);
    } else {
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

      finalError = mappedError ?? new AgentError(
        err instanceof Error ? err.message : 'Unknown SDK error',
      );
    }

    // Shared persistence
    const errorCode = finalError.code;
    const errorMessage = finalError.message;

    try {
      failAgentInvocation(db, agentInvocationId, { errorCode, errorMessage });
    } catch {
      // May already be terminal
    }
    publishAgentInvocationEvent(db, projectId, input.runId, agentInvocationId, 'planner', 'create_plan', 'failed', errorCode);

    throw finalError;
  } finally {
    if (budgetTimer !== undefined) clearTimeout(budgetTimer);
    clearInterval(phaseCheckInterval);
  }
}
