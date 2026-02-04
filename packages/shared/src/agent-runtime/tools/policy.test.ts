/**
 * Policy Evaluator Tests
 */

import { describe, it, expect } from 'vitest';
import type { ToolExecutionContext } from './types.js';
import {
  worktreeBoundaryRule,
  dotGitProtectionRule,
  sensitiveFileWriteRule,
  shellInjectionRule,
  evaluatePolicy,
  DEFAULT_POLICY_RULES,
} from './policy.js';

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
