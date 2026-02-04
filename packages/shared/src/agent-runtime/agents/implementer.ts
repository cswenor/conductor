/**
 * Implementer Agent
 *
 * Writes code following an approved plan.
 * Produces structured file operations (create/edit/delete).
 * Path validation prevents traversal and .git access.
 */

import { existsSync, writeFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { resolve, relative, dirname, isAbsolute } from 'node:path';
import type { Database } from 'better-sqlite3';
import { createLogger } from '../../logger/index.js';
import type { AgentProvider } from '../provider.js';
import { executeAgent } from '../provider.js';
import { assembleContext, formatContextForPrompt } from '../context.js';
import { createArtifact } from '../artifacts.js';
import { createAgentInvocation, markAgentRunning, completeAgentInvocation, failAgentInvocation } from '../invocations.js';
import { createToolRegistry } from '../tools/registry.js';
import { registerFilesystemTools } from '../tools/filesystem.js';
import { registerTestRunnerTool } from '../tools/test-runner.js';
import { DEFAULT_POLICY_RULES } from '../tools/policy.js';
import { runToolLoop } from '../executor.js';
import { listToolInvocations } from '../tool-invocations.js';

const log = createLogger({ name: 'conductor:implementer' });

// =============================================================================
// Types
// =============================================================================

export type FileOperation =
  | { op: 'create'; path: string; content: string }
  | { op: 'edit'; path: string; content: string }
  | { op: 'delete'; path: string };

export interface ImplementerInput {
  runId: string;
  worktreePath: string;
}

export interface ImplementerResult {
  agentInvocationId: string;
  artifactId: string;
  files: FileOperation[];
}

// =============================================================================
// System Prompt
// =============================================================================

const IMPLEMENTER_SYSTEM_PROMPT = `You are a software implementer working as part of an automated orchestration system.

Your task is to implement the approved plan by producing file changes.

## Output Format

For each file you create or modify, output it in this exact format:

=== FILE: path/to/file.ts ===
[complete file content here]
=== END FILE ===

For files to delete:

=== DELETE: path/to/old-file.ts ===

## Rules
- Follow the plan exactly. Implement all planned changes.
- Write COMPLETE files, not diffs or patches.
- Use relative paths from the repository root. No absolute paths.
- Include all necessary imports and type declarations.
- Follow existing code patterns and conventions in the repository.
- Do not modify files outside the scope of the plan.
- Do not create or modify .git/ directory files.
- Ensure all code compiles/parses correctly.`;

// =============================================================================
// Output Parsing
// =============================================================================

const FILE_BLOCK_REGEX = /=== FILE:\s*(.+?)\s*===\n([\s\S]*?)(?:=== END FILE ===)/g;
const DELETE_BLOCK_REGEX = /=== DELETE:\s*(.+?)\s*===/g;

/**
 * Validate that a file path is safe (no traversal, no absolute, no .git).
 */
export function isValidFilePath(filePath: string): boolean {
  if (isAbsolute(filePath)) return false;
  if (filePath.includes('..')) return false;

  const normalized = filePath.replace(/\\/g, '/');
  if (normalized.startsWith('.git/') || normalized === '.git') return false;
  if (normalized.includes('/.git/') || normalized.includes('/.git')) return false;

  return true;
}

/**
 * Parse file operations from agent response content.
 */
export function parseFileOperations(
  content: string,
  worktreePath: string
): FileOperation[] {
  const ops: FileOperation[] = [];

  // Parse FILE blocks
  let match: RegExpExecArray | null;

  FILE_BLOCK_REGEX.lastIndex = 0;
  while ((match = FILE_BLOCK_REGEX.exec(content)) !== null) {
    if (match[1] === undefined || match[2] === undefined) continue;
    const filePath = match[1].trim();
    const fileContent = match[2];

    if (!isValidFilePath(filePath)) {
      log.warn({ filePath }, 'Rejected invalid file path from agent output');
      continue;
    }

    // Determine if create vs edit based on file existence
    const fullPath = resolve(worktreePath, filePath);
    const op = existsSync(fullPath) ? 'edit' : 'create';

    ops.push({ op, path: filePath, content: fileContent });
  }

  // Parse DELETE blocks
  DELETE_BLOCK_REGEX.lastIndex = 0;
  while ((match = DELETE_BLOCK_REGEX.exec(content)) !== null) {
    if (match[1] === undefined) continue;
    const filePath = match[1].trim();

    if (!isValidFilePath(filePath)) {
      log.warn({ filePath }, 'Rejected invalid delete path from agent output');
      continue;
    }

    ops.push({ op: 'delete', path: filePath });
  }

  return ops;
}

// =============================================================================
// File Application
// =============================================================================

/**
 * Apply file operations to a worktree.
 * Validates all paths are within worktree bounds.
 * Creates parent directories as needed.
 */
export function applyFileOperations(
  worktreePath: string,
  ops: FileOperation[]
): void {
  for (const op of ops) {
    if (!isValidFilePath(op.path)) {
      throw new Error(`Invalid file path: ${op.path}`);
    }

    const fullPath = resolve(worktreePath, op.path);
    const rel = relative(worktreePath, fullPath);

    // Verify within worktree
    if (rel.startsWith('..') || isAbsolute(rel)) {
      throw new Error(`Path escapes worktree: ${op.path}`);
    }

    switch (op.op) {
      case 'create':
      case 'edit': {
        // Create parent directories
        const dir = dirname(fullPath);
        mkdirSync(dir, { recursive: true });
        writeFileSync(fullPath, op.content, 'utf8');
        break;
      }
      case 'delete': {
        if (existsSync(fullPath)) {
          unlinkSync(fullPath);
        }
        break;
      }
    }
  }

  log.info(
    { operationCount: ops.length, worktreePath },
    'Applied file operations to worktree'
  );
}

// =============================================================================
// Agent Function
// =============================================================================

/**
 * Run the implementer agent to produce code changes.
 */
export async function runImplementer(
  db: Database,
  input: ImplementerInput
): Promise<ImplementerResult> {
  const context = assembleContext(db, {
    runId: input.runId,
    worktreePath: input.worktreePath,
  });

  const userPrompt = formatContextForPrompt(context);

  const result = await executeAgent(db, {
    runId: input.runId,
    agent: 'implementer',
    action: 'apply_changes',
    step: 'implementer_apply_changes',
    systemPrompt: IMPLEMENTER_SYSTEM_PROMPT,
    userPrompt,
    maxTokens: 16384,
    temperature: 0.2,
  });

  // Parse file operations from response
  const files = parseFileOperations(result.content, input.worktreePath);

  // Store summary as artifact
  const summary = files.map((f) => {
    if (f.op === 'delete') return `${f.op}: ${f.path}`;
    return `${f.op}: ${f.path} (${Buffer.byteLength('content' in f ? f.content : '', 'utf8')} bytes)`;
  }).join('\n');

  const artifact = createArtifact(db, {
    runId: input.runId,
    type: 'other',
    contentMarkdown: `# Implementation Changes\n\n${summary}\n\n---\n\nFull response:\n\n${result.content}`,
    createdBy: 'implementer',
  });

  return {
    agentInvocationId: result.agentInvocationId,
    artifactId: artifact.artifactId,
    files,
  };
}

// =============================================================================
// Tool-Use Mode System Prompt
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
// Tool-Use Mode Agent Function
// =============================================================================

/**
 * Run the implementer agent in tool-use mode.
 * Instead of parsing text blocks, the agent uses structured tools to read/write files.
 */
export async function runImplementerWithTools(
  db: Database,
  input: ImplementerInput & { provider: AgentProvider }
): Promise<ImplementerResult> {
  const context = assembleContext(db, {
    runId: input.runId,
    worktreePath: input.worktreePath,
  });

  const userPrompt = formatContextForPrompt(context);

  // Create agent invocation record
  const invocation = createAgentInvocation(db, {
    runId: input.runId,
    agent: 'implementer',
    action: 'apply_changes',
    contextSummary: 'step=implementer_apply_changes (tool-use mode)',
  });
  markAgentRunning(db, invocation.agentInvocationId);

  // Set up tool registry
  const registry = createToolRegistry();
  registerFilesystemTools(registry);
  registerTestRunnerTool(registry);

  try {
    const result = await runToolLoop({
      db,
      provider: input.provider,
      systemPrompt: IMPLEMENTER_TOOLS_SYSTEM_PROMPT,
      userPrompt,
      registry,
      policyRules: DEFAULT_POLICY_RULES,
      context: {
        runId: input.runId,
        agentInvocationId: invocation.agentInvocationId,
        worktreePath: input.worktreePath,
        db,
        projectId: context.run.runId, // Will be resolved from run in executor
      },
      maxTokens: 16384,
      temperature: 0.2,
    });

    // Record success
    completeAgentInvocation(db, invocation.agentInvocationId, {
      tokensInput: result.totalTokensInput,
      tokensOutput: result.totalTokensOutput,
      durationMs: result.totalDurationMs,
    });

    // Derive file operations from tool invocation records
    const toolInvocations = listToolInvocations(db, invocation.agentInvocationId);
    const files: FileOperation[] = [];

    for (const ti of toolInvocations) {
      if (ti.status !== 'completed') continue;

      if (ti.tool === 'write_file' && ti.target !== undefined) {
        // Determine create vs edit from whether file existed before
        // Since tools already wrote to disk, we just record all as create/edit
        const fullPath = resolve(input.worktreePath, ti.target);
        files.push({
          op: existsSync(fullPath) ? 'edit' : 'create',
          path: ti.target,
          content: '', // Content is already on disk
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
      contentMarkdown: `# Implementation Changes (Tool-Use Mode)\n\n${summary}\n\nIterations: ${result.iterations}\nTokens: ${result.totalTokensInput} in / ${result.totalTokensOutput} out\n\n---\n\nFinal response:\n\n${result.content}`,
      createdBy: 'implementer',
    });

    log.info(
      {
        runId: input.runId,
        agentInvocationId: invocation.agentInvocationId,
        fileCount: files.length,
        iterations: result.iterations,
      },
      'Implementer (tool-use) completed'
    );

    return {
      agentInvocationId: invocation.agentInvocationId,
      artifactId: artifact.artifactId,
      files,
    };
  } catch (err) {
    const errorCode = err instanceof Error && 'code' in err ? (err as { code: string }).code : 'unknown';
    const errorMessage = err instanceof Error ? err.message : 'Unknown error';

    try {
      failAgentInvocation(db, invocation.agentInvocationId, {
        errorCode,
        errorMessage,
      });
    } catch {
      // Invocation may already be in terminal state
    }

    throw err;
  }
}
