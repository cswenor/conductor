/**
 * Smoke tests — exercise MCP tool handlers against a real temp database.
 *
 * These test the actual business logic functions (not JSON-RPC transport)
 * to verify they return meaningful output with realistic data.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const tempDir = mkdtempSync(join(tmpdir(), "pm-smoke-"));

vi.mock("node:child_process", () => ({
  execFile: (cmd: string, args: string[], optsOrCb: unknown, maybeCb?: unknown) => {
    // Handle both (cmd, args, cb) and (cmd, args, opts, cb) signatures
    const cb = (typeof optsOrCb === "function" ? optsOrCb : maybeCb) as
      (err: Error | null, result: { stdout: string; stderr: string }) => void;
    if (cmd === "git" && args?.[0] === "rev-parse") {
      cb(null, { stdout: tempDir + "\n", stderr: "" });
    } else if (cmd === "git" && args?.[0] === "remote") {
      cb(null, { stdout: "https://github.com/test-owner/test-repo.git\n", stderr: "" });
    } else if (cmd === "git" && args?.[0] === "log") {
      cb(null, { stdout: "", stderr: "" });
    } else if (cmd === "gh") {
      // Mock gh commands to return empty results
      cb(null, { stdout: "[]", stderr: "" });
    } else {
      cb(null, { stdout: "", stderr: "" });
    }
  },
}));

const { getDb, closeDb, upsertIssue, moveIssueWorkflow } = await import("../db.js");
const { recordDecision, recordOutcome, getInsights, getDecisions, getOutcomes } = await import("../memory.js");
const { getSprintAnalytics } = await import("../analytics.js");
const { getWorkflowHealth } = await import("../guardrails.js");

// Seed realistic data
beforeAll(async () => {
  const db = await getDb();

  // Create a mix of issues in different workflow states
  const issues = [
    { number: 1, title: "Fix login bug", state: "open", workflow: "Active", priority: "high", labels: ["bug"] },
    { number: 2, title: "Add dark mode", state: "open", workflow: "Backlog", priority: "normal", labels: ["feature"] },
    { number: 3, title: "Update deps", state: "open", workflow: "Ready", priority: "normal", labels: ["chore"] },
    { number: 4, title: "API rate limiting", state: "open", workflow: "Review", priority: "high", labels: ["feature"] },
    { number: 5, title: "Fix typo in docs", state: "closed", workflow: "Done", priority: "normal", labels: ["docs"] },
    { number: 6, title: "Refactor auth", state: "open", workflow: "Rework", priority: "critical", labels: ["tech-debt"] },
    { number: 7, title: "Add search", state: "open", workflow: "Backlog", priority: "normal", labels: ["feature"] },
    { number: 8, title: "Fix CORS issue", state: "closed", workflow: "Done", priority: "high", labels: ["bug"] },
  ];

  for (const issue of issues) {
    await upsertIssue({
      number: issue.number,
      title: issue.title,
      body: `Description for ${issue.title}`,
      state: issue.state,
      author: "testuser",
      created_at: new Date(Date.now() - Math.random() * 30 * 24 * 60 * 60 * 1000).toISOString(),
      updated_at: new Date().toISOString(),
      closed_at: issue.state === "closed" ? new Date().toISOString() : null,
      labels: issue.labels,
      assignees: ["testuser"],
    });
    // Override workflow (upsert defaults to Backlog for open)
    db.prepare("UPDATE issues SET workflow = ?, priority = ? WHERE number = ?")
      .run(issue.workflow, issue.priority, issue.number);
  }

  // Add some workflow events
  const eventInsert = db.prepare(`
    INSERT INTO events (event_type, issue_number, from_value, to_value, actor, timestamp)
    VALUES (?, ?, ?, ?, 'claude', ?)
  `);

  // Simulate issue #5 going Backlog → Ready → Active → Review → Done
  const baseTime = Date.now() - 7 * 24 * 60 * 60 * 1000;
  eventInsert.run("workflow_change", 5, "Backlog", "Ready", new Date(baseTime).toISOString());
  eventInsert.run("workflow_change", 5, "Ready", "Active", new Date(baseTime + 1 * 24 * 60 * 60 * 1000).toISOString());
  eventInsert.run("workflow_change", 5, "Active", "Review", new Date(baseTime + 3 * 24 * 60 * 60 * 1000).toISOString());
  eventInsert.run("workflow_change", 5, "Review", "Done", new Date(baseTime + 4 * 24 * 60 * 60 * 1000).toISOString());

  // Issue #8 going Backlog → Active → Review → Done
  eventInsert.run("workflow_change", 8, "Backlog", "Active", new Date(baseTime + 1 * 24 * 60 * 60 * 1000).toISOString());
  eventInsert.run("workflow_change", 8, "Active", "Review", new Date(baseTime + 2 * 24 * 60 * 60 * 1000).toISOString());
  eventInsert.run("workflow_change", 8, "Review", "Done", new Date(baseTime + 3 * 24 * 60 * 60 * 1000).toISOString());

  // Add a dependency
  db.prepare("INSERT INTO dependencies (blocker_issue, blocked_issue, dep_type) VALUES (?, ?, 'blocks')")
    .run(1, 2);
});

afterAll(() => {
  closeDb();
  rmSync(tempDir, { recursive: true, force: true });
});

describe("board and issue tools", () => {
  it("getLocalBoardSummary returns populated board", async () => {
    const { getLocalBoardSummary } = await import("../db.js");
    const board = await getLocalBoardSummary();
    expect(board.total).toBe(6); // 6 open
    expect(board.byWorkflow["Active"]).toBe(1);
    expect(board.byWorkflow["Backlog"]).toBe(2);
    expect(board.byWorkflow["Review"]).toBe(1);
    expect(board.byWorkflow["Rework"]).toBe(1);
    expect(board.byWorkflow["Ready"]).toBe(1);
    expect(board.activeIssues).toHaveLength(1);
    expect(board.reviewIssues).toHaveLength(1);
    expect(board.reworkIssues).toHaveLength(1);
    expect(board.blockedIssues).toHaveLength(1); // #2 blocked by #1
    expect(board.healthScore).toBeLessThan(100); // Rework penalty
  });

  it("getIssue returns enriched issue data", async () => {
    const { getIssue } = await import("../db.js");
    const issue = await getIssue(1);
    expect(issue).not.toBeNull();
    expect(issue!.title).toBe("Fix login bug");
    expect(issue!.workflow).toBe("Active");
    expect(issue!.priority).toBe("high");
    expect(issue!.labels).toContain("bug");
    expect(issue!.assignees).toContain("testuser");
  });

  it("getDependencies returns graph edges", async () => {
    const { getDependencies } = await import("../db.js");
    const deps = await getDependencies(2);
    expect(deps.blockedBy).toHaveLength(1);
    expect(deps.blockedBy[0].issue).toBe(1);
  });
});

describe("analytics tools", () => {
  it("getSprintAnalytics returns meaningful metrics", async () => {
    const analytics = await getSprintAnalytics(30);
    expect(analytics).toHaveProperty("throughput");
    expect(analytics).toHaveProperty("cycleTime");
    expect(analytics).toHaveProperty("timeInState");
    expect(analytics).toHaveProperty("flowEfficiency");
    expect(analytics).toHaveProperty("reworkAnalysis");
    expect(analytics.period.days).toBe(30);
  });

  it("getCycleTimes returns completed issue timings", async () => {
    const { getCycleTimes } = await import("../db.js");
    const cycles = await getCycleTimes(90);
    expect(cycles.length).toBeGreaterThanOrEqual(1);
    expect(cycles[0]).toHaveProperty("issue_number");
    expect(cycles[0]).toHaveProperty("hours");
    expect(cycles[0].hours).toBeGreaterThan(0);
  });
});

describe("memory tools", () => {
  it("recordDecision and getDecisions round-trip", async () => {
    await recordDecision({
      issueNumber: 1,
      area: "auth",
      type: "architectural",
      decision: "Use JWT with refresh tokens",
      rationale: "Stateless, scales well",
      alternatives: ["Session cookies", "OAuth only"],
    });

    const decisions = await getDecisions(5, 1);
    expect(decisions.length).toBeGreaterThanOrEqual(1);
    expect(decisions[0].decision).toContain("JWT");
    expect(decisions[0].alternatives_considered).toContain("Session cookies");
  });

  it("recordOutcome and getOutcomes round-trip", async () => {
    await recordOutcome({
      issueNumber: 5,
      result: "merged",
      reviewRounds: 2,
      area: "docs",
      lessons: "Always check links before merging docs PRs",
    });

    const outcomes = await getOutcomes(5, { issueNumber: 5 });
    expect(outcomes.length).toBeGreaterThanOrEqual(1);
    expect(outcomes[0].result).toBe("merged");
    expect(outcomes[0].lessons).toContain("links");
  });

  it("getInsights returns aggregate analytics", async () => {
    const insights = await getInsights();
    expect(insights.totalDecisions).toBeGreaterThanOrEqual(1);
    expect(insights.totalOutcomes).toBeGreaterThanOrEqual(1);
    expect(insights).toHaveProperty("reworkRate");
    expect(insights).toHaveProperty("averageReviewRounds");
    expect(insights).toHaveProperty("topAreas");
    expect(insights).toHaveProperty("decisionPatterns");
  });
});

describe("guardrails tools", () => {
  it("getWorkflowHealth returns health assessment", async () => {
    const health = await getWorkflowHealth();
    expect(health).toHaveProperty("period");
    expect(health).toHaveProperty("issueHealth");
    expect(health).toHaveProperty("bottlenecks");
    expect(health).toHaveProperty("summary");
    expect(health.summary.totalIssues).toBeGreaterThanOrEqual(0);
  });
});
