/**
 * Filesystem Tools Tests
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createToolRegistry } from './registry.js';
import { registerFilesystemTools } from './filesystem.js';
import type { ToolExecutionContext } from './types.js';

let worktreePath: string;
let context: ToolExecutionContext;

beforeEach(() => {
  worktreePath = mkdtempSync(join(tmpdir(), 'conductor-fs-test-'));

  // Initialize a git repo so list_files works
  execFileSync('git', ['init'], { cwd: worktreePath });
  execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: worktreePath });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: worktreePath });

  // Create some test files
  mkdirSync(join(worktreePath, 'src'), { recursive: true });
  writeFileSync(join(worktreePath, 'src/main.ts'), 'console.log("hello");');
  writeFileSync(join(worktreePath, 'README.md'), '# Test');
  execFileSync('git', ['add', '-A'], { cwd: worktreePath });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: worktreePath });

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

function getRegistry() {
  const registry = createToolRegistry();
  registerFilesystemTools(registry);
  return registry;
}

describe('read_file', () => {
  it('reads an existing file', async () => {
    const registry = getRegistry();
    const tool = registry.get('read_file')!;

    const result = await tool.execute({ path: 'src/main.ts' }, context);
    expect(result.isError).toBeUndefined();
    expect(result.content).toContain('console.log("hello")');
    expect(result.meta['bytesRead']).toBeGreaterThan(0);
  });

  it('returns error for non-existent file', async () => {
    const registry = getRegistry();
    const tool = registry.get('read_file')!;

    const result = await tool.execute({ path: 'nonexistent.ts' }, context);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('File not found');
  });

  it('blocks path traversal', async () => {
    const registry = getRegistry();
    const tool = registry.get('read_file')!;

    const result = await tool.execute({ path: '../../../etc/passwd' }, context);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('Invalid file path');
  });

  it('blocks absolute paths', async () => {
    const registry = getRegistry();
    const tool = registry.get('read_file')!;

    const result = await tool.execute({ path: '/etc/passwd' }, context);
    expect(result.isError).toBe(true);
  });

  it('truncates large files', async () => {
    const registry = getRegistry();
    const tool = registry.get('read_file')!;

    // Write a file larger than 100KB
    const largeContent = 'x'.repeat(200_000);
    writeFileSync(join(worktreePath, 'large.txt'), largeContent);

    const result = await tool.execute({ path: 'large.txt' }, context);
    expect(result.content).toContain('[...truncated]');
    expect(result.meta['truncated']).toBe(true);
  });
});

describe('write_file', () => {
  it('writes a new file', async () => {
    const registry = getRegistry();
    const tool = registry.get('write_file')!;

    const result = await tool.execute(
      { path: 'src/new.ts', content: 'export const x = 1;' },
      context
    );
    expect(result.isError).toBeUndefined();
    expect(result.content).toContain('Successfully wrote');

    const written = readFileSync(join(worktreePath, 'src/new.ts'), 'utf8');
    expect(written).toBe('export const x = 1;');
  });

  it('creates parent directories', async () => {
    const registry = getRegistry();
    const tool = registry.get('write_file')!;

    await tool.execute(
      { path: 'deep/nested/dir/file.ts', content: 'content' },
      context
    );

    expect(existsSync(join(worktreePath, 'deep/nested/dir/file.ts'))).toBe(true);
  });

  it('blocks path traversal', async () => {
    const registry = getRegistry();
    const tool = registry.get('write_file')!;

    const result = await tool.execute(
      { path: '../escape.txt', content: 'bad' },
      context
    );
    expect(result.isError).toBe(true);
  });
});

describe('delete_file', () => {
  it('deletes an existing file', async () => {
    const registry = getRegistry();
    const tool = registry.get('delete_file')!;

    const result = await tool.execute({ path: 'README.md' }, context);
    expect(result.isError).toBeUndefined();
    expect(result.content).toContain('Successfully deleted');
    expect(existsSync(join(worktreePath, 'README.md'))).toBe(false);
  });

  it('handles already-deleted file gracefully', async () => {
    const registry = getRegistry();
    const tool = registry.get('delete_file')!;

    const result = await tool.execute({ path: 'nonexistent.txt' }, context);
    expect(result.isError).toBeUndefined();
    expect(result.content).toContain('already deleted');
  });

  it('blocks path traversal', async () => {
    const registry = getRegistry();
    const tool = registry.get('delete_file')!;

    const result = await tool.execute({ path: '../../../tmp/bad' }, context);
    expect(result.isError).toBe(true);
  });
});

describe('list_files', () => {
  it('lists tracked files', async () => {
    const registry = getRegistry();
    const tool = registry.get('list_files')!;

    const result = await tool.execute({}, context);
    expect(result.isError).toBeUndefined();
    expect(result.content).toContain('src/main.ts');
    expect(result.content).toContain('README.md');
  });

  it('filters by directory', async () => {
    const registry = getRegistry();
    const tool = registry.get('list_files')!;

    const result = await tool.execute({ directory: 'src' }, context);
    expect(result.content).toContain('src/main.ts');
    expect(result.content).not.toContain('README.md');
  });

  it('excludes sensitive files', async () => {
    const registry = getRegistry();
    const tool = registry.get('list_files')!;

    // Add a sensitive file
    writeFileSync(join(worktreePath, '.env'), 'SECRET=value');
    execFileSync('git', ['add', '.env'], { cwd: worktreePath });
    execFileSync('git', ['commit', '-m', 'add env'], { cwd: worktreePath });

    const result = await tool.execute({}, context);
    expect(result.content).not.toContain('.env');
  });

  it('blocks path traversal in directory arg', async () => {
    const registry = getRegistry();
    const tool = registry.get('list_files')!;

    const result = await tool.execute({ directory: '../../' }, context);
    expect(result.isError).toBe(true);
  });
});

describe('registerFilesystemTools', () => {
  it('registers all four tools', () => {
    const registry = createToolRegistry();
    registerFilesystemTools(registry);

    expect(registry.has('read_file')).toBe(true);
    expect(registry.has('write_file')).toBe(true);
    expect(registry.has('delete_file')).toBe(true);
    expect(registry.has('list_files')).toBe(true);
    expect(registry.names()).toHaveLength(4);
  });
});
