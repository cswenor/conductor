/**
 * Reviewer Agent
 *
 * Critiques plans and code. Runs twice in the lifecycle:
 * 1. Plan review — before approval gate
 * 2. Code review — before PR creation
 *
 * Produces structured review artifacts with APPROVED / CHANGES_REQUESTED verdicts.
 */

import { execFileSync } from 'node:child_process';
import type { Database } from 'better-sqlite3';
import { executeAgent } from '../provider.js';
import { assembleContext, formatContextForPrompt } from '../context.js';
import { createArtifact } from '../artifacts.js';

// =============================================================================
// Types
// =============================================================================

export interface ReviewerInput {
  runId: string;
  worktreePath?: string;
}

export interface ReviewerResult {
  agentInvocationId: string;
  artifactId: string;
  review: string;
  approved: boolean;
}

// =============================================================================
// System Prompts
// =============================================================================

const PLAN_REVIEWER_SYSTEM_PROMPT = `You are a senior software engineer reviewing an implementation plan.

## Your Task
Review the proposed plan for the given issue and provide structured feedback.

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
- If the plan is borderline, default to CHANGES_REQUESTED. Better to iterate than ship bad code.`;

const CODE_REVIEWER_SYSTEM_PROMPT = `You are a senior software engineer reviewing code changes.

## Your Task
Review the code diff against the approved plan and provide structured feedback.

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
- CHANGES_REQUESTED means there are blocking issues the implementer must fix.`;

// =============================================================================
// Verdict Parsing
// =============================================================================

/**
 * Parse the review verdict from agent response.
 * Defaults to CHANGES_REQUESTED if verdict is ambiguous.
 */
export function parseVerdict(content: string): boolean {
  const firstLine = (content.split('\n')[0] ?? '').trim().toUpperCase();

  if (firstLine.startsWith('APPROVED')) return true;
  if (firstLine.startsWith('CHANGES_REQUESTED')) return false;

  // Check anywhere in first 200 chars
  const head = content.substring(0, 200).toUpperCase();
  if (head.includes('APPROVED') && !head.includes('CHANGES_REQUESTED')) return true;

  // Conservative default
  return false;
}

// =============================================================================
// Agent Functions
// =============================================================================

/**
 * Review the latest plan artifact.
 */
export async function runPlanReviewer(
  db: Database,
  input: ReviewerInput
): Promise<ReviewerResult> {
  const context = assembleContext(db, {
    runId: input.runId,
    worktreePath: input.worktreePath,
  });

  const userPrompt = formatContextForPrompt(context);

  const result = await executeAgent(db, {
    runId: input.runId,
    agent: 'reviewer',
    action: 'review_plan',
    step: 'reviewer_review_plan',
    systemPrompt: PLAN_REVIEWER_SYSTEM_PROMPT,
    userPrompt,
    maxTokens: 4096,
    temperature: 0.2,
  });

  // Store review as artifact
  const artifact = createArtifact(db, {
    runId: input.runId,
    type: 'review',
    contentMarkdown: result.content,
    createdBy: 'reviewer',
  });

  const approved = parseVerdict(result.content);

  return {
    agentInvocationId: result.agentInvocationId,
    artifactId: artifact.artifactId,
    review: result.content,
    approved,
  };
}

/**
 * Review code changes in the worktree.
 */
export async function runCodeReviewer(
  db: Database,
  input: ReviewerInput
): Promise<ReviewerResult> {
  // Get code diff if worktree available
  let diffContent = '';
  if (input.worktreePath !== undefined) {
    try {
      diffContent = execFileSync('git', ['diff', 'HEAD~1'], {
        cwd: input.worktreePath,
        encoding: 'utf8',
        maxBuffer: 512 * 1024, // 512KB
      });
    } catch {
      diffContent = '[diff unavailable]';
    }
  }

  const context = assembleContext(db, {
    runId: input.runId,
    worktreePath: input.worktreePath,
  });

  let userPrompt = formatContextForPrompt(context);

  // Append diff
  if (diffContent.length > 0) {
    userPrompt += '\n\n## Code Diff\n```diff\n' + diffContent + '\n```';
  }

  const result = await executeAgent(db, {
    runId: input.runId,
    agent: 'reviewer',
    action: 'review_code',
    step: 'reviewer_review_code',
    systemPrompt: CODE_REVIEWER_SYSTEM_PROMPT,
    userPrompt,
    maxTokens: 4096,
    temperature: 0.2,
  });

  // Store review as artifact
  const artifact = createArtifact(db, {
    runId: input.runId,
    type: 'review',
    contentMarkdown: result.content,
    createdBy: 'reviewer',
  });

  // Update review_rounds counter
  db.prepare(
    'UPDATE runs SET review_rounds = review_rounds + 1, updated_at = ? WHERE run_id = ?'
  ).run(new Date().toISOString(), input.runId);

  const approved = parseVerdict(result.content);

  return {
    agentInvocationId: result.agentInvocationId,
    artifactId: artifact.artifactId,
    review: result.content,
    approved,
  };
}
