/**
 * Filesystem Tools Tests
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, symlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createToolRegistry } from './registry.ts';
import { registerFilesystemTools, matchesGlob } from './filesystem.ts';
import type { ToolExecutionContext } from './types.ts';

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
  execFileSync('git', ['-c', 'commit.gpgsign=false', 'commit', '-m', 'init'], { cwd: worktreePath });

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
    expect(result.meta['charCount']).toBeGreaterThan(0);
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

    // Write a file larger than default 20KB limit
    const largeContent = 'x'.repeat(40_000);
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
    execFileSync('git', ['-c', 'commit.gpgsign=false', 'commit', '-m', 'add env'], { cwd: worktreePath });

    const result = await tool.execute({}, context);
    expect(result.content).not.toContain('.env');
  });

  it('includes untracked files', async () => {
    const registry = getRegistry();
    const tool = registry.get('list_files')!;

    // Create an untracked file (not git-added)
    writeFileSync(join(worktreePath, 'untracked.ts'), 'export const y = 2;');

    const result = await tool.execute({}, context);
    expect(result.content).toContain('untracked.ts');
    // Also still lists tracked files
    expect(result.content).toContain('src/main.ts');
  });

  it('blocks path traversal in directory arg', async () => {
    const registry = getRegistry();
    const tool = registry.get('list_files')!;

    const result = await tool.execute({ directory: '../../' }, context);
    expect(result.isError).toBe(true);
  });
});

describe('matchesGlob', () => {
  it('matches *.ts against filename', () => {
    expect(matchesGlob('src/utils.test.ts', '*.ts')).toBe(true);
  });

  it('does not match *.js against .ts file', () => {
    expect(matchesGlob('src/utils.test.ts', '*.js')).toBe(false);
  });

  it('matches **/*.test.ts against nested files', () => {
    expect(matchesGlob('src/deep/utils.test.ts', '**/*.test.ts')).toBe(true);
  });

  it('matches pattern with directory path', () => {
    expect(matchesGlob('src/main.ts', 'src/*.ts')).toBe(true);
  });

  it('does not match file outside directory in pattern', () => {
    expect(matchesGlob('lib/main.ts', 'src/*.ts')).toBe(false);
  });

  it('normalizes backslashes', () => {
    expect(matchesGlob('src/utils.ts', 'src\\utils.ts')).toBe(true);
  });

  it('handles ? wildcard', () => {
    expect(matchesGlob('file1.ts', 'file?.ts')).toBe(true);
    expect(matchesGlob('file12.ts', 'file?.ts')).toBe(false);
  });
});

describe('list_files with pattern', () => {
  it('filters files by pattern', async () => {
    const registry = getRegistry();
    const tool = registry.get('list_files')!;

    // Add a .js file
    writeFileSync(join(worktreePath, 'src/helper.js'), 'module.exports = {};');
    execFileSync('git', ['add', '-A'], { cwd: worktreePath });
    execFileSync('git', ['-c', 'commit.gpgsign=false', 'commit', '-m', 'add js'], { cwd: worktreePath });

    const result = await tool.execute({ pattern: '*.ts' }, context);
    expect(result.content).toContain('main.ts');
    expect(result.content).not.toContain('helper.js');
    expect(result.content).not.toContain('README.md');
  });

  it('directory + pattern intersection: only .ts under src/', async () => {
    const registry = getRegistry();
    const tool = registry.get('list_files')!;

    // Add a .ts file outside src/
    writeFileSync(join(worktreePath, 'index.ts'), 'export {};');
    writeFileSync(join(worktreePath, 'src/helper.js'), 'module.exports = {};');
    execFileSync('git', ['add', '-A'], { cwd: worktreePath });
    execFileSync('git', ['-c', 'commit.gpgsign=false', 'commit', '-m', 'add more'], { cwd: worktreePath });

    const result = await tool.execute({ directory: 'src', pattern: '*.ts' }, context);
    expect(result.content).toContain('src/main.ts');
    expect(result.content).not.toContain('index.ts');
    expect(result.content).not.toContain('helper.js');
  });

  it('filters untracked files by pattern', async () => {
    const registry = getRegistry();
    const tool = registry.get('list_files')!;

    writeFileSync(join(worktreePath, 'untracked.ts'), 'export {};');
    writeFileSync(join(worktreePath, 'untracked.js'), 'module.exports = {};');

    const result = await tool.execute({ pattern: '*.ts' }, context);
    expect(result.content).toContain('untracked.ts');
    expect(result.content).not.toContain('untracked.js');
  });

  it('description mentions 200', () => {
    const registry = getRegistry();
    const tool = registry.get('list_files')!;
    expect(tool.description).toContain('200');
  });
});

describe('symlink escape detection', () => {
  it('blocks write through symlink dir to outside worktree (non-existent target)', async () => {
    const registry = getRegistry();
    const tool = registry.get('write_file')!;

    // Create a symlink inside worktree that points to /tmp
    symlinkSync('/tmp', join(worktreePath, 'symlink_dir'));

    const result = await tool.execute(
      { path: 'symlink_dir/new_file.txt', content: 'evil' },
      context
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain('escapes worktree via symlink');
  });

  it('allows write through symlink dir pointing inside worktree', async () => {
    const registry = getRegistry();
    const tool = registry.get('write_file')!;

    // Create a real dir and symlink to it inside the worktree
    mkdirSync(join(worktreePath, 'real_dir'), { recursive: true });
    symlinkSync(join(worktreePath, 'real_dir'), join(worktreePath, 'link_dir'));

    const result = await tool.execute(
      { path: 'link_dir/new_file.txt', content: 'safe' },
      context
    );
    expect(result.isError).toBeUndefined();
    expect(result.content).toContain('Successfully wrote');
  });

  it('allows normal nested create (no symlinks)', async () => {
    const registry = getRegistry();
    const tool = registry.get('write_file')!;

    const result = await tool.execute(
      { path: 'deep/nested/new.ts', content: 'export const x = 1;' },
      context
    );
    expect(result.isError).toBeUndefined();
    expect(existsSync(join(worktreePath, 'deep/nested/new.ts'))).toBe(true);
  });

  it('blocks read through symlink to existing file outside worktree', async () => {
    const registry = getRegistry();
    const tool = registry.get('read_file')!;

    // Create a file outside worktree
    const outsideDir = mkdtempSync(join(tmpdir(), 'conductor-outside-'));
    writeFileSync(join(outsideDir, 'secret.txt'), 'secret data');

    // Symlink from worktree to outside file
    symlinkSync(join(outsideDir, 'secret.txt'), join(worktreePath, 'escape_link.txt'));

    const result = await tool.execute({ path: 'escape_link.txt' }, context);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('escapes worktree via symlink');

    rmSync(outsideDir, { recursive: true, force: true });
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

describe('env-configurable limits', () => {
  afterEach(() => {
    delete process.env['CONDUCTOR_MAX_READ_BYTES'];
    delete process.env['CONDUCTOR_MAX_LIST_ENTRIES'];
  });

  it('CONDUCTOR_MAX_READ_BYTES overrides read_file truncation threshold', async () => {
    process.env['CONDUCTOR_MAX_READ_BYTES'] = '5000';
    const registry = getRegistry();
    const tool = registry.get('read_file')!;

    // Write 10KB file, verify truncation at ~5000 chars
    const content = 'x'.repeat(10_000);
    writeFileSync(join(worktreePath, 'medium.txt'), content);

    const result = await tool.execute({ path: 'medium.txt' }, context);
    expect(result.content).toContain('[...truncated]');
    expect(result.meta['truncated']).toBe(true);
    // Content should be ~5000 chars + truncation marker
    expect(result.content.length).toBeLessThan(6000);
  });

  it('CONDUCTOR_MAX_LIST_ENTRIES overrides list_files cap', async () => {
    process.env['CONDUCTOR_MAX_LIST_ENTRIES'] = '10';
    const registry = getRegistry();
    const tool = registry.get('list_files')!;

    // Create and git-add 20 files
    for (let i = 0; i < 20; i++) {
      writeFileSync(join(worktreePath, `file${i.toString().padStart(2, '0')}.ts`), `export const x${i} = ${i};`);
    }
    execFileSync('git', ['add', '-A'], { cwd: worktreePath });
    execFileSync('git', ['-c', 'commit.gpgsign=false', 'commit', '-m', 'add files'], { cwd: worktreePath });

    const result = await tool.execute({}, context);
    expect(result.meta['truncated']).toBe(true);
    expect(result.meta['listed']).toBe(10);
    expect(result.content).toContain('more files');
  });

  it('invalid env values fall back to defaults', async () => {
    process.env['CONDUCTOR_MAX_READ_BYTES'] = 'abc';
    process.env['CONDUCTOR_MAX_LIST_ENTRIES'] = 'Infinity';
    const registry = getRegistry();
    const tool = registry.get('read_file')!;

    // Write 40KB file, verify truncation at default 20KB
    const content = 'x'.repeat(40_000);
    writeFileSync(join(worktreePath, 'big.txt'), content);

    const result = await tool.execute({ path: 'big.txt' }, context);
    expect(result.content).toContain('[...truncated]');
    expect(result.meta['truncated']).toBe(true);
    // Should be truncated at ~20000 (default), not at some other value
    expect(result.content.length).toBeGreaterThan(19_000);
    expect(result.content.length).toBeLessThan(21_000);
  });

  it('below-floor CONDUCTOR_MAX_READ_BYTES is clamped to floor', async () => {
    process.env['CONDUCTOR_MAX_READ_BYTES'] = '500'; // below floor of 1000
    const registry = getRegistry();
    const tool = registry.get('read_file')!;

    // Write 2KB file, verify truncation at 1000 (floor), not 500
    const content = 'x'.repeat(2_000);
    writeFileSync(join(worktreePath, 'small.txt'), content);

    const result = await tool.execute({ path: 'small.txt' }, context);
    expect(result.content).toContain('[...truncated]');
    expect(result.meta['truncated']).toBe(true);
    // Should be clamped to floor of 1000, so content ~1000 + marker
    expect(result.content.length).toBeGreaterThan(990);
    expect(result.content.length).toBeLessThan(1100);
  });

  it('invalid CONDUCTOR_MAX_LIST_ENTRIES falls back to default', async () => {
    process.env['CONDUCTOR_MAX_LIST_ENTRIES'] = 'not-a-number';
    const registry = getRegistry();
    const tool = registry.get('list_files')!;

    // Default is 200, so listing 3 tracked files should not truncate
    const result = await tool.execute({}, context);
    expect(result.meta['truncated']).toBe(false);
    expect(result.content).toContain('src/main.ts');
  });

  it('below-floor CONDUCTOR_MAX_LIST_ENTRIES is clamped to floor', async () => {
    process.env['CONDUCTOR_MAX_LIST_ENTRIES'] = '5'; // below floor of 10
    const registry = getRegistry();
    const tool = registry.get('list_files')!;

    // Create and git-add 15 files (+ 2 existing = 17 total)
    for (let i = 0; i < 15; i++) {
      writeFileSync(join(worktreePath, `clamp${i.toString().padStart(2, '0')}.ts`), `export {};`);
    }
    execFileSync('git', ['add', '-A'], { cwd: worktreePath });
    execFileSync('git', ['-c', 'commit.gpgsign=false', 'commit', '-m', 'add clamp files'], { cwd: worktreePath });

    const result = await tool.execute({}, context);
    expect(result.meta['truncated']).toBe(true);
    // Should be clamped to floor of 10, not 5
    expect(result.meta['listed']).toBe(10);
  });
});
