import { readFileSync } from 'node:fs';
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

// ---------------------------------------------------------------------------
// P0 regression: processWebhook must call dispatchPrWebhook unconditionally
// ---------------------------------------------------------------------------

describe('processWebhook call-site regression', () => {
  it('dispatchPrWebhook is not guarded by event !== null in index.ts', () => {
    // This structural test ensures that future refactors don't re-introduce
    // the P0 bug where duplicate events (createEvent returns null) would
    // skip PR dispatch. The dispatch must run regardless of deduplication.
    const src = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');

    // Find the dispatchPrWebhook call
    const dispatchIdx = src.indexOf('dispatchPrWebhook');
    expect(dispatchIdx).toBeGreaterThan(-1);

    // Find the 'event !== null' / 'event === null' checks
    const eventNullCheckIdx = src.indexOf('event !== null');
    // The dispatch call must NOT be inside either event-null branch.
    // Verify dispatch comes after both branches have closed.
    if (eventNullCheckIdx !== -1) {
      // Find the closing of the if/else block that checks event
      // The dispatch should be at a higher scope (after the if/else)
      const afterEventCheck = src.slice(eventNullCheckIdx);
      const dispatchInSlice = afterEventCheck.indexOf('dispatchPrWebhook');

      // Find how many braces deep we go — dispatch should be after the
      // if/else block closes. Simple check: ensure there's a closing brace
      // before the dispatch call that balances the if-block opening.
      const beforeDispatch = afterEventCheck.slice(0, dispatchInSlice);
      const opens = (beforeDispatch.match(/\{/g) ?? []).length;
      const closes = (beforeDispatch.match(/\}/g) ?? []).length;

      // The if/else block opens at least 2 braces (if + else) and closes them.
      // If dispatch is outside, closes >= opens for the event-check scope.
      expect(closes).toBeGreaterThanOrEqual(opens);
    }

    // Also verify there's no early return between createEvent and dispatch
    const createEventIdx = src.indexOf('createEvent(db,');
    expect(createEventIdx).toBeGreaterThan(-1);
    const betweenCreateAndDispatch = src.slice(createEventIdx, dispatchIdx);
    expect(betweenCreateAndDispatch).not.toContain('return Promise.resolve()');
    expect(betweenCreateAndDispatch).not.toContain('return;');
  });
});
