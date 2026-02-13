import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  projectChannel,
  publishTransitionEvent,
  initPublisher,
  _resetPublisher,
  persistAndPublish,
  insertStreamEvent,
  queryStreamEventsForReplay,
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
