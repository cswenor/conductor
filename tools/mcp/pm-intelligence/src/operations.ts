/**
 * Operational Intelligence Module
 *
 * Three tools that turn project data into actionable intelligence:
 *   - suggest_next_issue: "What should I work on next?" recommendation engine
 *   - generate_standup: Auto-generate daily standup from recent activity
 *   - generate_retro: Sprint retrospective from data
 */

import { getVelocity } from "./github.js";
import { getIssue, getLocalBoardSummary, getIssuesByWorkflow } from "./db.js";
import type { LocalIssue } from "./db.js";
import {
  getEvents,
  getOutcomes,
  getDecisions,
  getInsights,
} from "./memory.js";
import { getSprintAnalytics } from "./analytics.js";
import { getTeamCapacity } from "./capacity.js";
import {
  analyzeDependencyGraph,
  getIssueDependencies,
} from "./graph.js";
import { predictCompletion, predictRework } from "./predict.js";
import { getWorkflowHealth } from "./guardrails.js";
import type { WorkflowHealth } from "./guardrails.js";

// ─── TYPES ────────────────────────────────────────────

interface ScoredIssue {
  number: number;
  title: string;
  workflow: string | null;
  priority: string | null;
  area: string | null;
  score: number;
  reasons: string[];
  warnings: string[];
  estimatedDays: { p50: number; p80: number } | null;
  reworkRisk: string | null;
}

interface NextIssueSuggestion {
  recommended: ScoredIssue | null;
  alternatives: ScoredIssue[];
  context: {
    totalCandidates: number;
    activeIssues: number;
    blockedIssues: number;
    readyIssues: number;
  };
  reasoning: string;
}

interface StandupReport {
  date: string;
  period: { from: string; to: string };
  completed: Array<{
    number: number;
    title: string;
    area: string | null;
    completedAt: string;
  }>;
  inProgress: Array<{
    number: number;
    title: string;
    area: string | null;
    daysSinceActive: number;
    lastEvent: string | null;
  }>;
  blocked: Array<{
    number: number;
    title: string;
    blockedBy: number[];
    reason: string;
  }>;
  upcoming: Array<{
    number: number;
    title: string;
    priority: string | null;
    isUnblocked: boolean;
  }>;
  metrics: {
    velocity: { merged7d: number; closed7d: number };
    wip: number;
    flowEfficiency: number | null;
  };
  summary: string;
}

interface RetroReport {
  period: { from: string; to: string; days: number };
  whatWentWell: Array<{ observation: string; evidence: string }>;
  whatCouldImprove: Array<{ observation: string; evidence: string; suggestion: string }>;
  actionItems: Array<{ item: string; priority: "high" | "medium" | "low"; area: string | null }>;
  metrics: {
    issuesClosed: number;
    prsMerged: number;
    avgCycleTimeDays: number | null;
    reworkRate: number;
    flowEfficiency: number | null;
    velocityTrend: string;
  };
  patterns: {
    topReworkReasons: Array<{ reason: string; count: number }>;
    bottleneckStates: Array<{ state: string; avgHours: number }>;
    busyAreas: Array<{ area: string; count: number }>;
    peakHours: Array<{ hour: number; count: number }>;
  };
  highlights: string[];
  summary: string;
}

// ─── SUGGEST NEXT ISSUE ───────────────────────────────

export async function suggestNextIssue(): Promise<NextIssueSuggestion> {
  // Gather data in parallel
  const [board, graphResult, velocity, insights, health] =
    await Promise.all([
      getLocalBoardSummary(),
      analyzeDependencyGraph().catch(() => null),
      getVelocity(),
      getInsights(),
      getWorkflowHealth().catch(() => null),
    ]);

  // Collect from board — active items tell us WIP
  const activeCount = board.activeIssues.length;

  // Primary source: local DB is the source of truth for candidates
  const readyIssues = await getIssuesByWorkflow("Ready");
  const backlogIssues = await getIssuesByWorkflow("Backlog");
  const allIssueNumbers = [
    ...readyIssues.map((i) => i.number),
    ...backlogIssues.map((i) => i.number),
  ];

  const candidates: ScoredIssue[] = [];

  if (allIssueNumbers.length === 0) {
    return {
      recommended: null,
      alternatives: [],
      context: {
        totalCandidates: 0,
        activeIssues: activeCount,
        blockedIssues: 0,
        readyIssues: 0,
      },
      reasoning:
        "No candidate issues found in Ready or Backlog states. " +
        "All issues may be in progress or completed. " +
        "Create new issues or move existing ones to Ready.",
    };
  }

  // Score each candidate
  let blockedCount = 0;
  let readyCount = 0;

  for (const issueNum of allIssueNumbers.slice(0, 20)) {
    // Limit to 20 for performance
    try {
      const [status, deps, completion, rework] = await Promise.all([
        getIssue(issueNum),
        graphResult
          ? getIssueDependencies(issueNum).catch(() => null)
          : Promise.resolve(null),
        predictCompletion(issueNum).catch(() => null),
        predictRework(issueNum).catch(() => null),
      ]);

      if (!status) continue; // Not in local DB
      if (status.workflow === "Ready") readyCount++;

      // Check if blocked
      const isBlocked = deps ? !deps.isUnblocked : false;
      if (isBlocked) {
        blockedCount++;
        continue; // Skip blocked issues
      }

      const score = scoreIssue(status, deps, completion, rework, insights, graphResult);
      candidates.push(score);
    } catch {
      // Skip issues we can't fetch
    }
  }

  // Sort by score descending
  candidates.sort((a, b) => b.score - a.score);

  const recommended = candidates[0] || null;
  const alternatives = candidates.slice(1, 4); // Top 3 alternatives

  // Build reasoning
  let reasoning = "";
  if (recommended) {
    reasoning = `Recommending #${recommended.number} (${recommended.title}) ` +
      `with score ${recommended.score}/100. `;
    reasoning += recommended.reasons.join(". ") + ". ";
    if (recommended.warnings.length > 0) {
      reasoning += "Warnings: " + recommended.warnings.join("; ") + ". ";
    }
    if (activeCount > 0) {
      reasoning += `Note: ${activeCount} issue(s) already active — check WIP limits.`;
    }
  } else {
    reasoning = "No unblocked candidates available. " +
      `${blockedCount} issues are blocked by dependencies.`;
  }

  return {
    recommended,
    alternatives,
    context: {
      totalCandidates: allIssueNumbers.length,
      activeIssues: activeCount,
      blockedIssues: blockedCount,
      readyIssues: readyCount,
    },
    reasoning,
  };
}

function scoreIssue(
  status: LocalIssue,
  deps: { blocksCount?: number; downstreamChain?: number[]; executionOrder?: number; isUnblocked?: boolean } | null,
  completion: { riskScore?: number; prediction?: { p50Days: number; p80Days: number } } | null,
  rework: { riskLevel?: string; reworkProbability?: number } | null,
  insights: { reworkRate: number; topAreas: Array<{ area: string; count: number }> },
  graph: { bottlenecks: Array<{ number: number }> } | null,
): ScoredIssue {
  let score = 50; // Base score
  const reasons: string[] = [];
  const warnings: string[] = [];

  // Priority boost (+30 critical, +20 high, +0 normal)
  if (status.priority === "critical") {
    score += 30;
    reasons.push("Critical priority");
  } else if (status.priority === "high") {
    score += 20;
    reasons.push("High priority");
  }

  // Ready state boost (+10 over Backlog)
  if (status.workflow === "Ready") {
    score += 10;
    reasons.push("Already in Ready state");
  }

  // Dependency value — issues that unblock others score higher
  if (deps) {
    const blocksCount = deps.downstreamChain?.length ?? 0;
    if (blocksCount > 2) {
      score += 15;
      reasons.push(`Unblocks ${blocksCount} downstream issues`);
    } else if (blocksCount > 0) {
      score += 8;
      reasons.push(`Unblocks ${blocksCount} issue(s)`);
    }

    // Bottleneck bonus
    if (graph?.bottlenecks.some((b) => b.number === status.number)) {
      score += 10;
      reasons.push("Identified as graph bottleneck");
    }
  }

  // Low rework risk bonus
  if (rework) {
    if (rework.riskLevel === "low") {
      score += 5;
      reasons.push("Low rework risk");
    } else if (rework.riskLevel === "very_high") {
      score -= 5;
      warnings.push("Very high rework risk (" + Math.round((rework.reworkProbability ?? 0) * 100) + "%)");
    }
  }

  // Quick wins score higher (short predicted completion)
  let estimatedDays: { p50: number; p80: number } | null = null;
  if (completion?.prediction) {
    estimatedDays = {
      p50: completion.prediction.p50Days,
      p80: completion.prediction.p80Days,
    };
    if (completion.prediction.p50Days <= 1) {
      score += 10;
      reasons.push("Quick win (< 1 day estimated)");
    } else if (completion.prediction.p50Days <= 3) {
      score += 5;
      reasons.push("Short estimated cycle (" + completion.prediction.p50Days.toFixed(1) + " days)");
    }
  }

  // High completion risk penalty
  if (completion?.riskScore && completion.riskScore > 70) {
    score -= 5;
    warnings.push("High completion risk (score: " + completion.riskScore + ")");
  }

  // Clamp score
  score = Math.max(0, Math.min(100, score));

  return {
    number: status.number,
    title: status.title,
    workflow: status.workflow,
    priority: status.priority,
    area: status.labels.find((l) => l.startsWith("area:"))?.replace("area:", "") ?? null,
    score,
    reasons,
    warnings,
    estimatedDays,
    reworkRisk: rework?.riskLevel ?? null,
  };
}

// ─── GENERATE STANDUP ─────────────────────────────────

export async function generateStandup(
  lookbackHours = 24
): Promise<StandupReport> {
  const now = new Date();
  const cutoff = new Date(now.getTime() - lookbackHours * 60 * 60 * 1000);
  const cutoffISO = cutoff.toISOString();

  // Gather data in parallel
  const [board, velocity, events, graphResult, health] = await Promise.all([
    getLocalBoardSummary(),
    getVelocity(),
    getEvents(200), // Get recent events
    analyzeDependencyGraph().catch(() => null),
    getWorkflowHealth().catch(() => null),
  ]);

  // Completed: issues that moved to Done in the lookback period
  const completed: StandupReport["completed"] = [];
  const doneEvents = events.filter(
    (e) =>
      e.event_type === "state_transition" &&
      e.to_value === "Done" &&
      e.timestamp >= cutoffISO
  );
  for (const evt of doneEvents) {
    if (evt.issue_number) {
      try {
        const issue = await getIssue(evt.issue_number);
        completed.push({
          number: evt.issue_number,
          title: issue?.title ?? `Issue #${evt.issue_number}`,
          area: issue?.labels.find((l) => l.startsWith("area:"))?.replace("area:", "") ?? null,
          completedAt: evt.timestamp,
        });
      } catch {
        completed.push({
          number: evt.issue_number,
          title: `Issue #${evt.issue_number}`,
          area: null,
          completedAt: evt.timestamp,
        });
      }
    }
  }

  // In Progress: currently active issues
  const inProgress: StandupReport["inProgress"] = [];
  for (const item of board.activeIssues) {
    // Find last event for this issue
    const issueEvents = events.filter(
      (e) => e.issue_number === item.number
    );
    const lastEvent = issueEvents.length > 0
      ? issueEvents[0].event_type
      : null;

    // Estimate days since active
    const activeEvent = events.find(
      (e) =>
        e.issue_number === item.number &&
        e.event_type === "state_transition" &&
        e.to_value === "Active"
    );
    const daysSinceActive = activeEvent
      ? Math.round(
          (now.getTime() - new Date(activeEvent.timestamp).getTime()) /
            (1000 * 60 * 60 * 24)
        )
      : 0;

    inProgress.push({
      number: item.number,
      title: item.title,
      area: item.labels.find((l) => l.startsWith("area:"))?.replace("area:", "") ?? null,
      daysSinceActive,
      lastEvent,
    });
  }

  // Blocked: issues with unresolved blockers
  const blocked: StandupReport["blocked"] = [];
  if (graphResult) {
    for (const orphan of graphResult.orphanedBlocked) {
      blocked.push({
        number: orphan.number,
        title: orphan.title,
        blockedBy: orphan.blockedBy,
        reason: orphan.recommendation,
      });
    }
  }

  // Upcoming: ready issues that are unblocked
  const upcoming: StandupReport["upcoming"] = [];
  if (graphResult) {
    const readyNodes = graphResult.nodes.filter(
      (n) => n.workflow === "Ready" && n.state === "open"
    );
    for (const node of readyNodes.slice(0, 5)) {
      try {
        const deps = await getIssueDependencies(node.number);
        const issue = await getIssue(node.number);
        upcoming.push({
          number: node.number,
          title: node.title,
          priority: issue?.priority ?? null,
          isUnblocked: deps.isUnblocked,
        });
      } catch {
        upcoming.push({
          number: node.number,
          title: node.title,
          priority: null,
          isUnblocked: true,
        });
      }
    }
  }

  // Build summary
  const parts: string[] = [];
  if (completed.length > 0) {
    parts.push(`Completed ${completed.length} issue(s)`);
  }
  if (inProgress.length > 0) {
    parts.push(`${inProgress.length} in progress`);
  }
  if (blocked.length > 0) {
    parts.push(`${blocked.length} blocked`);
  }
  if (upcoming.length > 0) {
    const unblockedCount = upcoming.filter((u) => u.isUnblocked).length;
    parts.push(`${unblockedCount} ready to start`);
  }

  return {
    date: now.toISOString().split("T")[0],
    period: {
      from: cutoffISO,
      to: now.toISOString(),
    },
    completed,
    inProgress,
    blocked,
    upcoming,
    metrics: {
      velocity: {
        merged7d: velocity.last7Days.merged,
        closed7d: velocity.last7Days.closed,
      },
      wip: inProgress.length,
      flowEfficiency: health ? health.summary.healthScore : null,
    },
    summary: parts.length > 0 ? parts.join(". ") + "." : "No activity in the last " + lookbackHours + " hours.",
  };
}

// ─── GENERATE RETRO ───────────────────────────────────

export async function generateRetro(
  days = 14
): Promise<RetroReport> {
  // Gather all data in parallel
  const [analytics, velocity, insights, outcomes, decisions, events, health, graphResult, capacity] =
    await Promise.all([
      getSprintAnalytics(days),
      getVelocity(),
      getInsights(),
      getOutcomes(100),
      getDecisions(50),
      getEvents(500),
      getWorkflowHealth().catch(() => null),
      analyzeDependencyGraph().catch(() => null),
      getTeamCapacity(days).catch(() => null),
    ]);

  // ─── What Went Well ────────────────────────────────
  const well: RetroReport["whatWentWell"] = [];

  // High velocity
  if (analytics.throughput.prsMerged > 0) {
    well.push({
      observation: `Merged ${analytics.throughput.prsMerged} PRs in ${days} days`,
      evidence: `${velocity.last7Days.merged} in last 7 days, ${velocity.last30Days.merged} in last 30 days`,
    });
  }

  // Good flow efficiency
  if (analytics.flowEfficiency !== null && analytics.flowEfficiency > 0.6) {
    well.push({
      observation: `Flow efficiency at ${(analytics.flowEfficiency * 100).toFixed(0)}%`,
      evidence: "More time spent in Active (value-add) than in waiting states",
    });
  }

  // Improving velocity
  if (analytics.trends.velocityTrend === "increasing") {
    well.push({
      observation: "Velocity is increasing",
      evidence: analytics.trends.description,
    });
  }

  // Low rework
  if (insights.reworkRate < 0.15) {
    well.push({
      observation: `Low rework rate (${(insights.reworkRate * 100).toFixed(0)}%)`,
      evidence: `${insights.averageReviewRounds.toFixed(1)} avg review rounds`,
    });
  }

  // Good cycle time
  if (analytics.cycleTime.medianDays !== null && analytics.cycleTime.medianDays < 3) {
    well.push({
      observation: `Fast cycle time (${analytics.cycleTime.medianDays.toFixed(1)} day median)`,
      evidence: `P90: ${analytics.cycleTime.p90Days?.toFixed(1) ?? "N/A"} days`,
    });
  }

  // Decisions recorded
  if (insights.totalDecisions > 0) {
    well.push({
      observation: `${insights.totalDecisions} architectural decisions documented`,
      evidence: "Decision memory is being built for future reference",
    });
  }

  // ─── What Could Improve ────────────────────────────
  const improve: RetroReport["whatCouldImprove"] = [];

  // High rework
  if (insights.reworkRate > 0.25) {
    const topReason = analytics.reworkAnalysis.topReworkReasons[0];
    improve.push({
      observation: `High rework rate (${(insights.reworkRate * 100).toFixed(0)}%)`,
      evidence: topReason
        ? `Top reason: "${topReason.reason}" (${topReason.count} occurrences)`
        : `${insights.averageReviewRounds.toFixed(1)} avg review rounds`,
      suggestion: "Invest in spec readiness checks before starting work. " +
        "Use check_readiness before moving to Active.",
    });
  }

  // Bottlenecks
  for (const bottleneck of analytics.bottlenecks) {
    if (bottleneck.severity === "high") {
      improve.push({
        observation: `Bottleneck in ${bottleneck.state} state`,
        evidence: `Avg ${bottleneck.avgHours.toFixed(0)} hours, reason: ${bottleneck.reason}`,
        suggestion: bottleneck.state === "Review"
          ? "Speed up review cycles — consider automated pre-review with /pm-review"
          : `Investigate why issues stall in ${bottleneck.state}`,
      });
    }
  }

  // Decreasing velocity
  if (analytics.trends.velocityTrend === "decreasing") {
    improve.push({
      observation: "Velocity is decreasing",
      evidence: analytics.trends.description,
      suggestion: "Review scope of recent issues — are they getting larger? " +
        "Consider breaking epics into smaller issues.",
    });
  }

  // Stale items
  const staleCount = health
    ? health.issueHealth.filter((i) => i.stale).length
    : 0;
  if (staleCount > 3) {
    improve.push({
      observation: `${staleCount} stale issues on the board`,
      evidence: "Items with no updates for extended periods",
      suggestion: "Triage stale items — close, reprioritize, or break into smaller chunks",
    });
  }

  // Low flow efficiency
  if (analytics.flowEfficiency !== null && analytics.flowEfficiency < 0.4) {
    improve.push({
      observation: `Low flow efficiency (${(analytics.flowEfficiency * 100).toFixed(0)}%)`,
      evidence: "Too much time spent waiting (Review, Rework) vs working (Active)",
      suggestion: "Reduce handoff delays and review queue time",
    });
  }

  // Dependency bottlenecks
  if (graphResult && graphResult.bottlenecks.length > 0) {
    const criticalBottlenecks = graphResult.bottlenecks.filter(
      (b) => b.severity === "critical"
    );
    if (criticalBottlenecks.length > 0) {
      improve.push({
        observation: `${criticalBottlenecks.length} critical dependency bottleneck(s)`,
        evidence: criticalBottlenecks
          .map((b) => `#${b.number}: blocks ${b.transitiveBlocksCount} issues`)
          .join(", "),
        suggestion: "Prioritize bottleneck issues to unblock downstream work",
      });
    }
  }

  // ─── Action Items ──────────────────────────────────
  const actions: RetroReport["actionItems"] = [];

  // Generate from improvements
  for (const item of improve.slice(0, 5)) {
    actions.push({
      item: item.suggestion,
      priority: item.observation.includes("bottleneck") || item.observation.includes("rework")
        ? "high"
        : "medium",
      area: null,
    });
  }

  // Add area-specific actions from capacity analysis
  if (capacity) {
    for (const area of capacity.areaCoverage) {
      if (area.busFactor <= 1) {
        actions.push({
          item: `Address bus factor risk in ${area.area} (only ${area.contributorCount} contributor(s))`,
          priority: "medium",
          area: area.area,
        });
      }
    }
  }

  // ─── Patterns ──────────────────────────────────────
  const patterns: RetroReport["patterns"] = {
    topReworkReasons: analytics.reworkAnalysis.topReworkReasons,
    bottleneckStates: analytics.bottlenecks.map((b) => ({
      state: b.state,
      avgHours: b.avgHours,
    })),
    busyAreas: insights.topAreas,
    peakHours: analytics.sessionPatterns.peakHours.slice(0, 5),
  };

  // ─── Highlights ────────────────────────────────────
  const highlights: string[] = [];

  if (analytics.throughput.issuesClosed > 0) {
    highlights.push(
      `Closed ${analytics.throughput.issuesClosed} issues and merged ${analytics.throughput.prsMerged} PRs`
    );
  }

  if (capacity && capacity.teamMetrics.totalContributors > 1) {
    highlights.push(
      `${capacity.teamMetrics.activeContributors} active contributors across ${capacity.areaCoverage.length} areas`
    );
  }

  const lessonsLearned = insights.recentLessons.slice(0, 3);
  if (lessonsLearned.length > 0) {
    highlights.push(`${lessonsLearned.length} lessons captured in memory`);
  }

  // ─── Summary ───────────────────────────────────────
  const summaryParts: string[] = [];
  summaryParts.push(
    `Sprint of ${days} days: ${analytics.throughput.issuesClosed} issues closed, ` +
    `${analytics.throughput.prsMerged} PRs merged.`
  );

  if (analytics.cycleTime.medianDays !== null) {
    summaryParts.push(
      `Median cycle time: ${analytics.cycleTime.medianDays.toFixed(1)} days.`
    );
  }

  summaryParts.push(
    `Velocity trend: ${analytics.trends.velocityTrend}. ` +
    `Rework rate: ${(insights.reworkRate * 100).toFixed(0)}%.`
  );

  if (well.length > improve.length) {
    summaryParts.push("Overall: more things going well than areas for improvement.");
  } else if (improve.length > well.length) {
    summaryParts.push("Overall: several areas identified for improvement.");
  } else {
    summaryParts.push("Overall: balanced sprint with both wins and growth areas.");
  }

  return {
    period: analytics.period,
    whatWentWell: well,
    whatCouldImprove: improve,
    actionItems: actions,
    metrics: {
      issuesClosed: analytics.throughput.issuesClosed,
      prsMerged: analytics.throughput.prsMerged,
      avgCycleTimeDays: analytics.cycleTime.averageDays,
      reworkRate: insights.reworkRate,
      flowEfficiency: analytics.flowEfficiency,
      velocityTrend: analytics.trends.velocityTrend,
    },
    patterns,
    highlights,
    summary: summaryParts.join(" "),
  };
}
