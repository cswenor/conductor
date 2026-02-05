/**
 * Test Runner Tool Tests
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createToolRegistry } from './registry.js';
import type { ToolExecutionContext } from './types.js';
import {
  isAllowedTestCommand,
  detectTestCommand,
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

  it('rejects empty command when no detection possible', async () => {
    const registry = createToolRegistry();
    registerTestRunnerTool(registry);
    const tool = registry.get('run_tests')!;

    // Use an empty temp dir so nothing is detected
    const emptyDir = mkdtempSync(join(tmpdir(), 'conductor-empty-'));
    const emptyContext = { ...context, worktreePath: emptyDir };

    const result = await tool.execute({ command: '' }, emptyContext);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('auto-detection failed');
    expect(result.content).toContain('package.json');

    rmSync(emptyDir, { recursive: true, force: true });
  });

  it('auto-detects npm test when command is omitted', async () => {
    const registry = createToolRegistry();
    registerTestRunnerTool(registry);
    const tool = registry.get('run_tests')!;

    writeFileSync(
      join(worktreePath, 'package.json'),
      '{"scripts":{"test":"echo auto-detected"}}'
    );

    const result = await tool.execute({}, context);
    expect(result.meta['exitCode']).toBe(0);
    expect(result.content).toContain('auto-detected');
  });
});

describe('detectTestCommand', () => {
  it('detects npm test from package.json', () => {
    writeFileSync(
      join(worktreePath, 'package.json'),
      '{"scripts":{"test":"jest"}}'
    );
    expect(detectTestCommand(worktreePath)).toBe('npm test');
  });

  it('detects make test from Makefile', () => {
    writeFileSync(
      join(worktreePath, 'Makefile'),
      'test:\n\techo running tests\n'
    );
    expect(detectTestCommand(worktreePath)).toBe('make test');
  });

  it('detects pytest from pytest.ini', () => {
    writeFileSync(join(worktreePath, 'pytest.ini'), '[pytest]\n');
    expect(detectTestCommand(worktreePath)).toBe('pytest');
  });

  it('detects pytest from pyproject.toml with [tool.pytest section', () => {
    writeFileSync(
      join(worktreePath, 'pyproject.toml'),
      '[tool.pytest.ini_options]\nminversion = "6.0"\n'
    );
    expect(detectTestCommand(worktreePath)).toBe('pytest');
  });

  it('detects pytest from setup.cfg with [tool:pytest] section', () => {
    writeFileSync(
      join(worktreePath, 'setup.cfg'),
      '[tool:pytest]\naddopts = -v\n'
    );
    expect(detectTestCommand(worktreePath)).toBe('pytest');
  });

  it('detects cargo test from Cargo.toml', () => {
    writeFileSync(
      join(worktreePath, 'Cargo.toml'),
      '[package]\nname = "test"\n'
    );
    expect(detectTestCommand(worktreePath)).toBe('cargo test');
  });

  it('detects go test from go.mod', () => {
    writeFileSync(
      join(worktreePath, 'go.mod'),
      'module example.com/test\n'
    );
    expect(detectTestCommand(worktreePath)).toBe('go test ./...');
  });

  it('returns null for empty directory', () => {
    const emptyDir = mkdtempSync(join(tmpdir(), 'conductor-empty-'));
    expect(detectTestCommand(emptyDir)).toBeNull();
    rmSync(emptyDir, { recursive: true, force: true });
  });

  it('npm wins over make when both exist (detection order)', () => {
    writeFileSync(
      join(worktreePath, 'package.json'),
      '{"scripts":{"test":"jest"}}'
    );
    writeFileSync(
      join(worktreePath, 'Makefile'),
      'test:\n\techo make\n'
    );
    expect(detectTestCommand(worktreePath)).toBe('npm test');
  });

  it('make wins over pytest when both exist', () => {
    writeFileSync(
      join(worktreePath, 'Makefile'),
      'test:\n\techo make\n'
    );
    writeFileSync(join(worktreePath, 'pytest.ini'), '[pytest]\n');
    expect(detectTestCommand(worktreePath)).toBe('make test');
  });

  it('skips package.json without scripts.test', () => {
    writeFileSync(
      join(worktreePath, 'package.json'),
      '{"scripts":{"build":"tsc"}}'
    );
    expect(detectTestCommand(worktreePath)).toBeNull();
  });
});

describe('registerTestRunnerTool', () => {
  it('registers run_tests tool', () => {
    const registry = createToolRegistry();
    registerTestRunnerTool(registry);
    expect(registry.has('run_tests')).toBe(true);
  });
});
