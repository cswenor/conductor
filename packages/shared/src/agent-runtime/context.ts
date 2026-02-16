/**
 * Context Assembly
 *
 * Assembles context for agent invocations from DB state and worktree.
 * Includes secret-exposure guardrails: sensitive files excluded,
 * secret patterns redacted before prompt assembly.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, relative, isAbsolute } from 'node:path';
import type { Database } from 'better-sqlite3';
import { createLogger } from '../logger/index.ts';
import { getRun } from '../runs/index.ts';
import { getTask } from '../tasks/index.ts';
import { getRepo } from '../repos/index.ts';
import { getProject } from '../projects/index.ts';
import { getLatestArtifact } from './artifacts.ts';

const log = createLogger({ name: 'conductor:context' });

// =============================================================================
// Types
// =============================================================================

export interface AgentContext {
  issue: {
    number: number;
    title: string;
    body: string;
    type: string;
    state: string;
    labels: string[];
  };
  repository: {
    fullName: string;
    defaultBranch: string;
  };
  run: {
    runId: string;
    baseBranch: string;
    branch: string;
    planRevisions: number;
    testFixAttempts: number;
    reviewRounds: number;
  };
  plan?: string;
  review?: string;
  fileTree?: string;
  relevantFiles?: Array<{ path: string; content: string }>;
}

export interface AssembleContextInput {
  runId: string;
  worktreePath?: string;
  relevantFilePaths?: string[];
}

export interface SectionBudgets {
  issueBody?: number;
  plan?: number;
  review?: number;
  fileTree?: number;
  fileTreeEntries?: number;
}

// =============================================================================
// Budget Resolution
// =============================================================================

const warnedCtxEnvKeys = new Set<string>();

function resolveCtxEnvInt(key: string, defaultVal: number, floor: number): number {
  const raw = process.env[key];
  if (raw === undefined) return defaultVal;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    if (!warnedCtxEnvKeys.has(key)) {
      warnedCtxEnvKeys.add(key);
      log.warn({ envKey: key, envValue: raw }, `Invalid ${key}, using default ${defaultVal}`);
    }
    return defaultVal;
  }
  return Math.max(parsed, floor);
}

export function resolveImplementerBudgets(): SectionBudgets {
  return {
    issueBody: resolveCtxEnvInt('CONDUCTOR_CTX_BUDGET_ISSUE', 5_000, 500),
    plan: resolveCtxEnvInt('CONDUCTOR_CTX_BUDGET_PLAN', 10_000, 1_000),
    review: resolveCtxEnvInt('CONDUCTOR_CTX_BUDGET_REVIEW', 10_000, 1_000),
    fileTree: resolveCtxEnvInt('CONDUCTOR_CTX_BUDGET_FILE_TREE', 10_000, 1_000),
    fileTreeEntries: resolveCtxEnvInt('CONDUCTOR_CTX_BUDGET_FILE_TREE_ENTRIES', 500, 50),
  };
}

// =============================================================================
// Truncation
// =============================================================================

export const TRUNCATION_HINT = '[...truncated — use read_file, search_in_file, or list_files to inspect details on demand]';

function truncateSection(content: string, budget: number | undefined): string {
  if (budget === undefined || content.length <= budget) return content;
  if (budget <= 0) return '';
  const hintWithNewline = '\n' + TRUNCATION_HINT;
  // Strict < : when budget === hintWithNewline.length, fall through to last branch
  // which yields '' + hintWithNewline, length exactly = budget.
  if (budget < hintWithNewline.length) return TRUNCATION_HINT.slice(0, budget);
  return content.substring(0, budget - hintWithNewline.length) + hintWithNewline;
}

// =============================================================================
// Sensitive File Exclusion
// =============================================================================

/**
 * Glob-like patterns for files that must never reach agent prompts.
 * Matched against relative paths using simple string matching.
 */
export const SENSITIVE_FILE_PATTERNS = [
  '.env',
  '.env.local',
  '.env.development',
  '.env.production',
  '.env.staging',
  '.env.test',
  '.npmrc',
  '.git/',
  '.ssh/',
  '.aws/',
  'credentials.json',
  'service-account',
  'secrets.yaml',
  'secrets.yml',
];

const SENSITIVE_EXTENSIONS = ['.pem', '.key', '.p12', '.pfx', '.jks'];

/**
 * Check if a file path matches any sensitive pattern.
 */
export function isSensitiveFile(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, '/');
  const basename = normalized.split('/').pop() ?? '';

  // Check extension
  for (const ext of SENSITIVE_EXTENSIONS) {
    if (basename.endsWith(ext)) return true;
  }

  // Check path patterns
  for (const pattern of SENSITIVE_FILE_PATTERNS) {
    // Directory pattern (ends with /)
    if (pattern.endsWith('/')) {
      if (normalized.includes(`/${pattern}`) || normalized.startsWith(pattern)) return true;
      continue;
    }
    // Exact basename match or prefixed with separator
    if (basename === pattern || basename.startsWith(`${pattern}.`) || basename.startsWith(`${pattern}-`)) return true;
    if (normalized.includes(`/${pattern}`)) return true;
  }

  return false;
}

// =============================================================================
// Secret Redaction
// =============================================================================

const SECRET_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  // Anthropic API keys
  { pattern: /sk-ant-[A-Za-z0-9_-]{20,}/g, label: 'anthropic_key' },
  // OpenAI API keys
  { pattern: /sk-[A-Za-z0-9]{20,}/g, label: 'openai_key' },
  // Google AI keys
  { pattern: /AIza[A-Za-z0-9_-]{30,}/g, label: 'google_key' },
  // GitHub tokens
  { pattern: /ghp_[A-Za-z0-9]{30,}/g, label: 'github_pat' },
  { pattern: /ghs_[A-Za-z0-9]{30,}/g, label: 'github_server' },
  { pattern: /github_pat_[A-Za-z0-9_]{30,}/g, label: 'github_fine_pat' },
  // Slack tokens
  { pattern: /xoxb-[A-Za-z0-9-]{30,}/g, label: 'slack_bot' },
  { pattern: /xoxp-[A-Za-z0-9-]{30,}/g, label: 'slack_user' },
  // AWS access keys
  { pattern: /AKIA[A-Z0-9]{16}/g, label: 'aws_key' },
  // Config-line secrets (password=..., secret=..., token=...)
  { pattern: /(?:password|secret|token|api_key|apikey)\s*[=:]\s*['"]?(?!\[REDACTED)[^\s'"]{8,}['"]?/gi, label: 'config_secret' },
  // Long base64 blocks (> 40 chars, likely secrets)
  { pattern: /[A-Za-z0-9+/]{40,}={0,2}(?=\s|$)/g, label: 'base64_blob' },
];

/**
 * Redact common secret patterns from content.
 * Returns the redacted content. Logs a warning when redaction triggers.
 */
export function redactSecretPatterns(content: string, filePath?: string): string {
  let redacted = content;
  let redactionCount = 0;

  for (const { pattern, label } of SECRET_PATTERNS) {
    // Reset regex state
    pattern.lastIndex = 0;
    const matches = redacted.match(pattern);
    if (matches !== null) {
      redactionCount += matches.length;
      redacted = redacted.replace(pattern, `[REDACTED:${label}]`);
    }
  }

  if (redactionCount > 0) {
    log.warn(
      { filePath, redactionCount },
      'Secret patterns redacted from content before prompt assembly'
    );
  }

  return redacted;
}

// =============================================================================
// File Tree Assembly
// =============================================================================

const MAX_FILE_TREE_ENTRIES = 2000;
const MAX_FILE_TREE_BYTES = 100_000;

/**
 * List files in a worktree using git ls-files, excluding sensitive files.
 */
export function assembleFileTree(worktreePath: string): string {
  try {
    const output = execFileSync('git', ['ls-files'], {
      cwd: worktreePath,
      encoding: 'utf8',
      maxBuffer: 1024 * 1024, // 1MB
    });

    const files = output.split('\n').filter((f) => f.length > 0);

    // Filter out sensitive files
    const safeFiles = files.filter((f) => !isSensitiveFile(f));

    // Truncate to limits
    const limited = safeFiles.slice(0, MAX_FILE_TREE_ENTRIES);

    let tree = limited.join('\n');
    if (Buffer.byteLength(tree, 'utf8') > MAX_FILE_TREE_BYTES) {
      tree = tree.substring(0, MAX_FILE_TREE_BYTES) + '\n[...truncated]';
    }

    if (limited.length < safeFiles.length) {
      tree += `\n[...${safeFiles.length - limited.length} more files]`;
    }

    return tree;
  } catch {
    return '[file tree unavailable]';
  }
}

// =============================================================================
// File Reading
// =============================================================================

const MAX_FILE_CONTENT_CHARS = 10_000;

/**
 * Read files from worktree, excluding sensitive files and redacting secrets.
 */
export function readRelevantFiles(
  worktreePath: string,
  paths: string[]
): Array<{ path: string; content: string }> {
  const results: Array<{ path: string; content: string }> = [];

  for (const filePath of paths) {
    // Validate: no path traversal, no absolute paths
    if (isAbsolute(filePath) || filePath.includes('..')) {
      results.push({ path: filePath, content: '[EXCLUDED: invalid path]' });
      continue;
    }

    // Check sensitive file patterns
    if (isSensitiveFile(filePath)) {
      results.push({ path: filePath, content: '[EXCLUDED: sensitive file]' });
      continue;
    }

    const fullPath = resolve(worktreePath, filePath);
    const rel = relative(worktreePath, fullPath);

    // Verify within worktree
    if (rel.startsWith('..') || isAbsolute(rel)) {
      results.push({ path: filePath, content: '[EXCLUDED: path outside worktree]' });
      continue;
    }

    try {
      if (!existsSync(fullPath)) {
        results.push({ path: filePath, content: '[file not found]' });
        continue;
      }

      let content = readFileSync(fullPath, 'utf8');

      // Truncate
      if (content.length > MAX_FILE_CONTENT_CHARS) {
        content = content.substring(0, MAX_FILE_CONTENT_CHARS) + '\n[...truncated]';
      }

      // Redact secrets
      content = redactSecretPatterns(content, filePath);

      results.push({ path: filePath, content });
    } catch {
      results.push({ path: filePath, content: '[read error]' });
    }
  }

  return results;
}

// =============================================================================
// Context Assembly
// =============================================================================

const MAX_TOTAL_CONTEXT_CHARS = 100_000;

/**
 * Assemble context from DB state and optional worktree.
 */
export function assembleContext(
  db: Database,
  input: AssembleContextInput
): AgentContext {
  const run = getRun(db, input.runId);
  if (run === null) {
    throw new Error(`Run not found: ${input.runId}`);
  }

  const task = getTask(db, run.taskId);
  if (task === null) {
    throw new Error(`Task not found: ${run.taskId}`);
  }

  const repo = getRepo(db, run.repoId);
  if (repo === null) {
    throw new Error(`Repo not found: ${run.repoId}`);
  }

  const project = getProject(db, run.projectId);

  // Parse labels
  let labels: string[] = [];
  try {
    labels = JSON.parse(task.githubLabelsJson ?? '[]') as string[];
  } catch {
    labels = [];
  }

  const context: AgentContext = {
    issue: {
      number: task.githubIssueNumber,
      title: task.githubTitle,
      body: task.githubBody ?? '',
      type: task.githubType,
      state: task.githubState,
      labels,
    },
    repository: {
      fullName: repo.githubFullName,
      defaultBranch: project?.defaultBaseBranch ?? 'main',
    },
    run: {
      runId: run.runId,
      baseBranch: run.baseBranch,
      branch: run.branch,
      planRevisions: run.planRevisions,
      testFixAttempts: run.testFixAttempts,
      reviewRounds: run.reviewRounds,
    },
  };

  // Load latest plan artifact if exists
  const latestPlan = getLatestArtifact(db, run.runId, 'plan');
  if (latestPlan?.contentMarkdown !== undefined) {
    context.plan = latestPlan.contentMarkdown;
  }

  // Load latest review artifact if exists
  const latestReview = getLatestArtifact(db, run.runId, 'review');
  if (latestReview?.contentMarkdown !== undefined) {
    context.review = latestReview.contentMarkdown;
  }

  // Assemble file tree if worktree available
  if (input.worktreePath !== undefined) {
    context.fileTree = assembleFileTree(input.worktreePath);
  }

  // Read relevant files if worktree and paths provided
  if (input.worktreePath !== undefined && input.relevantFilePaths !== undefined) {
    context.relevantFiles = readRelevantFiles(input.worktreePath, input.relevantFilePaths);
  }

  return context;
}

/**
 * Serialize context into a structured text format for LLM consumption.
 * When budgets are provided, individual sections are truncated to fit.
 */
export function formatContextForPrompt(context: AgentContext, budgets?: SectionBudgets): string {
  const sections: string[] = [];

  // Track sizes for telemetry
  let issueBodyFinal = 0;
  let planFinal = 0;
  let reviewFinal = 0;
  let treeFinal = 0;

  // Issue section
  sections.push(`## Issue #${context.issue.number}: ${context.issue.title}`);
  sections.push(`Type: ${context.issue.type} | State: ${context.issue.state}`);
  if (context.issue.labels.length > 0) {
    sections.push(`Labels: ${context.issue.labels.join(', ')}`);
  }
  sections.push('');
  const issueBodyContent = truncateSection(context.issue.body, budgets?.issueBody);
  issueBodyFinal = issueBodyContent.length;
  sections.push(issueBodyContent);

  // Repository section
  sections.push('');
  sections.push(`## Repository: ${context.repository.fullName}`);
  sections.push(`Default branch: ${context.repository.defaultBranch}`);

  // Run info section
  sections.push('');
  sections.push(`## Run: ${context.run.runId}`);
  sections.push(`Base branch: ${context.run.baseBranch}`);
  if (context.run.branch !== '') {
    sections.push(`Working branch: ${context.run.branch}`);
  }
  if (context.run.planRevisions > 0) {
    sections.push(`Plan revision: ${context.run.planRevisions}`);
  }
  if (context.run.reviewRounds > 0) {
    sections.push(`Review round: ${context.run.reviewRounds}`);
  }

  // Plan section
  if (context.plan !== undefined) {
    const planContent = truncateSection(context.plan, budgets?.plan);
    planFinal = planContent.length;
    sections.push('');
    sections.push('## Current Plan');
    sections.push(planContent);
  }

  // Review feedback section
  if (context.review !== undefined) {
    const reviewContent = truncateSection(context.review, budgets?.review);
    reviewFinal = reviewContent.length;
    sections.push('');
    sections.push('## Latest Review Feedback');
    sections.push(reviewContent);
  }

  // File tree section
  if (context.fileTree !== undefined) {
    let tree = context.fileTree;
    if (budgets?.fileTreeEntries !== undefined) {
      const lines = tree.split('\n');
      if (lines.length > budgets.fileTreeEntries) {
        tree = lines.slice(0, budgets.fileTreeEntries).join('\n')
          + `\n[...${lines.length - budgets.fileTreeEntries} more files — use list_files to explore]`;
      }
    }
    const treeContent = truncateSection(tree, budgets?.fileTree);
    treeFinal = treeContent.length;
    sections.push('');
    sections.push('## Repository File Tree');
    sections.push('```');
    sections.push(treeContent);
    sections.push('```');
  }

  // Relevant files section
  if (context.relevantFiles !== undefined && context.relevantFiles.length > 0) {
    sections.push('');
    sections.push('## Relevant Files');
    for (const file of context.relevantFiles) {
      sections.push('');
      sections.push(`### ${file.path}`);
      sections.push('```');
      sections.push(file.content);
      sections.push('```');
    }
  }

  let result = sections.join('\n');
  const preSafetyTotal = result.length;

  // Enforce total size limit (existing safety net)
  if (result.length > MAX_TOTAL_CONTEXT_CHARS) {
    result = result.substring(0, MAX_TOTAL_CONTEXT_CHARS) + '\n[...context truncated]';
  }

  log.info({
    issueBodyOriginal: context.issue.body.length,
    issueBodyFinal,
    planOriginal: context.plan?.length ?? 0,
    planFinal,
    reviewOriginal: context.review?.length ?? 0,
    reviewFinal,
    fileTreeOriginal: context.fileTree?.length ?? 0,
    fileTreeFinal: treeFinal,
    preSafetyTotal,
    finalTotal: result.length,
    hasBudgets: budgets !== undefined,
  }, 'Context formatted for prompt');

  return result;
}
