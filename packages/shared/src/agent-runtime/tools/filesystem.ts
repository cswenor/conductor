/**
 * Filesystem Tools
 *
 * read_file, read_file_range, search_in_file, write_file, delete_file, list_files tool definitions.
 * All operations are bounded to the worktree and respect policy rules.
 */

import { readFileSync, writeFileSync, unlinkSync, mkdirSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, relative, dirname, isAbsolute } from 'node:path';
import { isValidFilePath } from '../agents/implementer.ts';
import { isSensitiveFile } from '../context.ts';
import { checkSymlinkEscape } from './path-safety.ts';
import { createLogger } from '../../logger/index.ts';
import type { ToolDefinition, ToolResult } from './types.ts';
import type { ToolRegistry } from './registry.ts';

const log = createLogger({ name: 'conductor:filesystem' });

// =============================================================================
// Runtime-resolved limits (issue #136)
// =============================================================================

// Rationale (issue #136): Tightened from 100KB/500 to reduce tool-loop payload
// size and rate-limit pressure. Env-configurable for operator tuning.
// Limits are resolved per-call (env changes take effect at runtime).
// Tool descriptions are a startup snapshot — they do NOT update if env changes after init.

const warnedEnvKeys = new Set<string>();

function resolveEnvInt(key: string, defaultVal: number, floor: number): number {
  const raw = process.env[key];
  if (raw === undefined) return defaultVal;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    if (!warnedEnvKeys.has(key)) {
      warnedEnvKeys.add(key);
      log.warn({ envKey: key, envValue: raw }, `Invalid ${key}, using default ${defaultVal}`);
    }
    return defaultVal;
  }
  return Math.max(parsed, floor);
}

// Note: truncation uses char count via substring(), not byte count.
// Acceptable for UTF-8 source files where chars ≈ bytes.
function resolveMaxReadBytes(): number {
  return resolveEnvInt('CONDUCTOR_MAX_READ_BYTES', 20_000, 1_000);
}

function resolveMaxListEntries(): number {
  return resolveEnvInt('CONDUCTOR_MAX_LIST_ENTRIES', 200, 10);
}

// =============================================================================
// Helpers
// =============================================================================

function validatePath(path: string, worktreePath: string): string | null {
  if (!isValidFilePath(path)) {
    return `Invalid file path: ${path}`;
  }

  const resolved = resolve(worktreePath, path);
  const rel = relative(worktreePath, resolved);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    return `Path escapes worktree: ${path}`;
  }

  // Resolve symlinks (including parent symlinks for non-existent targets) to detect escape
  const symlinkEscape = checkSymlinkEscape(resolved, worktreePath);
  if (symlinkEscape !== null) {
    return `${symlinkEscape}: ${path}`;
  }

  return null;
}

function ok(content: string, meta: Record<string, unknown>): Promise<ToolResult> {
  return Promise.resolve({ content, meta });
}

function err(content: string, meta: Record<string, unknown>): Promise<ToolResult> {
  return Promise.resolve({ content, isError: true, meta });
}

/**
 * Simple glob matcher supporting `*` (any chars except `/`) and `**` (any chars including `/`).
 * Normalizes backslashes to forward slashes before matching.
 * If pattern contains `/`, matches against full path; otherwise matches against filename only.
 */
export function matchesGlob(filePath: string, pattern: string): boolean {
  const normalizedPath = filePath.replace(/\\/g, '/');
  const normalizedPattern = pattern.replace(/\\/g, '/');

  // If pattern has no directory separator, match against filename only
  const matchTarget = normalizedPattern.includes('/')
    ? normalizedPath
    : normalizedPath.split('/').pop() ?? normalizedPath;

  // Convert glob pattern to regex
  let regexStr = '';
  let i = 0;
  while (i < normalizedPattern.length) {
    if (normalizedPattern[i] === '*' && normalizedPattern[i + 1] === '*') {
      regexStr += '.*';
      i += 2;
      // Skip trailing / after **
      if (normalizedPattern[i] === '/') i++;
    } else if (normalizedPattern[i] === '*') {
      regexStr += '[^/]*';
      i++;
    } else if (normalizedPattern[i] === '?') {
      regexStr += '[^/]';
      i++;
    } else if ('.+^${}()|[]\\'.includes(normalizedPattern[i] ?? '')) {
      regexStr += '\\' + normalizedPattern[i];
      i++;
    } else {
      regexStr += normalizedPattern[i];
      i++;
    }
  }

  return new RegExp(`^${regexStr}$`).test(matchTarget);
}

/**
 * Split file content into logical lines, stripping trailing-newline sentinel.
 * Matches editor/`wc -l` behavior:
 *   '' → [] (0 lines — empty file)
 *   'a\n' → ['a'] (1 line — trailing newline is normal terminator)
 *   'a\n\n' → ['a', ''] (2 lines — second is intentional empty line)
 *   'a\nb' → ['a', 'b'] (2 lines — no trailing newline)
 */
export function splitLines(content: string): string[] {
  if (content === '') return [];
  const parts = content.split('\n');
  if (parts[parts.length - 1] === '') parts.pop();
  return parts;
}

// =============================================================================
// read_file
// =============================================================================

const readFileTool: ToolDefinition = {
  name: 'read_file',
  // Description is a startup snapshot; does not update if env changes after init.
  description: `Read the contents of a file at the given path relative to the repository root. Returns the file content as text. Files larger than ${resolveMaxReadBytes()} characters will be truncated.`,
  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Relative file path from the repository root',
      },
    },
    required: ['path'],
  },
  extractTarget: (input) => input['path'] as string | undefined,
  execute: (input, context) => {
    const maxReadBytes = resolveMaxReadBytes();
    const path = input['path'] as string;

    const validationError = validatePath(path, context.worktreePath);
    if (validationError !== null) {
      return err(`Error: ${validationError}`, { error: validationError });
    }

    const fullPath = resolve(context.worktreePath, path);

    try {
      if (!existsSync(fullPath)) {
        return err(`Error: File not found: ${path}`, { error: 'ENOENT' });
      }

      let content = readFileSync(fullPath, 'utf8');
      const originalLength = content.length;
      let truncated = false;

      if (originalLength > maxReadBytes) {
        content = content.substring(0, maxReadBytes) + '\n[...truncated]';
        truncated = true;
      }

      return ok(content, { charCount: originalLength, truncated });
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Unknown error';
      return err(`Error reading file: ${msg}`, { error: msg });
    }
  },
};

// =============================================================================
// read_file_range
// =============================================================================

const readFileRangeTool: ToolDefinition = {
  name: 'read_file_range',
  description: `Read specific lines from a file. Returns lines with line numbers. Output capped at ${resolveMaxReadBytes()} characters.`,
  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Relative file path from the repository root',
      },
      start_line: {
        type: 'integer',
        description: 'First line to read (1-based inclusive)',
      },
      end_line: {
        type: 'integer',
        description: 'Last line to read (1-based inclusive)',
      },
    },
    required: ['path', 'start_line', 'end_line'],
  },
  extractTarget: (input) => input['path'] as string | undefined,
  execute: (input, context) => {
    const maxReadBytes = resolveMaxReadBytes();
    const path = input['path'] as string;
    const startLine = input['start_line'] as number;
    const endLine = input['end_line'] as number;

    const validationError = validatePath(path, context.worktreePath);
    if (validationError !== null) {
      return err(`Error: ${validationError}`, { error: validationError });
    }

    if (!Number.isInteger(startLine)) {
      return err('Error: start_line must be an integer', { error: 'start_line must be an integer' });
    }
    if (!Number.isInteger(endLine)) {
      return err('Error: end_line must be an integer', { error: 'end_line must be an integer' });
    }
    if (startLine < 1) {
      return err('Error: start_line must be >= 1', { error: 'start_line must be >= 1' });
    }
    if (endLine < startLine) {
      return err('Error: end_line must be >= start_line', { error: 'end_line must be >= start_line' });
    }

    const fullPath = resolve(context.worktreePath, path);

    try {
      if (!existsSync(fullPath)) {
        return err(`Error: File not found: ${path}`, { error: 'ENOENT' });
      }

      const content = readFileSync(fullPath, 'utf8');
      const lines = splitLines(content);
      const totalLines = lines.length;

      if (startLine > totalLines) {
        return ok('', {
          requestedStartLine: startLine,
          requestedEndLine: endLine,
          effectiveStartLine: startLine,
          effectiveEndLine: startLine,
          totalLines,
          linesReturned: 0,
          outOfBounds: true,
        });
      }

      const effectiveEndLine = Math.min(endLine, totalLines);
      const selectedLines = lines.slice(startLine - 1, effectiveEndLine);

      let output = selectedLines
        .map((line, i) => `${startLine + i}: ${line}`)
        .join('\n');

      let truncated = false;
      if (output.length > maxReadBytes) {
        output = output.substring(0, maxReadBytes) + '\n[...truncated]';
        truncated = true;
      }

      return ok(output, {
        requestedStartLine: startLine,
        requestedEndLine: endLine,
        effectiveStartLine: startLine,
        effectiveEndLine,
        totalLines,
        linesReturned: selectedLines.length,
        outOfBounds: false,
        truncated,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Unknown error';
      return err(`Error reading file: ${msg}`, { error: msg });
    }
  },
};

// =============================================================================
// search_in_file
// =============================================================================

const REGEX_DELIMITER = /^\/(.+)\/([gimsuy]*)$/;

const searchInFileTool: ToolDefinition = {
  name: 'search_in_file',
  description: `Search for a literal string or regex in a file. Returns matching lines with line numbers. Wrap pattern in /pattern/flags for regex mode. Output capped at ${resolveMaxReadBytes()} characters.`,
  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Relative file path from the repository root',
      },
      pattern: {
        type: 'string',
        description: 'Search string (literal). Wrap in /regex/flags for regex mode.',
      },
      max_matches: {
        type: 'integer',
        description: 'Maximum matches to return (default 20, max 200)',
      },
    },
    required: ['path', 'pattern'],
  },
  extractTarget: (input) => input['path'] as string | undefined,
  execute: (input, context) => {
    const maxReadBytes = resolveMaxReadBytes();
    const path = input['path'] as string;
    const pattern = input['pattern'] as string;
    const rawMaxMatches = input['max_matches'] as number | undefined;

    const validationError = validatePath(path, context.worktreePath);
    if (validationError !== null) {
      return err(`Error: ${validationError}`, { error: validationError });
    }

    if (pattern === '') {
      return err('Error: Pattern must not be empty', { error: 'Pattern must not be empty' });
    }

    // Validate max_matches
    let requestedMaxMatches: number | null = null;
    let effectiveMaxMatches = 20;

    if (rawMaxMatches !== undefined) {
      if (typeof rawMaxMatches !== 'number') {
        return err('Error: max_matches must be an integer', { error: 'max_matches must be an integer' });
      }
      if (!Number.isInteger(rawMaxMatches)) {
        return err('Error: max_matches must be an integer', { error: 'max_matches must be an integer' });
      }
      requestedMaxMatches = rawMaxMatches;
      effectiveMaxMatches = Math.max(1, Math.min(rawMaxMatches, 200));
    }

    const fullPath = resolve(context.worktreePath, path);

    try {
      if (!existsSync(fullPath)) {
        return err(`Error: File not found: ${path}`, { error: 'ENOENT' });
      }

      const content = readFileSync(fullPath, 'utf8');
      const lines = splitLines(content);
      const totalLines = lines.length;

      // Determine match function
      let patternType: 'regex' | 'literal' = 'literal';
      let matchFn: (line: string) => boolean;

      const regexMatch = REGEX_DELIMITER.exec(pattern);
      if (regexMatch?.[1] !== undefined) {
        const body = regexMatch[1];
        const flags = (regexMatch[2] ?? '').replace(/[gy]/g, '');
        try {
          const regex = new RegExp(body, flags);
          patternType = 'regex';
          matchFn = (line) => regex.test(line);
        } catch {
          // Invalid regex — fall back to literal match on raw pattern
          matchFn = (line) => line.includes(pattern);
        }
      } else {
        matchFn = (line) => line.includes(pattern);
      }

      let totalMatches = 0;
      const matchedLines: string[] = [];

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? '';
        if (matchFn(line)) {
          totalMatches++;
          if (matchedLines.length < effectiveMaxMatches) {
            const snippet = line.length > 200 ? line.substring(0, 200) + '...' : line;
            matchedLines.push(`${i + 1}: ${snippet}`);
          }
        }
      }

      const returnedMatches = matchedLines.length;

      if (totalMatches === 0) {
        return ok(`No matches found for "${pattern}" in ${path}`, {
          totalMatches: 0,
          returnedMatches: 0,
          requestedMaxMatches,
          effectiveMaxMatches,
          totalLines,
          patternType,
        });
      }

      let output = `Found ${totalMatches} match(es) in ${path}:\n` + matchedLines.join('\n');

      if (totalMatches > returnedMatches) {
        output += `\n[...${totalMatches - returnedMatches} more matches]`;
      }

      if (output.length > maxReadBytes) {
        output = output.substring(0, maxReadBytes) + '\n[...truncated]';
      }

      return ok(output, {
        totalMatches,
        returnedMatches,
        requestedMaxMatches,
        effectiveMaxMatches,
        totalLines,
        patternType,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Unknown error';
      return err(`Error reading file: ${msg}`, { error: msg });
    }
  },
};

// =============================================================================
// write_file
// =============================================================================

const writeFileTool: ToolDefinition = {
  name: 'write_file',
  description: 'Write content to a file at the given path relative to the repository root. Creates parent directories as needed. Overwrites existing files completely.',
  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Relative file path from the repository root',
      },
      content: {
        type: 'string',
        description: 'The complete file content to write',
      },
    },
    required: ['path', 'content'],
  },
  extractTarget: (input) => input['path'] as string | undefined,
  execute: (input, context) => {
    const path = input['path'] as string;
    const content = input['content'] as string;

    const validationError = validatePath(path, context.worktreePath);
    if (validationError !== null) {
      return err(`Error: ${validationError}`, { error: validationError });
    }

    const fullPath = resolve(context.worktreePath, path);

    try {
      const dir = dirname(fullPath);
      mkdirSync(dir, { recursive: true });
      writeFileSync(fullPath, content, 'utf8');

      const bytesWritten = Buffer.byteLength(content, 'utf8');
      return ok(`Successfully wrote ${bytesWritten} bytes to ${path}`, { bytesWritten });
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Unknown error';
      return err(`Error writing file: ${msg}`, { error: msg });
    }
  },
};

// =============================================================================
// delete_file
// =============================================================================

const deleteFileTool: ToolDefinition = {
  name: 'delete_file',
  description: 'Delete a file at the given path relative to the repository root.',
  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Relative file path from the repository root',
      },
    },
    required: ['path'],
  },
  extractTarget: (input) => input['path'] as string | undefined,
  execute: (input, context) => {
    const path = input['path'] as string;

    const validationError = validatePath(path, context.worktreePath);
    if (validationError !== null) {
      return err(`Error: ${validationError}`, { error: validationError });
    }

    const fullPath = resolve(context.worktreePath, path);

    try {
      if (!existsSync(fullPath)) {
        return ok(`File not found (already deleted): ${path}`, { alreadyDeleted: true });
      }

      unlinkSync(fullPath);
      return ok(`Successfully deleted ${path}`, { deleted: true });
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Unknown error';
      return err(`Error deleting file: ${msg}`, { error: msg });
    }
  },
};

// =============================================================================
// list_files
// =============================================================================

const listFilesTool: ToolDefinition = {
  name: 'list_files',
  // Description is a startup snapshot; does not update if env changes after init.
  description: `List files in the repository using git ls-files. Optionally filter by a subdirectory and/or glob pattern. Sensitive files (.env, .pem, etc) are excluded. Maximum ${resolveMaxListEntries()} entries.`,
  inputSchema: {
    type: 'object',
    properties: {
      directory: {
        type: 'string',
        description: 'Optional subdirectory to list (relative to repository root). Omit to list all files.',
      },
      pattern: {
        type: 'string',
        description: 'Optional glob pattern to filter results (e.g., "*.ts", "**/*.test.ts"). Supports * (any non-/ chars) and ** (any chars including /).',
      },
    },
  },
  extractTarget: (input) => input['directory'] as string | undefined,
  execute: (input, context) => {
    const maxListEntries = resolveMaxListEntries();
    const directory = input['directory'] as string | undefined;
    const pattern = input['pattern'] as string | undefined;

    if (directory !== undefined) {
      const validationError = validatePath(directory, context.worktreePath);
      if (validationError !== null) {
        return err(`Error: ${validationError}`, { error: validationError });
      }
    }

    try {
      const gitArgs = ['ls-files'];
      if (directory !== undefined) {
        gitArgs.push(directory);
      }

      const tracked = execFileSync('git', gitArgs, {
        cwd: context.worktreePath,
        encoding: 'utf8',
        maxBuffer: 1024 * 1024,
      });

      // Also include untracked (non-ignored) files
      const untrackedArgs = ['ls-files', '--others', '--exclude-standard'];
      if (directory !== undefined) {
        untrackedArgs.push(directory);
      }

      const untracked = execFileSync('git', untrackedArgs, {
        cwd: context.worktreePath,
        encoding: 'utf8',
        maxBuffer: 1024 * 1024,
      });

      let trackedFiles = tracked.split('\n').filter((f) => f.length > 0);
      let untrackedFiles = untracked.split('\n').filter((f) => f.length > 0);

      // Apply pattern filter (post-filter for correct directory+pattern intersection)
      if (pattern !== undefined && pattern.length > 0) {
        trackedFiles = trackedFiles.filter((f) => matchesGlob(f, pattern));
        untrackedFiles = untrackedFiles.filter((f) => matchesGlob(f, pattern));
      }

      const files = [...trackedFiles, ...untrackedFiles];
      const safeFiles = files.filter((f) => !isSensitiveFile(f));
      const limited = safeFiles.slice(0, maxListEntries);
      const truncated = safeFiles.length > maxListEntries;

      let listing = limited.join('\n');
      if (truncated) {
        listing += `\n[...${safeFiles.length - maxListEntries} more files]`;
      }

      return ok(listing, { totalFiles: safeFiles.length, listed: limited.length, truncated });
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Unknown error';
      return err(`Error listing files: ${msg}`, { error: msg });
    }
  },
};

// =============================================================================
// Registration
// =============================================================================

export function registerFilesystemTools(registry: ToolRegistry): void {
  registry.register(readFileTool);
  registry.register(readFileRangeTool);
  registry.register(searchInFileTool);
  registry.register(writeFileTool);
  registry.register(deleteFileTool);
  registry.register(listFilesTool);
}
