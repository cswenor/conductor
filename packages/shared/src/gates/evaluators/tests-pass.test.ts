/**
 * Tests Pass Gate Evaluator Tests
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Database as DatabaseType } from 'better-sqlite3';
import { initDatabase, closeDatabase } from '../../db/index.ts';
import { createRun, getRun, type Run } from '../../runs/index.ts';
import { createArtifact, updateValidationStatus } from '../../agent-runtime/artifacts.ts';
import { createAgentInvocation } from '../../agent-runtime/invocations.ts';
import { createToolInvocation, completeToolInvocation, failToolInvocation } from '../../agent-runtime/tool-invocations.ts';
import { ensureBuiltInPolicyDefinitions } from '../../agent-runtime/policy-definitions.ts';
import { ensureBuiltInGateDefinitions } from '../gate-definitions.ts';
import { evaluateTestsPass, getTestExecutionTruth } from './tests-pass.ts';

let db: DatabaseType;

function seedTestData(database: DatabaseType): {
  run: Run;
  runId: string;
  agentInvocationId: string;
} {
  const now = new Date().toISOString();
  const userId = 'user_test';
  const projectId = 'proj_test';
  const repoId = 'repo_test';
  const taskId = 'task_test';

  database.prepare(`
    INSERT OR IGNORE INTO users (user_id, github_id, github_node_id, github_login, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'active', ?, ?)
  `).run(userId, 100, 'U_test', 'testuser', now, now);

  database.prepare(`
    INSERT INTO projects (
      project_id, user_id, name, github_org_id, github_org_node_id, github_org_name,
      github_installation_id, default_profile_id, default_base_branch,
      port_range_start, port_range_end, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(projectId, userId, 'Test Project', 1, 'O_test', 'testorg',
    12345, 'default', 'main', 3100, 3199, now, now);

  database.prepare(`
    INSERT INTO repos (
      repo_id, project_id, github_node_id, github_numeric_id,
      github_owner, github_name, github_full_name, github_default_branch,
      profile_id, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(repoId, projectId, 'R_test', 100,
    'testowner', 'testrepo', 'testowner/testrepo', 'main',
    'default', 'active', now, now);

  database.prepare(`
    INSERT INTO tasks (
      task_id, project_id, repo_id, github_node_id, github_issue_number,
      github_type, github_title, github_body, github_state, github_labels_json,
      github_synced_at, created_at, updated_at, last_activity_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(taskId, projectId, repoId, 'I_test', 42,
    'issue', 'Test Task', 'Body', 'open', '[]',
    now, now, now, now);

  const run = createRun(database, { taskId, projectId, repoId, baseBranch: 'main' });

  // Set phase to executing for test context
  database.prepare(
    'UPDATE runs SET phase = ?, updated_at = ? WHERE run_id = ?'
  ).run('executing', now, run.runId);

  const inv = createAgentInvocation(database, {
    runId: run.runId,
    agent: 'tester',
    action: 'run_tests',
  });

  const updatedRun = getRun(database, run.runId);

  return {
    run: updatedRun ?? run,
    runId: run.runId,
    agentInvocationId: inv.agentInvocationId,
  };
}

/**
 * Create a validated test report with a linked tool invocation.
 */
function createTestReport(
  database: DatabaseType,
  runId: string,
  agentInvocationId: string,
  exitCode: number,
  agentResult: string,
): void {
  // Create tool invocation for the test run
  const toolInv = createToolInvocation(database, {
    agentInvocationId,
    runId,
    tool: 'run_tests',
    target: 'npm test',
    argsRedactedJson: '{"command":"npm test"}',
    argsFieldsRemovedJson: '[]',
    argsSecretsDetected: false,
    argsPayloadHash: 'test_hash',
    argsPayloadHashScheme: 'sha256:cjson:v1',
    policyDecision: 'allow',
  });

  // Complete or fail the tool invocation
  if (exitCode === 0) {
    completeToolInvocation(database, toolInv.toolInvocationId, {
      resultMeta: { exitCode, result: agentResult },
      durationMs: 1000,
    });
  } else {
    failToolInvocation(database, toolInv.toolInvocationId, {
      resultMeta: { exitCode, result: agentResult },
      durationMs: 1000,
    });
  }

  // Create artifact linked to tool invocation
  const art = createArtifact(database, {
    runId,
    type: 'test_report',
    contentMarkdown: `# Test Report\nResult: ${agentResult}\nExit code: ${exitCode}`,
    sourceToolInvocationId: toolInv.toolInvocationId,
    createdBy: 'tester',
  });
  updateValidationStatus(database, art.artifactId, 'valid');
}

beforeEach(() => {
  db = initDatabase({ path: ':memory:' });
  ensureBuiltInGateDefinitions(db);
  ensureBuiltInPolicyDefinitions(db);
});

afterEach(() => {
  closeDatabase(db);
});

describe('evaluateTestsPass', () => {
  it('returns pending when no test report exists', () => {
    const { run } = seedTestData(db);
    const result = evaluateTestsPass(db, run);
    expect(result.status).toBe('pending');
    expect(result.reason).toContain('not yet run');
  });

  it('returns passed when test report shows pass (exit code 0)', () => {
    const { run, runId, agentInvocationId } = seedTestData(db);
    createTestReport(db, runId, agentInvocationId, 0, 'pass');

    const result = evaluateTestsPass(db, run);
    expect(result.status).toBe('passed');
    expect(result.reason).toContain('passed');
  });

  it('returns pending with retry when tests fail and attempts < max', () => {
    const { run, runId, agentInvocationId } = seedTestData(db);
    createTestReport(db, runId, agentInvocationId, 1, 'fail');

    const result = evaluateTestsPass(db, run);
    expect(result.status).toBe('pending');
    expect(result.reason).toContain('retry');
    expect(result.reason).toContain('1/3');
  });

  it('returns failed with escalate when retries exhausted', () => {
    const { runId, agentInvocationId } = seedTestData(db);

    // Set test_fix_attempts to max (3)
    db.prepare('UPDATE runs SET test_fix_attempts = ? WHERE run_id = ?').run(3, runId);
    const run = getRun(db, runId);

    createTestReport(db, runId, agentInvocationId, 1, 'fail');

    const result = evaluateTestsPass(db, run ?? ({} as never));
    expect(result.status).toBe('failed');
    expect(result.reason).toContain('3 attempts');
    expect(result.escalate).toBe(true);
  });

  it('uses exit code truth when agent claims pass but exit code != 0', () => {
    const { run, runId, agentInvocationId } = seedTestData(db);
    // Agent claims pass but exit code is 1 (truth: failed)
    createTestReport(db, runId, agentInvocationId, 1, 'pass');

    const result = evaluateTestsPass(db, run);
    // Should use actual exit code, not agent claim
    expect(result.status).not.toBe('passed');
  });

  it('returns passed when skip_tests override is active', () => {
    const { run, runId } = seedTestData(db);
    const now = new Date().toISOString();

    // Insert a skip_tests override directly
    db.prepare(`
      INSERT INTO overrides (
        override_id, run_id, kind, target_id, scope,
        operator, justification, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run('ov_test1', runId, 'skip_tests', 'tests_pass', 'this_run',
      'user_test', 'Flaky tests in CI', now);

    const result = evaluateTestsPass(db, run);
    expect(result.status).toBe('passed');
    expect(result.reason).toContain('skip_tests');
    expect(result.reason).toContain('user_test');
  });

  it('ignores expired skip_tests override', () => {
    const { run, runId } = seedTestData(db);
    const expired = new Date(Date.now() - 86400000).toISOString(); // yesterday

    // Insert an expired override
    db.prepare(`
      INSERT INTO overrides (
        override_id, run_id, kind, target_id, scope,
        operator, justification, expires_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run('ov_expired', runId, 'skip_tests', 'tests_pass', 'this_run',
      'user_test', 'Expired override', expired, expired);

    const result = evaluateTestsPass(db, run);
    expect(result.status).toBe('pending');
    expect(result.reason).toContain('not yet run');
  });
});

describe('getTestExecutionTruth', () => {
  it('returns truth from tool invocation exit code', () => {
    const { runId, agentInvocationId } = seedTestData(db);

    const toolInv = createToolInvocation(db, {
      agentInvocationId,
      runId,
      tool: 'run_tests',
      argsRedactedJson: '{}',
      argsFieldsRemovedJson: '[]',
      argsSecretsDetected: false,
      argsPayloadHash: 'hash',
      argsPayloadHashScheme: 'sha256:cjson:v1',
      policyDecision: 'allow',
    });

    completeToolInvocation(db, toolInv.toolInvocationId, {
      resultMeta: { exitCode: 0, result: 'pass' },
      durationMs: 500,
    });

    const truth = getTestExecutionTruth(db, toolInv.toolInvocationId);
    expect(truth).not.toBeNull();
    expect(truth?.actualPassed).toBe(true);
    expect(truth?.exitCode).toBe(0);
    expect(truth?.agentResult).toBe('pass');
  });

  it('returns null for non-existent invocation', () => {
    expect(getTestExecutionTruth(db, 'ti_nonexistent')).toBeNull();
  });
});
