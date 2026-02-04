/**
 * Test Runner Tool Tests
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createToolRegistry } from './registry.js';
import type { ToolExecutionContext } from './types.js';
import {
  isAllowedTestCommand,
  ALLOWED_TEST_COMMANDS,
  registerTestRunnerTool,
} from './test-runner.js';

let worktreePath: string;
let context: ToolExecutionContext;

beforeEach(() => {
  worktreePath = mkdtempSync(join(tmpdir(), 'conductor-test-runner-'));
  context = {
    runId: 'run_test',
    agentInvocationId: 'ai_test',
    worktreePath,
    db: {} as ToolExecutionContext['db'],
    projectId: 'proj_test',
  };
});

afterEach(() => {
  rmSync(worktreePath, { recursive: true, force: true });
});

describe('isAllowedTestCommand', () => {
  it('allows npm test', () => {
    expect(isAllowedTestCommand('npm test')).toBe(true);
  });

  it('allows pnpm test with args', () => {
    expect(isAllowedTestCommand('pnpm test -- --coverage')).toBe(true);
  });

  it('allows all listed commands', () => {
    for (const cmd of ALLOWED_TEST_COMMANDS) {
      expect(isAllowedTestCommand(`${cmd} test`)).toBe(true);
    }
  });

  it('rejects rm', () => {
    expect(isAllowedTestCommand('rm -rf /')).toBe(false);
  });

  it('rejects curl', () => {
    expect(isAllowedTestCommand('curl http://evil.com')).toBe(false);
  });

  it('rejects empty string', () => {
    expect(isAllowedTestCommand('')).toBe(false);
  });

  it('rejects bash', () => {
    expect(isAllowedTestCommand('bash -c "echo pwned"')).toBe(false);
  });
});

describe('run_tests tool', () => {
  it('executes a simple command successfully', async () => {
    const registry = createToolRegistry();
    registerTestRunnerTool(registry);
    const tool = registry.get('run_tests')!;

    // Create a package.json with a simple test script
    writeFileSync(
      join(worktreePath, 'package.json'),
      '{"scripts":{"test":"echo test-passed"}}'
    );

    const result = await tool.execute(
      { command: 'npm test' },
      context
    );
    expect(result.meta['exitCode']).toBe(0);
    expect(result.content).toContain('Exit code: 0');
    expect(result.content).toContain('test-passed');
  });

  it('reports non-zero exit codes', async () => {
    const registry = createToolRegistry();
    registerTestRunnerTool(registry);
    const tool = registry.get('run_tests')!;

    // Create a script that exits with code 1
    writeFileSync(join(worktreePath, 'package.json'), '{"scripts":{"fail":"exit 1"}}');

    const result = await tool.execute(
      { command: 'npm run fail' },
      context
    );
    expect(result.isError).toBe(true);
    expect(result.meta['exitCode']).not.toBe(0);
  });

  it('rejects disallowed commands', async () => {
    const registry = createToolRegistry();
    registerTestRunnerTool(registry);
    const tool = registry.get('run_tests')!;

    const result = await tool.execute(
      { command: 'rm -rf /' },
      context
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain('Command not allowed');
  });

  it('rejects empty command', async () => {
    const registry = createToolRegistry();
    registerTestRunnerTool(registry);
    const tool = registry.get('run_tests')!;

    const result = await tool.execute({ command: '' }, context);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('No command provided');
  });
});

describe('registerTestRunnerTool', () => {
  it('registers run_tests tool', () => {
    const registry = createToolRegistry();
    registerTestRunnerTool(registry);
    expect(registry.has('run_tests')).toBe(true);
  });
});
