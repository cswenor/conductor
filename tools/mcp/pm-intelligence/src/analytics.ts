/**
 * Sprint analytics — deep analysis from event stream and memory.
 *
 * Computes time-in-state, bottleneck detection, velocity trends,
 * cycle time distributions, and flow efficiency from SQLite event data.
 */

import { getEvents, getOutcomes, getDecisions, type PMEvent, type Outcome, type Decision } from "./memory.js";

// ─── Types ──────────────────────────────────────────────

export interface SprintAnalytics {
  period: { from: string; to: string; days: number };
  throughput: {
    issuesClosed: number;
    prsMerged: number;
    decisionsRecorded: number;
  };
  cycleTime: {
    averageDays: number | null;
    medianDays: number | null;
    p90Days: number | null;
    byArea: Array<{ area: string; avgDays: number; count: number }>;
  };
  timeInState: Record<string, { avgHours: number; maxHours: number; count: number }>;
  bottlenecks: Array<{
    state: string;
    severity: "low" | "medium" | "high";
    reason: string;
    avgHours: number;
  }>;
  flowEfficiency: number | null; // ratio of active time to total time
  reworkAnalysis: {
    reworkRate: number;
    avgReworkCycles: number;
    topReworkReasons: Array<{ reason: string; count: number }>;
  };
  sessionPatterns: {
    totalSessions: number;
    avgEventsPerSession: number;
    peakHours: Array<{ hour: number; count: number }>;
    needsInputRate: number; // fraction of sessions that required user input
  };
  trends: {
    velocityTrend: "increasing" | "stable" | "decreasing";
    reworkTrend: "improving" | "stable" | "worsening";
    description: string;
  };
}

export interface ApproachSuggestion {
  issueNumber: number;
  issueTitle: string;
  suggestions: Array<{
    source: "decision" | "outcome" | "pattern";
    relevance: "high" | "medium" | "low";
    text: string;
    context: string;
  }>;
  warnings: string[];
  relatedIssues: Array<{ number: number; area: string | null; result: string }>;
}

export interface ReadinessCheck {
  ready: boolean;
  score: number; // 0-100
  checks: Array<{
    name: string;
    passed: boolean;
    severity: "blocking" | "warning" | "info";
    detail: string;
  }>;
  missingSteps: string[];
}

// ─── Sprint Analytics ───────────────────────────────────

/** Compute sprint analytics from event stream */
export async function getSprintAnalytics(days = 14): Promise<SprintAnalytics> {
  const now = new Date();
  const from = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  const events = await getEvents(10000);
  const outcomes = await getOutcomes(1000);
  const decisions = await getDecisions(1000);

  // Filter to period
  const periodEvents = events.filter(
    (e) => new Date(e.timestamp) >= from && new Date(e.timestamp) <= now
  );
  const periodOutcomes = outcomes.filter(
    (o) => new Date(o.timestamp) >= from && new Date(o.timestamp) <= now
  );
  const periodDecisions = decisions.filter(
    (d) => new Date(d.timestamp) >= from && new Date(d.timestamp) <= now
  );

  // ─── Throughput ───
  const issuesClosed = periodOutcomes.filter((o) => o.result === "merged").length;
  const prsMerged = periodOutcomes.filter(
    (o) => o.result === "merged" && o.pr_number
  ).length;

  // ─── Time in State ───
  const timeInState = computeTimeInState(periodEvents);

  // ─── Bottlenecks ───
  const bottlenecks = detectBottlenecks(timeInState);

  // ─── Cycle Time ───
  const cycleTime = computeCycleTime(periodEvents, periodOutcomes);

  // ─── Flow Efficiency ───
  const flowEfficiency = computeFlowEfficiency(timeInState);

  // ─── Rework Analysis ───
  const reworkAnalysis = analyzeRework(periodOutcomes);

  // ─── Session Patterns ───
  const sessionPatterns = analyzeSessionPatterns(periodEvents);

  // ─── Trends ───
  const trends = computeTrends(events, outcomes, days);

  return {
    period: {
      from: from.toISOString().split("T")[0],
      to: now.toISOString().split("T")[0],
      days,
    },
    throughput: {
      issuesClosed,
      prsMerged,
      decisionsRecorded: periodDecisions.length,
    },
    cycleTime,
    timeInState,
    bottlenecks,
    flowEfficiency,
    reworkAnalysis,
    sessionPatterns,
    trends,
  };
}

/** Compute average time spent in each workflow state */
function computeTimeInState(
  events: PMEvent[]
): Record<string, { avgHours: number; maxHours: number; count: number }> {
  const stateChanges = events.filter((e) => e.event_type === "workflow_change");
  const result: Record<string, { totalMs: number; maxMs: number; count: number }> = {};

  // Group state changes by issue, compute duration between transitions
  const byIssue = new Map<number, PMEvent[]>();
  for (const e of stateChanges) {
    if (!e.issue_number) continue;
    const list = byIssue.get(e.issue_number) || [];
    list.push(e);
    byIssue.set(e.issue_number, list);
  }

  for (const [, issueEvents] of byIssue) {
    // Sort by timestamp
    issueEvents.sort(
      (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
    );

    for (let i = 0; i < issueEvents.length - 1; i++) {
      const current = issueEvents[i];
      const next = issueEvents[i + 1];
      const state = current.to_value || "Unknown";
      const durationMs =
        new Date(next.timestamp).getTime() - new Date(current.timestamp).getTime();

      if (!result[state]) result[state] = { totalMs: 0, maxMs: 0, count: 0 };
      result[state].totalMs += durationMs;
      result[state].maxMs = Math.max(result[state].maxMs, durationMs);
      result[state].count++;
    }
  }

  const output: Record<string, { avgHours: number; maxHours: number; count: number }> = {};
  for (const [state, data] of Object.entries(result)) {
    output[state] = {
      avgHours: Math.round((data.totalMs / data.count / (1000 * 60 * 60)) * 10) / 10,
      maxHours: Math.round((data.maxMs / (1000 * 60 * 60)) * 10) / 10,
      count: data.count,
    };
  }
  return output;
}

/** Detect bottleneck states */
function detectBottlenecks(
  timeInState: Record<string, { avgHours: number; maxHours: number; count: number }>
): SprintAnalytics["bottlenecks"] {
  const bottlenecks: SprintAnalytics["bottlenecks"] = [];

  for (const [state, data] of Object.entries(timeInState)) {
    // Review taking too long (> 24 hours avg)
    if (state === "Review" && data.avgHours > 24) {
      bottlenecks.push({
        state,
        severity: data.avgHours > 72 ? "high" : "medium",
        reason: `Average ${data.avgHours}h in Review (target: <24h)`,
        avgHours: data.avgHours,
      });
    }

    // Rework taking too long (> 8 hours avg)
    if (state === "Rework" && data.avgHours > 8) {
      bottlenecks.push({
        state,
        severity: data.avgHours > 24 ? "high" : "medium",
        reason: `Average ${data.avgHours}h in Rework (target: <8h)`,
        avgHours: data.avgHours,
      });
    }

    // Ready queue too long (items waiting > 48 hours)
    if (state === "Ready" && data.avgHours > 48) {
      bottlenecks.push({
        state,
        severity: data.avgHours > 168 ? "high" : "low",
        reason: `Issues wait ${data.avgHours}h in Ready before starting (target: <48h)`,
        avgHours: data.avgHours,
      });
    }

    // Active too long (> 72 hours avg = scope too big)
    if (state === "Active" && data.avgHours > 72) {
      bottlenecks.push({
        state,
        severity: data.avgHours > 168 ? "high" : "medium",
        reason: `Average ${data.avgHours}h Active (may indicate oversized issues)`,
        avgHours: data.avgHours,
      });
    }
  }

  return bottlenecks.sort(
    (a, b) => {
      const severityOrder = { high: 0, medium: 1, low: 2 };
      return severityOrder[a.severity] - severityOrder[b.severity];
    }
  );
}

/** Compute cycle time (Ready → Done) */
function computeCycleTime(
  events: PMEvent[],
  outcomes: Outcome[]
): SprintAnalytics["cycleTime"] {
  const stateChanges = events.filter((e) => e.event_type === "workflow_change");

  // Find first Active timestamp and Done/merged timestamp per issue
  const issueTimelines = new Map<number, { start: number; end: number; area: string | null }>();

  for (const e of stateChanges) {
    if (!e.issue_number) continue;
    const ts = new Date(e.timestamp).getTime();

    // Track first time issue became Active
    if (e.to_value === "Active") {
      const existing = issueTimelines.get(e.issue_number);
      if (!existing || ts < existing.start) {
        issueTimelines.set(e.issue_number, {
          start: ts,
          end: existing?.end || 0,
          area: existing?.area || null,
        });
      }
    }

    // Track when issue reached Done
    if (e.to_value === "Done") {
      const existing = issueTimelines.get(e.issue_number);
      if (existing) {
        existing.end = ts;
      }
    }
  }

  // Enrich with area from outcomes
  for (const o of outcomes) {
    const timeline = issueTimelines.get(o.issue_number);
    if (timeline && o.area) timeline.area = o.area;
  }

  // Compute cycle times
  const cycleTimes: Array<{ days: number; area: string | null }> = [];
  for (const [, timeline] of issueTimelines) {
    if (timeline.start > 0 && timeline.end > timeline.start) {
      cycleTimes.push({
        days: (timeline.end - timeline.start) / (1000 * 60 * 60 * 24),
        area: timeline.area,
      });
    }
  }

  if (cycleTimes.length === 0) {
    return { averageDays: null, medianDays: null, p90Days: null, byArea: [] };
  }

  const sorted = cycleTimes.map((c) => c.days).sort((a, b) => a - b);
  const avg = sorted.reduce((a, b) => a + b, 0) / sorted.length;
  const median = sorted[Math.floor(sorted.length / 2)];
  const p90 = sorted[Math.floor(sorted.length * 0.9)];

  // By area
  const areaMap = new Map<string, number[]>();
  for (const ct of cycleTimes) {
    const area = ct.area || "unknown";
    const list = areaMap.get(area) || [];
    list.push(ct.days);
    areaMap.set(area, list);
  }
  const byArea = Array.from(areaMap.entries())
    .map(([area, days]) => ({
      area,
      avgDays: Math.round((days.reduce((a, b) => a + b, 0) / days.length) * 10) / 10,
      count: days.length,
    }))
    .sort((a, b) => b.avgDays - a.avgDays);

  return {
    averageDays: Math.round(avg * 10) / 10,
    medianDays: Math.round(median * 10) / 10,
    p90Days: Math.round(p90 * 10) / 10,
    byArea,
  };
}

/** Compute flow efficiency (active work / total elapsed) */
function computeFlowEfficiency(
  timeInState: Record<string, { avgHours: number; maxHours: number; count: number }>
): number | null {
  const activeHours = timeInState["Active"]?.avgHours || 0;
  const totalHours = Object.values(timeInState).reduce(
    (sum, s) => sum + s.avgHours,
    0
  );
  if (totalHours === 0) return null;
  return Math.round((activeHours / totalHours) * 100) / 100;
}

/** Analyze rework patterns */
function analyzeRework(outcomes: Outcome[]): SprintAnalytics["reworkAnalysis"] {
  const total = outcomes.length;
  const reworkOutcomes = outcomes.filter((o) => o.result === "rework");
  const reworkRate = total > 0 ? Math.round((reworkOutcomes.length / total) * 100) / 100 : 0;

  // Average rework cycles per issue
  const reworkCounts = new Map<number, number>();
  for (const o of reworkOutcomes) {
    reworkCounts.set(o.issue_number, (reworkCounts.get(o.issue_number) || 0) + 1);
  }
  const avgCycles = reworkCounts.size > 0
    ? Math.round(
        (Array.from(reworkCounts.values()).reduce((a, b) => a + b, 0) /
          reworkCounts.size) *
          10
      ) / 10
    : 0;

  // Top rework reasons
  const reasonCounts: Record<string, number> = {};
  for (const o of reworkOutcomes) {
    for (const reason of o.rework_reasons) {
      reasonCounts[reason] = (reasonCounts[reason] || 0) + 1;
    }
  }
  const topReasons = Object.entries(reasonCounts)
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);

  return {
    reworkRate,
    avgReworkCycles: avgCycles,
    topReworkReasons: topReasons,
  };
}

/** Analyze session patterns from events */
function analyzeSessionPatterns(events: PMEvent[]): SprintAnalytics["sessionPatterns"] {
  const sessions = events.filter((e) => e.event_type === "session_start");
  const needsInput = events.filter((e) => e.event_type === "needs_input");
  const allEvents = events;

  // Events per session (approximate by grouping by session_id or by time windows)
  const avgEvents = sessions.length > 0 ? Math.round(allEvents.length / sessions.length) : 0;

  // Peak hours
  const hourCounts: Record<number, number> = {};
  for (const e of events) {
    const hour = new Date(e.timestamp).getHours();
    hourCounts[hour] = (hourCounts[hour] || 0) + 1;
  }
  const peakHours = Object.entries(hourCounts)
    .map(([hour, count]) => ({ hour: parseInt(hour), count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);

  // needs-input rate
  const needsInputRate = sessions.length > 0
    ? Math.round((needsInput.length / sessions.length) * 100) / 100
    : 0;

  return {
    totalSessions: sessions.length,
    avgEventsPerSession: avgEvents,
    peakHours,
    needsInputRate,
  };
}

/** Compute velocity and rework trends by comparing periods */
function computeTrends(
  allEvents: PMEvent[],
  allOutcomes: Outcome[],
  periodDays: number
): SprintAnalytics["trends"] {
  const now = Date.now();
  const periodMs = periodDays * 24 * 60 * 60 * 1000;

  // Current period vs previous period
  const currentStart = now - periodMs;
  const prevStart = currentStart - periodMs;

  const currentOutcomes = allOutcomes.filter(
    (o) => {
      const ts = new Date(o.timestamp).getTime();
      return ts >= currentStart && ts <= now;
    }
  );
  const prevOutcomes = allOutcomes.filter(
    (o) => {
      const ts = new Date(o.timestamp).getTime();
      return ts >= prevStart && ts < currentStart;
    }
  );

  // Velocity trend
  const currentMerged = currentOutcomes.filter((o) => o.result === "merged").length;
  const prevMerged = prevOutcomes.filter((o) => o.result === "merged").length;
  let velocityTrend: "increasing" | "stable" | "decreasing" = "stable";
  if (prevMerged > 0) {
    const change = (currentMerged - prevMerged) / prevMerged;
    if (change > 0.2) velocityTrend = "increasing";
    else if (change < -0.2) velocityTrend = "decreasing";
  } else if (currentMerged > 0) {
    velocityTrend = "increasing";
  }

  // Rework trend
  const currentRework = currentOutcomes.filter((o) => o.result === "rework").length;
  const prevRework = prevOutcomes.filter((o) => o.result === "rework").length;
  const currentReworkRate = currentOutcomes.length > 0 ? currentRework / currentOutcomes.length : 0;
  const prevReworkRate = prevOutcomes.length > 0 ? prevRework / prevOutcomes.length : 0;
  let reworkTrend: "improving" | "stable" | "worsening" = "stable";
  if (prevReworkRate > 0) {
    const change = currentReworkRate - prevReworkRate;
    if (change < -0.1) reworkTrend = "improving";
    else if (change > 0.1) reworkTrend = "worsening";
  }

  const descriptions: string[] = [];
  descriptions.push(
    `Velocity: ${currentMerged} merged (prev: ${prevMerged}) → ${velocityTrend}`
  );
  descriptions.push(
    `Rework: ${Math.round(currentReworkRate * 100)}% (prev: ${Math.round(prevReworkRate * 100)}%) → ${reworkTrend}`
  );

  return {
    velocityTrend,
    reworkTrend,
    description: descriptions.join(". "),
  };
}

// ─── Approach Suggestion ────────────────────────────────

/** Suggest approaches based on past decisions and outcomes for similar work */
export async function suggestApproach(
  area: string,
  keywords: string[]
): Promise<ApproachSuggestion> {
  const decisions = await getDecisions(500);
  const outcomes = await getOutcomes(500);

  const suggestions: ApproachSuggestion["suggestions"] = [];
  const warnings: string[] = [];
  const relatedIssues: ApproachSuggestion["relatedIssues"] = [];

  // Find decisions in the same area
  const areaDecisions = decisions.filter((d) => d.area === area);
  for (const d of areaDecisions) {
    const keywordMatch = keywords.some(
      (kw) =>
        d.decision.toLowerCase().includes(kw.toLowerCase()) ||
        (d.rationale && d.rationale.toLowerCase().includes(kw.toLowerCase()))
    );

    if (keywordMatch) {
      suggestions.push({
        source: "decision",
        relevance: "high",
        text: d.decision,
        context: d.rationale
          ? `Rationale: ${d.rationale}${d.alternatives_considered.length > 0 ? `. Alternatives considered: ${d.alternatives_considered.join(", ")}` : ""}`
          : `Issue #${d.issue_number || "unknown"}`,
      });
    }
  }

  // Find outcomes for similar area work
  const areaOutcomes = outcomes.filter((o) => o.area === area);
  for (const o of areaOutcomes) {
    relatedIssues.push({
      number: o.issue_number,
      area: o.area,
      result: o.result,
    });

    // If it was reworked, warn about it
    if (o.result === "rework" && o.rework_reasons.length > 0) {
      warnings.push(
        `Issue #${o.issue_number} in ${area} required rework: ${o.rework_reasons.join(", ")}`
      );
    }

    // Add lessons as suggestions
    if (o.lessons) {
      const keywordMatch = keywords.some((kw) =>
        o.lessons!.toLowerCase().includes(kw.toLowerCase())
      );
      suggestions.push({
        source: "outcome",
        relevance: keywordMatch ? "high" : "medium",
        text: o.lessons,
        context: `From issue #${o.issue_number} (${o.result}, ${o.review_rounds || 0} review rounds)`,
      });
    }

    // Add successful approaches
    if (o.result === "merged" && o.approach_summary) {
      suggestions.push({
        source: "outcome",
        relevance: "medium",
        text: `Previously used approach: ${o.approach_summary}`,
        context: `Issue #${o.issue_number} merged successfully (${o.review_rounds || 0} review rounds)`,
      });
    }
  }

  // Pattern-based warnings from rework history
  const reworkRate = areaOutcomes.length > 0
    ? areaOutcomes.filter((o) => o.result === "rework").length / areaOutcomes.length
    : 0;
  if (reworkRate > 0.3) {
    warnings.push(
      `High rework rate (${Math.round(reworkRate * 100)}%) for ${area} area. Extra review recommended.`
    );
  }

  // Sort suggestions by relevance
  const relevanceOrder = { high: 0, medium: 1, low: 2 };
  suggestions.sort((a, b) => relevanceOrder[a.relevance] - relevanceOrder[b.relevance]);

  return {
    issueNumber: 0, // caller fills this in
    issueTitle: "",
    suggestions: suggestions.slice(0, 10),
    warnings,
    relatedIssues: relatedIssues.slice(0, 10),
  };
}

// ─── Readiness Check ────────────────────────────────────

/** Check if an issue is ready for review based on event stream */
export async function checkReadiness(issueNumber: number): Promise<ReadinessCheck> {
  const events = await getEvents(5000, { issueNumber });
  const checks: ReadinessCheck["checks"] = [];
  const missingSteps: string[] = [];

  // Check 1: Issue was moved to Active
  const wasActive = events.some(
    (e) => e.event_type === "workflow_change" && e.to_value === "Active"
  );
  checks.push({
    name: "Issue moved to Active",
    passed: wasActive,
    severity: "blocking",
    detail: wasActive
      ? "Issue was moved to Active state"
      : "Issue was never moved to Active — was work started properly?",
  });
  if (!wasActive) missingSteps.push("Move issue to Active before starting work");

  // Check 2: Has session activity
  const sessionStarts = events.filter((e) => e.event_type === "session_start");
  checks.push({
    name: "Has development sessions",
    passed: sessionStarts.length > 0,
    severity: "warning",
    detail: `${sessionStarts.length} session(s) recorded for this issue`,
  });

  // Check 3: Look for workflow_change to Review
  const moveToReview = events.some(
    (e) => e.event_type === "workflow_change" && e.to_value === "Review"
  );
  checks.push({
    name: "Not already in Review",
    passed: !moveToReview,
    severity: "info",
    detail: moveToReview
      ? "Issue was already moved to Review"
      : "Issue has not been moved to Review yet",
  });

  // Check 4: No unresolved rework
  const reworkEvents = events.filter(
    (e) => e.event_type === "workflow_change" && e.to_value === "Rework"
  );
  const activeAfterRework = reworkEvents.length > 0 && events.some(
    (e) =>
      e.event_type === "workflow_change" &&
      e.to_value === "Active" &&
      new Date(e.timestamp) > new Date(reworkEvents[reworkEvents.length - 1].timestamp)
  );
  if (reworkEvents.length > 0) {
    checks.push({
      name: "Rework addressed",
      passed: activeAfterRework,
      severity: "blocking",
      detail: activeAfterRework
        ? `${reworkEvents.length} rework cycle(s), latest addressed`
        : "Issue was sent back for rework but no subsequent Active transition found",
    });
    if (!activeAfterRework) {
      missingSteps.push("Address rework feedback and move back to Active");
    }
  }

  // Check 5: Reasonable session duration (not too fast)
  if (sessionStarts.length > 0) {
    const firstSession = new Date(sessionStarts[0].timestamp).getTime();
    const lastEvent = new Date(events[events.length - 1].timestamp).getTime();
    const durationMinutes = (lastEvent - firstSession) / (1000 * 60);
    const tooFast = durationMinutes < 5;
    checks.push({
      name: "Sufficient development time",
      passed: !tooFast,
      severity: "warning",
      detail: tooFast
        ? `Only ${Math.round(durationMinutes)} minutes of activity — was this too quick?`
        : `${Math.round(durationMinutes)} minutes of recorded activity`,
    });
  }

  // Check 6: Has decisions recorded (for non-trivial issues)
  const decisions = await getDecisions(100, issueNumber);
  checks.push({
    name: "Decisions documented",
    passed: decisions.length > 0,
    severity: "info",
    detail: decisions.length > 0
      ? `${decisions.length} decision(s) recorded`
      : "No decisions recorded — consider documenting key choices",
  });

  // Score
  const blockingFailed = checks.filter((c) => !c.passed && c.severity === "blocking").length;
  const warningFailed = checks.filter((c) => !c.passed && c.severity === "warning").length;
  const totalChecks = checks.length;
  const passed = checks.filter((c) => c.passed).length;
  const score = Math.round((passed / totalChecks) * 100);

  return {
    ready: blockingFailed === 0,
    score,
    checks,
    missingSteps,
  };
}
