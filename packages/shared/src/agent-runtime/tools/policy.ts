/**
 * Tool Policy Evaluator
 *
 * Enforces security boundaries on tool execution.
 * Rules run in order; first 'block' wins.
 */

import { resolve, relative, isAbsolute } from 'node:path';
import { isValidFilePath } from '../agents/implementer.js';
import { isSensitiveFile } from '../context.js';
import { checkSymlinkEscape } from './path-safety.js';
import type { ToolExecutionContext } from './types.js';

// =============================================================================
// Types
// =============================================================================

export type PolicyDecision = 'allow' | 'block';

export interface PolicyEvaluation {
  decision: PolicyDecision;
  policyId?: string;
  reason?: string;
}

export interface PolicyRule {
  policyId: string;
  description: string;
  evaluate: (
    toolName: string,
    args: Record<string, unknown>,
    context: ToolExecutionContext
  ) => PolicyEvaluation | null;
}

// =============================================================================
// Built-in Rules
// =============================================================================

const PATH_TOOLS = new Set(['read_file', 'write_file', 'delete_file', 'list_files']);

function getPathArg(toolName: string, args: Record<string, unknown>): string | undefined {
  if (toolName === 'list_files') {
    return (args['directory'] as string | undefined) ?? undefined;
  }
  return (args['path'] as string | undefined) ?? undefined;
}

/**
 * Blocks file operations that escape the worktree boundary.
 */
export const worktreeBoundaryRule: PolicyRule = {
  policyId: 'worktree_boundary',
  description: 'Blocks path escape outside worktree',
  evaluate: (toolName, args, context) => {
    if (!PATH_TOOLS.has(toolName)) return null;

    const pathArg = getPathArg(toolName, args);
    if (pathArg === undefined) return null;

    // Check basic path validity
    if (!isValidFilePath(pathArg)) {
      return {
        decision: 'block',
        policyId: 'worktree_boundary',
        reason: `Invalid file path: ${pathArg}`,
      };
    }

    // Resolve and verify within worktree
    const resolved = resolve(context.worktreePath, pathArg);
    const rel = relative(context.worktreePath, resolved);
    if (rel.startsWith('..') || isAbsolute(rel)) {
      return {
        decision: 'block',
        policyId: 'worktree_boundary',
        reason: `Path escapes worktree: ${pathArg}`,
      };
    }

    // Resolve symlinks (including parent symlinks for non-existent targets) to detect escape
    const symlinkEscape = checkSymlinkEscape(resolved, context.worktreePath);
    if (symlinkEscape !== null) {
      return {
        decision: 'block',
        policyId: 'worktree_boundary',
        reason: `${symlinkEscape}: ${pathArg}`,
      };
    }

    return null;
  },
};

/**
 * Blocks access to .git/ directory.
 */
export const dotGitProtectionRule: PolicyRule = {
  policyId: 'dotgit_protection',
  description: 'Blocks .git/ directory access',
  evaluate: (toolName, args) => {
    if (!PATH_TOOLS.has(toolName)) return null;

    const pathArg = getPathArg(toolName, args);
    if (pathArg === undefined) return null;

    const normalized = pathArg.replace(/\\/g, '/');
    if (
      normalized === '.git' ||
      normalized.startsWith('.git/') ||
      normalized.includes('/.git/') ||
      normalized.includes('/.git')
    ) {
      return {
        decision: 'block',
        policyId: 'dotgit_protection',
        reason: `Access to .git directory blocked: ${pathArg}`,
      };
    }

    return null;
  },
};

const WRITE_TOOLS = new Set(['write_file', 'delete_file']);

/**
 * Blocks writes to sensitive files (.env, .pem, credentials, etc).
 */
export const sensitiveFileWriteRule: PolicyRule = {
  policyId: 'sensitive_file_write',
  description: 'Blocks writes to sensitive files',
  evaluate: (toolName, args) => {
    if (!WRITE_TOOLS.has(toolName)) return null;

    const pathArg = (args['path'] as string | undefined) ?? undefined;
    if (pathArg === undefined) return null;

    if (isSensitiveFile(pathArg)) {
      return {
        decision: 'block',
        policyId: 'sensitive_file_write',
        reason: `Write to sensitive file blocked: ${pathArg}`,
      };
    }

    return null;
  },
};

const SHELL_OPERATORS = /[;&|`$(){}[\]<>!#]/;

/**
 * Blocks shell injection in run_tests command.
 */
export const shellInjectionRule: PolicyRule = {
  policyId: 'shell_injection',
  description: 'Blocks shell operators in run_tests command',
  evaluate: (toolName, args) => {
    if (toolName !== 'run_tests') return null;

    const command = (args['command'] as string | undefined) ?? '';
    if (SHELL_OPERATORS.test(command)) {
      return {
        decision: 'block',
        policyId: 'shell_injection',
        reason: `Shell operators detected in test command: ${command}`,
      };
    }

    return null;
  },
};

// =============================================================================
// Default Rule Set + Evaluator
// =============================================================================

export const DEFAULT_POLICY_RULES: PolicyRule[] = [
  worktreeBoundaryRule,
  dotGitProtectionRule,
  sensitiveFileWriteRule,
  shellInjectionRule,
];

/**
 * Evaluate policy rules against a tool call.
 * First 'block' wins and short-circuits.
 * Returns 'allow' if no rule blocks.
 */
export function evaluatePolicy(
  rules: PolicyRule[],
  toolName: string,
  args: Record<string, unknown>,
  context: ToolExecutionContext
): PolicyEvaluation {
  for (const rule of rules) {
    const result = rule.evaluate(toolName, args, context);
    if (result !== null && result.decision === 'block') {
      return result;
    }
  }
  return { decision: 'allow' };
}
