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
import { executeAgent } from '../provider.js';
import { assembleContext, formatContextForPrompt } from '../context.js';
import { createArtifact } from '../artifacts.js';

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
