/**
 * Policy Evaluator Tests
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ToolExecutionContext } from './types.ts';
import {
  worktreeBoundaryRule,
  dotGitProtectionRule,
  sensitiveFileWriteRule,
  shellInjectionRule,
  planModeWriteBlockRule,
  evaluatePolicy,
  DEFAULT_POLICY_RULES,
  PLAN_MODE_POLICY_RULES,
} from './policy.ts';

function makeContext(worktreePath = '/tmp/worktree'): ToolExecutionContext {
  return {
    runId: 'run_test',
    agentInvocationId: 'ai_test',
    worktreePath,
    db: {} as ToolExecutionContext['db'],
    projectId: 'proj_test',
  };
}

describe('worktreeBoundaryRule', () => {
  it('blocks absolute paths', () => {
    const result = worktreeBoundaryRule.evaluate(
      'read_file',
      { path: '/etc/passwd' },
      makeContext()
    );
    expect(result?.decision).toBe('block');
  });

  it('blocks path traversal with ..', () => {
    const result = worktreeBoundaryRule.evaluate(
      'write_file',
      { path: '../../../etc/passwd' },
      makeContext()
    );
    expect(result?.decision).toBe('block');
  });

  it('allows valid paths within worktree', () => {
    const result = worktreeBoundaryRule.evaluate(
      'read_file',
      { path: 'src/main.ts' },
      makeContext()
    );
    expect(result).toBeNull();
  });

  it('returns null for non-path tools', () => {
    const result = worktreeBoundaryRule.evaluate(
      'run_tests',
      { command: 'npm test' },
      makeContext()
    );
    expect(result).toBeNull();
  });

  it('checks directory arg for list_files', () => {
    const result = worktreeBoundaryRule.evaluate(
      'list_files',
      { directory: '../secret' },
      makeContext()
    );
    expect(result?.decision).toBe('block');
  });

  it('blocks path traversal via read_file_range', () => {
    const result = worktreeBoundaryRule.evaluate(
      'read_file_range',
      { path: '../secret.txt', start_line: 1, end_line: 10 },
      makeContext()
    );
    expect(result?.decision).toBe('block');
  });

  it('allows valid path via read_file_range', () => {
    const result = worktreeBoundaryRule.evaluate(
      'read_file_range',
      { path: 'src/main.ts', start_line: 1, end_line: 10 },
      makeContext()
    );
    expect(result).toBeNull();
  });

  it('blocks path traversal via search_in_file', () => {
    const result = worktreeBoundaryRule.evaluate(
      'search_in_file',
      { path: '/etc/passwd', pattern: 'root' },
      makeContext()
    );
    expect(result?.decision).toBe('block');
  });

  it('allows valid path via search_in_file', () => {
    const result = worktreeBoundaryRule.evaluate(
      'search_in_file',
      { path: 'src/main.ts', pattern: 'hello' },
      makeContext()
    );
    expect(result).toBeNull();
  });

  describe('symlink escape detection', () => {
    let testWorktree: string;

    afterEach(() => {
      if (testWorktree) {
        rmSync(testWorktree, { recursive: true, force: true });
      }
    });

    it('blocks write through symlink dir to outside worktree (non-existent target)', () => {
      testWorktree = mkdtempSync(join(tmpdir(), 'conductor-policy-symlink-'));
      symlinkSync('/tmp', join(testWorktree, 'symlink_dir'));

      const result = worktreeBoundaryRule.evaluate(
        'write_file',
        { path: 'symlink_dir/new_file.txt', content: 'evil' },
        makeContext(testWorktree)
      );
      expect(result?.decision).toBe('block');
      expect(result?.reason).toContain('escapes worktree via symlink');
    });

    it('allows write through symlink dir pointing inside worktree', () => {
      testWorktree = mkdtempSync(join(tmpdir(), 'conductor-policy-symlink-'));
      mkdirSync(join(testWorktree, 'real_dir'), { recursive: true });
      symlinkSync(join(testWorktree, 'real_dir'), join(testWorktree, 'link_dir'));

      const result = worktreeBoundaryRule.evaluate(
        'write_file',
        { path: 'link_dir/new_file.txt', content: 'safe' },
        makeContext(testWorktree)
      );
      expect(result).toBeNull();
    });

    it('allows normal nested create (no symlinks)', () => {
      testWorktree = mkdtempSync(join(tmpdir(), 'conductor-policy-symlink-'));

      const result = worktreeBoundaryRule.evaluate(
        'write_file',
        { path: 'deep/nested/new.ts', content: 'code' },
        makeContext(testWorktree)
      );
      expect(result).toBeNull();
    });

    it('blocks existing file symlink escape', () => {
      testWorktree = mkdtempSync(join(tmpdir(), 'conductor-policy-symlink-'));
      const outsideDir = mkdtempSync(join(tmpdir(), 'conductor-outside-'));
      writeFileSync(join(outsideDir, 'secret.txt'), 'secret');
      symlinkSync(join(outsideDir, 'secret.txt'), join(testWorktree, 'link_to_secret.txt'));

      const result = worktreeBoundaryRule.evaluate(
        'read_file',
        { path: 'link_to_secret.txt' },
        makeContext(testWorktree)
      );
      expect(result?.decision).toBe('block');

      rmSync(outsideDir, { recursive: true, force: true });
    });
  });
});

describe('dotGitProtectionRule', () => {
  it('blocks .git directory access', () => {
    const result = dotGitProtectionRule.evaluate(
      'read_file',
      { path: '.git/config' },
      makeContext()
    );
    expect(result?.decision).toBe('block');
  });

  it('blocks .git itself', () => {
    const result = dotGitProtectionRule.evaluate(
      'list_files',
      { directory: '.git' },
      makeContext()
    );
    expect(result?.decision).toBe('block');
  });

  it('blocks nested .git path', () => {
    const result = dotGitProtectionRule.evaluate(
      'read_file',
      { path: 'sub/.git/config' },
      makeContext()
    );
    expect(result?.decision).toBe('block');
  });

  it('blocks .git access via read_file_range', () => {
    const result = dotGitProtectionRule.evaluate(
      'read_file_range',
      { path: '.git/config', start_line: 1, end_line: 5 },
      makeContext()
    );
    expect(result?.decision).toBe('block');
  });

  it('blocks .git access via search_in_file', () => {
    const result = dotGitProtectionRule.evaluate(
      'search_in_file',
      { path: '.git/config', pattern: 'url' },
      makeContext()
    );
    expect(result?.decision).toBe('block');
  });

  it('allows normal paths', () => {
    const result = dotGitProtectionRule.evaluate(
      'read_file',
      { path: 'src/git-utils.ts' },
      makeContext()
    );
    expect(result).toBeNull();
  });

  it('returns null for non-path tools', () => {
    const result = dotGitProtectionRule.evaluate(
      'run_tests',
      { command: 'npm test' },
      makeContext()
    );
    expect(result).toBeNull();
  });
});

describe('sensitiveFileWriteRule', () => {
  it('blocks writes to .env files', () => {
    const result = sensitiveFileWriteRule.evaluate(
      'write_file',
      { path: '.env', content: 'SECRET=value' },
      makeContext()
    );
    expect(result?.decision).toBe('block');
  });

  it('blocks writes to .pem files', () => {
    const result = sensitiveFileWriteRule.evaluate(
      'write_file',
      { path: 'certs/server.pem', content: '' },
      makeContext()
    );
    expect(result?.decision).toBe('block');
  });

  it('blocks delete of sensitive files', () => {
    const result = sensitiveFileWriteRule.evaluate(
      'delete_file',
      { path: 'credentials.json' },
      makeContext()
    );
    expect(result?.decision).toBe('block');
  });

  it('allows writes to normal files', () => {
    const result = sensitiveFileWriteRule.evaluate(
      'write_file',
      { path: 'src/main.ts', content: 'code' },
      makeContext()
    );
    expect(result).toBeNull();
  });

  it('returns null for read operations', () => {
    const result = sensitiveFileWriteRule.evaluate(
      'read_file',
      { path: '.env' },
      makeContext()
    );
    expect(result).toBeNull();
  });
});

describe('shellInjectionRule', () => {
  it('blocks commands with semicolons', () => {
    const result = shellInjectionRule.evaluate(
      'run_tests',
      { command: 'npm test; rm -rf /' },
      makeContext()
    );
    expect(result?.decision).toBe('block');
  });

  it('blocks commands with pipe', () => {
    const result = shellInjectionRule.evaluate(
      'run_tests',
      { command: 'npm test | tee output' },
      makeContext()
    );
    expect(result?.decision).toBe('block');
  });

  it('blocks commands with backticks', () => {
    const result = shellInjectionRule.evaluate(
      'run_tests',
      { command: 'npm test `whoami`' },
      makeContext()
    );
    expect(result?.decision).toBe('block');
  });

  it('blocks commands with $() substitution', () => {
    const result = shellInjectionRule.evaluate(
      'run_tests',
      { command: 'npm test $(whoami)' },
      makeContext()
    );
    expect(result?.decision).toBe('block');
  });

  it('allows clean test commands', () => {
    const result = shellInjectionRule.evaluate(
      'run_tests',
      { command: 'npm test -- --coverage' },
      makeContext()
    );
    expect(result).toBeNull();
  });

  it('returns null for non-test tools', () => {
    const result = shellInjectionRule.evaluate(
      'read_file',
      { path: 'test.ts' },
      makeContext()
    );
    expect(result).toBeNull();
  });
});

describe('planModeWriteBlockRule', () => {
  it('blocks write_file in plan mode', () => {
    const result = planModeWriteBlockRule.evaluate(
      'write_file',
      { path: 'src/main.ts', content: 'code' },
      makeContext()
    );
    expect(result?.decision).toBe('block');
    expect(result?.policyId).toBe('plan_mode_write_block');
  });

  it('blocks delete_file in plan mode', () => {
    const result = planModeWriteBlockRule.evaluate(
      'delete_file',
      { path: 'src/old.ts' },
      makeContext()
    );
    expect(result?.decision).toBe('block');
    expect(result?.policyId).toBe('plan_mode_write_block');
  });

  it('allows read_file in plan mode', () => {
    const result = planModeWriteBlockRule.evaluate(
      'read_file',
      { path: 'src/main.ts' },
      makeContext()
    );
    expect(result).toBeNull();
  });

  it('allows run_tests in plan mode', () => {
    const result = planModeWriteBlockRule.evaluate(
      'run_tests',
      { command: 'npm test' },
      makeContext()
    );
    expect(result).toBeNull();
  });

  it('allows list_files in plan mode', () => {
    const result = planModeWriteBlockRule.evaluate(
      'list_files',
      { directory: 'src' },
      makeContext()
    );
    expect(result).toBeNull();
  });

  it('allows search_in_file in plan mode', () => {
    const result = planModeWriteBlockRule.evaluate(
      'search_in_file',
      { path: 'src/main.ts', pattern: 'hello' },
      makeContext()
    );
    expect(result).toBeNull();
  });
});

describe('PLAN_MODE_POLICY_RULES', () => {
  it('includes all default rules plus planModeWriteBlockRule', () => {
    expect(PLAN_MODE_POLICY_RULES).toHaveLength(DEFAULT_POLICY_RULES.length + 1);
    const ids = PLAN_MODE_POLICY_RULES.map(r => r.policyId);
    expect(ids).toContain('worktree_boundary');
    expect(ids).toContain('dotgit_protection');
    expect(ids).toContain('sensitive_file_write');
    expect(ids).toContain('shell_injection');
    expect(ids).toContain('plan_mode_write_block');
  });

  it('planModeWriteBlockRule is last (security rules fire first for forensic clarity)', () => {
    const lastRule = PLAN_MODE_POLICY_RULES[PLAN_MODE_POLICY_RULES.length - 1];
    expect(lastRule?.policyId).toBe('plan_mode_write_block');
  });

  it('blocks writes to sensitive files with sensitive_file_write (not plan_mode_write_block)', () => {
    const result = evaluatePolicy(
      PLAN_MODE_POLICY_RULES,
      'write_file',
      { path: '.env', content: 'SECRET=x' },
      makeContext()
    );
    expect(result.decision).toBe('block');
    // sensitive_file_write should fire before plan_mode_write_block
    expect(result.policyId).toBe('sensitive_file_write');
  });

  it('blocks normal writes with plan_mode_write_block', () => {
    const result = evaluatePolicy(
      PLAN_MODE_POLICY_RULES,
      'write_file',
      { path: 'src/main.ts', content: 'code' },
      makeContext()
    );
    expect(result.decision).toBe('block');
    expect(result.policyId).toBe('plan_mode_write_block');
  });
});

describe('evaluatePolicy', () => {
  it('returns allow when no rules block', () => {
    const result = evaluatePolicy(
      DEFAULT_POLICY_RULES,
      'read_file',
      { path: 'src/main.ts' },
      makeContext()
    );
    expect(result.decision).toBe('allow');
  });

  it('returns first block (short-circuits)', () => {
    const result = evaluatePolicy(
      DEFAULT_POLICY_RULES,
      'write_file',
      { path: '.git/config', content: 'bad' },
      makeContext()
    );
    // worktree_boundary or dotgit_protection — either is valid as first block
    expect(result.decision).toBe('block');
    expect(result.policyId).toBeDefined();
  });

  it('returns allow with empty rule set', () => {
    const result = evaluatePolicy(
      [],
      'write_file',
      { path: '.env', content: 'SECRET=x' },
      makeContext()
    );
    expect(result.decision).toBe('allow');
  });

  it('blocks sensitive file write with default rules', () => {
    const result = evaluatePolicy(
      DEFAULT_POLICY_RULES,
      'write_file',
      { path: 'config/.env.production', content: '' },
      makeContext()
    );
    expect(result.decision).toBe('block');
    expect(result.policyId).toBe('sensitive_file_write');
  });
});
