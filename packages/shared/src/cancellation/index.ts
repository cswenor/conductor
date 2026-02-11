/**
 * In-memory cancellation registry for agent runs.
 *
 * Primary mechanism: AbortController signals abort in-flight API calls
 * and tool loops immediately within the same process.
 *
 * Limitation: signals are per-process. In multi-worker deployments, a
 * cancel job processed by worker B won't abort an agent running on
 * worker A. The executor's DB phase check (every iteration) serves as
 * cross-process fallback, but single-shot executeAgent calls (planner,
 * reviewer) will only abort via the local signal. Single worker process
 * is recommended for immediate cancellation guarantees.
 */

interface CancellableEntry {
  controller: AbortController;
  refCount: number;
}

const registry = new Map<string, CancellableEntry>();

/**
 * Register a run as cancellable.
 * If an entry already exists and is not aborted, increments refCount.
 * If an entry exists but is already aborted, returns the aborted controller
 * (the agent will check the signal immediately on start).
 * If no entry exists, creates a new AbortController with refCount=1.
 */
export function registerCancellable(runId: string): AbortController {
  const existing = registry.get(runId);
  if (existing !== undefined) {
    existing.refCount++;
    return existing.controller;
  }

  const controller = new AbortController();
  registry.set(runId, { controller, refCount: 1 });
  return controller;
}

/**
 * Signal cancellation for a run.
 * Returns true if the entry existed (signal fired), false otherwise.
 */
export function signalCancellation(runId: string): boolean {
  const entry = registry.get(runId);
  if (entry === undefined) return false;
  entry.controller.abort();
  return true;
}

/**
 * Check whether a run has been cancelled.
 */
export function isCancelled(runId: string): boolean {
  const entry = registry.get(runId);
  return entry?.controller.signal.aborted === true;
}

/**
 * Get the AbortSignal for a run, if registered.
 */
export function getAbortSignal(runId: string): AbortSignal | undefined {
  return registry.get(runId)?.controller.signal;
}

/**
 * Unregister a run from the cancellation registry.
 * Decrements refCount; only deletes the entry when refCount reaches 0.
 */
export function unregisterCancellable(runId: string): void {
  const entry = registry.get(runId);
  if (entry === undefined) return;
  entry.refCount--;
  if (entry.refCount <= 0) {
    registry.delete(runId);
  }
}

/**
 * Clear the entire registry. For tests only.
 */
export function clearRegistry(): void {
  registry.clear();
}
