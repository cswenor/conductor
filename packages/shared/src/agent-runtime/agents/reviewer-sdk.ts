/**
 * Reviewer Agent — Agent SDK Backend
 *
 * Runs plan reviewer and code reviewer via the Claude Agent SDK `query()`.
 * Unlike the raw path (single-call executeAgent), this runs as a
 * multi-turn SDK conversation with MCP tools — enabling the reviewer
 * to verify file paths, function names, and technical claims by
 * reading the actual codebase.
 */

import { execFileSync } from 'node:child_process';
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
import { parseVerdict } from './reviewer.ts';
import type { ReviewerInput, ReviewerResult } from './reviewer.ts';

const log = createLogger({ name: 'conductor:reviewer-sdk' });

// =============================================================================
// System Prompts
// =============================================================================

const PLAN_REVIEWER_SDK_SYSTEM_PROMPT = `You are a senior software engineer reviewing an implementation plan.

## Your Task
Review the proposed plan for the given issue and provide structured feedback.
Use the provided tools to verify file paths, function names, and technical claims in the plan.

## Available Tools
- **read_file**: Read file contents to verify plan references.
- **read_file_range**: Read specific lines from a file.
- **search_in_file**: Search for patterns to verify code references.
- **list_files**: List repository files to verify file paths in the plan.
- **run_tests**: Run test commands to verify current test state.

## Process
1. Read the plan and review feedback sections from the context.
2. Use tools to verify file paths, function names, and technical claims in the plan.
3. Run tests if needed to understand current project state.
4. Produce your verdict as your FINAL response.

## Response Format
Your response MUST begin with one of these verdicts on the first line:

APPROVED — The plan is ready for implementation.
CHANGES_REQUESTED — The plan needs revisions.

After the verdict, provide your review:

### Strengths
- What the plan does well

### Issues (if CHANGES_REQUESTED)
- Specific problems that must be addressed
- Each issue must be actionable

### Suggestions (optional)
- Non-blocking improvements

## Rules
- Be specific: reference file paths, function names, and steps.
- APPROVED means you're confident the plan will produce correct, complete code.
- CHANGES_REQUESTED means there are blocking issues. Be clear about what to fix.
- If the plan is borderline, default to CHANGES_REQUESTED. Better to iterate than ship bad code.
- Your FINAL response MUST contain the verdict. Do not end with a tool call.`;

const CODE_REVIEWER_SDK_SYSTEM_PROMPT = `You are a senior software engineer reviewing code changes.

## Your Task
Review the code diff against the approved plan and provide structured feedback.
Use the provided tools to verify the implementation details.

## Available Tools
- **read_file**: Read file contents to verify implementation.
- **read_file_range**: Read specific lines from a file.
- **search_in_file**: Search for patterns to verify code changes.
- **list_files**: List repository files to verify file structure.
- **run_tests**: Run test commands to verify the changes work.

## Process
1. Review the code diff provided in the context.
2. Use tools to verify the implementation matches the plan.
3. Run tests to verify correctness.
4. Produce your verdict as your FINAL response.

## Response Format
Your response MUST begin with one of these verdicts on the first line:

APPROVED — The code is ready for PR.
CHANGES_REQUESTED — The code needs revisions.

After the verdict, provide your review:

### Correctness
- Does the code correctly implement the plan?
- Are there logic errors or edge cases?

### Completeness
- Are all planned changes implemented?
- Are tests included?

### Issues (if CHANGES_REQUESTED)
- Specific problems with file paths and descriptions
- Each issue must be actionable

## Rules
- Check for: correctness, completeness, security issues, missing error handling.
- APPROVED means the code is ready for human review as a PR.
- CHANGES_REQUESTED means there are blocking issues the implementer must fix.
- Your FINAL response MUST contain the verdict. Do not end with a tool call.`;

// =============================================================================
// Shared SDK Runner
// =============================================================================

async function runReviewerSdk(
  db: Database,
  input: ReviewerInput & { apiKey: string },
  agent: string,
  action: string,
  stepName: string,
  systemPrompt: string,
  userPrompt: string,
  defaultsRef: typeof MVP_DEFAULTS.reviewerPlan,
): Promise<ReviewerResult> {
  ensureBuiltInPolicyDefinitions(db);

  const runRecord = getRun(db, input.runId);
  if (runRecord === null) throw new Error(`Run not found: ${input.runId}`);
  const projectId = runRecord.projectId;

  // Resolve tool profile with step-specific constraint enforcement
  const profileName = input.stepConfig?.toolProfile ?? 'inspect';
  if (!isValidToolProfile(profileName)) {
    throw new AgentError(`Invalid tool profile: '${profileName}'`, 'invalid_tool_profile');
  }
  const constraintError = validateProfileForStep(profileName, stepName);
  if (constraintError !== null) {
    throw new AgentError(constraintError, 'invalid_tool_profile');
  }

  // Create agent invocation
  const invocation = createAgentInvocation(db, {
    runId: input.runId,
    agent,
    action,
    contextSummary: `step=${stepName} (agent-sdk mode)`,
  });
  const agentInvocationId = invocation.agentInvocationId;
  publishAgentInvocationEvent(db, projectId, input.runId, agentInvocationId, agent, action, 'pending');

  markAgentRunning(db, agentInvocationId);
  publishAgentInvocationEvent(db, projectId, input.runId, agentInvocationId, agent, action, 'running');

  // Set up tool registry
  const registry = createToolRegistry();
  registerToolsForProfile(registry, profileName);

  const abortSignal = getAbortSignal(input.runId);
  const abortController = new AbortController();

  if (abortSignal?.aborted === true) {
    abortController.abort();
  } else if (abortSignal !== undefined) {
    abortSignal.addEventListener('abort', () => abortController.abort(), { once: true });
  }

  const toolContext = {
    runId: input.runId,
    agentInvocationId,
    worktreePath: input.worktreePath ?? '',
    db,
    projectId,
    abortSignal: abortController.signal,
  };

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

  let turnIndex = 0;
  const nextTurnIndex = () => turnIndex++;

  try {
    createAgentMessage(db, {
      agentInvocationId,
      turnIndex: nextTurnIndex(),
      role: 'system',
      contentJson: JSON.stringify(systemPrompt),
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

  function flushToolResults(): void {
    flushToolResultsHelper(pendingToolResults, pendingToolUseIds, db, agentInvocationId, nextTurnIndex);
  }

  // Warn if non-default maxTokens/temperature
  if (
    (input.stepConfig?.maxTokens !== undefined && input.stepConfig.maxTokens !== defaultsRef.maxTokens) ||
    (input.stepConfig?.temperature !== undefined && input.stepConfig.temperature !== defaultsRef.temperature)
  ) {
    log.warn(
      { runId: input.runId, maxTokens: input.stepConfig?.maxTokens, temperature: input.stepConfig?.temperature },
      'agent_sdk backend does not support maxTokens/temperature overrides — values ignored',
    );
  }

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
  let lastAssistantSnapshot: { content: unknown[]; stopReason: string | undefined } | undefined;

  try {
    const queryStream = sdkQuery({
      prompt: userPrompt,
      options: {
        systemPrompt,
        model: input.stepConfig?.model ?? 'claude-sonnet-4-20250514',
        maxTurns: 20,
        cwd: input.worktreePath ?? process.cwd(),
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
        flushToolResults();

        pendingToolUseIds.length = 0;
        for (const block of message.message.content) {
          if (block.type === 'tool_use') {
            pendingToolUseIds.push(block.id);
          }
        }

        lastAssistantSnapshot = {
          content: message.message.content,
          stopReason: message.message.stop_reason ?? undefined,
        };

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
        flushToolResults();

        if (message.usage !== undefined) {
          totalTokensInput = message.usage.input_tokens ?? totalTokensInput;
          totalTokensOutput = message.usage.output_tokens ?? totalTokensOutput;
        }

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

    // Extract review from terminal assistant message
    const review = extractTerminalAssistantText(lastAssistantSnapshot, 'Reviewer');
    const approved = parseVerdict(review);

    // Record success
    completeAgentInvocation(db, agentInvocationId, {
      tokensInput: totalTokensInput,
      tokensOutput: totalTokensOutput,
      durationMs,
    });
    publishAgentInvocationEvent(db, projectId, input.runId, agentInvocationId, agent, action, 'completed');

    // Store review as artifact
    const artifact = createArtifact(db, {
      runId: input.runId,
      type: 'review',
      contentMarkdown: review,
      createdBy: 'reviewer',
    });

    log.info(
      { runId: input.runId, agentInvocationId, approved, artifactId: artifact.artifactId },
      `Reviewer (agent-sdk, ${action}) completed`,
    );

    return {
      agentInvocationId,
      artifactId: artifact.artifactId,
      review,
      approved,
    };
  } catch (err) {
    flushToolResults();

    let finalError: AgentError;

    if (budgetTimedOut) {
      finalError = new AgentTimeoutError(
        budgetDurationMs ?? 0,
        agent,
        action,
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

    const errorCode = finalError.code;
    const errorMessage = finalError.message;

    try {
      failAgentInvocation(db, agentInvocationId, { errorCode, errorMessage });
    } catch {
      // May already be terminal
    }
    publishAgentInvocationEvent(db, projectId, input.runId, agentInvocationId, agent, action, 'failed', errorCode);

    throw finalError;
  } finally {
    if (budgetTimer !== undefined) clearTimeout(budgetTimer);
    clearInterval(phaseCheckInterval);
  }
}

// =============================================================================
// Public API
// =============================================================================

/**
 * Run plan reviewer via Agent SDK.
 */
export async function runPlanReviewerWithAgentSDK(
  db: Database,
  input: ReviewerInput & { apiKey: string },
): Promise<ReviewerResult> {
  const assembledContext = assembleContext(db, {
    runId: input.runId,
    worktreePath: input.worktreePath,
  });
  const userPrompt = formatContextForPrompt(assembledContext);

  return runReviewerSdk(
    db, input,
    'reviewer', 'review_plan', 'reviewerPlan',
    PLAN_REVIEWER_SDK_SYSTEM_PROMPT,
    userPrompt,
    MVP_DEFAULTS.reviewerPlan,
  );
}

/**
 * Run code reviewer via Agent SDK.
 */
export async function runCodeReviewerWithAgentSDK(
  db: Database,
  input: ReviewerInput & { apiKey: string },
): Promise<ReviewerResult> {
  // Get code diff if worktree available
  let diffContent = '';
  if (input.worktreePath !== undefined) {
    try {
      diffContent = execFileSync('git', ['diff', 'HEAD~1'], {
        cwd: input.worktreePath,
        encoding: 'utf8',
        maxBuffer: 512 * 1024,
      });
    } catch {
      diffContent = '[diff unavailable]';
    }
  }

  const assembledContext = assembleContext(db, {
    runId: input.runId,
    worktreePath: input.worktreePath,
  });

  let userPrompt = formatContextForPrompt(assembledContext);

  if (diffContent.length > 0) {
    userPrompt += '\n\n## Code Diff\n```diff\n' + diffContent + '\n```';
  }

  // Update review_rounds counter
  db.prepare(
    'UPDATE runs SET review_rounds = review_rounds + 1, updated_at = ? WHERE run_id = ?'
  ).run(new Date().toISOString(), input.runId);

  return runReviewerSdk(
    db, input,
    'reviewer', 'review_code', 'reviewerCode',
    CODE_REVIEWER_SDK_SYSTEM_PROMPT,
    userPrompt,
    MVP_DEFAULTS.reviewerCode,
  );
}
