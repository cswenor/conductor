import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const {
  mockHandlePrMerged,
  mockHandlePrStateChange,
} = vi.hoisted(() => ({
  mockHandlePrMerged: vi.fn<(...args: unknown[]) => Promise<void>>().mockResolvedValue(undefined),
  mockHandlePrStateChange: vi.fn(),
}));

vi.mock('./merge-handler.ts', () => ({
  handlePrMerged: mockHandlePrMerged,
  handlePrStateChange: mockHandlePrStateChange,
}));

vi.mock('@conductor/shared', () => ({
  getDatabase: vi.fn(),
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { dispatchPrWebhook } from './webhook-dispatch.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const fakeDb = {} as ReturnType<typeof import('@conductor/shared').getDatabase>;
const mockMirror = vi.fn();
const mockScheduleCleanup = vi.fn<(runId: string) => Promise<void>>().mockResolvedValue(undefined);

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// dispatchPrWebhook
// ---------------------------------------------------------------------------

describe('dispatchPrWebhook', () => {
  it('calls handlePrMerged for pr.merged with prNodeId', async () => {
    await dispatchPrWebhook(
      fakeDb,
      { eventType: 'pr.merged', prNodeId: 'PR_123' },
      mockMirror,
      mockScheduleCleanup,
    );

    expect(mockHandlePrMerged).toHaveBeenCalledWith(
      fakeDb, 'PR_123', mockMirror, mockScheduleCleanup,
    );
    expect(mockHandlePrStateChange).not.toHaveBeenCalled();
  });

  it('calls handlePrStateChange with "closed" for pr.closed', async () => {
    await dispatchPrWebhook(
      fakeDb,
      { eventType: 'pr.closed', prNodeId: 'PR_456' },
      mockMirror,
      mockScheduleCleanup,
    );

    expect(mockHandlePrStateChange).toHaveBeenCalledWith(fakeDb, 'PR_456', 'closed');
    expect(mockHandlePrMerged).not.toHaveBeenCalled();
  });

  it('calls handlePrStateChange with "open" for pr.reopened', async () => {
    await dispatchPrWebhook(
      fakeDb,
      { eventType: 'pr.reopened', prNodeId: 'PR_789' },
      mockMirror,
      mockScheduleCleanup,
    );

    expect(mockHandlePrStateChange).toHaveBeenCalledWith(fakeDb, 'PR_789', 'open');
    expect(mockHandlePrMerged).not.toHaveBeenCalled();
  });

  it('does nothing when prNodeId is undefined', async () => {
    await dispatchPrWebhook(
      fakeDb,
      { eventType: 'pr.merged' },
      mockMirror,
      mockScheduleCleanup,
    );

    expect(mockHandlePrMerged).not.toHaveBeenCalled();
    expect(mockHandlePrStateChange).not.toHaveBeenCalled();
  });

  it('does nothing for unrelated event types', async () => {
    await dispatchPrWebhook(
      fakeDb,
      { eventType: 'issue.opened', prNodeId: 'PR_nope' },
      mockMirror,
      mockScheduleCleanup,
    );

    expect(mockHandlePrMerged).not.toHaveBeenCalled();
    expect(mockHandlePrStateChange).not.toHaveBeenCalled();
  });
});
