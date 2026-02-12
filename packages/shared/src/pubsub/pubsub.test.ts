import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  projectChannel,
  publishTransitionEvent,
  initPublisher,
  _resetPublisher,
  type StreamEvent,
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
  // publishTransitionEvent — with init
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

    const received: StreamEvent[] = [];
    await subscriber.subscribe(['proj_1'], (event) => received.push(event));

    // Verify redis.subscribe was called with the correct channel
    expect(mockSubscribe).toHaveBeenCalledWith('conductor:events:proj_1');

    // Verify redis.on('message', handler) was registered
    expect(mockOn).toHaveBeenCalledWith('message', expect.any(Function));

    // Simulate receiving a message
    const handler = mockOn.mock.calls.find(
      (call: unknown[]) => call[0] === 'message',
    )?.[1] as (channel: string, message: string) => void;

    const testEvent: StreamEvent = {
      type: 'run.phase_changed',
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

  // -------------------------------------------------------------------------
  // initPublisher is idempotent
  // -------------------------------------------------------------------------

  it('initPublisher does not re-initialize if already initialized', () => {
    initPublisher('redis://localhost:6379');
    initPublisher('redis://localhost:6380'); // Should be ignored
    // Only one connect call
    expect(mockConnect).toHaveBeenCalledTimes(1);
  });
});
