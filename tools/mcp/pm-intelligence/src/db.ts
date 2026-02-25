/**
 * Local SQLite database — the PM brain.
 *
 * GitHub is the source of truth for issue content (title, body, labels, state).
 * This database stores:
 *   1. A mirror of GitHub issue/PR metadata (refreshed on sync)
 *   2. Local-only PM state (workflow, priority, dependencies)
 *   3. Event history (every state change with timestamp)
 *   4. Decisions, outcomes, and session data
 *
 * Schema is event-sourced: every mutation records an event, enabling
 * full history reconstruction, velocity calculation, and pattern detection.
 */

import Database from "better-sqlite3";
import { existsSync, mkdirSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";

const execFileAsync = promisify(execFile);

// ─── Database Singleton ─────────────────────────────────

let _db: Database.Database | null = null;
let _dbPath: string | null = null;

/**
 * Get the main repo root (cached).
 * In git worktrees, --show-toplevel returns the worktree root, but .pm/
 * lives in the main repo. Use --git-common-dir to find the main repo.
 */
let _repoRoot: string | null = null;
async function getRepoRoot(): Promise<string> {
  if (_repoRoot) return _repoRoot;
  const { stdout: commonDir } = await execFileAsync("git", [
    "rev-parse",
    "--git-common-dir",
  ]);
  const trimmed = commonDir.trim();
  if (trimmed === ".git") {
    // In main repo — use --show-toplevel
    const { stdout } = await execFileAsync("git", [
      "rev-parse",
      "--show-toplevel",
    ]);
    _repoRoot = stdout.trim();
  } else {
    // In a worktree — commonDir is <main-repo>/.git, go up one level
    _repoRoot = join(trimmed, "..");
  }
  return _repoRoot;
}

/** Get or create the database connection */
export async function getDb(): Promise<Database.Database> {
  if (_db) return _db;

  const root = await getRepoRoot();
  const pmDir = join(root, ".pm");
  if (!existsSync(pmDir)) {
    mkdirSync(pmDir, { recursive: true });
  }

  _dbPath = join(pmDir, "state.db");
  _db = new Database(_dbPath);

  // Performance pragmas
  _db.pragma("journal_mode = WAL");
  _db.pragma("synchronous = NORMAL");
  _db.pragma("foreign_keys = ON");

  // Run migrations
  migrate(_db);

  return _db;
}

/** Close the database connection */
export function closeDb(): void {
  if (_db) {
    _db.close();
    _db = null;
    _dbPath = null;
  }
}

/** Get the .pm directory path */
export async function getPmDir(): Promise<string> {
  const root = await getRepoRoot();
  return join(root, ".pm");
}

// ─── Schema Migrations ──────────────────────────────────

const MIGRATIONS: Array<{ version: number; sql: string }> = [
  {
    version: 1,
    sql: `
      -- Issues: mirrored from GitHub + local enrichment
      CREATE TABLE IF NOT EXISTS issues (
        number        INTEGER PRIMARY KEY,
        title         TEXT NOT NULL,
        body          TEXT,
        state         TEXT NOT NULL DEFAULT 'open',    -- GitHub state: open/closed
        author        TEXT,
        created_at    TEXT NOT NULL,
        updated_at    TEXT NOT NULL,
        closed_at     TEXT,

        -- Local-only PM fields (not on GitHub)
        workflow      TEXT NOT NULL DEFAULT 'Backlog',  -- Backlog/Ready/Active/Review/Rework/Done
        priority      TEXT NOT NULL DEFAULT 'normal',   -- critical/high/normal
        estimate      TEXT,                             -- T-shirt: xs/s/m/l/xl
        risk          TEXT DEFAULT 'medium',            -- low/medium/high

        -- Sync metadata
        synced_at     TEXT NOT NULL DEFAULT (datetime('now')),
        github_etag   TEXT                              -- For conditional requests
      );

      -- Issue labels (many-to-many, mirrored from GitHub)
      CREATE TABLE IF NOT EXISTS issue_labels (
        issue_number  INTEGER NOT NULL REFERENCES issues(number) ON DELETE CASCADE,
        label         TEXT NOT NULL,
        PRIMARY KEY (issue_number, label)
      );

      -- Issue assignees (mirrored from GitHub)
      CREATE TABLE IF NOT EXISTS issue_assignees (
        issue_number  INTEGER NOT NULL REFERENCES issues(number) ON DELETE CASCADE,
        login         TEXT NOT NULL,
        PRIMARY KEY (issue_number, login)
      );

      -- Pull requests: mirrored from GitHub
      CREATE TABLE IF NOT EXISTS pull_requests (
        number        INTEGER PRIMARY KEY,
        title         TEXT NOT NULL,
        state         TEXT NOT NULL DEFAULT 'open',    -- open/closed/merged
        author        TEXT,
        branch        TEXT,
        base_branch   TEXT DEFAULT 'main',
        created_at    TEXT NOT NULL,
        updated_at    TEXT NOT NULL,
        merged_at     TEXT,
        closed_at     TEXT,
        additions     INTEGER DEFAULT 0,
        deletions     INTEGER DEFAULT 0,
        changed_files INTEGER DEFAULT 0,
        review_state  TEXT,                            -- pending/approved/changes_requested
        draft         INTEGER DEFAULT 0,               -- boolean
        synced_at     TEXT NOT NULL DEFAULT (datetime('now'))
      );

      -- PR-to-Issue links (from "Fixes #X" in PR body)
      CREATE TABLE IF NOT EXISTS pr_issue_links (
        pr_number     INTEGER NOT NULL REFERENCES pull_requests(number) ON DELETE CASCADE,
        issue_number  INTEGER NOT NULL REFERENCES issues(number) ON DELETE CASCADE,
        link_type     TEXT NOT NULL DEFAULT 'fixes',   -- fixes/closes/resolves/references
        PRIMARY KEY (pr_number, issue_number)
      );

      -- Dependencies: local-only, real graph
      CREATE TABLE IF NOT EXISTS dependencies (
        blocker_issue   INTEGER NOT NULL REFERENCES issues(number) ON DELETE CASCADE,
        blocked_issue   INTEGER NOT NULL REFERENCES issues(number) ON DELETE CASCADE,
        dep_type        TEXT NOT NULL DEFAULT 'blocks', -- blocks/prerequisite/related
        created_at      TEXT NOT NULL DEFAULT (datetime('now')),
        resolved_at     TEXT,
        PRIMARY KEY (blocker_issue, blocked_issue)
      );

      -- Events: every state change, append-only
      CREATE TABLE IF NOT EXISTS events (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp     TEXT NOT NULL DEFAULT (datetime('now')),
        event_type    TEXT NOT NULL,                    -- workflow_change/priority_change/created/closed/comment/sync/decision/outcome/dependency_added/dependency_resolved
        issue_number  INTEGER REFERENCES issues(number),
        pr_number     INTEGER REFERENCES pull_requests(number),
        from_value    TEXT,
        to_value      TEXT,
        actor         TEXT,                             -- 'claude'/'human'/'sync'
        session_id    TEXT,
        metadata      TEXT                              -- JSON blob for extra data
      );

      -- Decisions: architectural decisions with context
      CREATE TABLE IF NOT EXISTS decisions (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp     TEXT NOT NULL DEFAULT (datetime('now')),
        issue_number  INTEGER REFERENCES issues(number),
        area          TEXT,
        decision_type TEXT NOT NULL DEFAULT 'architectural',
        decision      TEXT NOT NULL,
        rationale     TEXT,
        alternatives  TEXT,                             -- JSON array
        files         TEXT,                             -- JSON array
        session_id    TEXT
      );

      -- Outcomes: work results for learning
      CREATE TABLE IF NOT EXISTS outcomes (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp     TEXT NOT NULL DEFAULT (datetime('now')),
        issue_number  INTEGER NOT NULL REFERENCES issues(number),
        pr_number     INTEGER REFERENCES pull_requests(number),
        result        TEXT NOT NULL,                    -- merged/rework/abandoned
        review_rounds INTEGER,
        rework_reasons TEXT,                            -- JSON array
        area          TEXT,
        approach      TEXT,
        lessons       TEXT,
        cycle_time_hours REAL                           -- Active → Done in hours
      );

      -- Sessions: track Claude Code sessions
      CREATE TABLE IF NOT EXISTS sessions (
        id            TEXT PRIMARY KEY,                 -- UUID
        started_at    TEXT NOT NULL DEFAULT (datetime('now')),
        ended_at      TEXT,
        issue_number  INTEGER REFERENCES issues(number),
        focus_area    TEXT,
        tools_used    INTEGER DEFAULT 0,
        tokens_used   INTEGER DEFAULT 0
      );

      -- Sync state: track last sync per resource type
      CREATE TABLE IF NOT EXISTS sync_state (
        resource      TEXT PRIMARY KEY,                 -- 'issues'/'pull_requests'/'labels'
        last_sync     TEXT NOT NULL,
        cursor        TEXT,                             -- GitHub pagination cursor
        etag          TEXT                              -- For conditional requests
      );

      -- Indexes for common queries
      CREATE INDEX IF NOT EXISTS idx_events_issue ON events(issue_number);
      CREATE INDEX IF NOT EXISTS idx_events_type ON events(event_type);
      CREATE INDEX IF NOT EXISTS idx_events_timestamp ON events(timestamp);
      CREATE INDEX IF NOT EXISTS idx_issues_workflow ON issues(workflow);
      CREATE INDEX IF NOT EXISTS idx_issues_priority ON issues(priority);
      CREATE INDEX IF NOT EXISTS idx_issues_state ON issues(state);
      CREATE INDEX IF NOT EXISTS idx_deps_blocked ON dependencies(blocked_issue);
      CREATE INDEX IF NOT EXISTS idx_deps_blocker ON dependencies(blocker_issue);
      CREATE INDEX IF NOT EXISTS idx_pr_links_issue ON pr_issue_links(issue_number);
      CREATE INDEX IF NOT EXISTS idx_outcomes_issue ON outcomes(issue_number);
      CREATE INDEX IF NOT EXISTS idx_decisions_issue ON decisions(issue_number);

      -- Schema version tracking
      CREATE TABLE IF NOT EXISTS schema_version (
        version       INTEGER PRIMARY KEY,
        applied_at    TEXT NOT NULL DEFAULT (datetime('now'))
      );

      INSERT OR IGNORE INTO schema_version (version) VALUES (1);
    `,
  },
];

/** Run pending migrations */
function migrate(db: Database.Database): void {
  // Ensure schema_version table exists (bootstrap)
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version       INTEGER PRIMARY KEY,
      applied_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  const currentVersion =
    (
      db.prepare("SELECT MAX(version) as v FROM schema_version").get() as {
        v: number | null;
      }
    )?.v ?? 0;

  for (const migration of MIGRATIONS) {
    if (migration.version > currentVersion) {
      db.exec(migration.sql);
    }
  }
}

// ─── Query Helpers ───────────────────────────────────────

export type WorkflowState =
  | "Backlog"
  | "Ready"
  | "Active"
  | "Review"
  | "Rework"
  | "Done";

export const VALID_WORKFLOWS: WorkflowState[] = [
  "Backlog",
  "Ready",
  "Active",
  "Review",
  "Rework",
  "Done",
];

export const VALID_PRIORITIES = ["critical", "high", "normal"] as const;
export type Priority = (typeof VALID_PRIORITIES)[number];

export interface LocalIssue {
  number: number;
  title: string;
  body: string | null;
  state: string;
  author: string | null;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  workflow: WorkflowState;
  priority: Priority;
  estimate: string | null;
  risk: string | null;
  labels: string[];
  assignees: string[];
  synced_at: string;
}

/** Get an issue with its labels and assignees */
export async function getIssue(issueNumber: number): Promise<LocalIssue | null> {
  const db = await getDb();

  const row = db
    .prepare("SELECT * FROM issues WHERE number = ?")
    .get(issueNumber) as Record<string, unknown> | undefined;

  if (!row) return null;

  const labels = db
    .prepare("SELECT label FROM issue_labels WHERE issue_number = ?")
    .all(issueNumber) as Array<{ label: string }>;

  const assignees = db
    .prepare("SELECT login FROM issue_assignees WHERE issue_number = ?")
    .all(issueNumber) as Array<{ login: string }>;

  return {
    number: row.number as number,
    title: row.title as string,
    body: row.body as string | null,
    state: row.state as string,
    author: row.author as string | null,
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
    closed_at: row.closed_at as string | null,
    workflow: row.workflow as WorkflowState,
    priority: row.priority as Priority,
    estimate: row.estimate as string | null,
    risk: row.risk as string | null,
    labels: labels.map((l) => l.label),
    assignees: assignees.map((a) => a.login),
    synced_at: row.synced_at as string,
  };
}

/** Get all issues in a workflow state */
export async function getIssuesByWorkflow(
  workflow: WorkflowState
): Promise<LocalIssue[]> {
  const db = await getDb();

  const rows = db
    .prepare("SELECT number FROM issues WHERE workflow = ? AND state = 'open' ORDER BY priority DESC, created_at ASC")
    .all(workflow) as Array<{ number: number }>;

  const issues: LocalIssue[] = [];
  for (const row of rows) {
    const issue = await getIssue(row.number);
    if (issue) issues.push(issue);
  }
  return issues;
}

/** Get board summary from local DB */
export async function getLocalBoardSummary(): Promise<{
  total: number;
  byWorkflow: Record<string, number>;
  byPriority: Record<string, number>;
  activeIssues: LocalIssue[];
  reviewIssues: LocalIssue[];
  reworkIssues: LocalIssue[];
  blockedIssues: Array<{ issue: LocalIssue; blockedBy: number[] }>;
  healthScore: number;
}> {
  const db = await getDb();

  // Counts by workflow (open issues only)
  const workflowCounts = db
    .prepare(
      "SELECT workflow, COUNT(*) as count FROM issues WHERE state = 'open' GROUP BY workflow"
    )
    .all() as Array<{ workflow: string; count: number }>;

  const byWorkflow: Record<string, number> = {};
  for (const row of workflowCounts) {
    byWorkflow[row.workflow] = row.count;
  }

  // Counts by priority (open issues only)
  const priorityCounts = db
    .prepare(
      "SELECT priority, COUNT(*) as count FROM issues WHERE state = 'open' GROUP BY priority"
    )
    .all() as Array<{ priority: string; count: number }>;

  const byPriority: Record<string, number> = {};
  for (const row of priorityCounts) {
    byPriority[row.priority] = row.count;
  }

  const activeIssues = await getIssuesByWorkflow("Active");
  const reviewIssues = await getIssuesByWorkflow("Review");
  const reworkIssues = await getIssuesByWorkflow("Rework");

  // Blocked issues: those with unresolved dependencies
  const blockedRows = db
    .prepare(`
      SELECT DISTINCT d.blocked_issue, d.blocker_issue
      FROM dependencies d
      JOIN issues blocker ON blocker.number = d.blocker_issue
      WHERE d.resolved_at IS NULL
        AND blocker.workflow != 'Done'
        AND blocker.state = 'open'
    `)
    .all() as Array<{ blocked_issue: number; blocker_issue: number }>;

  const blockedMap = new Map<number, number[]>();
  for (const row of blockedRows) {
    const existing = blockedMap.get(row.blocked_issue) || [];
    existing.push(row.blocker_issue);
    blockedMap.set(row.blocked_issue, existing);
  }

  const blockedIssues: Array<{ issue: LocalIssue; blockedBy: number[] }> = [];
  for (const [issueNum, blockers] of blockedMap) {
    const issue = await getIssue(issueNum);
    if (issue) blockedIssues.push({ issue, blockedBy: blockers });
  }

  // Total open issues
  const totalRow = db
    .prepare("SELECT COUNT(*) as count FROM issues WHERE state = 'open'")
    .get() as { count: number };

  // Health score
  const total = totalRow.count;
  let healthScore = 100;
  const active = byWorkflow["Active"] || 0;
  if (active > 1) healthScore -= (active - 1) * 15;
  const rework = byWorkflow["Rework"] || 0;
  if (rework > 0) healthScore -= rework * 10;
  const review = byWorkflow["Review"] || 0;
  if (review > 3) healthScore -= (review - 3) * 5;
  const backlog = byWorkflow["Backlog"] || 0;
  if (total > 0 && backlog / total > 0.5) healthScore -= 10;
  if (blockedIssues.length > 0) healthScore -= Math.min(blockedIssues.length * 5, 20);
  healthScore = Math.max(0, Math.min(100, healthScore));

  return {
    total,
    byWorkflow,
    byPriority,
    activeIssues,
    reviewIssues,
    reworkIssues,
    blockedIssues,
    healthScore,
  };
}

// ─── Workflow Engine ─────────────────────────────────────

/** Valid workflow transitions */
const VALID_TRANSITIONS: Record<WorkflowState, WorkflowState[]> = {
  Backlog: ["Ready", "Active"],
  Ready: ["Active", "Backlog"],
  Active: ["Review", "Backlog", "Ready"],
  Review: ["Done", "Rework", "Active"],
  Rework: ["Active", "Review"],
  Done: ["Active"], // Reopen
};

/** Move an issue to a new workflow state */
export async function moveIssueWorkflow(
  issueNumber: number,
  targetState: WorkflowState,
  actor: string = "claude"
): Promise<{ success: boolean; message: string; from: string; to: string }> {
  const db = await getDb();

  const issue = db
    .prepare("SELECT workflow FROM issues WHERE number = ?")
    .get(issueNumber) as { workflow: string } | undefined;

  if (!issue) {
    throw new Error(`Issue #${issueNumber} not found in local database. Run 'pm sync' first.`);
  }

  const currentState = issue.workflow as WorkflowState;
  const allowed = VALID_TRANSITIONS[currentState];

  if (!allowed?.includes(targetState)) {
    throw new Error(
      `Invalid transition: ${currentState} → ${targetState}. ` +
        `Allowed from ${currentState}: ${allowed?.join(", ") || "none"}`
    );
  }

  // WIP limit check: only 1 Active issue at a time
  if (targetState === "Active") {
    const activeCount = db
      .prepare("SELECT COUNT(*) as count FROM issues WHERE workflow = 'Active' AND state = 'open' AND number != ?")
      .get(issueNumber) as { count: number };

    if (activeCount.count >= 1) {
      const activeIssue = db
        .prepare("SELECT number, title FROM issues WHERE workflow = 'Active' AND state = 'open' AND number != ? LIMIT 1")
        .get(issueNumber) as { number: number; title: string };

      throw new Error(
        `WIP limit reached: #${activeIssue.number} "${activeIssue.title}" is already Active. ` +
          `Move it to Review or Done first.`
      );
    }
  }

  // Update workflow
  db.prepare("UPDATE issues SET workflow = ? WHERE number = ?").run(
    targetState,
    issueNumber
  );

  // If moving to Done and issue is open on GitHub, mark closed locally
  if (targetState === "Done") {
    db.prepare(
      "UPDATE issues SET state = 'closed', closed_at = datetime('now') WHERE number = ? AND state = 'open'"
    ).run(issueNumber);
  }

  // Record event
  db.prepare(`
    INSERT INTO events (event_type, issue_number, from_value, to_value, actor)
    VALUES ('workflow_change', ?, ?, ?, ?)
  `).run(issueNumber, currentState, targetState, actor);

  // Auto-resolve dependencies when a blocker moves to Done
  if (targetState === "Done") {
    db.prepare(`
      UPDATE dependencies SET resolved_at = datetime('now')
      WHERE blocker_issue = ? AND resolved_at IS NULL
    `).run(issueNumber);
  }

  return {
    success: true,
    message: `Issue #${issueNumber}: ${currentState} → ${targetState}`,
    from: currentState,
    to: targetState,
  };
}

// ─── Dependency Operations ───────────────────────────────

/** Add a dependency between issues */
export async function addDependency(
  blockerIssue: number,
  blockedIssue: number,
  depType: string = "blocks"
): Promise<void> {
  const db = await getDb();

  // Prevent self-dependency
  if (blockerIssue === blockedIssue) {
    throw new Error("An issue cannot depend on itself");
  }

  // Cycle detection: check if adding this would create a cycle
  const wouldCycle = checkForCycle(db, blockerIssue, blockedIssue);
  if (wouldCycle) {
    throw new Error(
      `Adding dependency #${blockerIssue} → #${blockedIssue} would create a cycle`
    );
  }

  db.prepare(`
    INSERT OR REPLACE INTO dependencies (blocker_issue, blocked_issue, dep_type)
    VALUES (?, ?, ?)
  `).run(blockerIssue, blockedIssue, depType);

  db.prepare(`
    INSERT INTO events (event_type, issue_number, from_value, to_value, actor, metadata)
    VALUES ('dependency_added', ?, ?, ?, 'claude', ?)
  `).run(blockedIssue, null, String(blockerIssue),
    JSON.stringify({ dep_type: depType, blocker: blockerIssue })
  );
}

/** Check if adding an edge would create a cycle (DFS) */
function checkForCycle(
  db: Database.Database,
  from: number,
  to: number
): boolean {
  // Would adding from→to create a cycle?
  // Check if there's already a path from `to` to `from`
  const visited = new Set<number>();
  const stack = [to];

  while (stack.length > 0) {
    const current = stack.pop()!;
    if (current === from) return true;
    if (visited.has(current)) continue;
    visited.add(current);

    const deps = db
      .prepare(
        "SELECT blocked_issue FROM dependencies WHERE blocker_issue = ? AND resolved_at IS NULL"
      )
      .all(current) as Array<{ blocked_issue: number }>;

    for (const dep of deps) {
      stack.push(dep.blocked_issue);
    }
  }

  return false;
}

/** Get dependencies for an issue */
export async function getDependencies(
  issueNumber: number
): Promise<{
  blockedBy: Array<{ issue: number; type: string; resolved: boolean }>;
  blocks: Array<{ issue: number; type: string; resolved: boolean }>;
}> {
  const db = await getDb();

  const blockedBy = db
    .prepare(
      "SELECT blocker_issue, dep_type, resolved_at FROM dependencies WHERE blocked_issue = ?"
    )
    .all(issueNumber) as Array<{
    blocker_issue: number;
    dep_type: string;
    resolved_at: string | null;
  }>;

  const blocks = db
    .prepare(
      "SELECT blocked_issue, dep_type, resolved_at FROM dependencies WHERE blocker_issue = ?"
    )
    .all(issueNumber) as Array<{
    blocked_issue: number;
    dep_type: string;
    resolved_at: string | null;
  }>;

  return {
    blockedBy: blockedBy.map((d) => ({
      issue: d.blocker_issue,
      type: d.dep_type,
      resolved: d.resolved_at !== null,
    })),
    blocks: blocks.map((d) => ({
      issue: d.blocked_issue,
      type: d.dep_type,
      resolved: d.resolved_at !== null,
    })),
  };
}

// ─── Event Queries ───────────────────────────────────────

export interface PMEvent {
  id: number;
  timestamp: string;
  event_type: string;
  issue_number: number | null;
  pr_number: number | null;
  from_value: string | null;
  to_value: string | null;
  actor: string | null;
  session_id: string | null;
  metadata: Record<string, unknown> | null;
}

/** Query events with filters */
export async function queryEvents(filters?: {
  issueNumber?: number;
  eventType?: string;
  since?: string;
  limit?: number;
}): Promise<PMEvent[]> {
  const db = await getDb();
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (filters?.issueNumber !== undefined) {
    conditions.push("issue_number = ?");
    params.push(filters.issueNumber);
  }
  if (filters?.eventType) {
    conditions.push("event_type = ?");
    params.push(filters.eventType);
  }
  if (filters?.since) {
    conditions.push("timestamp >= ?");
    params.push(filters.since);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const limit = filters?.limit || 100;

  const rows = db
    .prepare(`SELECT * FROM events ${where} ORDER BY timestamp DESC LIMIT ?`)
    .all(...params, limit) as Array<Record<string, unknown>>;

  return rows.map((row) => ({
    id: row.id as number,
    timestamp: row.timestamp as string,
    event_type: row.event_type as string,
    issue_number: row.issue_number as number | null,
    pr_number: row.pr_number as number | null,
    from_value: row.from_value as string | null,
    to_value: row.to_value as string | null,
    actor: row.actor as string | null,
    session_id: row.session_id as string | null,
    metadata: row.metadata ? JSON.parse(row.metadata as string) : null,
  }));
}

/** Get cycle time (Active → Done) for completed issues */
export async function getCycleTimes(
  days: number = 90
): Promise<Array<{ issue_number: number; hours: number; workflow_path: string[] }>> {
  const db = await getDb();
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  // Get all workflow_change events for issues that reached Done
  const doneEvents = db
    .prepare(`
      SELECT DISTINCT issue_number FROM events
      WHERE event_type = 'workflow_change' AND to_value = 'Done' AND timestamp >= ?
    `)
    .all(since) as Array<{ issue_number: number }>;

  const results: Array<{ issue_number: number; hours: number; workflow_path: string[] }> = [];

  for (const { issue_number } of doneEvents) {
    const events = db
      .prepare(`
        SELECT timestamp, from_value, to_value FROM events
        WHERE event_type = 'workflow_change' AND issue_number = ?
        ORDER BY timestamp ASC
      `)
      .all(issue_number) as Array<{
      timestamp: string;
      from_value: string;
      to_value: string;
    }>;

    if (events.length < 2) continue;

    // Find first Active and last Done
    const firstActive = events.find((e) => e.to_value === "Active");
    const lastDone = events.findLast((e) => e.to_value === "Done");

    if (firstActive && lastDone) {
      const hours =
        (new Date(lastDone.timestamp).getTime() -
          new Date(firstActive.timestamp).getTime()) /
        (1000 * 60 * 60);

      const path = events.map((e) => e.to_value);

      results.push({ issue_number, hours: Math.round(hours * 10) / 10, workflow_path: path });
    }
  }

  return results;
}

// ─── Upsert Helpers (for sync) ───────────────────────────

/** Upsert an issue from GitHub data */
export async function upsertIssue(data: {
  number: number;
  title: string;
  body: string | null;
  state: string;
  author: string | null;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  labels: string[];
  assignees: string[];
}): Promise<{ isNew: boolean }> {
  const db = await getDb();

  const existing = db
    .prepare("SELECT number, workflow FROM issues WHERE number = ?")
    .get(data.number) as { number: number; workflow: string } | undefined;

  if (existing) {
    // Update GitHub-owned fields, preserve local-only fields
    db.prepare(`
      UPDATE issues SET
        title = ?, body = ?, state = ?, author = ?,
        updated_at = ?, closed_at = ?, synced_at = datetime('now')
      WHERE number = ?
    `).run(
      data.title,
      data.body,
      data.state,
      data.author,
      data.updated_at,
      data.closed_at,
      data.number
    );

    // If GitHub closed the issue and we're not already Done, auto-transition
    if (data.state === "closed" && existing.workflow !== "Done") {
      db.prepare("UPDATE issues SET workflow = 'Done' WHERE number = ?").run(data.number);
      db.prepare(`
        INSERT INTO events (event_type, issue_number, from_value, to_value, actor)
        VALUES ('workflow_change', ?, ?, 'Done', 'sync')
      `).run(data.number, existing.workflow);
    }
  } else {
    // New issue — determine initial workflow from state
    const workflow = data.state === "closed" ? "Done" : "Backlog";
    db.prepare(`
      INSERT INTO issues (number, title, body, state, author, created_at, updated_at, closed_at, workflow)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      data.number,
      data.title,
      data.body,
      data.state,
      data.author,
      data.created_at,
      data.updated_at,
      data.closed_at,
      workflow
    );
  }

  // Sync labels
  db.prepare("DELETE FROM issue_labels WHERE issue_number = ?").run(data.number);
  const insertLabel = db.prepare(
    "INSERT INTO issue_labels (issue_number, label) VALUES (?, ?)"
  );
  for (const label of data.labels) {
    insertLabel.run(data.number, label);
  }

  // Sync assignees
  db.prepare("DELETE FROM issue_assignees WHERE issue_number = ?").run(
    data.number
  );
  const insertAssignee = db.prepare(
    "INSERT INTO issue_assignees (issue_number, login) VALUES (?, ?)"
  );
  for (const login of data.assignees) {
    insertAssignee.run(data.number, login);
  }

  return { isNew: !existing };
}

/** Upsert a pull request from GitHub data */
export async function upsertPR(data: {
  number: number;
  title: string;
  state: string;
  author: string | null;
  branch: string | null;
  base_branch: string | null;
  created_at: string;
  updated_at: string;
  merged_at: string | null;
  closed_at: string | null;
  additions: number;
  deletions: number;
  changed_files: number;
  review_state: string | null;
  draft: boolean;
  linked_issues: Array<{ issue_number: number; link_type: string }>;
}): Promise<void> {
  const db = await getDb();

  db.prepare(`
    INSERT INTO pull_requests (number, title, state, author, branch, base_branch,
      created_at, updated_at, merged_at, closed_at, additions, deletions,
      changed_files, review_state, draft, synced_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(number) DO UPDATE SET
      title = excluded.title, state = excluded.state, author = excluded.author,
      branch = excluded.branch, base_branch = excluded.base_branch,
      updated_at = excluded.updated_at, merged_at = excluded.merged_at,
      closed_at = excluded.closed_at, additions = excluded.additions,
      deletions = excluded.deletions, changed_files = excluded.changed_files,
      review_state = excluded.review_state, draft = excluded.draft,
      synced_at = datetime('now')
  `).run(
    data.number,
    data.title,
    data.state,
    data.author,
    data.branch,
    data.base_branch,
    data.created_at,
    data.updated_at,
    data.merged_at,
    data.closed_at,
    data.additions,
    data.deletions,
    data.changed_files,
    data.review_state,
    data.draft ? 1 : 0
  );

  // Sync issue links
  db.prepare("DELETE FROM pr_issue_links WHERE pr_number = ?").run(data.number);
  const insertLink = db.prepare(
    "INSERT OR IGNORE INTO pr_issue_links (pr_number, issue_number, link_type) VALUES (?, ?, ?)"
  );
  for (const link of data.linked_issues) {
    insertLink.run(data.number, link.issue_number, link.link_type);
  }
}

/** Record last sync timestamp */
export async function updateSyncState(
  resource: string,
  cursor?: string
): Promise<void> {
  const db = await getDb();
  db.prepare(`
    INSERT INTO sync_state (resource, last_sync, cursor)
    VALUES (?, datetime('now'), ?)
    ON CONFLICT(resource) DO UPDATE SET
      last_sync = datetime('now'), cursor = excluded.cursor
  `).run(resource, cursor || null);
}

/** Get last sync time for a resource */
export async function getLastSync(
  resource: string
): Promise<{ last_sync: string; cursor: string | null } | null> {
  const db = await getDb();
  return db
    .prepare("SELECT last_sync, cursor FROM sync_state WHERE resource = ?")
    .get(resource) as { last_sync: string; cursor: string | null } | null;
}
