import { describe, it, expect, beforeEach } from "vitest";
import { cached, invalidateAll, invalidatePrefix, getCacheStats, TTL } from "../cache.js";

beforeEach(() => {
  invalidateAll();
});

describe("cached()", () => {
  it("computes value on first call", async () => {
    let calls = 0;
    const value = await cached("test:key", 5000, async () => {
      calls++;
      return 42;
    });
    expect(value).toBe(42);
    expect(calls).toBe(1);
  });

  it("returns cached value on second call", async () => {
    let calls = 0;
    const compute = async () => {
      calls++;
      return "hello";
    };

    await cached("test:key", 5000, compute);
    const second = await cached("test:key", 5000, compute);
    expect(second).toBe("hello");
    expect(calls).toBe(1);
  });

  it("recomputes after TTL expires", async () => {
    let calls = 0;
    const compute = async () => {
      calls++;
      return calls;
    };

    // Use a TTL of 1ms so it expires immediately
    await cached("test:expire", 1, compute);
    // Wait for expiry
    await new Promise((r) => setTimeout(r, 10));
    const second = await cached("test:expire", 1, compute);
    expect(second).toBe(2);
    expect(calls).toBe(2);
  });
});

describe("invalidateAll()", () => {
  it("clears all cached entries", async () => {
    await cached("a", 5000, async () => 1);
    await cached("b", 5000, async () => 2);
    expect(getCacheStats().entries).toBe(2);

    invalidateAll();
    expect(getCacheStats().entries).toBe(0);
  });
});

describe("invalidatePrefix()", () => {
  it("clears only entries matching the prefix", async () => {
    await cached("github:issues", 5000, async () => 1);
    await cached("github:prs", 5000, async () => 2);
    await cached("git:log", 5000, async () => 3);

    invalidatePrefix("github:");
    const stats = getCacheStats();
    expect(stats.entries).toBe(1);
    expect(stats.keys).toEqual(["git:log"]);
  });
});

describe("getCacheStats()", () => {
  it("reports active vs total entries", async () => {
    // Add one with 1ms TTL (will expire) and one with 5s TTL
    await cached("short", 1, async () => "x");
    await new Promise((r) => setTimeout(r, 10));
    await cached("long", 5000, async () => "y");

    const stats = getCacheStats();
    expect(stats.entries).toBe(2);
    expect(stats.activeEntries).toBe(1);
    expect(stats.keys).toContain("short");
    expect(stats.keys).toContain("long");
  });
});

describe("TTL presets", () => {
  it("has expected values", () => {
    expect(TTL.GITHUB).toBe(5 * 60 * 1000);
    expect(TTL.GIT).toBe(2 * 60 * 1000);
    expect(TTL.DB).toBe(30 * 1000);
    expect(TTL.COMPUTED).toBe(60 * 1000);
  });
});
