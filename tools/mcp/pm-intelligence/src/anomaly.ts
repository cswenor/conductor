/**
 * Anomaly Detection Module
 *
 * Surfaces unusual patterns and early warning signals across the project.
 * Answers: "What should I be worried about that I haven't noticed yet?"
 *
 *   - detect_patterns: Cross-cutting anomaly detection
 */

import { getVelocity } from "./github.js";
import { getLocalBoardSummary } from "./db.js";
import { getInsights, getEvents, getOutcomes } from "./memory.js";
import { getSprintAnalytics } from "./analytics.js";
import { getTeamCapacity } from "./capacity.js";
import { analyzeDependencyGraph } from "./graph.js";
import { getWorkflowHealth } from "./guardrails.js";
import { getDORAMetrics, getKnowledgeRisk } from "./predict.js";

// ─── TYPES ────────────────────────────────────────────

interface Anomaly {
  id: string;
  category:
    | "velocity"
    | "quality"
    | "process"
    | "capacity"
    | "dependency"
    | "knowledge";
  severity: "critical" | "warning" | "info";
  title: string;
  description: string;
  evidence: string;
  trend: "worsening" | "new" | "stable" | "improving";
  affectedIssues: number[];
  suggestedAction: string;
}

interface PatternReport {
  timestamp: string;
  anomalies: Anomaly[];
  healthSnapshot: {
    boardHealth: number;
    velocityTrend: string;
    reworkRate: number;
    doraRating: string;
    dependencyHealth: string;
    knowledgeRisk: string;
  };
  summary: string;
}

// ─── DETECT PATTERNS ──────────────────────────────────

export async function detectPatterns(): Promise<PatternReport> {
  // Gather all data sources in parallel
  const [
    board,
    velocity,
    insights,
    analytics,
    health,
    graph,
    dora,
    knowledge,
    capacity,
    events,
    outcomes,
  ] = await Promise.all([
    getLocalBoardSummary(),
    getVelocity(),
    getInsights(),
    getSprintAnalytics(14).catch(() => null),
    getWorkflowHealth().catch(() => null),
    analyzeDependencyGraph().catch(() => null),
    getDORAMetrics(30).catch(() => null),
    getKnowledgeRisk(90).catch(() => null),
    getTeamCapacity(60).catch(() => null),
    getEvents(500),
    getOutcomes(50),
  ]);

  const anomalies: Anomaly[] = [];
  let anomalyId = 0;

  // ─── Velocity Anomalies ────────────────────────────

  // Velocity drop: 7-day much lower than 30-day average
  if (velocity.last30Days.merged > 0) {
    const weeklyRate = velocity.last7Days.merged;
    const monthlyWeeklyAvg = velocity.last30Days.merged / 4.3;

    if (weeklyRate < monthlyWeeklyAvg * 0.5 && monthlyWeeklyAvg >= 1) {
      anomalies.push({
        id: `anomaly-${++anomalyId}`,
        category: "velocity",
        severity: weeklyRate === 0 ? "critical" : "warning",
        title: "Velocity drop detected",
        description:
          `This week: ${weeklyRate} PRs merged. ` +
          `Monthly average: ${monthlyWeeklyAvg.toFixed(1)}/week. ` +
          `That's a ${((1 - weeklyRate / monthlyWeeklyAvg) * 100).toFixed(0)}% drop.`,
        evidence: `7d: ${velocity.last7Days.merged} merged, 30d: ${velocity.last30Days.merged} merged`,
        trend: "worsening",
        affectedIssues: [],
        suggestedAction: "Check for blockers, capacity issues, or unusually large WIP items.",
      });
    }
  }

  // Issue creation outpacing closure
  if (velocity.last30Days.opened > velocity.last30Days.closed * 1.5 &&
      velocity.last30Days.opened > 5) {
    anomalies.push({
      id: `anomaly-${++anomalyId}`,
      category: "velocity",
      severity: "warning",
      title: "Backlog growing faster than completion",
      description:
        `${velocity.last30Days.opened} issues created vs ${velocity.last30Days.closed} closed in 30 days. ` +
        `Backlog is growing at ${(velocity.last30Days.opened - velocity.last30Days.closed)} items/month.`,
      evidence: `Net growth: +${velocity.last30Days.opened - velocity.last30Days.closed} issues`,
      trend: "worsening",
      affectedIssues: [],
      suggestedAction: "Triage and close stale issues, or focus on closing existing work before creating new.",
    });
  }

  // ─── Quality Anomalies ─────────────────────────────

  // High rework rate
  if (insights.reworkRate > 0.3) {
    anomalies.push({
      id: `anomaly-${++anomalyId}`,
      category: "quality",
      severity: insights.reworkRate > 0.5 ? "critical" : "warning",
      title: "High rework rate",
      description:
        `${(insights.reworkRate * 100).toFixed(0)}% of issues require rework. ` +
        `Average ${insights.averageReviewRounds.toFixed(1)} review rounds.`,
      evidence: `Rework rate: ${(insights.reworkRate * 100).toFixed(0)}%, ` +
        `avg review rounds: ${insights.averageReviewRounds.toFixed(1)}`,
      trend: analytics?.trends.reworkTrend === "worsening" ? "worsening" : "stable",
      affectedIssues: [],
      suggestedAction:
        "Invest in spec readiness (check_readiness) before starting work. " +
        "Consider collaborative planning to catch issues earlier.",
    });
  }

  // Rework trend worsening
  if (analytics?.trends.reworkTrend === "worsening") {
    anomalies.push({
      id: `anomaly-${++anomalyId}`,
      category: "quality",
      severity: "warning",
      title: "Rework trend is worsening",
      description: analytics.trends.description,
      evidence: `Top rework reasons: ${analytics.reworkAnalysis.topReworkReasons
        .slice(0, 3)
        .map((r) => `"${r.reason}" (${r.count}x)`)
        .join(", ")}`,
      trend: "worsening",
      affectedIssues: [],
      suggestedAction: "Address the top rework reasons systematically.",
    });
  }

  // DORA change failure rate
  if (dora && dora.changeFailureRate.rating === "low") {
    anomalies.push({
      id: `anomaly-${++anomalyId}`,
      category: "quality",
      severity: "warning",
      title: "High change failure rate",
      description: dora.changeFailureRate.description,
      evidence: `CFR: ${(dora.changeFailureRate.rate * 100).toFixed(0)}% ` +
        `(${dora.changeFailureRate.reworkCount}/${dora.changeFailureRate.totalCount})`,
      trend: "stable",
      affectedIssues: [],
      suggestedAction: "Improve pre-merge validation — use /pm-review and Codex implementation review.",
    });
  }

  // ─── Process Anomalies ─────────────────────────────

  // Stale items (no staleItems in local board — skip if unavailable)

  // WIP limit violation
  if (board.activeIssues.length > 1) {
    anomalies.push({
      id: `anomaly-${++anomalyId}`,
      category: "process",
      severity: board.activeIssues.length > 2 ? "critical" : "warning",
      title: `WIP limit exceeded (${board.activeIssues.length} active issues)`,
      description:
        `Policy allows 1 active issue at a time, but ${board.activeIssues.length} are currently Active. ` +
        "This splits focus and increases context switching.",
      evidence: board.activeIssues
        .map((a) => `#${a.number} "${a.title}"`)
        .join(", "),
      trend: "new",
      affectedIssues: board.activeIssues.map((a) => a.number),
      suggestedAction: "Complete or park excess active items. Focus on one at a time.",
    });
  }

  // Bottleneck in Review
  if (analytics) {
    const reviewBottleneck = analytics.bottlenecks.find(
      (b) => b.state === "Review" && b.severity === "high"
    );
    if (reviewBottleneck) {
      anomalies.push({
        id: `anomaly-${++anomalyId}`,
        category: "process",
        severity: "warning",
        title: "Review bottleneck",
        description:
          `Issues averaging ${reviewBottleneck.avgHours.toFixed(0)} hours in Review. ` +
          reviewBottleneck.reason,
        evidence: `Review queue: ${board.reviewIssues.length} items`,
        trend: "stable",
        affectedIssues: board.reviewIssues.map((r) => r.number),
        suggestedAction: "Speed up reviews — use /pm-review for automated pre-review.",
      });
    }
  }

  // Low flow efficiency
  if (analytics && analytics.flowEfficiency !== null && analytics.flowEfficiency < 0.3) {
    const fe = analytics.flowEfficiency;
    anomalies.push({
      id: `anomaly-${++anomalyId}`,
      category: "process",
      severity: "warning",
      title: "Low flow efficiency",
      description:
        `Only ${(fe * 100).toFixed(0)}% of time is spent in Active (value-add). ` +
        "Most time is spent waiting in non-productive states.",
      evidence: `Flow efficiency: ${(fe * 100).toFixed(0)}%`,
      trend: "stable",
      affectedIssues: [],
      suggestedAction: "Reduce handoff delays and review queue time. Consider smaller PRs.",
    });
  }

  // ─── Dependency Anomalies ──────────────────────────

  if (graph) {
    // Cycles
    if (graph.cycles.length > 0) {
      anomalies.push({
        id: `anomaly-${++anomalyId}`,
        category: "dependency",
        severity: "critical",
        title: `${graph.cycles.length} dependency cycle(s) detected`,
        description:
          "Circular dependencies create deadlocks — no issue in the cycle can start. " +
          graph.cycles[0].description,
        evidence: graph.cycles
          .map((c) => c.issues.map((i) => `#${i}`).join(" → "))
          .join("; "),
        trend: "new",
        affectedIssues: graph.cycles.flatMap((c) => c.issues),
        suggestedAction: "Break cycles by removing or redefining dependency relationships.",
      });
    }

    // Critical bottleneck issues
    const criticalBottlenecks = graph.bottlenecks.filter(
      (b) => b.severity === "critical"
    );
    if (criticalBottlenecks.length > 0) {
      for (const bottleneck of criticalBottlenecks) {
        if (bottleneck.workflow !== "Active" && bottleneck.workflow !== "Done") {
          anomalies.push({
            id: `anomaly-${++anomalyId}`,
            category: "dependency",
            severity: "critical",
            title: `Bottleneck issue #${bottleneck.number} blocks ${bottleneck.transitiveBlocksCount} issues`,
            description:
              `"${bottleneck.title}" is in ${bottleneck.workflow ?? bottleneck.state} state ` +
              `but blocks ${bottleneck.transitiveBlocksCount} downstream issues transitively.`,
            evidence: bottleneck.recommendation,
            trend: "stable",
            affectedIssues: [bottleneck.number],
            suggestedAction: `Prioritize #${bottleneck.number} to unblock ${bottleneck.transitiveBlocksCount} issues.`,
          });
        }
      }
    }

    // Orphaned blocked issues
    if (graph.orphanedBlocked.length > 0) {
      anomalies.push({
        id: `anomaly-${++anomalyId}`,
        category: "dependency",
        severity: "info",
        title: `${graph.orphanedBlocked.length} issue(s) with resolved blockers still marked blocked`,
        description:
          "These issues have all their blockers resolved but haven't been unblocked. " +
          "They can start immediately.",
        evidence: graph.orphanedBlocked
          .map((o) => `#${o.number}`)
          .join(", "),
        trend: "stable",
        affectedIssues: graph.orphanedBlocked.map((o) => o.number),
        suggestedAction: "Remove blocked labels and move these to Ready.",
      });
    }
  }

  // ─── Capacity Anomalies ────────────────────────────

  if (capacity) {
    // Decelerating contributors
    const decelerating = capacity.contributors.filter(
      (c) => c.velocityTrend === "decelerating"
    );
    if (decelerating.length > 0 && capacity.contributors.length > 1) {
      anomalies.push({
        id: `anomaly-${++anomalyId}`,
        category: "capacity",
        severity: "info",
        title: `${decelerating.length} contributor(s) decelerating`,
        description:
          "Contributors whose merge velocity is decreasing: " +
          decelerating.map((c) => `@${c.login}`).join(", "),
        evidence: decelerating
          .map(
            (c) =>
              `@${c.login}: ${c.prsMerged} PRs, avg ${c.avgDaysToMerge.toFixed(1)}d to merge`
          )
          .join("; "),
        trend: "worsening",
        affectedIssues: [],
        suggestedAction: "Check for blockers or context switching that's slowing contributors.",
      });
    }

    // Single-contributor areas (bus factor = 1)
    const singleContributorAreas = capacity.areaCoverage.filter(
      (a) => a.busFactor <= 1 && a.throughput > 0
    );
    if (singleContributorAreas.length > 0) {
      anomalies.push({
        id: `anomaly-${++anomalyId}`,
        category: "capacity",
        severity: "warning",
        title: `${singleContributorAreas.length} area(s) with bus factor of 1`,
        description:
          "These areas depend entirely on one contributor: " +
          singleContributorAreas
            .map((a) => `${a.area} (${a.contributors.join(", ")})`)
            .join("; "),
        evidence: "If the sole contributor is unavailable, these areas stall.",
        trend: "stable",
        affectedIssues: [],
        suggestedAction: "Cross-train contributors or pair on work in these areas.",
      });
    }
  }

  // ─── Knowledge Risk Anomalies ──────────────────────

  if (knowledge) {
    // Critical knowledge risk files
    if (knowledge.summary.criticalRiskFiles > 0) {
      anomalies.push({
        id: `anomaly-${++anomalyId}`,
        category: "knowledge",
        severity: knowledge.summary.criticalRiskFiles > 5 ? "warning" : "info",
        title: `${knowledge.summary.criticalRiskFiles} file(s) with critical knowledge risk`,
        description:
          `Bus factor: ${knowledge.summary.averageBusFactor.toFixed(1)} average. ` +
          `${knowledge.summary.criticalRiskFiles} files at critical risk.`,
        evidence: knowledge.fileRisks
          .filter((f) => f.knowledgeRisk === "critical")
          .slice(0, 5)
          .map(
            (f) =>
              `${f.file} (bus factor: ${f.busFactor}, ${f.daysSinceTouch}d since touch)`
          )
          .join("; "),
        trend: "stable",
        affectedIssues: [],
        suggestedAction: knowledge.summary.recommendation,
      });
    }

    // Decay alerts
    if (knowledge.decayAlerts.length > 3) {
      anomalies.push({
        id: `anomaly-${++anomalyId}`,
        category: "knowledge",
        severity: "info",
        title: `${knowledge.decayAlerts.length} knowledge decay alert(s)`,
        description: "Files with significant changes that haven't been touched recently.",
        evidence: knowledge.decayAlerts
          .slice(0, 3)
          .map((d) => d.alert)
          .join("; "),
        trend: "stable",
        affectedIssues: [],
        suggestedAction: "Review and document these files while context is still fresh.",
      });
    }
  }

  // ─── Sort and Build Report ─────────────────────────

  // Sort by severity
  const severityOrder: Record<string, number> = {
    critical: 0,
    warning: 1,
    info: 2,
  };
  anomalies.sort(
    (a, b) => (severityOrder[a.severity] ?? 2) - (severityOrder[b.severity] ?? 2)
  );

  // Build health snapshot
  const healthSnapshot = {
    boardHealth: board.healthScore,
    velocityTrend: analytics?.trends.velocityTrend ?? "unknown",
    reworkRate: insights.reworkRate,
    doraRating: dora?.overall.rating ?? "unknown",
    dependencyHealth: graph
      ? graph.cycles.length > 0
        ? "cycles detected"
        : graph.bottlenecks.length > 0
          ? `${graph.bottlenecks.length} bottleneck(s)`
          : "healthy"
      : "unknown",
    knowledgeRisk: knowledge
      ? knowledge.summary.criticalRiskFiles > 0
        ? `${knowledge.summary.criticalRiskFiles} critical files`
        : "healthy"
      : "unknown",
  };

  // Build summary
  const critical = anomalies.filter((a) => a.severity === "critical");
  const warnings = anomalies.filter((a) => a.severity === "warning");
  const infos = anomalies.filter((a) => a.severity === "info");

  let summary: string;
  if (anomalies.length === 0) {
    summary = "No anomalies detected. Project metrics are within normal ranges.";
  } else {
    const parts: string[] = [];
    parts.push(`${anomalies.length} pattern(s) detected`);
    if (critical.length > 0) parts.push(`${critical.length} critical`);
    if (warnings.length > 0) parts.push(`${warnings.length} warning(s)`);
    if (infos.length > 0) parts.push(`${infos.length} informational`);
    summary = parts.join(", ") + ". ";

    if (critical.length > 0) {
      summary += `Top concern: ${critical[0].title}. `;
    } else if (warnings.length > 0) {
      summary += `Top concern: ${warnings[0].title}. `;
    }

    // Add a worsening trend callout
    const worsening = anomalies.filter((a) => a.trend === "worsening");
    if (worsening.length > 0) {
      summary += `${worsening.length} pattern(s) are actively worsening.`;
    }
  }

  return {
    timestamp: new Date().toISOString(),
    anomalies,
    healthSnapshot,
    summary,
  };
}
