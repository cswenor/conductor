/**
 * In-memory TTL cache for expensive MCP tool operations.
 *
 * Caches at the data-source level (not tool level) so multiple tools
 * benefit from a single cached GitHub API call or git operation.
 *
 * Default TTLs:
 *   - GitHub data (velocity, PRs): 5 minutes
 *   - Git operations (history, commits): 2 minutes
 *   - Database queries (board, analytics): 30 seconds
 *
 * Cache is invalidated automatically on sync_from_github.
 */

// ─── Types ──────────────────────────────────────────────

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

// ─── TTL Presets (milliseconds) ─────────────────────────

export const TTL = {
  /** GitHub API data: velocity, PRs, issues */
  GITHUB: 5 * 60 * 1000,
  /** Git log operations: history, commits, hotspots */
  GIT: 2 * 60 * 1000,
  /** Database aggregate queries: board, analytics */
  DB: 30 * 1000,
  /** Expensive computed results: dashboard, risk radar */
  COMPUTED: 60 * 1000,
} as const;

// ─── Cache Implementation ───────────────────────────────

const store = new Map<string, CacheEntry<unknown>>();

/**
 * Get a cached value, or compute and cache it if missing/expired.
 */
export async function cached<T>(
  key: string,
  ttlMs: number,
  compute: () => Promise<T>
): Promise<T> {
  const existing = store.get(key) as CacheEntry<T> | undefined;
  if (existing && existing.expiresAt > Date.now()) {
    return existing.value;
  }

  const value = await compute();
  store.set(key, { value, expiresAt: Date.now() + ttlMs });
  return value;
}

/**
 * Invalidate all cached entries (e.g. after sync).
 */
export function invalidateAll(): void {
  store.clear();
}

/**
 * Invalidate entries matching a key prefix.
 */
export function invalidatePrefix(prefix: string): void {
  for (const key of store.keys()) {
    if (key.startsWith(prefix)) {
      store.delete(key);
    }
  }
}

/**
 * Get cache statistics for observability.
 */
export function getCacheStats(): {
  entries: number;
  activeEntries: number;
  keys: string[];
} {
  const now = Date.now();
  let activeEntries = 0;
  for (const entry of store.values()) {
    if ((entry as CacheEntry<unknown>).expiresAt > now) {
      activeEntries++;
    }
  }

  return {
    entries: store.size,
    activeEntries,
    keys: Array.from(store.keys()),
  };
}
