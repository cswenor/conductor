import { describe, it, expect } from "vitest";
import {
  WORKFLOW_STATES,
  PRIORITY_LEVELS,
  ISSUE_TYPES,
  WIP_LIMIT,
  SYNC_STALE_MS,
  BOTTLENECK_THRESHOLDS,
  STALE_THRESHOLDS,
  SYNC_LIMITS,
} from "../config.js";

describe("WORKFLOW_STATES", () => {
  it("has 6 states in correct order", () => {
    expect(WORKFLOW_STATES).toEqual([
      "Backlog", "Ready", "Active", "Review", "Rework", "Done",
    ]);
  });
});

describe("PRIORITY_LEVELS", () => {
  it("has 3 levels, all lowercase", () => {
    expect(PRIORITY_LEVELS).toEqual(["critical", "high", "normal"]);
    for (const p of PRIORITY_LEVELS) {
      expect(p).toBe(p.toLowerCase());
    }
  });
});

describe("ISSUE_TYPES", () => {
  it("includes expected types", () => {
    expect(ISSUE_TYPES).toContain("bug");
    expect(ISSUE_TYPES).toContain("feature");
    expect(ISSUE_TYPES).toContain("spike");
    expect(ISSUE_TYPES).toContain("epic");
    expect(ISSUE_TYPES).toContain("chore");
  });
});

describe("operational constants", () => {
  it("WIP_LIMIT is 1", () => {
    expect(WIP_LIMIT).toBe(1);
  });

  it("SYNC_STALE_MS is 1 hour", () => {
    expect(SYNC_STALE_MS).toBe(60 * 60 * 1000);
  });

  it("BOTTLENECK_THRESHOLDS has expected keys", () => {
    expect(BOTTLENECK_THRESHOLDS).toHaveProperty("reviewAvgHours");
    expect(BOTTLENECK_THRESHOLDS).toHaveProperty("reworkAvgHours");
    expect(BOTTLENECK_THRESHOLDS).toHaveProperty("readyAvgHours");
    expect(BOTTLENECK_THRESHOLDS).toHaveProperty("activeAvgHours");
    // Values are reasonable hours
    expect(BOTTLENECK_THRESHOLDS.reviewAvgHours).toBe(24);
    expect(BOTTLENECK_THRESHOLDS.activeAvgHours).toBe(72);
  });

  it("STALE_THRESHOLDS has expected keys", () => {
    expect(STALE_THRESHOLDS.activeDays).toBe(7);
    expect(STALE_THRESHOLDS.reviewDays).toBe(5);
    expect(STALE_THRESHOLDS.reworkDays).toBe(3);
  });

  it("SYNC_LIMITS has reasonable defaults", () => {
    expect(SYNC_LIMITS.issuesPerSync).toBe(200);
    expect(SYNC_LIMITS.prsPerSync).toBe(100);
    expect(SYNC_LIMITS.ghTimeoutMs).toBe(30_000);
    expect(SYNC_LIMITS.ghMaxBuffer).toBe(10 * 1024 * 1024);
  });
});
