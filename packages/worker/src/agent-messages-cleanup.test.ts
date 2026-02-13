/**
 * Tests for the agent_messages cleanup wiring.
 *
 * Tests both:
 *   1. The CleanupJobData type accepts 'agent_messages'
 *   2. pruneAgentMessages works correctly via @conductor/shared
 *   3. dispatchDbCleanup correctly routes 'agent_messages' to pruneAgentMessages
 *      (verifies the switch-case wiring in the actual worker dispatch path)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  initDatabase,
  closeDatabase,
  createRun,
  createAgentInvocation,
  markAgentRunning,
  createAgentMessage,
  pruneAgentMessages,
  type CleanupJobData,
} from '@conductor/shared';
import { dispatchDbCleanup } from './cleanup-dispatch.ts';

type Db = ReturnType<typeof initDatabase>;
let db: Db;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function seedTestData(database: Db) {
  const now = new Date().toISOString();
  const userId = 'user_amcleanup';
  const projectId = 'proj_amcleanup';
  const repoId = 'repo_amcleanup';
  const taskId = 'task_amcleanup';

  database.prepare(`
    INSERT OR IGNORE INTO users (user_id, github_id, github_node_id, github_login, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'active', ?, ?)
  `).run(userId, 800, 'U_amcleanup', 'amcleanupuser', now, now);

  database.prepare(`
    INSERT INTO projects (
      project_id, user_id, name, github_org_id, github_org_node_id, github_org_name,
      github_installation_id, default_profile_id, default_base_branch,
      port_range_start, port_range_end, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    projectId, userId, 'AM Cleanup Project', 800, 'O_amcleanup', 'amcleanuporg',
    800, 'default', 'main', 3000, 3100, now, now,
  );

  database.prepare(`
    INSERT INTO repos (
      repo_id, project_id, github_node_id, github_numeric_id,
      github_owner, github_name, github_full_name, github_default_branch,
      profile_id, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    repoId, projectId, 'R_amcleanup', 800,
    'amcleanupowner', 'amcleanrepo', 'amcleanupowner/amcleanrepo', 'main',
    'default', 'active', now, now,
  );

  database.prepare(`
    INSERT INTO tasks (
      task_id, project_id, repo_id, github_node_id, github_issue_number,
      github_type, github_title, github_body, github_state, github_labels_json,
      github_synced_at, created_at, updated_at, last_activity_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    taskId, projectId, repoId, 'I_amcleanup', 1,
    'issue', 'AM Cleanup Task', 'Body', 'open', '[]',
    now, now, now, now,
  );

  const run = createRun(database, {
    taskId,
    projectId,
    repoId,
    baseBranch: 'main',
  });

  const inv = createAgentInvocation(database, {
    runId: run.runId,
    agent: 'planner',
    action: 'create_plan',
  });
  markAgentRunning(database, inv.agentInvocationId);

  return { runId: run.runId, agentInvocationId: inv.agentInvocationId };
}

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  db = initDatabase({ path: ':memory:' });
});

afterEach(() => {
  closeDatabase(db);
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('agent_messages cleanup wiring', () => {
  it('CleanupJobData type accepts agent_messages', () => {
    // Type-level check: this must compile without error
    const jobData: CleanupJobData = { type: 'agent_messages' };
    expect(jobData.type).toBe('agent_messages');
  });

  it('pruneAgentMessages is importable and callable from @conductor/shared', () => {
    expect(typeof pruneAgentMessages).toBe('function');
  });

  it('pruneAgentMessages with 30-day retention deletes old messages and keeps recent ones', () => {
    const { agentInvocationId } = seedTestData(db);

    // Create a recent message (should be kept)
    const recentMsg = createAgentMessage(db, {
      agentInvocationId,
      turnIndex: 0,
      role: 'user',
      contentJson: '"recent message"',
    });

    // Create a message and backdate it to 60 days ago (should be pruned)
    const oldMsg = createAgentMessage(db, {
      agentInvocationId,
      turnIndex: 1,
      role: 'assistant',
      contentJson: '"old message"',
    });
    db.prepare(
      `UPDATE agent_messages SET created_at = datetime('now', '-60 days') WHERE agent_message_id = ?`,
    ).run(oldMsg.agentMessageId);

    // Call with 30-day retention — matching the worker's hardcoded value
    const pruned = pruneAgentMessages(db, 30);

    expect(pruned).toBe(1);

    // Verify the recent message remains
    const remaining = db
      .prepare('SELECT agent_message_id FROM agent_messages')
      .all() as { agent_message_id: string }[];
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.agent_message_id).toBe(recentMsg.agentMessageId);
  });

  it('pruneAgentMessages returns 0 when no messages are older than retention', () => {
    const { agentInvocationId } = seedTestData(db);

    // Insert only recent messages
    createAgentMessage(db, {
      agentInvocationId,
      turnIndex: 0,
      role: 'user',
      contentJson: '"message 1"',
    });
    createAgentMessage(db, {
      agentInvocationId,
      turnIndex: 1,
      role: 'assistant',
      contentJson: '"message 2"',
    });

    const pruned = pruneAgentMessages(db, 30);

    expect(pruned).toBe(0);

    const remaining = db
      .prepare('SELECT COUNT(*) as count FROM agent_messages')
      .get() as { count: number };
    expect(remaining.count).toBe(2);
  });

  it('pruneAgentMessages respects the maxAgeDays parameter', () => {
    const { agentInvocationId } = seedTestData(db);

    // Create a message and backdate it to 10 days ago
    const msg = createAgentMessage(db, {
      agentInvocationId,
      turnIndex: 0,
      role: 'user',
      contentJson: '"10-day-old message"',
    });
    db.prepare(
      `UPDATE agent_messages SET created_at = datetime('now', '-10 days') WHERE agent_message_id = ?`,
    ).run(msg.agentMessageId);

    // With 30-day retention, it should NOT be pruned
    const prunedWith30 = pruneAgentMessages(db, 30);
    expect(prunedWith30).toBe(0);

    // With 5-day retention, it SHOULD be pruned
    const prunedWith5 = pruneAgentMessages(db, 5);
    expect(prunedWith5).toBe(1);
  });
});

describe('dispatchDbCleanup wiring', () => {
  it('dispatches agent_messages type to pruneAgentMessages with 30-day retention', () => {
    const { agentInvocationId } = seedTestData(db);

    // Create a recent message and an old one
    createAgentMessage(db, {
      agentInvocationId,
      turnIndex: 0,
      role: 'user',
      contentJson: '"recent"',
    });
    const oldMsg = createAgentMessage(db, {
      agentInvocationId,
      turnIndex: 1,
      role: 'assistant',
      contentJson: '"old"',
    });
    db.prepare(
      `UPDATE agent_messages SET created_at = datetime('now', '-60 days') WHERE agent_message_id = ?`,
    ).run(oldMsg.agentMessageId);

    // Call through the actual dispatch path used by processCleanup
    const result = dispatchDbCleanup(db, 'agent_messages');

    expect(result).not.toBeNull();
    expect(result?.type).toBe('agent_messages');
    expect(result?.pruned).toBe(1);

    // Verify only recent message remains
    const remaining = db
      .prepare('SELECT COUNT(*) as count FROM agent_messages')
      .get() as { count: number };
    expect(remaining.count).toBe(1);
  });

  it('dispatches stream_events type correctly', () => {
    // No stream events to prune, but dispatch should succeed
    const result = dispatchDbCleanup(db, 'stream_events');

    expect(result).not.toBeNull();
    expect(result?.type).toBe('stream_events');
    expect(result?.pruned).toBe(0);
  });

  it('returns null for unknown cleanup types', () => {
    const result = dispatchDbCleanup(db, 'worktree');
    expect(result).toBeNull();
  });
});
