import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  projectChannel,
  publishTransitionEvent,
  initPublisher,
  _resetPublisher,
  persistAndPublish,
  insertStreamEvent,
  queryStreamEventsForReplay,
  queryRecentStreamEvents,
  queryRecentStreamEventsEnriched,
  rowToStreamEventV2,
  pruneStreamEvents,
  publishGateEvaluatedEvent,
  publishOperatorActionEvent,
  publishAgentInvocationEvent,
  publishRunUpdatedEvent,
  publishProjectUpdatedEvent,
  type StreamEvent,
  type StreamEventV2,
} from './index.ts';

// ---------------------------------------------------------------------------
// Mock ioredis — must be before the tested module is imported.
// vi.mock hoisting means the factory runs before module evaluation.
// ---------------------------------------------------------------------------

const mockPublish = vi.fn<[string, string], Promise<number>>().mockResolvedValue(1);
const mockSubscribe = vi.fn<[...string[]], Promise<unknown>>().mockResolvedValue(undefined);
const mockUnsubscribe = vi.fn<[], Promise<unknown>>().mockResolvedValue(undefined);
const mockQuit = vi.fn<[], Promise<string>>().mockResolvedValue('OK');
const mockConnect = vi.fn<[], Promise<void>>().mockResolvedValue(undefined);
const mockOn = vi.fn();
const mockRemoveListener = vi.fn();

vi.mock('ioredis', () => {
  class RedisMock {
    publish = mockPublish;
    subscribe = mockSubscribe;
    unsubscribe = mockUnsubscribe;
    quit = mockQuit;
    connect = mockConnect;
    on = mockOn;
    removeListener = mockRemoveListener;
  }
  return { Redis: RedisMock };
});

describe('pubsub', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetPublisher();
  });

  afterEach(() => {
    _resetPublisher();
  });

  // -------------------------------------------------------------------------
  // projectChannel
  // -------------------------------------------------------------------------

  it('projectChannel returns correct channel name', () => {
    expect(projectChannel('proj_1')).toBe('conductor:events:proj_1');
    expect(projectChannel('proj_abc')).toBe('conductor:events:proj_abc');
  });

  // -------------------------------------------------------------------------
  // publishTransitionEvent — no-op without init
  // -------------------------------------------------------------------------

  it('publishTransitionEvent is a silent no-op when publisher not initialized', () => {
    // Should not throw
    publishTransitionEvent('proj_1', 'run_1', 'planning', 'executing');
    expect(mockPublish).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // publishTransitionEvent — with init (legacy path, no db)
  // -------------------------------------------------------------------------

  it('publishTransitionEvent calls redis.publish with correct channel and payload after init', async () => {
    initPublisher('redis://localhost:6379');

    publishTransitionEvent('proj_x', 'run_y', 'planning', 'awaiting_plan_approval');

    // Allow the fire-and-forget promise to resolve
    await vi.waitFor(() => {
      expect(mockPublish).toHaveBeenCalledOnce();
    });

    const [channel, payload] = mockPublish.mock.calls[0]!;
    expect(channel).toBe('conductor:events:proj_x');

    const parsed = JSON.parse(payload) as StreamEvent;
    expect(parsed.type).toBe('run.phase_changed');
    expect(parsed.projectId).toBe('proj_x');
    expect(parsed.runId).toBe('run_y');
    expect(parsed.fromPhase).toBe('planning');
    expect(parsed.toPhase).toBe('awaiting_plan_approval');
    expect(parsed.timestamp).toBeTruthy();
  });

  // -------------------------------------------------------------------------
  // StreamEvent JSON round-trip
  // -------------------------------------------------------------------------

  it('StreamEvent serialization round-trip preserves all fields', () => {
    const event: StreamEvent = {
      type: 'run.phase_changed',
      projectId: 'proj_1',
      runId: 'run_1',
      fromPhase: 'pending',
      toPhase: 'planning',
      timestamp: '2025-01-01T00:00:00.000Z',
    };

    const serialized = JSON.stringify(event);
    const deserialized = JSON.parse(serialized) as StreamEvent;

    expect(deserialized).toEqual(event);
  });

  // -------------------------------------------------------------------------
  // createSubscriber routes messages to onMessage
  // -------------------------------------------------------------------------

  it('createSubscriber routes Redis messages to onMessage callback', async () => {
    // Import dynamically to use mocked ioredis
    const { createSubscriber } = await import('./index.ts');
    const subscriber = createSubscriber('redis://localhost:6379');

    const received: StreamEventV2[] = [];
    subscriber.setHandler((event) => received.push(event));
    await subscriber.addChannels(['proj_1']);

    // Verify redis.subscribe was called with the correct channel
    expect(mockSubscribe).toHaveBeenCalledWith('conductor:events:proj_1');

    // Verify redis.on('message', handler) was registered exactly once
    expect(mockOn).toHaveBeenCalledWith('message', expect.any(Function));
    expect(mockOn).toHaveBeenCalledTimes(1);

    // Simulate receiving a message
    const handler = mockOn.mock.calls.find(
      (call: unknown[]) => call[0] === 'message',
    )?.[1] as (channel: string, message: string) => void;

    const testEvent: StreamEventV2 = {
      kind: 'run.phase_changed',
      projectId: 'proj_1',
      runId: 'run_1',
      fromPhase: 'executing',
      toPhase: 'awaiting_review',
      timestamp: '2025-01-01T00:00:00.000Z',
    };
    handler('conductor:events:proj_1', JSON.stringify(testEvent));

    expect(received).toHaveLength(1);
    expect(received[0]).toEqual(testEvent);

    await subscriber.close();
    expect(mockQuit).toHaveBeenCalled();
  });

  it('setHandler registers exactly one redis.on("message") call', async () => {
    const { createSubscriber } = await import('./index.ts');
    const subscriber = createSubscriber('redis://localhost:6379');

    subscriber.setHandler(() => {});

    const messageOnCalls = mockOn.mock.calls.filter(
      (call: unknown[]) => call[0] === 'message',
    );
    expect(messageOnCalls).toHaveLength(1);

    await subscriber.close();
  });

  it('addChannels calls redis.subscribe but NOT redis.on("message")', async () => {
    const { createSubscriber } = await import('./index.ts');
    const subscriber = createSubscriber('redis://localhost:6379');

    subscriber.setHandler(() => {});
    mockOn.mockClear(); // Clear the setHandler call

    await subscriber.addChannels(['proj_2']);

    expect(mockSubscribe).toHaveBeenCalledWith('conductor:events:proj_2');
    expect(mockOn).not.toHaveBeenCalled();

    await subscriber.close();
  });

  it('calling setHandler twice throws', async () => {
    const { createSubscriber } = await import('./index.ts');
    const subscriber = createSubscriber('redis://localhost:6379');

    subscriber.setHandler(() => {});
    expect(() => subscriber.setHandler(() => {})).toThrow(
      'setHandler() called twice',
    );

    await subscriber.close();
  });

  // -------------------------------------------------------------------------
  // initPublisher is idempotent
  // -------------------------------------------------------------------------

  // -------------------------------------------------------------------------
  // queryRecentStreamEvents
  // -------------------------------------------------------------------------

  describe('queryRecentStreamEvents', () => {
    // Import the real better-sqlite3 for query tests
    let realDb: import('better-sqlite3').Database;

    function createTestDb(): import('better-sqlite3').Database {
      // Lazy import to avoid conflicting with the ioredis mock
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const Database = require('better-sqlite3') as typeof import('better-sqlite3').default;
      const database = new Database(':memory:');
      database.pragma('journal_mode = WAL');
      database.pragma('foreign_keys = ON');

      // Apply migrations manually — need the schema
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { migrations } = require('../db/migrations/index.ts') as { migrations: Array<{ version: number; name: string; up: (db: import('better-sqlite3').Database) => void }> };
      database.exec(`
        CREATE TABLE IF NOT EXISTS schema_versions (
          version INTEGER PRIMARY KEY,
          name TEXT NOT NULL,
          applied_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
      `);
      for (const m of migrations) {
        database.transaction(() => {
          m.up(database);
          database.prepare('INSERT INTO schema_versions (version, name) VALUES (?, ?)').run(m.version, m.name);
        })();
      }

      // Seed a user and projects
      const now = new Date().toISOString();
      database.prepare(`
        INSERT INTO users (user_id, github_id, github_node_id, github_login, status, created_at, updated_at)
        VALUES ('u1', 1, 'U_1', 'alice', 'active', ?, ?)
      `).run(now, now);
      database.prepare(`
        INSERT INTO projects (project_id, user_id, name, github_org_id, github_org_node_id, github_org_name,
          github_installation_id, default_profile_id, default_base_branch,
          port_range_start, port_range_end, created_at, updated_at)
        VALUES ('proj_1', 'u1', 'P1', 1, 'O_1', 'org', 100, 'default', 'main', 3100, 3199, ?, ?)
      `).run(now, now);
      database.prepare(`
        INSERT INTO projects (project_id, user_id, name, github_org_id, github_org_node_id, github_org_name,
          github_installation_id, default_profile_id, default_base_branch,
          port_range_start, port_range_end, created_at, updated_at)
        VALUES ('proj_2', 'u1', 'P2', 2, 'O_2', 'org', 101, 'default', 'main', 3200, 3299, ?, ?)
      `).run(now, now);

      return database;
    }

    beforeEach(() => {
      realDb = createTestDb();
    });

    afterEach(() => {
      realDb.close();
    });

    it('returns events in descending id order', () => {
      const { queryRecentStreamEvents } = require('./index.ts') as typeof import('./index.ts');
      insertStreamEvent(realDb, {
        kind: 'run.phase_changed', projectId: 'proj_1', runId: 'run_1',
        fromPhase: 'pending', toPhase: 'planning', timestamp: '2025-01-01T00:00:00.000Z',
      });
      insertStreamEvent(realDb, {
        kind: 'gate.evaluated', projectId: 'proj_1', runId: 'run_1',
        gateId: 'g1', gateKind: 'approval', status: 'passed', timestamp: '2025-01-01T00:01:00.000Z',
      });
      insertStreamEvent(realDb, {
        kind: 'operator.action', projectId: 'proj_1', runId: 'run_1',
        action: 'approve', operator: 'alice', timestamp: '2025-01-01T00:02:00.000Z',
      });

      const events = queryRecentStreamEvents(realDb, ['proj_1']);
      expect(events).toHaveLength(3);
      // Should be newest first (descending id)
      expect(events[0]!.id).toBeGreaterThan(events[1]!.id!);
      expect(events[1]!.id).toBeGreaterThan(events[2]!.id!);
    });

    it('respects limit parameter', () => {
      const { queryRecentStreamEvents } = require('./index.ts') as typeof import('./index.ts');
      for (let i = 0; i < 5; i++) {
        insertStreamEvent(realDb, {
          kind: 'run.phase_changed', projectId: 'proj_1', runId: `run_${i}`,
          fromPhase: 'pending', toPhase: 'planning', timestamp: '2025-01-01T00:00:00.000Z',
        });
      }

      const events = queryRecentStreamEvents(realDb, ['proj_1'], 2);
      expect(events).toHaveLength(2);
    });

    it('returns [] for empty projectIds', () => {
      const { queryRecentStreamEvents } = require('./index.ts') as typeof import('./index.ts');
      const events = queryRecentStreamEvents(realDb, []);
      expect(events).toHaveLength(0);
    });

    it('filters by projectIds (other projects excluded)', () => {
      const { queryRecentStreamEvents } = require('./index.ts') as typeof import('./index.ts');
      insertStreamEvent(realDb, {
        kind: 'run.phase_changed', projectId: 'proj_1', runId: 'run_1',
        fromPhase: 'pending', toPhase: 'planning', timestamp: '2025-01-01T00:00:00.000Z',
      });
      insertStreamEvent(realDb, {
        kind: 'run.phase_changed', projectId: 'proj_2', runId: 'run_2',
        fromPhase: 'pending', toPhase: 'planning', timestamp: '2025-01-01T00:01:00.000Z',
      });

      const events = queryRecentStreamEvents(realDb, ['proj_1']);
      expect(events).toHaveLength(1);
      expect(events[0]!.projectId).toBe('proj_1');
    });

    it('returns StreamEventV2[] with typed fields', () => {
      const { queryRecentStreamEvents } = require('./index.ts') as typeof import('./index.ts');
      insertStreamEvent(realDb, {
        kind: 'gate.evaluated', projectId: 'proj_1', runId: 'run_1',
        gateId: 'plan_approval', gateKind: 'approval', status: 'passed',
        timestamp: '2025-01-01T00:00:00.000Z',
      });

      const events = queryRecentStreamEvents(realDb, ['proj_1']);
      expect(events).toHaveLength(1);
      const event = events[0]!;
      expect(event.kind).toBe('gate.evaluated');
      expect(event.projectId).toBe('proj_1');
      expect(event.id).toBeDefined();
      if (event.kind === 'gate.evaluated') {
        expect(event.gateId).toBe('plan_approval');
        expect(event.gateKind).toBe('approval');
        expect(event.status).toBe('passed');
      }
    });
  });

  // -------------------------------------------------------------------------
  // queryRecentStreamEventsEnriched
  // -------------------------------------------------------------------------

  describe('queryRecentStreamEventsEnriched', () => {
    let enrichedDb: import('better-sqlite3').Database;

    function createEnrichedTestDb(): import('better-sqlite3').Database {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const Database = require('better-sqlite3') as typeof import('better-sqlite3').default;
      const database = new Database(':memory:');
      database.pragma('journal_mode = WAL');
      database.pragma('foreign_keys = ON');

      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { migrations } = require('../db/migrations/index.ts') as { migrations: Array<{ version: number; name: string; up: (db: import('better-sqlite3').Database) => void }> };
      database.exec(`
        CREATE TABLE IF NOT EXISTS schema_versions (
          version INTEGER PRIMARY KEY,
          name TEXT NOT NULL,
          applied_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
      `);
      for (const m of migrations) {
        database.transaction(() => {
          m.up(database);
          database.prepare('INSERT INTO schema_versions (version, name) VALUES (?, ?)').run(m.version, m.name);
        })();
      }

      const now = new Date().toISOString();
      // Seed user
      database.prepare(`
        INSERT INTO users (user_id, github_id, github_node_id, github_login, status, created_at, updated_at)
        VALUES ('u1', 1, 'U_1', 'alice', 'active', ?, ?)
      `).run(now, now);
      // Seed projects
      database.prepare(`
        INSERT INTO projects (project_id, user_id, name, github_org_id, github_org_node_id, github_org_name,
          github_installation_id, default_profile_id, default_base_branch,
          port_range_start, port_range_end, created_at, updated_at)
        VALUES ('proj_1', 'u1', 'My Project', 1, 'O_1', 'org', 100, 'default', 'main', 3100, 3199, ?, ?)
      `).run(now, now);
      // Seed repo
      database.prepare(`
        INSERT INTO repos (repo_id, project_id, github_numeric_id, github_node_id, github_owner, github_name, github_full_name,
          github_default_branch, profile_id, status, created_at, updated_at)
        VALUES ('repo_1', 'proj_1', 1, 'R_1', 'org', 'repo', 'org/repo', 'main', 'default', 'active', ?, ?)
      `).run(now, now);
      // Seed task
      database.prepare(`
        INSERT INTO tasks (task_id, project_id, repo_id, github_issue_number, github_node_id,
          github_title, github_body, github_type, github_state, github_labels_json,
          github_synced_at, created_at, updated_at, last_activity_at)
        VALUES ('task_1', 'proj_1', 'repo_1', 42, 'I_1', 'Fix login bug', '', 'issue', 'open', '[]', ?, ?, ?, ?)
      `).run(now, now, now, now);
      // Seed policy set (required FK for runs)
      database.prepare(`
        INSERT INTO policy_sets (policy_set_id, project_id, config_hash, created_by, created_at)
        VALUES ('ps_1', 'proj_1', 'hash_1', 'system', ?)
      `).run(now);
      // Seed run
      database.prepare(`
        INSERT INTO runs (run_id, task_id, project_id, repo_id, run_number,
          phase, step, policy_set_id, base_branch, branch, started_at, updated_at)
        VALUES ('run_1', 'task_1', 'proj_1', 'repo_1', 1,
          'planning', 'plan', 'ps_1', 'main', 'fix/login', ?, ?)
      `).run(now, now);

      return database;
    }

    beforeEach(() => {
      enrichedDb = createEnrichedTestDb();
    });

    afterEach(() => {
      enrichedDb.close();
    });

    it('returns projectName and taskTitle when data exists', () => {
      insertStreamEvent(enrichedDb, {
        kind: 'run.phase_changed', projectId: 'proj_1', runId: 'run_1',
        fromPhase: 'pending', toPhase: 'planning', timestamp: '2025-01-01T00:00:00.000Z',
      });

      const rows = queryRecentStreamEventsEnriched(enrichedDb, ['proj_1']);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.projectName).toBe('My Project');
      expect(rows[0]!.taskTitle).toBe('Fix login bug');
      expect(rows[0]!.event.kind).toBe('run.phase_changed');
    });

    it('returns null for taskTitle when event has no runId', () => {
      insertStreamEvent(enrichedDb, {
        kind: 'project.updated', projectId: 'proj_1',
        reason: 'config', timestamp: '2025-01-01T00:00:00.000Z',
      });

      const rows = queryRecentStreamEventsEnriched(enrichedDb, ['proj_1']);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.projectName).toBe('My Project');
      expect(rows[0]!.taskTitle).toBeNull();
    });

    it('returns null for projectName and taskTitle when orphaned', () => {
      // Insert event referencing non-existent project (bypass FK with pragma)
      enrichedDb.pragma('foreign_keys = OFF');
      enrichedDb.prepare(`
        INSERT INTO stream_events (kind, project_id, run_id, payload_json, created_at)
        VALUES ('run.phase_changed', 'deleted_proj', 'deleted_run', '{"fromPhase":"a","toPhase":"b"}', '2025-01-01T00:00:00.000Z')
      `).run();
      enrichedDb.pragma('foreign_keys = ON');

      const rows = queryRecentStreamEventsEnriched(enrichedDb, ['deleted_proj']);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.projectName).toBeNull();
      expect(rows[0]!.taskTitle).toBeNull();
    });

    it('respects limit and ordering', () => {
      for (let i = 0; i < 5; i++) {
        insertStreamEvent(enrichedDb, {
          kind: 'run.phase_changed', projectId: 'proj_1', runId: 'run_1',
          fromPhase: 'pending', toPhase: 'planning', timestamp: `2025-01-01T00:0${i}:00.000Z`,
        });
      }

      const rows = queryRecentStreamEventsEnriched(enrichedDb, ['proj_1'], 3);
      expect(rows).toHaveLength(3);
      // Descending order: newest first
      expect(rows[0]!.event.id).toBeGreaterThan(rows[1]!.event.id!);
      expect(rows[1]!.event.id).toBeGreaterThan(rows[2]!.event.id!);
    });

    it('returns [] for empty projectIds', () => {
      const rows = queryRecentStreamEventsEnriched(enrichedDb, []);
      expect(rows).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // initPublisher is idempotent
  // -------------------------------------------------------------------------

  it('initPublisher does not re-initialize if already initialized', () => {
    initPublisher('redis://localhost:6379');
    initPublisher('redis://localhost:6380'); // Should be ignored
    // Only one connect call
    expect(mockConnect).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------------------------
  // V2 StreamEventV2 serialization round-trip
  // -------------------------------------------------------------------------

  it('StreamEventV2 run.phase_changed round-trip preserves all fields', () => {
    const event: StreamEventV2 = {
      id: 42,
      kind: 'run.phase_changed',
      projectId: 'proj_1',
      runId: 'run_1',
      fromPhase: 'pending',
      toPhase: 'planning',
      timestamp: '2025-01-01T00:00:00.000Z',
    };

    const serialized = JSON.stringify(event);
    const deserialized = JSON.parse(serialized) as StreamEventV2;

    expect(deserialized).toEqual(event);
    expect(deserialized.kind).toBe('run.phase_changed');
  });

  it('StreamEventV2 gate.evaluated round-trip', () => {
    const event: StreamEventV2 = {
      kind: 'gate.evaluated',
      projectId: 'proj_1',
      runId: 'run_1',
      gateId: 'gate_plan',
      gateKind: 'plan_review',
      status: 'passed',
      timestamp: '2025-01-01T00:00:00.000Z',
    };

    const serialized = JSON.stringify(event);
    const deserialized = JSON.parse(serialized) as StreamEventV2;
    expect(deserialized).toEqual(event);
  });

  // -------------------------------------------------------------------------
  // persistAndPublish skips empty projectId
  // -------------------------------------------------------------------------

  it('persistAndPublish skips empty projectId', () => {
    initPublisher('redis://localhost:6379');

    // Create a minimal mock db
    const mockDb = {
      prepare: vi.fn().mockReturnValue({ run: vi.fn().mockReturnValue({ lastInsertRowid: 1 }) }),
    };

    persistAndPublish(mockDb as never, '', {
      kind: 'run.phase_changed',
      projectId: '',
      runId: 'run_1',
      fromPhase: 'pending',
      toPhase: 'planning',
      timestamp: new Date().toISOString(),
    });

    // Should not have attempted any db or publish operations
    expect(mockDb.prepare).not.toHaveBeenCalled();
    expect(mockPublish).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // persistAndPublish publishes even if db fails
  // -------------------------------------------------------------------------

  it('persistAndPublish publishes to Redis even when db INSERT fails', async () => {
    initPublisher('redis://localhost:6379');

    const mockDb = {
      prepare: vi.fn().mockReturnValue({
        run: vi.fn().mockImplementation(() => {
          throw new Error('DB error');
        }),
      }),
    };

    persistAndPublish(mockDb as never, 'proj_1', {
      kind: 'gate.evaluated',
      projectId: 'proj_1',
      runId: 'run_1',
      gateId: 'gate_1',
      gateKind: 'plan_review',
      status: 'passed',
      timestamp: new Date().toISOString(),
    });

    await vi.waitFor(() => {
      expect(mockPublish).toHaveBeenCalledOnce();
    });

    // Event should NOT have an id field since db failed
    const [, payload] = mockPublish.mock.calls[0]!;
    const parsed = JSON.parse(payload) as Record<string, unknown>;
    expect(parsed['id']).toBeUndefined();
    expect(parsed['kind']).toBe('gate.evaluated');
  });

  // -------------------------------------------------------------------------
  // persistAndPublish includes id when db succeeds
  // -------------------------------------------------------------------------

  it('persistAndPublish includes id when db INSERT succeeds', async () => {
    initPublisher('redis://localhost:6379');

    const mockDb = {
      prepare: vi.fn().mockReturnValue({
        run: vi.fn().mockReturnValue({ lastInsertRowid: 99 }),
      }),
    };

    persistAndPublish(mockDb as never, 'proj_1', {
      kind: 'run.updated',
      projectId: 'proj_1',
      runId: 'run_1',
      fields: ['prUrl'],
      timestamp: new Date().toISOString(),
    });

    await vi.waitFor(() => {
      expect(mockPublish).toHaveBeenCalledOnce();
    });

    const [, payload] = mockPublish.mock.calls[0]!;
    const parsed = JSON.parse(payload) as Record<string, unknown>;
    expect(parsed['id']).toBe(99);
    expect(parsed['kind']).toBe('run.updated');
  });

  // -------------------------------------------------------------------------
  // publishTransitionEvent with db uses V2 path
  // -------------------------------------------------------------------------

  // -------------------------------------------------------------------------
  // Payload shape assertions for V2 publish helpers
  // -------------------------------------------------------------------------

  it('publishGateEvaluatedEvent publishes correct payload shape', async () => {
    initPublisher('redis://localhost:6379');

    const mockDb = {
      prepare: vi.fn().mockReturnValue({
        run: vi.fn().mockReturnValue({ lastInsertRowid: 10 }),
      }),
    };

    publishGateEvaluatedEvent(mockDb as never, 'proj_1', 'run_1', 'gate_plan', 'plan_review', 'passed', 'Looks good');

    await vi.waitFor(() => {
      expect(mockPublish).toHaveBeenCalledOnce();
    });

    const [channel, payload] = mockPublish.mock.calls[0]!;
    expect(channel).toBe('conductor:events:proj_1');

    const parsed = JSON.parse(payload) as Record<string, unknown>;
    expect(parsed['kind']).toBe('gate.evaluated');
    expect(parsed['projectId']).toBe('proj_1');
    expect(parsed['runId']).toBe('run_1');
    expect(parsed['gateId']).toBe('gate_plan');
    expect(parsed['gateKind']).toBe('plan_review');
    expect(parsed['status']).toBe('passed');
    expect(parsed['reason']).toBe('Looks good');
    expect(parsed['timestamp']).toBeTruthy();
    expect(parsed['id']).toBe(10);
  });

  it('publishAgentInvocationEvent publishes correct payload shape with agentInvocationId', async () => {
    initPublisher('redis://localhost:6379');

    const mockDb = {
      prepare: vi.fn().mockReturnValue({
        run: vi.fn().mockReturnValue({ lastInsertRowid: 20 }),
      }),
    };

    publishAgentInvocationEvent(mockDb as never, 'proj_1', 'run_1', 'inv_abc', 'planner', 'create_plan', 'running');

    await vi.waitFor(() => {
      expect(mockPublish).toHaveBeenCalledOnce();
    });

    const [channel, payload] = mockPublish.mock.calls[0]!;
    expect(channel).toBe('conductor:events:proj_1');

    const parsed = JSON.parse(payload) as Record<string, unknown>;
    expect(parsed['kind']).toBe('agent.invocation');
    expect(parsed['projectId']).toBe('proj_1');
    expect(parsed['runId']).toBe('run_1');
    expect(parsed['agentInvocationId']).toBe('inv_abc');
    expect(parsed['agent']).toBe('planner');
    expect(parsed['action']).toBe('create_plan');
    expect(parsed['status']).toBe('running');
    expect(parsed['timestamp']).toBeTruthy();
    expect(parsed['id']).toBe(20);
  });

  it('publishRunUpdatedEvent publishes correct payload shape', async () => {
    initPublisher('redis://localhost:6379');

    const mockDb = {
      prepare: vi.fn().mockReturnValue({
        run: vi.fn().mockReturnValue({ lastInsertRowid: 30 }),
      }),
    };

    publishRunUpdatedEvent(mockDb as never, 'proj_1', 'run_1', ['prUrl', 'prNumber', 'prState']);

    await vi.waitFor(() => {
      expect(mockPublish).toHaveBeenCalledOnce();
    });

    const [channel, payload] = mockPublish.mock.calls[0]!;
    expect(channel).toBe('conductor:events:proj_1');

    const parsed = JSON.parse(payload) as Record<string, unknown>;
    expect(parsed['kind']).toBe('run.updated');
    expect(parsed['projectId']).toBe('proj_1');
    expect(parsed['runId']).toBe('run_1');
    expect(parsed['fields']).toEqual(['prUrl', 'prNumber', 'prState']);
    expect(parsed['timestamp']).toBeTruthy();
    expect(parsed['id']).toBe(30);
  });

  // -------------------------------------------------------------------------
  // publishTransitionEvent with db uses V2 path
  // -------------------------------------------------------------------------

  it('publishTransitionEvent with db publishes V2 event via persistAndPublish', async () => {
    initPublisher('redis://localhost:6379');

    const mockDb = {
      prepare: vi.fn().mockReturnValue({
        run: vi.fn().mockReturnValue({ lastInsertRowid: 5 }),
      }),
    };

    publishTransitionEvent('proj_1', 'run_1', 'planning', 'executing', mockDb as never);

    await vi.waitFor(() => {
      expect(mockPublish).toHaveBeenCalledOnce();
    });

    const [channel, payload] = mockPublish.mock.calls[0]!;
    expect(channel).toBe('conductor:events:proj_1');

    const parsed = JSON.parse(payload) as Record<string, unknown>;
    expect(parsed['kind']).toBe('run.phase_changed');
    expect(parsed['type']).toBeUndefined(); // V1 type field removed
    expect(parsed['id']).toBe(5);
    expect(parsed['fromPhase']).toBe('planning');
    expect(parsed['toPhase']).toBe('executing');
  });
});
