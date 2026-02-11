/**
 * Test Runner Tool
 *
 * Executes test commands via child_process.spawn (not exec — avoids shell injection).
 * Only allows a curated set of test runner programs.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import type { ToolDefinition, ToolResult } from './types.ts';
import type { ToolRegistry } from './registry.ts';

// =============================================================================
// Constants
// =============================================================================

export const MAX_TEST_OUTPUT_BYTES = 50_000;
export const DEFAULT_TEST_TIMEOUT_MS = 120_000;

export const ALLOWED_TEST_COMMANDS: string[] = [
  'npm',
  'npx',
  'pnpm',
  'yarn',
  'jest',
  'vitest',
  'pytest',
  'go',
  'cargo',
  'make',
];

// =============================================================================
// Arg Parsing
// =============================================================================

/**
 * Split a command string into args, respecting single and double quotes.
 * Does not interpret escapes — keeps it simple and safe.
 */
export function parseCommandArgs(command: string): string[] {
  const args: string[] = [];
  let current = '';
  let quote: string | null = null;

  for (const ch of command.trim()) {
    if (quote !== null) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === ' ' || ch === '\t') {
      if (current.length > 0) {
        args.push(current);
        current = '';
      }
    } else {
      current += ch;
    }
  }
  if (current.length > 0) {
    args.push(current);
  }
  return args;
}

// =============================================================================
// Validation
// =============================================================================

export function isAllowedTestCommand(command: string): boolean {
  const parts = parseCommandArgs(command);
  const program = parts[0];
  if (program === undefined) return false;
  return ALLOWED_TEST_COMMANDS.includes(program);
}

// =============================================================================
// Auto-detection
// =============================================================================

const DETECTION_CHECKS = [
  'package.json',
  'Makefile',
  'pytest.ini',
  'pyproject.toml',
  'setup.cfg',
  'Cargo.toml',
  'go.mod',
] as const;

/**
 * Auto-detect a test command based on project files.
 * Checks in priority order: npm > make > pytest > cargo > go.
 */
export function detectTestCommand(worktreePath: string): string | null {
  // 1. package.json with scripts.test
  const pkgPath = join(worktreePath, 'package.json');
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as Record<string, unknown>;
      const scripts = pkg['scripts'] as Record<string, unknown> | undefined;
      if (scripts?.['test'] !== undefined && scripts['test'] !== '') {
        return 'npm test';
      }
    } catch {
      // Malformed package.json — skip
    }
  }

  // 2. Makefile with test target
  const makefilePath = join(worktreePath, 'Makefile');
  if (existsSync(makefilePath)) {
    try {
      const content = readFileSync(makefilePath, 'utf8');
      if (/^test\s*:/m.test(content)) {
        return 'make test';
      }
    } catch {
      // Skip
    }
  }

  // 3. pytest indicators
  if (existsSync(join(worktreePath, 'pytest.ini'))) {
    return 'pytest';
  }
  const pyprojectPath = join(worktreePath, 'pyproject.toml');
  if (existsSync(pyprojectPath)) {
    try {
      const content = readFileSync(pyprojectPath, 'utf8');
      if (content.includes('[tool.pytest')) {
        return 'pytest';
      }
    } catch {
      // Skip
    }
  }
  const setupCfgPath = join(worktreePath, 'setup.cfg');
  if (existsSync(setupCfgPath)) {
    try {
      const content = readFileSync(setupCfgPath, 'utf8');
      if (content.includes('[tool:pytest]')) {
        return 'pytest';
      }
    } catch {
      // Skip
    }
  }

  // 4. Cargo.toml
  if (existsSync(join(worktreePath, 'Cargo.toml'))) {
    return 'cargo test';
  }

  // 5. go.mod
  if (existsSync(join(worktreePath, 'go.mod'))) {
    return 'go test ./...';
  }

  return null;
}

// =============================================================================
// Tool Definition
// =============================================================================

export const runTestsTool: ToolDefinition = {
  name: 'run_tests',
  description: 'Run a test command in the repository. The command must start with an allowed test runner (npm, pnpm, yarn, jest, vitest, pytest, go, cargo, make). Shell operators are not allowed. Output is truncated to keep the tail (where test failures appear). If command is omitted, auto-detects based on project files (package.json, Makefile, pytest.ini, Cargo.toml, go.mod).',
  inputSchema: {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        description: 'The test command to run (e.g., "npm test", "pnpm test -- --coverage", "pytest tests/"). If omitted, auto-detects from project files.',
      },
    },
  },
  execute: async (input, context): Promise<ToolResult> => {
    let command = (input['command'] as string ?? '').trim();

    if (command.length === 0) {
      const detected = detectTestCommand(context.worktreePath);
      if (detected === null) {
        return {
          content: `Error: No command provided and auto-detection failed. Checked: ${DETECTION_CHECKS.join(', ')}. Please provide an explicit command.`,
          isError: true,
          meta: { error: 'no_command_detected', checked: DETECTION_CHECKS },
        };
      }
      command = detected;
    }

    if (!isAllowedTestCommand(command)) {
      return {
        content: `Error: Command not allowed. Must start with one of: ${ALLOWED_TEST_COMMANDS.join(', ')}`,
        isError: true,
        meta: { error: 'disallowed_command', command },
      };
    }

    const parts = parseCommandArgs(command);
    const program = parts[0] ?? '';
    const args = parts.slice(1);

    return new Promise<ToolResult>((resolveResult) => {
      const chunks: Buffer[] = [];
      let totalBytes = 0;
      let timedOut = false;
      const startTime = Date.now();

      // Only pass through safe env vars (minimal sandbox)
      const safeEnv = {
        PATH: process.env['PATH'] ?? '',
        HOME: process.env['HOME'] ?? '',
        LANG: process.env['LANG'] ?? 'en_US.UTF-8',
      } as unknown as NodeJS.ProcessEnv;

      const child: ChildProcess = spawn(program, args, {
        cwd: context.worktreePath,
        env: safeEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      // Kill timeout
      const killTimer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
        setTimeout(() => {
          if (!child.killed) {
            child.kill('SIGKILL');
          }
        }, 5000);
      }, DEFAULT_TEST_TIMEOUT_MS);

      // Listen for abort signal to kill subprocess on cancellation
      let abortListener: (() => void) | undefined;
      if (context.abortSignal !== undefined) {
        const onAbort = () => {
          child.kill('SIGTERM');
          setTimeout(() => {
            if (!child.killed) child.kill('SIGKILL');
          }, 5000);
        };
        if (context.abortSignal.aborted) {
          onAbort();
        } else {
          abortListener = onAbort;
          context.abortSignal.addEventListener('abort', onAbort, { once: true });
        }
      }

      const collectOutput = (data: Buffer) => {
        chunks.push(data);
        totalBytes += data.length;
      };

      child.stdout?.on('data', collectOutput);
      child.stderr?.on('data', collectOutput);

      child.on('error', (err: Error) => {
        clearTimeout(killTimer);
        resolveResult({
          content: `Error spawning process: ${err.message}`,
          isError: true,
          meta: { error: err.message, durationMs: Date.now() - startTime },
        });
      });

      child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
        clearTimeout(killTimer);
        if (abortListener !== undefined && context.abortSignal !== undefined) {
          context.abortSignal.removeEventListener('abort', abortListener);
        }
        const durationMs = Date.now() - startTime;
        let output = Buffer.concat(chunks).toString('utf8');

        // Truncate keeping the tail (test failures are at the end)
        if (totalBytes > MAX_TEST_OUTPUT_BYTES) {
          const tail = output.slice(-MAX_TEST_OUTPUT_BYTES);
          output = `[...truncated ${totalBytes - MAX_TEST_OUTPUT_BYTES} bytes from start]\n${tail}`;
        }

        const exitCode = code ?? -1;
        const isError = exitCode !== 0;

        resolveResult({
          content: `Exit code: ${exitCode}${signal !== null ? ` (signal: ${signal})` : ''}\n\n${output}`,
          isError,
          meta: {
            exitCode,
            signal,
            totalBytes,
            truncated: totalBytes > MAX_TEST_OUTPUT_BYTES,
            durationMs,
            timedOut,
          },
        });
      });
    });
  },
};

// =============================================================================
// Registration
// =============================================================================

export function registerTestRunnerTool(registry: ToolRegistry): void {
  registry.register(runTestsTool);
}
