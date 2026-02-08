/**
 * Implementer Agent Tests
 *
 * Tests file operation parsing, path validation, and file application.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  isValidFilePath,
  parseFileOperations,
  applyFileOperations,
  type FileOperation,
} from './implementer.ts';

let testDir: string;

function createTestDir(): string {
  testDir = join(tmpdir(), `conductor-impl-test-${Date.now()}`);
  mkdirSync(testDir, { recursive: true });
  // Create an existing file to test edit detection
  mkdirSync(join(testDir, 'src'), { recursive: true });
  writeFileSync(join(testDir, 'src/existing.ts'), 'old content');
  return testDir;
}

afterEach(() => {
  if (testDir) {
    try { rmSync(testDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

// =============================================================================
// isValidFilePath
// =============================================================================

describe('isValidFilePath', () => {
  it('accepts normal relative paths', () => {
    expect(isValidFilePath('src/index.ts')).toBe(true);
    expect(isValidFilePath('README.md')).toBe(true);
    expect(isValidFilePath('packages/shared/src/types.ts')).toBe(true);
  });

  it('rejects absolute paths', () => {
    expect(isValidFilePath('/etc/passwd')).toBe(false);
    expect(isValidFilePath('/home/user/file.txt')).toBe(false);
  });

  it('rejects path traversal', () => {
    expect(isValidFilePath('../../etc/passwd')).toBe(false);
    expect(isValidFilePath('../secret.txt')).toBe(false);
    expect(isValidFilePath('src/../../etc/passwd')).toBe(false);
  });

  it('rejects .git directory access', () => {
    expect(isValidFilePath('.git/config')).toBe(false);
    expect(isValidFilePath('.git/HEAD')).toBe(false);
    expect(isValidFilePath('path/.git/config')).toBe(false);
  });
});

// =============================================================================
// parseFileOperations
// =============================================================================

describe('parseFileOperations', () => {
  it('parses FILE blocks into create operations for new files', () => {
    const wt = createTestDir();
    const content = `
Here are the changes:

=== FILE: src/new-file.ts ===
export function hello() {
  return 'world';
}
=== END FILE ===
`;

    const ops = parseFileOperations(content, wt);
    expect(ops).toHaveLength(1);
    expect(ops[0]?.op).toBe('create');
    expect(ops[0]?.path).toBe('src/new-file.ts');
    expect(ops[0] !== undefined && 'content' in ops[0] && ops[0].content).toContain('hello');
  });

  it('parses FILE blocks into edit operations for existing files', () => {
    const wt = createTestDir();
    const content = `
=== FILE: src/existing.ts ===
export const updated = true;
=== END FILE ===
`;

    const ops = parseFileOperations(content, wt);
    expect(ops).toHaveLength(1);
    expect(ops[0]?.op).toBe('edit');
    expect(ops[0]?.path).toBe('src/existing.ts');
  });

  it('parses DELETE blocks', () => {
    const wt = createTestDir();
    const content = `
=== DELETE: src/old-file.ts ===
`;

    const ops = parseFileOperations(content, wt);
    expect(ops).toHaveLength(1);
    expect(ops[0]?.op).toBe('delete');
    expect(ops[0]?.path).toBe('src/old-file.ts');
  });

  it('parses multiple operations', () => {
    const wt = createTestDir();
    const content = `
=== FILE: src/new.ts ===
new content
=== END FILE ===

=== FILE: src/existing.ts ===
updated content
=== END FILE ===

=== DELETE: src/removed.ts ===
`;

    const ops = parseFileOperations(content, wt);
    expect(ops).toHaveLength(3);
    expect(ops[0]?.op).toBe('create');
    expect(ops[1]?.op).toBe('edit');
    expect(ops[2]?.op).toBe('delete');
  });

  it('rejects path traversal attempts', () => {
    const wt = createTestDir();
    const content = `
=== FILE: ../../etc/passwd ===
malicious content
=== END FILE ===
`;

    const ops = parseFileOperations(content, wt);
    expect(ops).toHaveLength(0);
  });

  it('rejects absolute paths', () => {
    const wt = createTestDir();
    const content = `
=== FILE: /etc/passwd ===
malicious content
=== END FILE ===
`;

    const ops = parseFileOperations(content, wt);
    expect(ops).toHaveLength(0);
  });

  it('rejects .git directory operations', () => {
    const wt = createTestDir();
    const content = `
=== FILE: .git/config ===
malicious content
=== END FILE ===
`;

    const ops = parseFileOperations(content, wt);
    expect(ops).toHaveLength(0);
  });
});

// =============================================================================
// applyFileOperations
// =============================================================================

describe('applyFileOperations', () => {
  it('creates new files', () => {
    const wt = createTestDir();
    const ops: FileOperation[] = [
      { op: 'create', path: 'src/new.ts', content: 'new file content' },
    ];

    applyFileOperations(wt, ops);

    const content = readFileSync(join(wt, 'src/new.ts'), 'utf8');
    expect(content).toBe('new file content');
  });

  it('creates parent directories as needed', () => {
    const wt = createTestDir();
    const ops: FileOperation[] = [
      { op: 'create', path: 'deep/nested/dir/file.ts', content: 'content' },
    ];

    applyFileOperations(wt, ops);
    expect(existsSync(join(wt, 'deep/nested/dir/file.ts'))).toBe(true);
  });

  it('edits existing files', () => {
    const wt = createTestDir();
    const ops: FileOperation[] = [
      { op: 'edit', path: 'src/existing.ts', content: 'updated content' },
    ];

    applyFileOperations(wt, ops);

    const content = readFileSync(join(wt, 'src/existing.ts'), 'utf8');
    expect(content).toBe('updated content');
  });

  it('deletes files', () => {
    const wt = createTestDir();
    expect(existsSync(join(wt, 'src/existing.ts'))).toBe(true);

    const ops: FileOperation[] = [
      { op: 'delete', path: 'src/existing.ts' },
    ];

    applyFileOperations(wt, ops);
    expect(existsSync(join(wt, 'src/existing.ts'))).toBe(false);
  });

  it('refuses paths outside worktree', () => {
    const wt = createTestDir();
    const ops: FileOperation[] = [
      { op: 'create', path: '../../etc/evil', content: 'evil' },
    ];

    expect(() => applyFileOperations(wt, ops)).toThrow('Invalid file path');
  });
});
