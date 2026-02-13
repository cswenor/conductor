/**
 * Agent Messages Service Tests
 *
 * Tests CRUD operations, constraints, size guards, and pruning
 * for the agent_messages table.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Database as DatabaseType } from 'better-sqlite3';
import { initDatabase, closeDatabase } from '../db/index.ts';
import { createRun } from '../runs/index.ts';
import { createAgentInvocation, markAgentRunning } from './invocations.ts';
import {
  generateAgentMessageId,
  createAgentMessage,
  listAgentMessages,
  listAgentMessagesByRun,
  getAgentMessageCountsByRun,
  pruneAgentMessages,
} from './agent-messages.ts';

let db: DatabaseType;

function seedTestData(database: DatabaseType): {
  runId: string;
  agentInvocationId: string;
} {
  const now = new Date().toISOString();
  const userId = 'user_test';
  const projectId = 'proj_test';
  const repoId = 'repo_test';
  const taskId = 'task_test';

  database
    .prepare(
      `
    INSERT OR IGNORE INTO users (user_id, github_id, github_node_id, github_login, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'active', ?, ?)
  `,
    )
    .run(userId, 100, 'U_test', 'testuser', now, now);

  database
    .prepare(
      `
    INSERT INTO projects (
      project_id, user_id, name, github_org_id, github_org_node_id, github_org_name,
      github_installation_id, default_profile_id, default_base_branch,
      port_range_start, port_range_end, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
    )
    .run(
      projectId,
      userId,
      'Test Project',
      1,
      'O_test',
      'testorg',
      12345,
      'default',
      'main',
      3100,
      3199,
      now,
      now,
    );

  database
    .prepare(
      `
    INSERT INTO repos (
      repo_id, project_id, github_node_id, github_numeric_id,
      github_owner, github_name, github_full_name, github_default_branch,
      profile_id, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
    )
    .run(
      repoId,
      projectId,
      'R_test',
      100,
      'testowner',
      'testrepo',
      'testowner/testrepo',
      'main',
      'default',
      'active',
      now,
      now,
    );

  database
    .prepare(
      `
    INSERT INTO tasks (
      task_id, project_id, repo_id, github_node_id, github_issue_number,
      github_type, github_title, github_body, github_state, github_labels_json,
      github_synced_at, created_at, updated_at, last_activity_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
    )
    .run(
      taskId,
      projectId,
      repoId,
      'I_test',
      42,
      'issue',
      'Test Task',
      'Body',
      'open',
      '[]',
      now,
      now,
      now,
      now,
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

beforeEach(() => {
  db = initDatabase({ path: ':memory:' });
});

afterEach(() => {
  closeDatabase(db);
});

// =============================================================================
// generateAgentMessageId
// =============================================================================

describe('generateAgentMessageId', () => {
  it('returns am_ prefix', () => {
    const id = generateAgentMessageId();
    expect(id).toMatch(/^am_/);
  });

  it('produces unique ids', () => {
    const ids = new Set(
      Array.from({ length: 100 }, () => generateAgentMessageId()),
    );
    expect(ids.size).toBe(100);
  });
});

// =============================================================================
// createAgentMessage
// =============================================================================

describe('createAgentMessage', () => {
  it('round-trip: insert and read back correct fields', () => {
    const { agentInvocationId, runId } = seedTestData(db);

    const msg = createAgentMessage(db, {
      agentInvocationId,
      turnIndex: 0,
      role: 'user',
      contentJson: JSON.stringify('Hello, agent!'),
      tokensInput: 50,
      tokensOutput: 100,
      stopReason: 'end_turn',
    });

    expect(msg.agentMessageId).toMatch(/^am_/);
    expect(msg.agentInvocationId).toBe(agentInvocationId);
    expect(msg.runId).toBe(runId);
    expect(msg.turnIndex).toBe(0);
    expect(msg.role).toBe('user');
    expect(msg.contentJson).toBe(JSON.stringify('Hello, agent!'));
    expect(msg.tokensInput).toBe(50);
    expect(msg.tokensOutput).toBe(100);
    expect(msg.stopReason).toBe('end_turn');
    expect(msg.contentSizeBytes).toBeGreaterThan(0);
    expect(msg.createdAt).toBeDefined();

    // Verify it persisted to the database
    const row = db
      .prepare(
        'SELECT * FROM agent_messages WHERE agent_message_id = ?',
      )
      .get(msg.agentMessageId) as Record<string, unknown> | undefined;
    expect(row).toBeDefined();
    expect(row?.['role']).toBe('user');
    expect(row?.['turn_index']).toBe(0);
    expect(row?.['run_id']).toBe(runId);
  });

  it('duplicate turn_index throws (UNIQUE constraint)', () => {
    const { agentInvocationId } = seedTestData(db);

    createAgentMessage(db, {
      agentInvocationId,
      turnIndex: 0,
      role: 'user',
      contentJson: '"first"',
    });

    expect(() => {
      createAgentMessage(db, {
        agentInvocationId,
        turnIndex: 0,
        role: 'assistant',
        contentJson: '"duplicate"',
      });
    }).toThrow(/UNIQUE/);
  });

  it('run_id derived correctly from agent_invocations (no explicit run_id param)', () => {
    const { agentInvocationId, runId } = seedTestData(db);

    const msg = createAgentMessage(db, {
      agentInvocationId,
      turnIndex: 0,
      role: 'system',
      contentJson: '"system prompt"',
    });

    // run_id should be derived from the invocation, not passed directly
    expect(msg.runId).toBe(runId);
  });

  it('throws on invalid agentInvocationId', () => {
    seedTestData(db);

    expect(() => {
      createAgentMessage(db, {
        agentInvocationId: 'ai_nonexistent',
        turnIndex: 0,
        role: 'user',
        contentJson: '"x"',
      });
    }).toThrow(/Agent invocation not found/);
  });

  it('content_size_bytes computed correctly (matches Buffer.byteLength)', () => {
    const { agentInvocationId } = seedTestData(db);

    const content = JSON.stringify({ text: 'Hello, world! Unicode: \u00e9\u00e8\u00ea' });
    const expectedSize = Buffer.byteLength(content, 'utf8');

    const msg = createAgentMessage(db, {
      agentInvocationId,
      turnIndex: 0,
      role: 'user',
      contentJson: content,
    });

    expect(msg.contentSizeBytes).toBe(expectedSize);
  });
});

// =============================================================================
// Write-time size guard (truncation)
// =============================================================================

describe('write-time size guard', () => {
  const bigContent = JSON.stringify('x'.repeat(600_000));

  it('truncates system role content exceeding 512KB', () => {
    const { agentInvocationId } = seedTestData(db);

    const msg = createAgentMessage(db, {
      agentInvocationId,
      turnIndex: 0,
      role: 'system',
      contentJson: bigContent,
    });

    expect(msg.contentSizeBytes).toBeLessThan(Buffer.byteLength(bigContent, 'utf8'));
    expect(msg.contentJson).toContain('truncated');
    expect(msg.contentJson).toContain('exceeded');
    // Should be a JSON string
    const parsed = JSON.parse(msg.contentJson) as string;
    expect(typeof parsed).toBe('string');
  });

  it('truncates user role content exceeding 512KB', () => {
    const { agentInvocationId } = seedTestData(db);

    const msg = createAgentMessage(db, {
      agentInvocationId,
      turnIndex: 1,
      role: 'user',
      contentJson: bigContent,
    });

    expect(msg.contentSizeBytes).toBeLessThan(Buffer.byteLength(bigContent, 'utf8'));
    expect(msg.contentJson).toContain('truncated');
    const parsed = JSON.parse(msg.contentJson) as string;
    expect(typeof parsed).toBe('string');
  });

  it('truncates assistant role content exceeding 512KB into array format', () => {
    const { agentInvocationId } = seedTestData(db);

    const msg = createAgentMessage(db, {
      agentInvocationId,
      turnIndex: 2,
      role: 'assistant',
      contentJson: bigContent,
    });

    expect(msg.contentSizeBytes).toBeLessThan(Buffer.byteLength(bigContent, 'utf8'));
    expect(msg.contentJson).toContain('truncated');
    const parsed = JSON.parse(msg.contentJson) as Array<{ type: string; text: string }>;
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed[0]?.type).toBe('text');
  });

  it('truncates tool_result role content exceeding 512KB into array format', () => {
    const { agentInvocationId } = seedTestData(db);

    const msg = createAgentMessage(db, {
      agentInvocationId,
      turnIndex: 3,
      role: 'tool_result',
      contentJson: bigContent,
    });

    expect(msg.contentSizeBytes).toBeLessThan(Buffer.byteLength(bigContent, 'utf8'));
    expect(msg.contentJson).toContain('truncated');
    const parsed = JSON.parse(msg.contentJson) as Array<{
      type: string;
      tool_use_id: string;
      content: string;
    }>;
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed[0]?.type).toBe('tool_result');
    expect(parsed[0]?.tool_use_id).toBe('truncated');
  });
});

// =============================================================================
// listAgentMessages
// =============================================================================

describe('listAgentMessages', () => {
  it('returns messages ordered by turn_index', () => {
    const { agentInvocationId } = seedTestData(db);

    createAgentMessage(db, {
      agentInvocationId,
      turnIndex: 2,
      role: 'assistant',
      contentJson: '"response"',
    });
    createAgentMessage(db, {
      agentInvocationId,
      turnIndex: 0,
      role: 'system',
      contentJson: '"system prompt"',
    });
    createAgentMessage(db, {
      agentInvocationId,
      turnIndex: 1,
      role: 'user',
      contentJson: '"user msg"',
    });

    const messages = listAgentMessages(db, agentInvocationId);
    expect(messages).toHaveLength(3);
    expect(messages[0]?.turnIndex).toBe(0);
    expect(messages[0]?.role).toBe('system');
    expect(messages[1]?.turnIndex).toBe(1);
    expect(messages[1]?.role).toBe('user');
    expect(messages[2]?.turnIndex).toBe(2);
    expect(messages[2]?.role).toBe('assistant');
  });

  it('returns empty array for unknown invocation', () => {
    seedTestData(db);
    const messages = listAgentMessages(db, 'ai_nonexistent');
    expect(messages).toEqual([]);
  });
});

// =============================================================================
// listAgentMessagesByRun
// =============================================================================

describe('listAgentMessagesByRun', () => {
  it('returns messages across invocations for the same run', () => {
    const { runId, agentInvocationId } = seedTestData(db);

    // Create a second invocation for the same run
    const inv2 = createAgentInvocation(db, {
      runId,
      agent: 'reviewer',
      action: 'review_code',
    });

    createAgentMessage(db, {
      agentInvocationId,
      turnIndex: 0,
      role: 'user',
      contentJson: '"from inv1"',
    });

    createAgentMessage(db, {
      agentInvocationId: inv2.agentInvocationId,
      turnIndex: 0,
      role: 'user',
      contentJson: '"from inv2"',
    });

    createAgentMessage(db, {
      agentInvocationId: inv2.agentInvocationId,
      turnIndex: 1,
      role: 'assistant',
      contentJson: '"response from inv2"',
    });

    const messages = listAgentMessagesByRun(db, runId);
    expect(messages).toHaveLength(3);

    // Should contain messages from both invocations
    const invocationIds = new Set(messages.map((m) => m.agentInvocationId));
    expect(invocationIds.size).toBe(2);
    expect(invocationIds.has(agentInvocationId)).toBe(true);
    expect(invocationIds.has(inv2.agentInvocationId)).toBe(true);
  });

  it('returns empty array for run with no messages', () => {
    const { runId } = seedTestData(db);
    const messages = listAgentMessagesByRun(db, runId);
    expect(messages).toEqual([]);
  });
});

// =============================================================================
// getAgentMessageCountsByRun
// =============================================================================

describe('getAgentMessageCountsByRun', () => {
  it('returns correct grouped counts', () => {
    const { runId, agentInvocationId } = seedTestData(db);

    // Create a second invocation for the same run
    const inv2 = createAgentInvocation(db, {
      runId,
      agent: 'reviewer',
      action: 'review_code',
    });

    // 2 messages in first invocation
    createAgentMessage(db, {
      agentInvocationId,
      turnIndex: 0,
      role: 'user',
      contentJson: '"msg1"',
    });
    createAgentMessage(db, {
      agentInvocationId,
      turnIndex: 1,
      role: 'assistant',
      contentJson: '"msg2"',
    });

    // 1 message in second invocation
    createAgentMessage(db, {
      agentInvocationId: inv2.agentInvocationId,
      turnIndex: 0,
      role: 'user',
      contentJson: '"msg3"',
    });

    const counts = getAgentMessageCountsByRun(db, runId);
    expect(counts[agentInvocationId]).toBe(2);
    expect(counts[inv2.agentInvocationId]).toBe(1);
  });

  it('returns empty object for run with no messages', () => {
    const { runId } = seedTestData(db);
    const counts = getAgentMessageCountsByRun(db, runId);
    expect(counts).toEqual({});
  });
});

// =============================================================================
// pruneAgentMessages
// =============================================================================

describe('pruneAgentMessages', () => {
  it('deletes old rows and keeps recent ones', () => {
    const { agentInvocationId } = seedTestData(db);

    // Create a message (recent)
    const recentMsg = createAgentMessage(db, {
      agentInvocationId,
      turnIndex: 0,
      role: 'user',
      contentJson: '"recent"',
    });

    // Create another message and backdate it
    const oldMsg = createAgentMessage(db, {
      agentInvocationId,
      turnIndex: 1,
      role: 'assistant',
      contentJson: '"old"',
    });
    db.prepare(
      `UPDATE agent_messages SET created_at = datetime('now', '-60 days') WHERE agent_message_id = ?`,
    ).run(oldMsg.agentMessageId);

    const deleted = pruneAgentMessages(db, 30);
    expect(deleted).toBe(1);

    // Recent message should remain
    const remaining = db
      .prepare('SELECT agent_message_id FROM agent_messages')
      .all() as { agent_message_id: string }[];
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.agent_message_id).toBe(recentMsg.agentMessageId);
  });

  it('returns 0 when nothing to prune', () => {
    const { agentInvocationId } = seedTestData(db);

    createAgentMessage(db, {
      agentInvocationId,
      turnIndex: 0,
      role: 'user',
      contentJson: '"recent"',
    });

    const deleted = pruneAgentMessages(db, 30);
    expect(deleted).toBe(0);
  });
});
