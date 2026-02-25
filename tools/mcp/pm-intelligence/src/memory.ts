/**
 * Memory system — backed by SQLite.
 *
 * v0.15.0: Fully migrated to SQLite database.
 * Decisions, outcomes, and events all live in .pm/state.db.
 */

import { getDb, queryEvents, type PMEvent } from "./db.js";

// ─── Types (preserved from v0.14 for API compatibility) ──

export interface Decision {
  id?: number;
  timestamp: string;
  issue_number: number | null;
  area: string | null;
  type: string;
  decision: string;
  rationale: string | null;
  alternatives_considered: string[];
  files: string[];
}

export interface Outcome {
  id?: number;
  timestamp: string;
  issue_number: number;
  pr_number: number | null;
  result: string;
  review_rounds: number | null;
  rework_reasons: string[];
  area: string | null;
  approach_summary: string | null;
  lessons: string | null;
  cycle_time_hours: number | null;
}

export { PMEvent };

// ─── Read Operations ────────────────────────────────────

/** Get recent decisions, optionally filtered by issue */
export async function getDecisions(
  limit = 20,
  issueNumber?: number
): Promise<Decision[]> {
  const db = await getDb();

  let query = "SELECT * FROM decisions";
  const params: unknown[] = [];

  if (issueNumber !== undefined) {
    query += " WHERE issue_number = ?";
    params.push(issueNumber);
  }

  query += " ORDER BY timestamp DESC LIMIT ?";
  params.push(limit);

  const rows = db.prepare(query).all(...params) as Array<Record<string, unknown>>;

  return rows.map((row) => ({
    id: row.id as number,
    timestamp: row.timestamp as string,
    issue_number: row.issue_number as number | null,
    area: row.area as string | null,
    type: row.decision_type as string,
    decision: row.decision as string,
    rationale: row.rationale as string | null,
    alternatives_considered: row.alternatives
      ? JSON.parse(row.alternatives as string)
      : [],
    files: row.files ? JSON.parse(row.files as string) : [],
  }));
}

/** Get recent outcomes, optionally filtered */
export async function getOutcomes(
  limit = 20,
  filters?: { issueNumber?: number; area?: string; result?: string }
): Promise<Outcome[]> {
  const db = await getDb();

  const conditions: string[] = [];
  const params: unknown[] = [];

  if (filters?.issueNumber !== undefined) {
    conditions.push("issue_number = ?");
    params.push(filters.issueNumber);
  }
  if (filters?.area) {
    conditions.push("area = ?");
    params.push(filters.area);
  }
  if (filters?.result) {
    conditions.push("result = ?");
    params.push(filters.result);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  params.push(limit);

  const rows = db
    .prepare(`SELECT * FROM outcomes ${where} ORDER BY timestamp DESC LIMIT ?`)
    .all(...params) as Array<Record<string, unknown>>;

  return rows.map((row) => ({
    id: row.id as number,
    timestamp: row.timestamp as string,
    issue_number: row.issue_number as number,
    pr_number: row.pr_number as number | null,
    result: row.result as string,
    review_rounds: row.review_rounds as number | null,
    rework_reasons: row.rework_reasons
      ? JSON.parse(row.rework_reasons as string)
      : [],
    area: row.area as string | null,
    approach_summary: row.approach as string | null,
    lessons: row.lessons as string | null,
    cycle_time_hours: row.cycle_time_hours as number | null,
  }));
}

/** Get recent events from event stream */
export async function getEvents(
  limit = 50,
  filters?: { issueNumber?: number; eventType?: string }
): Promise<PMEvent[]> {
  return queryEvents({
    issueNumber: filters?.issueNumber,
    eventType: filters?.eventType,
    limit,
  });
}

/** Get board snapshot (computed live from local DB) */
export async function getBoardCache(): Promise<{
  timestamp: string;
  active: number;
  review: number;
  rework: number;
  done: number;
  backlog: number;
  ready: number;
} | null> {
  const db = await getDb();

  const counts = db
    .prepare(
      "SELECT workflow, COUNT(*) as count FROM issues WHERE state = 'open' GROUP BY workflow"
    )
    .all() as Array<{ workflow: string; count: number }>;

  const byWorkflow: Record<string, number> = {};
  for (const row of counts) {
    byWorkflow[row.workflow] = row.count;
  }

  return {
    timestamp: new Date().toISOString(),
    active: byWorkflow["Active"] || 0,
    review: byWorkflow["Review"] || 0,
    rework: byWorkflow["Rework"] || 0,
    done: byWorkflow["Done"] || 0,
    backlog: byWorkflow["Backlog"] || 0,
    ready: byWorkflow["Ready"] || 0,
  };
}

// ─── Write Operations ───────────────────────────────────

/** Record a decision */
export async function recordDecision(decision: {
  issueNumber?: number;
  area?: string;
  type?: string;
  decision: string;
  rationale?: string;
  alternatives?: string[];
  files?: string[];
  sessionId?: string;
}): Promise<void> {
  const db = await getDb();

  db.prepare(`
    INSERT INTO decisions (issue_number, area, decision_type, decision, rationale, alternatives, files, session_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    decision.issueNumber ?? null,
    decision.area ?? null,
    decision.type ?? "architectural",
    decision.decision,
    decision.rationale ?? null,
    decision.alternatives ? JSON.stringify(decision.alternatives) : null,
    decision.files ? JSON.stringify(decision.files) : null,
    decision.sessionId ?? null
  );

  // Also record as event
  db.prepare(`
    INSERT INTO events (event_type, issue_number, to_value, actor, session_id)
    VALUES ('decision', ?, ?, 'claude', ?)
  `).run(
    decision.issueNumber ?? null,
    decision.decision.slice(0, 200),
    decision.sessionId ?? null
  );
}

/** Record an outcome */
export async function recordOutcome(outcome: {
  issueNumber: number;
  prNumber?: number;
  result: string;
  reviewRounds?: number;
  reworkReasons?: string[];
  area?: string;
  summary?: string;
  lessons?: string;
  cycleTimeHours?: number;
}): Promise<void> {
  const db = await getDb();

  db.prepare(`
    INSERT INTO outcomes (issue_number, pr_number, result, review_rounds, rework_reasons, area, approach, lessons, cycle_time_hours)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    outcome.issueNumber,
    outcome.prNumber ?? null,
    outcome.result,
    outcome.reviewRounds ?? null,
    outcome.reworkReasons ? JSON.stringify(outcome.reworkReasons) : null,
    outcome.area ?? null,
    outcome.summary ?? null,
    outcome.lessons ?? null,
    outcome.cycleTimeHours ?? null
  );

  // Also record as event
  db.prepare(`
    INSERT INTO events (event_type, issue_number, pr_number, to_value, actor)
    VALUES ('outcome', ?, ?, ?, 'claude')
  `).run(outcome.issueNumber, outcome.prNumber ?? null, outcome.result);
}

// ─── Analytics ──────────────────────────────────────────

export interface MemoryInsights {
  totalDecisions: number;
  totalOutcomes: number;
  reworkRate: number;
  averageReviewRounds: number;
  topAreas: Array<{ area: string; count: number }>;
  recentLessons: string[];
  decisionPatterns: Array<{ type: string; count: number }>;
}

/** Analyze memory for patterns and insights */
export async function getInsights(): Promise<MemoryInsights> {
  const db = await getDb();

  const totalDecisions = (
    db.prepare("SELECT COUNT(*) as c FROM decisions").get() as { c: number }
  ).c;

  const totalOutcomes = (
    db.prepare("SELECT COUNT(*) as c FROM outcomes").get() as { c: number }
  ).c;

  // Rework rate
  const reworkCount = (
    db
      .prepare("SELECT COUNT(*) as c FROM outcomes WHERE result = 'rework'")
      .get() as { c: number }
  ).c;
  const reworkRate =
    totalOutcomes > 0 ? Math.round((reworkCount / totalOutcomes) * 100) / 100 : 0;

  // Average review rounds
  const avgRounds = (
    db
      .prepare(
        "SELECT AVG(review_rounds) as avg FROM outcomes WHERE review_rounds IS NOT NULL"
      )
      .get() as { avg: number | null }
  ).avg;

  // Top areas
  const topAreas = db
    .prepare(
      "SELECT area, COUNT(*) as count FROM outcomes WHERE area IS NOT NULL GROUP BY area ORDER BY count DESC LIMIT 5"
    )
    .all() as Array<{ area: string; count: number }>;

  // Recent lessons
  const lessons = db
    .prepare(
      "SELECT lessons FROM outcomes WHERE lessons IS NOT NULL ORDER BY timestamp DESC LIMIT 5"
    )
    .all() as Array<{ lessons: string }>;

  // Decision patterns
  const patterns = db
    .prepare(
      "SELECT decision_type as type, COUNT(*) as count FROM decisions GROUP BY decision_type ORDER BY count DESC"
    )
    .all() as Array<{ type: string; count: number }>;

  return {
    totalDecisions,
    totalOutcomes,
    reworkRate,
    averageReviewRounds: avgRounds ? Math.round(avgRounds * 10) / 10 : 0,
    topAreas,
    recentLessons: lessons.map((l) => l.lessons),
    decisionPatterns: patterns,
  };
}
