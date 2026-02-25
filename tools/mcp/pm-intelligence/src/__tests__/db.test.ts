/**
 * Database integration tests using a real temp SQLite database.
 *
 * We mock `getRepoRoot()` so that getDb() creates a temp .pm/state.db
 * instead of trying to find a real git repo root.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Create temp dir before any imports that use getRepoRoot
const tempDir = mkdtempSync(join(tmpdir(), "pm-test-"));

// Mock the child_process execFile to return our temp dir for git rev-parse
vi.mock("node:child_process", () => ({
  execFile: (cmd: string, args: string[], cb: (err: Error | null, result: { stdout: string }) => void) => {
    if (cmd === "git" && args?.[0] === "rev-parse") {
      cb(null, { stdout: tempDir + "\n" });
    } else if (cmd === "git" && args?.[0] === "remote") {
      cb(null, { stdout: "https://github.com/test-owner/test-repo.git\n" });
    } else {
      cb(new Error(`Unmocked execFile: ${cmd} ${args?.join(" ")}`), { stdout: "" });
    }
  },
}));

// Now import the modules under test
const {
  getDb,
  closeDb,
  getIssue,
  upsertIssue,
  moveIssueWorkflow,
  addDependency,
  getDependencies,
  queryEvents,
  getCycleTimes,
  getLocalBoardSummary,
  VALID_WORKFLOWS,
  VALID_PRIORITIES,
} = await import("../db.js");

afterAll(() => {
  closeDb();
  rmSync(tempDir, { recursive: true, force: true });
});

// Helper: insert a test issue directly
async function insertTestIssue(number: number, opts?: {
  workflow?: string;
  priority?: string;
  state?: string;
  title?: string;
}) {
  const db = await getDb();
  db.prepare(`
    INSERT OR REPLACE INTO issues (number, title, body, state, author, created_at, updated_at, workflow, priority)
    VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'), ?, ?)
  `).run(
    number,
    opts?.title ?? `Test Issue ${number}`,
    `Body of issue ${number}`,
    opts?.state ?? "open",
    "testuser",
    opts?.workflow ?? "Backlog",
    opts?.priority ?? "normal",
  );
}

describe("schema", () => {
  it("creates all expected tables", async () => {
    const db = await getDb();
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as Array<{ name: string }>;
    const names = tables.map((t) => t.name);

    expect(names).toContain("issues");
    expect(names).toContain("events");
    expect(names).toContain("pull_requests");
    expect(names).toContain("dependencies");
    expect(names).toContain("decisions");
    expect(names).toContain("outcomes");
    expect(names).toContain("sessions");
    expect(names).toContain("sync_state");
    expect(names).toContain("schema_version");
  });

  it("tracks schema version", async () => {
    const db = await getDb();
    const row = db.prepare("SELECT MAX(version) as v FROM schema_version").get() as { v: number };
    expect(row.v).toBe(1);
  });
});

describe("constants", () => {
  it("has 6 valid workflow states", () => {
    expect(VALID_WORKFLOWS).toEqual(["Backlog", "Ready", "Active", "Review", "Rework", "Done"]);
  });

  it("has 3 valid priorities (lowercase)", () => {
    expect(VALID_PRIORITIES).toEqual(["critical", "high", "normal"]);
  });
});

describe("upsertIssue()", () => {
  it("inserts a new issue", async () => {
    const result = await upsertIssue({
      number: 100,
      title: "Test Issue",
      body: "Body text",
      state: "open",
      author: "alice",
      created_at: "2025-01-01T00:00:00Z",
      updated_at: "2025-01-01T00:00:00Z",
      closed_at: null,
      labels: ["bug", "urgent"],
      assignees: ["alice", "bob"],
    });

    expect(result.isNew).toBe(true);

    const issue = await getIssue(100);
    expect(issue).not.toBeNull();
    expect(issue!.title).toBe("Test Issue");
    expect(issue!.workflow).toBe("Backlog");
    expect(issue!.priority).toBe("normal");
    expect(issue!.labels).toEqual(["bug", "urgent"]);
    expect(issue!.assignees).toEqual(["alice", "bob"]);
  });

  it("updates existing issue preserving local fields", async () => {
    // First upsert
    await upsertIssue({
      number: 101,
      title: "Original Title",
      body: null,
      state: "open",
      author: "alice",
      created_at: "2025-01-01T00:00:00Z",
      updated_at: "2025-01-01T00:00:00Z",
      closed_at: null,
      labels: [],
      assignees: [],
    });

    // Move to Active (local-only field)
    await moveIssueWorkflow(101, "Ready");
    await moveIssueWorkflow(101, "Active");

    // Second upsert (simulating re-sync)
    const result = await upsertIssue({
      number: 101,
      title: "Updated Title",
      body: "New body",
      state: "open",
      author: "alice",
      created_at: "2025-01-01T00:00:00Z",
      updated_at: "2025-01-02T00:00:00Z",
      closed_at: null,
      labels: ["feature"],
      assignees: ["bob"],
    });

    expect(result.isNew).toBe(false);

    const issue = await getIssue(101);
    expect(issue!.title).toBe("Updated Title");
    expect(issue!.workflow).toBe("Active"); // Preserved
    expect(issue!.labels).toEqual(["feature"]);
  });

  it("auto-transitions to Done when GitHub closes the issue", async () => {
    await upsertIssue({
      number: 102,
      title: "To be closed",
      body: null,
      state: "open",
      author: "alice",
      created_at: "2025-01-01T00:00:00Z",
      updated_at: "2025-01-01T00:00:00Z",
      closed_at: null,
      labels: [],
      assignees: [],
    });

    // Sync with closed state
    await upsertIssue({
      number: 102,
      title: "To be closed",
      body: null,
      state: "closed",
      author: "alice",
      created_at: "2025-01-01T00:00:00Z",
      updated_at: "2025-01-02T00:00:00Z",
      closed_at: "2025-01-02T00:00:00Z",
      labels: [],
      assignees: [],
    });

    const issue = await getIssue(102);
    expect(issue!.workflow).toBe("Done");
  });
});

describe("moveIssueWorkflow()", () => {
  // Clear any Active issues from prior tests to avoid WIP limit interference
  beforeEach(async () => {
    const db = await getDb();
    db.prepare("UPDATE issues SET workflow = 'Done', state = 'closed' WHERE workflow = 'Active'").run();
  });

  it("moves issue through valid transitions", async () => {
    await insertTestIssue(200, { workflow: "Backlog" });

    const r1 = await moveIssueWorkflow(200, "Ready");
    expect(r1.from).toBe("Backlog");
    expect(r1.to).toBe("Ready");

    const r2 = await moveIssueWorkflow(200, "Active");
    expect(r2.from).toBe("Ready");
    expect(r2.to).toBe("Active");

    const r3 = await moveIssueWorkflow(200, "Review");
    expect(r3.from).toBe("Active");
    expect(r3.to).toBe("Review");

    const r4 = await moveIssueWorkflow(200, "Done");
    expect(r4.from).toBe("Review");
    expect(r4.to).toBe("Done");
  });

  it("rejects invalid transitions", async () => {
    await insertTestIssue(201, { workflow: "Backlog" });
    await expect(moveIssueWorkflow(201, "Done")).rejects.toThrow("Invalid transition");
  });

  it("throws for nonexistent issue", async () => {
    await expect(moveIssueWorkflow(9999, "Active")).rejects.toThrow("not found");
  });

  it("enforces WIP limit of 1 Active issue", async () => {
    await insertTestIssue(210, { workflow: "Active" });
    await insertTestIssue(211, { workflow: "Ready" });
    await expect(moveIssueWorkflow(211, "Active")).rejects.toThrow("WIP limit");
  });

  it("records workflow_change event", async () => {
    await insertTestIssue(220, { workflow: "Backlog" });
    await moveIssueWorkflow(220, "Ready");

    const events = await queryEvents({ issueNumber: 220, eventType: "workflow_change" });
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events[0].from_value).toBe("Backlog");
    expect(events[0].to_value).toBe("Ready");
  });

  it("marks issue closed when moved to Done", async () => {
    await insertTestIssue(230, { workflow: "Review", state: "open" });
    await moveIssueWorkflow(230, "Done");

    const issue = await getIssue(230);
    expect(issue!.state).toBe("closed");
  });

  it("auto-resolves dependencies when blocker moves to Done", async () => {
    await insertTestIssue(240, { workflow: "Review" });
    await insertTestIssue(241, { workflow: "Backlog" });
    await addDependency(240, 241);

    const depsBefore = await getDependencies(241);
    expect(depsBefore.blockedBy[0].resolved).toBe(false);

    await moveIssueWorkflow(240, "Done");

    const depsAfter = await getDependencies(241);
    expect(depsAfter.blockedBy[0].resolved).toBe(true);
  });
});

describe("addDependency()", () => {
  it("creates a dependency between issues", async () => {
    await insertTestIssue(300);
    await insertTestIssue(301);
    await addDependency(300, 301);

    const deps = await getDependencies(301);
    expect(deps.blockedBy).toHaveLength(1);
    expect(deps.blockedBy[0].issue).toBe(300);
    expect(deps.blockedBy[0].type).toBe("blocks");

    const blockerDeps = await getDependencies(300);
    expect(blockerDeps.blocks).toHaveLength(1);
    expect(blockerDeps.blocks[0].issue).toBe(301);
  });

  it("prevents self-dependency", async () => {
    await insertTestIssue(310);
    await expect(addDependency(310, 310)).rejects.toThrow("cannot depend on itself");
  });

  it("detects cycles", async () => {
    await insertTestIssue(320);
    await insertTestIssue(321);
    await insertTestIssue(322);

    await addDependency(320, 321); // 320 blocks 321
    await addDependency(321, 322); // 321 blocks 322
    await expect(addDependency(322, 320)).rejects.toThrow("cycle");
  });
});

describe("queryEvents()", () => {
  beforeEach(async () => {
    const db = await getDb();
    db.prepare("UPDATE issues SET workflow = 'Done', state = 'closed' WHERE workflow = 'Active'").run();
  });

  it("returns events for an issue", async () => {
    await insertTestIssue(400, { workflow: "Backlog" });
    await moveIssueWorkflow(400, "Ready");
    await moveIssueWorkflow(400, "Active");

    const events = await queryEvents({ issueNumber: 400, eventType: "workflow_change" });
    expect(events.length).toBeGreaterThanOrEqual(2);
    // Both transitions recorded
    const toValues = events.map((e) => e.to_value);
    expect(toValues).toContain("Ready");
    expect(toValues).toContain("Active");
  });

  it("filters by event type", async () => {
    await insertTestIssue(410, { workflow: "Backlog" });
    await moveIssueWorkflow(410, "Ready");
    await addDependency(410, 300); // Creates a dependency_added event

    const workflowEvents = await queryEvents({ issueNumber: 410, eventType: "workflow_change" });
    expect(workflowEvents.every((e) => e.event_type === "workflow_change")).toBe(true);
  });

  it("respects limit", async () => {
    const events = await queryEvents({ limit: 2 });
    expect(events.length).toBeLessThanOrEqual(2);
  });
});

describe("getLocalBoardSummary()", () => {
  it("returns board with workflow counts and health score", async () => {
    const board = await getLocalBoardSummary();
    expect(board).toHaveProperty("total");
    expect(board).toHaveProperty("byWorkflow");
    expect(board).toHaveProperty("byPriority");
    expect(board).toHaveProperty("healthScore");
    expect(board.healthScore).toBeGreaterThanOrEqual(0);
    expect(board.healthScore).toBeLessThanOrEqual(100);
  });
});
