/**
 * Agent Invocation Framework Tests
 *
 * Tests provider factory, error classes, executeAgent flow,
 * and executeAgent message persistence.
 * API calls are NOT tested here (mocked via vitest).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Database as DatabaseType } from 'better-sqlite3';
import { initDatabase, closeDatabase } from '../db/index.ts';
import { createRun } from '../runs/index.ts';
import { listAgentMessages } from './agent-messages.ts';
import { listAgentInvocations } from './invocations.ts';
import {
  createProvider,
  AgentError,
  AgentAuthError,
  AgentRateLimitError,
  AgentContextLengthError,
  AgentUnsupportedProviderError,
  AgentTimeoutError,
  AgentCancelledError,
  AnthropicProvider,
  getDefaultTimeout,
  executeAgent,
} from './provider.ts';

// =============================================================================
// Module-level mocks
// =============================================================================

// Mock resolver so executeAgent never hits real credential lookups
vi.mock('./resolver.ts', () => ({
  resolveCredentials: vi.fn().mockResolvedValue({
    mode: 'ai_provider',
    provider: 'anthropic',
    apiKey: 'test-key',
  }),
}));

// Mock the Anthropic SDK with a proper class constructor so that
// both `new Anthropic(...)` and instanceof checks work.
vi.mock('@anthropic-ai/sdk', () => {
  class MockAnthropic {
    messages = {
      create: vi.fn().mockResolvedValue({
        content: [{ type: 'text', text: 'Mock response', citations: null }],
        usage: { input_tokens: 100, output_tokens: 50 },
        stop_reason: 'end_turn',
      }),
    };

    constructor(_opts?: Record<string, unknown>) {
      // no-op
    }

    static AuthenticationError = class extends Error {
      constructor(message?: string) {
        super(message);
        this.name = 'AuthenticationError';
      }
    };

    static RateLimitError = class extends Error {
      constructor(message?: string) {
        super(message);
        this.name = 'RateLimitError';
      }
    };

    static BadRequestError = class extends Error {
      constructor(message?: string) {
        super(message);
        this.name = 'BadRequestError';
      }
    };
  }

  return { default: MockAnthropic };
});

// =============================================================================
// Existing tests (unchanged)
// =============================================================================

describe('createProvider', () => {
  it('creates AnthropicProvider for anthropic', () => {
    const provider = createProvider('anthropic', 'sk-ant-test123');
    expect(provider).toBeInstanceOf(AnthropicProvider);
  });

  it('throws AgentUnsupportedProviderError for openai', () => {
    expect(() => createProvider('openai', 'sk-test')).toThrow(AgentUnsupportedProviderError);
    expect(() => createProvider('openai', 'sk-test')).toThrow("Provider 'openai' is not yet supported");
  });

  it('throws AgentUnsupportedProviderError for google', () => {
    expect(() => createProvider('google', 'AIza-test')).toThrow(AgentUnsupportedProviderError);
  });

  it('throws AgentUnsupportedProviderError for mistral', () => {
    expect(() => createProvider('mistral', 'test-key')).toThrow(AgentUnsupportedProviderError);
  });
});

describe('error classes', () => {
  it('AgentError has correct code', () => {
    const err = new AgentError('test');
    expect(err.code).toBe('agent_error');
    expect(err.name).toBe('AgentError');
    expect(err).toBeInstanceOf(Error);
  });

  it('AgentAuthError has auth_error code', () => {
    const err = new AgentAuthError('bad key');
    expect(err.code).toBe('auth_error');
    expect(err.name).toBe('AgentAuthError');
    expect(err).toBeInstanceOf(AgentError);
  });

  it('AgentRateLimitError includes retryAfterMs', () => {
    const err = new AgentRateLimitError('rate limited', 5000);
    expect(err.code).toBe('rate_limit');
    expect(err.retryAfterMs).toBe(5000);
    expect(err).toBeInstanceOf(AgentError);
  });

  it('AgentContextLengthError has context_length code', () => {
    const err = new AgentContextLengthError('too long');
    expect(err.code).toBe('context_length');
    expect(err).toBeInstanceOf(AgentError);
  });

  it('AgentUnsupportedProviderError has unsupported_provider code', () => {
    const err = new AgentUnsupportedProviderError('cohere');
    expect(err.code).toBe('unsupported_provider');
    expect(err.message).toContain('cohere');
    expect(err.message).toContain('not yet supported');
  });

  it('AgentTimeoutError includes timeout details', () => {
    const err = new AgentTimeoutError(300000, 'planner', 'create_plan');
    expect(err.code).toBe('timeout');
    expect(err.timeoutMs).toBe(300000);
    expect(err.agent).toBe('planner');
    expect(err.action).toBe('create_plan');
    expect(err.message).toContain('300s');
    expect(err).toBeInstanceOf(AgentError);
  });
});

describe('getDefaultTimeout', () => {
  it('returns 300s for planner', () => {
    expect(getDefaultTimeout('planner')).toBe(300_000);
  });

  it('returns 180s for reviewer', () => {
    expect(getDefaultTimeout('reviewer')).toBe(180_000);
  });

  it('returns 600s for implementer', () => {
    expect(getDefaultTimeout('implementer')).toBe(600_000);
  });

  it('returns default for unknown agent', () => {
    expect(getDefaultTimeout('custom_agent')).toBe(300_000);
  });
});

// =============================================================================
// executeAgent message persistence tests
// =============================================================================

describe('executeAgent message persistence', () => {
  let db: DatabaseType;
  let runId: string;
  let projectId: string;

  function seedTestData(database: DatabaseType): { runId: string; projectId: string } {
    const now = new Date().toISOString();
    const userId = 'user_test';
    const pId = 'proj_test';
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
    `).run(pId, userId, 'Test Project', 1, 'O_test', 'testorg',
      12345, 'default', 'main', 3100, 3199, now, now);

    database.prepare(`
      INSERT INTO repos (
        repo_id, project_id, github_node_id, github_numeric_id,
        github_owner, github_name, github_full_name, github_default_branch,
        profile_id, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(repoId, pId, 'R_test', 100,
      'testowner', 'testrepo', 'testowner/testrepo', 'main',
      'default', 'active', now, now);

    database.prepare(`
      INSERT INTO tasks (
        task_id, project_id, repo_id, github_node_id, github_issue_number,
        github_type, github_title, github_body, github_state, github_labels_json,
        github_synced_at, created_at, updated_at, last_activity_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(taskId, pId, repoId, 'I_test', 42,
      'issue', 'Test Task', 'Body', 'open', '[]',
      now, now, now, now);

    const run = createRun(database, { taskId, projectId: pId, repoId, baseBranch: 'main' });
    return { runId: run.runId, projectId: pId };
  }

  beforeEach(() => {
    db = initDatabase({ path: ':memory:' });
    const seed = seedTestData(db);
    runId = seed.runId;
    projectId = seed.projectId;
  });

  afterEach(() => {
    closeDatabase(db);
  });

  it('persists 3 messages on success (system, user, assistant)', async () => {
    const result = await executeAgent(db, {
      runId,
      projectId,
      agent: 'implementer',
      action: 'apply_changes',
      systemPrompt: 'You are helpful.',
      userPrompt: 'Do the thing.',
      step: 'implementer_apply_changes',
    });

    // Verify executeAgent returned successfully
    expect(result.content).toBe('Mock response');
    expect(result.tokensInput).toBe(100);
    expect(result.tokensOutput).toBe(50);

    // Look up the invocation created by executeAgent
    const invocations = listAgentInvocations(db, runId);
    expect(invocations.length).toBeGreaterThanOrEqual(1);
    const invocation = invocations[invocations.length - 1];

    const msgs = listAgentMessages(db, invocation!.agentInvocationId);
    expect(msgs).toHaveLength(3);
    expect(msgs[0]?.role).toBe('system');
    expect(msgs[0]?.turnIndex).toBe(0);
    expect(msgs[1]?.role).toBe('user');
    expect(msgs[1]?.turnIndex).toBe(1);
    expect(msgs[2]?.role).toBe('assistant');
    expect(msgs[2]?.turnIndex).toBe(2);
    expect(msgs[2]?.tokensInput).toBe(100);
    expect(msgs[2]?.tokensOutput).toBe(50);
    expect(msgs[2]?.stopReason).toBe('end_turn');
  });

  it('persists system + user + error assistant on cancellation', async () => {
    const ac = new AbortController();
    ac.abort();

    await expect(
      executeAgent(db, {
        runId,
        projectId,
        agent: 'implementer',
        action: 'apply_changes',
        systemPrompt: 'System prompt.',
        userPrompt: 'User prompt.',
        step: 'implementer_apply_changes',
        abortSignal: ac.signal,
      })
    ).rejects.toThrow(AgentCancelledError);

    // Look up the invocation
    const invocations = listAgentInvocations(db, runId);
    expect(invocations.length).toBeGreaterThanOrEqual(1);
    const invocation = invocations[invocations.length - 1];

    const msgs = listAgentMessages(db, invocation!.agentInvocationId);
    // system(0), user(1), error assistant(2)
    expect(msgs).toHaveLength(3);
    expect(msgs[0]?.role).toBe('system');
    expect(msgs[1]?.role).toBe('user');
    expect(msgs[2]?.role).toBe('assistant');
    expect(msgs[2]?.stopReason).toBe('cancelled');
  });

  it('persistence failure does not prevent executeAgent from completing', async () => {
    // Corrupt the agent_messages table to force insert failures
    db.exec('DROP TABLE agent_messages');
    db.exec('CREATE TABLE agent_messages (agent_message_id TEXT PRIMARY KEY)');

    const result = await executeAgent(db, {
      runId,
      projectId,
      agent: 'implementer',
      action: 'apply_changes',
      systemPrompt: 'S',
      userPrompt: 'U',
      step: 'implementer_apply_changes',
    });

    // executeAgent should still complete successfully
    expect(result.content).toBe('Mock response');
    expect(result.tokensInput).toBe(100);
    expect(result.tokensOutput).toBe(50);
  });
});
