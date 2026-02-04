/**
 * Planner Agent
 *
 * Generates an implementation plan from an issue.
 */

import type { Database } from 'better-sqlite3';
import { executeAgent } from '../provider.js';
import { assembleContext, formatContextForPrompt } from '../context.js';
import { createArtifact } from '../artifacts.js';

// =============================================================================
// Types
// =============================================================================

export interface PlannerInput {
  runId: string;
  worktreePath?: string;
}

export interface PlannerResult {
  agentInvocationId: string;
  artifactId: string;
  plan: string;
}

// =============================================================================
// System Prompt
// =============================================================================

const PLANNER_SYSTEM_PROMPT = `You are a software engineering planner working as part of an automated orchestration system.

Your task is to analyze a GitHub issue and produce a detailed, actionable implementation plan.

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
- Be specific: reference exact file paths, function names, and types.
- Be complete: an implementer agent must be able to follow this plan without additional context.
- Be concise: no unnecessary prose. Every sentence must be actionable.
- If you have review feedback from a previous revision, address every point raised.`;

// =============================================================================
// Agent Function
// =============================================================================

/**
 * Run the planner agent to generate or revise an implementation plan.
 */
export async function runPlanner(
  db: Database,
  input: PlannerInput
): Promise<PlannerResult> {
  const context = assembleContext(db, {
    runId: input.runId,
    worktreePath: input.worktreePath,
  });

  const userPrompt = formatContextForPrompt(context);

  const result = await executeAgent(db, {
    runId: input.runId,
    agent: 'planner',
    action: 'create_plan',
    step: 'planner_create_plan',
    systemPrompt: PLANNER_SYSTEM_PROMPT,
    userPrompt,
    maxTokens: 8192,
    temperature: 0.3,
  });

  // Store plan as artifact
  const artifact = createArtifact(db, {
    runId: input.runId,
    type: 'plan',
    contentMarkdown: result.content,
    createdBy: 'planner',
  });

  // Update plan_revisions counter
  db.prepare(
    'UPDATE runs SET plan_revisions = plan_revisions + 1, updated_at = ? WHERE run_id = ?'
  ).run(new Date().toISOString(), input.runId);

  return {
    agentInvocationId: result.agentInvocationId,
    artifactId: artifact.artifactId,
    plan: result.content,
  };
}
