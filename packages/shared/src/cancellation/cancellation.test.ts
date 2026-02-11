/**
 * Cancellation Registry Tests
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  registerCancellable,
  signalCancellation,
  isCancelled,
  getAbortSignal,
  unregisterCancellable,
  clearRegistry,
} from './index.ts';

beforeEach(() => {
  clearRegistry();
});

describe('cancellation registry', () => {
  it('registerCancellable creates and returns an AbortController', () => {
    const controller = registerCancellable('run_1');
    expect(controller).toBeInstanceOf(AbortController);
    expect(controller.signal.aborted).toBe(false);
  });

  it('registerCancellable reuses existing controller (increments refCount)', () => {
    const first = registerCancellable('run_1');
    const second = registerCancellable('run_1');
    expect(second).toBe(first);
  });

  it('signalCancellation aborts the signal and returns true', () => {
    registerCancellable('run_1');
    const result = signalCancellation('run_1');
    expect(result).toBe(true);
    expect(isCancelled('run_1')).toBe(true);
  });

  it('signalCancellation returns false for unknown runId', () => {
    const result = signalCancellation('run_nonexistent');
    expect(result).toBe(false);
  });

  it('isCancelled returns true after signal, false before', () => {
    registerCancellable('run_1');
    expect(isCancelled('run_1')).toBe(false);
    signalCancellation('run_1');
    expect(isCancelled('run_1')).toBe(true);
  });

  it('getAbortSignal returns the AbortSignal object', () => {
    const controller = registerCancellable('run_1');
    const signal = getAbortSignal('run_1');
    expect(signal).toBe(controller.signal);
    expect(getAbortSignal('run_nonexistent')).toBeUndefined();
  });

  it('unregisterCancellable decrements refCount; only deletes at 0', () => {
    registerCancellable('run_1');
    registerCancellable('run_1'); // refCount = 2

    unregisterCancellable('run_1'); // refCount = 1
    expect(getAbortSignal('run_1')).toBeDefined();

    unregisterCancellable('run_1'); // refCount = 0, deleted
    expect(getAbortSignal('run_1')).toBeUndefined();
  });
});
