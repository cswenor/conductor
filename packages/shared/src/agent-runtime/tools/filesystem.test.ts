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
import { registerFilesystemTools, matchesGlob, splitLines } from './filesystem.ts';
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

describe('splitLines', () => {
  it('returns empty array for empty string', () => {
    expect(splitLines('')).toEqual([]);
  });

  it('returns one line for content with trailing newline', () => {
    expect(splitLines('a\n')).toEqual(['a']);
  });

  it('returns two lines when second is intentional empty line', () => {
    expect(splitLines('a\n\n')).toEqual(['a', '']);
  });

  it('returns two lines with no trailing newline', () => {
    expect(splitLines('a\nb')).toEqual(['a', 'b']);
  });
});

describe('read_file_range', () => {
  it('reads correct line range with line number prefixes', async () => {
    const registry = getRegistry();
    const tool = registry.get('read_file_range')!;

    writeFileSync(join(worktreePath, 'lines.txt'), 'line1\nline2\nline3\nline4\nline5\n');

    const result = await tool.execute({ path: 'lines.txt', start_line: 2, end_line: 4 }, context);
    expect(result.isError).toBeUndefined();
    expect(result.content).toBe('2: line2\n3: line3\n4: line4');
    expect(result.meta['linesReturned']).toBe(3);
  });

  it('clamps end_line past EOF without error', async () => {
    const registry = getRegistry();
    const tool = registry.get('read_file_range')!;

    writeFileSync(join(worktreePath, 'short.txt'), 'a\nb\nc\n');

    const result = await tool.execute({ path: 'short.txt', start_line: 2, end_line: 100 }, context);
    expect(result.isError).toBeUndefined();
    expect(result.meta['effectiveEndLine']).toBe(3);
    expect(result.meta['requestedEndLine']).toBe(100);
    expect(result.meta['linesReturned']).toBe(2);
  });

  it('returns empty content when start_line > totalLines', async () => {
    const registry = getRegistry();
    const tool = registry.get('read_file_range')!;

    writeFileSync(join(worktreePath, 'small.txt'), 'one\ntwo\n');

    const result = await tool.execute({ path: 'small.txt', start_line: 10, end_line: 20 }, context);
    expect(result.isError).toBeUndefined();
    expect(result.content).toBe('');
    expect(result.meta['linesReturned']).toBe(0);
    expect(result.meta['outOfBounds']).toBe(true);
  });

  it('rejects start_line < 1', async () => {
    const registry = getRegistry();
    const tool = registry.get('read_file_range')!;

    writeFileSync(join(worktreePath, 'any.txt'), 'content\n');

    const result = await tool.execute({ path: 'any.txt', start_line: 0, end_line: 1 }, context);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('start_line must be >= 1');
  });

  it('rejects end_line < start_line', async () => {
    const registry = getRegistry();
    const tool = registry.get('read_file_range')!;

    writeFileSync(join(worktreePath, 'any.txt'), 'content\n');

    const result = await tool.execute({ path: 'any.txt', start_line: 5, end_line: 3 }, context);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('end_line must be >= start_line');
  });

  it('rejects non-integer start_line', async () => {
    const registry = getRegistry();
    const tool = registry.get('read_file_range')!;

    writeFileSync(join(worktreePath, 'any.txt'), 'content\n');

    const result = await tool.execute({ path: 'any.txt', start_line: 1.5, end_line: 3 }, context);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('start_line must be an integer');
  });

  it('returns error for non-existent file', async () => {
    const registry = getRegistry();
    const tool = registry.get('read_file_range')!;

    const result = await tool.execute({ path: 'nope.txt', start_line: 1, end_line: 5 }, context);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('File not found');
  });

  it('blocks path that escapes worktree', async () => {
    const registry = getRegistry();
    const tool = registry.get('read_file_range')!;

    const result = await tool.execute({ path: '../../../etc/passwd', start_line: 1, end_line: 5 }, context);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('Invalid file path');
  });

  it('returns correct metadata with requested vs effective fields', async () => {
    const registry = getRegistry();
    const tool = registry.get('read_file_range')!;

    writeFileSync(join(worktreePath, 'meta.txt'), 'a\nb\nc\nd\ne\n');

    const result = await tool.execute({ path: 'meta.txt', start_line: 2, end_line: 10 }, context);
    expect(result.meta['requestedStartLine']).toBe(2);
    expect(result.meta['requestedEndLine']).toBe(10);
    expect(result.meta['effectiveStartLine']).toBe(2);
    expect(result.meta['effectiveEndLine']).toBe(5);
    expect(result.meta['totalLines']).toBe(5);
    expect(result.meta['linesReturned']).toBe(4);
    expect(result.meta['outOfBounds']).toBe(false);
  });

  it('truncates output when exceeding max read char limit', async () => {
    process.env['CONDUCTOR_MAX_READ_BYTES'] = '1000';
    const registry = getRegistry();
    const tool = registry.get('read_file_range')!;

    const bigContent = Array.from({ length: 500 }, (_, i) => `line ${i + 1} ${'x'.repeat(50)}`).join('\n') + '\n';
    writeFileSync(join(worktreePath, 'big.txt'), bigContent);

    const result = await tool.execute({ path: 'big.txt', start_line: 1, end_line: 500 }, context);
    expect(result.content).toContain('[...truncated]');
    expect(result.meta['truncated']).toBe(true);
    delete process.env['CONDUCTOR_MAX_READ_BYTES'];
  });

  it('returns totalLines: 0 for empty file', async () => {
    const registry = getRegistry();
    const tool = registry.get('read_file_range')!;

    writeFileSync(join(worktreePath, 'empty.txt'), '');

    const result = await tool.execute({ path: 'empty.txt', start_line: 1, end_line: 1 }, context);
    expect(result.meta['totalLines']).toBe(0);
    expect(result.meta['outOfBounds']).toBe(true);
    expect(result.meta['linesReturned']).toBe(0);
  });

  it('file with trailing newline has correct totalLines', async () => {
    const registry = getRegistry();
    const tool = registry.get('read_file_range')!;

    writeFileSync(join(worktreePath, 'trail.txt'), 'a\nb\n');

    const result = await tool.execute({ path: 'trail.txt', start_line: 1, end_line: 10 }, context);
    expect(result.meta['totalLines']).toBe(2);
  });

  it('outOfBounds is false for normal in-range requests', async () => {
    const registry = getRegistry();
    const tool = registry.get('read_file_range')!;

    writeFileSync(join(worktreePath, 'inrange.txt'), 'a\nb\nc\n');

    const result = await tool.execute({ path: 'inrange.txt', start_line: 1, end_line: 2 }, context);
    expect(result.meta['outOfBounds']).toBe(false);
  });

  it('effectiveStartLine <= effectiveEndLine always holds', async () => {
    const registry = getRegistry();
    const tool = registry.get('read_file_range')!;

    writeFileSync(join(worktreePath, 'inv.txt'), 'a\n');

    // Normal case
    const r1 = await tool.execute({ path: 'inv.txt', start_line: 1, end_line: 1 }, context);
    expect(r1.meta['effectiveStartLine']).toBeLessThanOrEqual(r1.meta['effectiveEndLine'] as number);

    // Out of bounds case
    const r2 = await tool.execute({ path: 'inv.txt', start_line: 10, end_line: 20 }, context);
    expect(r2.meta['effectiveStartLine']).toBeLessThanOrEqual(r2.meta['effectiveEndLine'] as number);
  });

  it('requestedStartLine/requestedEndLine always reflect original input', async () => {
    const registry = getRegistry();
    const tool = registry.get('read_file_range')!;

    writeFileSync(join(worktreePath, 'req.txt'), 'a\nb\n');

    const result = await tool.execute({ path: 'req.txt', start_line: 1, end_line: 999 }, context);
    expect(result.meta['requestedStartLine']).toBe(1);
    expect(result.meta['requestedEndLine']).toBe(999);
  });

  it('extractTarget returns path', () => {
    const registry = getRegistry();
    const tool = registry.get('read_file_range')!;

    expect(tool.extractTarget({ path: 'src/foo.ts', start_line: 1, end_line: 10 })).toBe('src/foo.ts');
  });
});

describe('search_in_file', () => {
  it('finds literal substring matches with line numbers', async () => {
    const registry = getRegistry();
    const tool = registry.get('search_in_file')!;

    writeFileSync(join(worktreePath, 'search.txt'), 'foo bar\nbaz foo\nqux\nfoo end\n');

    const result = await tool.execute({ path: 'search.txt', pattern: 'foo' }, context);
    expect(result.isError).toBeUndefined();
    expect(result.content).toContain('Found 3 match(es)');
    expect(result.content).toContain('1: foo bar');
    expect(result.content).toContain('2: baz foo');
    expect(result.content).toContain('4: foo end');
    expect(result.meta['totalMatches']).toBe(3);
    expect(result.meta['patternType']).toBe('literal');
  });

  it('finds regex matches when pattern uses /pattern/ delimiters', async () => {
    const registry = getRegistry();
    const tool = registry.get('search_in_file')!;

    writeFileSync(join(worktreePath, 'regex.txt'), 'abc 123\ndef 456\nghi\n');

    const result = await tool.execute({ path: 'regex.txt', pattern: '/\\d+/' }, context);
    expect(result.meta['patternType']).toBe('regex');
    expect(result.meta['totalMatches']).toBe(2);
  });

  it('falls back to literal on invalid regex inside delimiters', async () => {
    const registry = getRegistry();
    const tool = registry.get('search_in_file')!;

    // Pattern looks like regex but body is invalid
    writeFileSync(join(worktreePath, 'fallback.txt'), 'hello /[invalid/ world\nother\n');

    const result = await tool.execute({ path: 'fallback.txt', pattern: '/[invalid/' }, context);
    expect(result.meta['patternType']).toBe('literal');
    expect(result.meta['totalMatches']).toBe(1);
  });

  it('treats undelimited patterns as literal (. matches literal dot)', async () => {
    const registry = getRegistry();
    const tool = registry.get('search_in_file')!;

    writeFileSync(join(worktreePath, 'literal.txt'), 'file.ts\nfilets\n');

    const result = await tool.execute({ path: 'literal.txt', pattern: 'file.ts' }, context);
    expect(result.meta['patternType']).toBe('literal');
    // 'file.ts' literal matches first line only, not 'filets'
    expect(result.meta['totalMatches']).toBe(1);
  });

  it('regex with /g flag works correctly across multiple matching lines', async () => {
    const registry = getRegistry();
    const tool = registry.get('search_in_file')!;

    writeFileSync(join(worktreePath, 'gflag.txt'), 'match1\nmatch2\nmatch3\n');

    const result = await tool.execute({ path: 'gflag.txt', pattern: '/match/g' }, context);
    expect(result.meta['patternType']).toBe('regex');
    expect(result.meta['totalMatches']).toBe(3);
  });

  it('regex with escaped slash matches literal a/b', async () => {
    const registry = getRegistry();
    const tool = registry.get('search_in_file')!;

    writeFileSync(join(worktreePath, 'slash.txt'), 'a/b\nc/d\na/b again\n');

    const result = await tool.execute({ path: 'slash.txt', pattern: '/a\\/b/' }, context);
    expect(result.meta['patternType']).toBe('regex');
    expect(result.meta['totalMatches']).toBe(2);
  });

  it('pattern with invalid flag char treated as literal', async () => {
    const registry = getRegistry();
    const tool = registry.get('search_in_file')!;

    writeFileSync(join(worktreePath, 'badflag.txt'), '/foo/z\nother\n');

    // /foo/z — 'z' is not in [gimsuy], so regex delimiter doesn't match; treated as literal
    const result = await tool.execute({ path: 'badflag.txt', pattern: '/foo/z' }, context);
    expect(result.meta['patternType']).toBe('literal');
    expect(result.meta['totalMatches']).toBe(1);
  });

  it('rejects empty pattern', async () => {
    const registry = getRegistry();
    const tool = registry.get('search_in_file')!;

    writeFileSync(join(worktreePath, 'any.txt'), 'content\n');

    const result = await tool.execute({ path: 'any.txt', pattern: '' }, context);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('Pattern must not be empty');
  });

  it('respects max_matches limit with [...N more matches] note', async () => {
    const registry = getRegistry();
    const tool = registry.get('search_in_file')!;

    const lines = Array.from({ length: 50 }, (_, i) => `match line ${i + 1}`).join('\n') + '\n';
    writeFileSync(join(worktreePath, 'many.txt'), lines);

    const result = await tool.execute({ path: 'many.txt', pattern: 'match', max_matches: 5 }, context);
    expect(result.meta['returnedMatches']).toBe(5);
    expect(result.meta['totalMatches']).toBe(50);
    expect(result.content).toContain('[...45 more matches]');
  });

  it('clamps max_matches to [1, 200] range', async () => {
    const registry = getRegistry();
    const tool = registry.get('search_in_file')!;

    writeFileSync(join(worktreePath, 'clamp.txt'), 'a\n');

    // Above 200
    const r1 = await tool.execute({ path: 'clamp.txt', pattern: 'a', max_matches: 500 }, context);
    expect(r1.meta['effectiveMaxMatches']).toBe(200);
    expect(r1.meta['requestedMaxMatches']).toBe(500);

    // Below 1
    const r2 = await tool.execute({ path: 'clamp.txt', pattern: 'a', max_matches: -5 }, context);
    expect(r2.meta['effectiveMaxMatches']).toBe(1);
    expect(r2.meta['requestedMaxMatches']).toBe(-5);
  });

  it('rejects non-integer max_matches', async () => {
    const registry = getRegistry();
    const tool = registry.get('search_in_file')!;

    writeFileSync(join(worktreePath, 'any.txt'), 'content\n');

    const result = await tool.execute({ path: 'any.txt', pattern: 'content', max_matches: 2.5 }, context);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('max_matches must be an integer');
  });

  it('rejects non-number max_matches', async () => {
    const registry = getRegistry();
    const tool = registry.get('search_in_file')!;

    writeFileSync(join(worktreePath, 'any.txt'), 'content\n');

    const result = await tool.execute({ path: 'any.txt', pattern: 'content', max_matches: '5' as unknown as number }, context);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('max_matches must be an integer');
  });

  it('returns appropriate message when no matches found', async () => {
    const registry = getRegistry();
    const tool = registry.get('search_in_file')!;

    writeFileSync(join(worktreePath, 'nomatch.txt'), 'hello world\n');

    const result = await tool.execute({ path: 'nomatch.txt', pattern: 'zzz' }, context);
    expect(result.isError).toBeUndefined();
    expect(result.content).toContain('No matches found for "zzz"');
    expect(result.meta['totalMatches']).toBe(0);
  });

  it('returns error for non-existent file', async () => {
    const registry = getRegistry();
    const tool = registry.get('search_in_file')!;

    const result = await tool.execute({ path: 'missing.txt', pattern: 'foo' }, context);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('File not found');
  });

  it('blocks path that escapes worktree', async () => {
    const registry = getRegistry();
    const tool = registry.get('search_in_file')!;

    const result = await tool.execute({ path: '../../../etc/passwd', pattern: 'root' }, context);
    expect(result.isError).toBe(true);
  });

  it('requestedMaxMatches is null when max_matches omitted', async () => {
    const registry = getRegistry();
    const tool = registry.get('search_in_file')!;

    writeFileSync(join(worktreePath, 'nullreq.txt'), 'a\n');

    const result = await tool.execute({ path: 'nullreq.txt', pattern: 'a' }, context);
    expect(result.meta['requestedMaxMatches']).toBeNull();
    expect(result.meta['effectiveMaxMatches']).toBe(20);
  });

  it('truncates per-line snippets at 200 chars', async () => {
    const registry = getRegistry();
    const tool = registry.get('search_in_file')!;

    const longLine = 'x'.repeat(300);
    writeFileSync(join(worktreePath, 'longline.txt'), `${longLine}\n`);

    const result = await tool.execute({ path: 'longline.txt', pattern: 'x' }, context);
    // The output line should contain 200 x's + '...'
    expect(result.content).toContain('x'.repeat(200) + '...');
    expect(result.content).not.toContain('x'.repeat(201));
  });

  it('caps total output by resolveMaxReadBytes', async () => {
    process.env['CONDUCTOR_MAX_READ_BYTES'] = '1000';
    const registry = getRegistry();
    const tool = registry.get('search_in_file')!;

    const lines = Array.from({ length: 200 }, (_, i) => `match_line_${i}_${'y'.repeat(50)}`).join('\n') + '\n';
    writeFileSync(join(worktreePath, 'bigmatch.txt'), lines);

    const result = await tool.execute({ path: 'bigmatch.txt', pattern: 'match_line', max_matches: 200 }, context);
    expect(result.content).toContain('[...truncated]');
    delete process.env['CONDUCTOR_MAX_READ_BYTES'];
  });

  it('extractTarget returns path', () => {
    const registry = getRegistry();
    const tool = registry.get('search_in_file')!;

    expect(tool.extractTarget({ path: 'src/foo.ts', pattern: 'hello' })).toBe('src/foo.ts');
  });

  it('defaults max_matches to 20 when omitted', async () => {
    const registry = getRegistry();
    const tool = registry.get('search_in_file')!;

    const lines = Array.from({ length: 30 }, (_, i) => `match ${i}`).join('\n') + '\n';
    writeFileSync(join(worktreePath, 'default.txt'), lines);

    const result = await tool.execute({ path: 'default.txt', pattern: 'match' }, context);
    expect(result.meta['returnedMatches']).toBe(20);
    expect(result.meta['effectiveMaxMatches']).toBe(20);
    expect(result.meta['requestedMaxMatches']).toBeNull();
    expect(result.meta['totalMatches']).toBe(30);
  });

  it('empty file returns totalLines: 0 and totalMatches: 0', async () => {
    const registry = getRegistry();
    const tool = registry.get('search_in_file')!;

    writeFileSync(join(worktreePath, 'empty.txt'), '');

    const result = await tool.execute({ path: 'empty.txt', pattern: 'anything' }, context);
    expect(result.meta['totalLines']).toBe(0);
    expect(result.meta['totalMatches']).toBe(0);
  });

  it('file with trailing newline has totalLines: 2', async () => {
    const registry = getRegistry();
    const tool = registry.get('search_in_file')!;

    writeFileSync(join(worktreePath, 'trail.txt'), 'a\nb\n');

    const result = await tool.execute({ path: 'trail.txt', pattern: 'a' }, context);
    expect(result.meta['totalLines']).toBe(2);
  });
});

describe('registerFilesystemTools', () => {
  it('registers all six tools', () => {
    const registry = createToolRegistry();
    registerFilesystemTools(registry);

    expect(registry.has('read_file')).toBe(true);
    expect(registry.has('read_file_range')).toBe(true);
    expect(registry.has('search_in_file')).toBe(true);
    expect(registry.has('write_file')).toBe(true);
    expect(registry.has('delete_file')).toBe(true);
    expect(registry.has('list_files')).toBe(true);
    expect(registry.names()).toHaveLength(6);
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
