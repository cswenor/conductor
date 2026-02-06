/**
 * Plan Approval Gate Evaluator Tests
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Database as DatabaseType } from 'better-sqlite3';
import { initDatabase, closeDatabase } from '../../db/index.js';
import { createRun, getRun, type Run } from '../../runs/index.js';
import { createArtifact, updateValidationStatus } from '../../agent-runtime/artifacts.js';
import { createToolInvocation, completeToolInvocation } from '../../agent-runtime/tool-invocations.js';
import { ensureBuiltInPolicyDefinitions } from '../../agent-runtime/policy-definitions.js';
import { ensureBuiltInGateDefinitions } from '../gate-definitions.js';
import { recordOperatorAction } from '../../operator-actions/index.js';
import { evaluatePlanApproval } from './plan-approval.js';

let db: DatabaseType;

function seedTestData(database: DatabaseType): {
  run: Run;
  projectId: string;
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

  // Set to awaiting_plan_approval for operator action validation
  database.prepare(
    'UPDATE runs SET phase = ?, updated_at = ? WHERE run_id = ?'
  ).run('awaiting_plan_approval', now, run.runId);

  const updatedRun = getRun(database, run.runId);

  return { run: updatedRun ?? run, projectId };
}

function createValidPlan(database: DatabaseType, runId: string): void {
  const art = createArtifact(database, {
    runId,
    type: 'plan',
    contentMarkdown: '# Plan\n\nDo the thing.',
    createdBy: 'planner',
  });
  updateValidationStatus(database, art.artifactId, 'valid');
}

/**
 * Create a validated review artifact with a source tool invocation.
 * The tool invocation's resultMetaJson contains a structured verdict field.
 */
function createValidReview(
  database: DatabaseType,
  runId: string,
  options?: { verdict?: string; content?: string },
): void {
  const verdict = options?.verdict ?? 'approved';
  const content = options?.content ?? '# Review\n\nApproved.';

  // Need agent_invocation for FK chain
  const agentInvId = `ai_test_${Date.now().toString(36)}${Math.random().toString(36).substring(2, 6)}`;
  const now = new Date().toISOString();
  database.prepare(`
    INSERT INTO agent_invocations (
      agent_invocation_id, run_id, agent, action, status,
      tokens_input, tokens_output, started_at
    ) VALUES (?, ?, 'reviewer', 'review_plan', 'completed', 0, 0, ?)
  `).run(agentInvId, runId, now);

  // Create tool invocation with structured verdict in resultMetaJson
  const toolInv = createToolInvocation(database, {
    agentInvocationId: agentInvId,
    runId,
    tool: 'review_plan',
    argsRedactedJson: '{}',
    argsFieldsRemovedJson: '[]',
    argsSecretsDetected: false,
    argsPayloadHash: 'test',
    argsPayloadHashScheme: 'sha256',
    policyDecision: 'allow',
    policyId: 'worktree_boundary',
  });

  completeToolInvocation(database, toolInv.toolInvocationId, {
    resultMeta: { verdict },
    durationMs: 100,
  });

  const art = createArtifact(database, {
    runId,
    type: 'review',
    contentMarkdown: content,
    sourceToolInvocationId: toolInv.toolInvocationId,
    createdBy: 'reviewer',
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

describe('evaluatePlanApproval', () => {
  it('returns pending when no artifacts exist', () => {
    const { run } = seedTestData(db);
    const result = evaluatePlanApproval(db, run);
    expect(result.status).toBe('pending');
    expect(result.reason).toContain('plan artifact');
  });

  it('returns pending when PLAN valid but no REVIEW', () => {
    const { run } = seedTestData(db);
    createValidPlan(db, run.runId);

    const result = evaluatePlanApproval(db, run);
    expect(result.status).toBe('pending');
    expect(result.reason).toContain('review artifact');
  });

  it('returns pending when PLAN has validation_status=pending', () => {
    const { run } = seedTestData(db);
    // Create plan but don't validate it (stays pending)
    createArtifact(db, {
      runId: run.runId,
      type: 'plan',
      contentMarkdown: '# Plan',
      createdBy: 'planner',
    });
    createValidReview(db, run.runId);

    const result = evaluatePlanApproval(db, run);
    expect(result.status).toBe('pending');
    expect(result.reason).toContain('plan artifact');
  });

  it('returns pending when PLAN has validation_status=invalid', () => {
    const { run } = seedTestData(db);
    const art = createArtifact(db, {
      runId: run.runId,
      type: 'plan',
      contentMarkdown: '# Bad Plan',
      createdBy: 'planner',
    });
    updateValidationStatus(db, art.artifactId, 'invalid', 'Missing sections');
    createValidReview(db, run.runId);

    const result = evaluatePlanApproval(db, run);
    expect(result.status).toBe('pending');
    expect(result.reason).toContain('plan artifact');
  });

  it('returns pending when both artifacts valid but no action (awaiting operator)', () => {
    const { run } = seedTestData(db);
    createValidPlan(db, run.runId);
    createValidReview(db, run.runId);

    const result = evaluatePlanApproval(db, run);
    expect(result.status).toBe('pending');
    expect(result.reason).toContain('operator approval');
  });

  it('returns passed when both artifacts valid and approve_plan action exists', () => {
    const { run } = seedTestData(db);
    createValidPlan(db, run.runId);
    createValidReview(db, run.runId);

    recordOperatorAction(db, {
      runId: run.runId,
      action: 'approve_plan',
      actorId: 'user_test',
      actorType: 'operator',
      comment: 'Looks good',
    });

    const result = evaluatePlanApproval(db, run);
    expect(result.status).toBe('passed');
    expect(result.reason).toContain('approved');
  });

  it('returns failed when reject_run action exists', () => {
    const { run } = seedTestData(db);
    createValidPlan(db, run.runId);
    createValidReview(db, run.runId);

    recordOperatorAction(db, {
      runId: run.runId,
      action: 'reject_run',
      actorId: 'user_test',
      actorType: 'operator',
      comment: 'Plan is inadequate',
    });

    const result = evaluatePlanApproval(db, run);
    expect(result.status).toBe('failed');
    expect(result.reason).toContain('inadequate');
  });

  it('returns pending when review verdict is changes_requested', () => {
    const { run } = seedTestData(db);
    createValidPlan(db, run.runId);
    createValidReview(db, run.runId, { verdict: 'changes_requested' });

    const result = evaluatePlanApproval(db, run);
    expect(result.status).toBe('pending');
    expect(result.reason).toContain('changes');
  });
});
