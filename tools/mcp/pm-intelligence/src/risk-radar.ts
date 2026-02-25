/**
 * Risk Radar — Unified risk assessment synthesizing all intelligence signals
 *
 * Tools:
 *   - getRiskRadar: One-call comprehensive risk view combining knowledge risk,
 *     rework probability, dependency cycles, stale items, anomalies, DORA
 *     metrics, and capacity constraints. Returns prioritized risks with
 *     trend arrows and actionable mitigations.
 */

import { getVelocity } from "./github.js";
import { getLocalBoardSummary } from "./db.js";
import { analyzeDependencyGraph } from "./graph.js";
import { getWorkflowHealth } from "./guardrails.js";
import { getKnowledgeRisk, getDORAMetrics } from "./predict.js";
import { getTeamCapacity } from "./capacity.js";
import { getInsights } from "./memory.js";
import { detectPatterns } from "./anomaly.js";

// ─── Types ───────────────────────────────────────────────

interface Risk {
  id: string;
  category:
    | "delivery"
    | "quality"
    | "knowledge"
    | "process"
    | "dependency"
    | "capacity";
  severity: "critical" | "high" | "medium" | "low";
  title: string;
  description: string;
  evidence: string[];
  trend: "worsening" | "stable" | "improving" | "new";
  affectedAreas: string[];
  affectedIssues: number[];
  mitigations: Array<{
    action: string;
    effort: "low" | "medium" | "high";
    impact: "low" | "medium" | "high";
  }>;
  score: number; // 0-100
}

interface RiskRadarResult {
  overallRiskScore: number; // 0-100
  riskLevel: "critical" | "high" | "medium" | "low";
  risks: Risk[];
  topRisks: Risk[];
  risksByCategory: Record<string, number>;
  trendSummary: {
    worsening: number;
    stable: number;
    improving: number;
    new: number;
  };
  healthIndicators: {
    velocityHealth: "healthy" | "warning" | "critical";
    qualityHealth: "healthy" | "warning" | "critical";
    processHealth: "healthy" | "warning" | "critical";
    knowledgeHealth: "healthy" | "warning" | "critical";
    dependencyHealth: "healthy" | "warning" | "critical";
    capacityHealth: "healthy" | "warning" | "critical";
  };
  recommendations: string[];
  summary: string;
}

// ─── Main Tool ───────────────────────────────────────────

export async function getRiskRadar(): Promise<RiskRadarResult> {
  // Gather all signals in parallel
  const [
    board,
    velocity,
    graph,
    health,
    knowledge,
    dora,
    capacity,
    insights,
    anomalies,
  ] = await Promise.all([
    getLocalBoardSummary().catch(() => null),
    getVelocity().catch(() => null),
    analyzeDependencyGraph().catch(() => null),
    getWorkflowHealth().catch(() => null),
    getKnowledgeRisk().catch(() => null),
    getDORAMetrics().catch(() => null),
    getTeamCapacity().catch(() => null),
    getInsights().catch(() => null),
    detectPatterns().catch(() => null),
  ]);

  const risks: Risk[] = [];

  // ─── Delivery Risks ────────────────────────────────────
  if (velocity) {
    const weeklyRate = velocity.last7Days.merged;
    const monthlyRate = velocity.last30Days.merged / 4.3;

    if (weeklyRate === 0) {
      risks.push({
        id: "delivery-zero-velocity",
        category: "delivery",
        severity: "critical",
        title: "Zero delivery velocity",
        description: "No PRs merged in the last 7 days",
        evidence: [`7d merges: ${weeklyRate}`, `30d avg/week: ${monthlyRate.toFixed(1)}`],
        trend: monthlyRate > 0 ? "worsening" : "stable",
        affectedAreas: [],
        affectedIssues: [],
        mitigations: [
          { action: "Investigate blocked items and review queue", effort: "low", impact: "high" },
          { action: "Check if active work is stuck", effort: "low", impact: "medium" },
        ],
        score: 95,
      });
    } else if (weeklyRate < monthlyRate * 0.5) {
      risks.push({
        id: "delivery-velocity-drop",
        category: "delivery",
        severity: "high",
        title: "Velocity dropped significantly",
        description: `This week: ${weeklyRate} merges vs ${monthlyRate.toFixed(1)}/week average`,
        evidence: [`50%+ drop from 30-day average`],
        trend: "worsening",
        affectedAreas: [],
        affectedIssues: [],
        mitigations: [
          { action: "Check for new blockers or distractions", effort: "low", impact: "medium" },
        ],
        score: 70,
      });
    }

    // Backlog growth
    if (velocity.last7Days.opened > velocity.last7Days.closed * 2) {
      risks.push({
        id: "delivery-backlog-growth",
        category: "delivery",
        severity: "medium",
        title: "Backlog growing faster than delivery",
        description: `${velocity.last7Days.opened} opened vs ${velocity.last7Days.closed} closed (7d)`,
        evidence: [`2:1+ creation-to-closure ratio`],
        trend: "worsening",
        affectedAreas: [],
        affectedIssues: [],
        mitigations: [
          { action: "Triage and close stale/duplicate issues", effort: "low", impact: "medium" },
          { action: "Reduce WIP to focus on completion", effort: "medium", impact: "high" },
        ],
        score: 55,
      });
    }
  }

  // ─── Quality Risks ─────────────────────────────────────
  if (insights) {
    if (insights.reworkRate > 0.3) {
      risks.push({
        id: "quality-high-rework",
        category: "quality",
        severity: insights.reworkRate > 0.5 ? "critical" : "high",
        title: `High rework rate: ${Math.round(insights.reworkRate * 100)}%`,
        description: `${Math.round(insights.reworkRate * 100)}% of completed work requires rework`,
        evidence: [
          `Rework rate: ${Math.round(insights.reworkRate * 100)}%`,
          `Avg review rounds: ${insights.averageReviewRounds.toFixed(1)}`,
        ],
        trend: "stable", // would need historical comparison
        affectedAreas: insights.topAreas.map((a) => a.area),
        affectedIssues: [],
        mitigations: [
          { action: "Run /pm-review before requesting human review", effort: "low", impact: "high" },
          { action: "Improve acceptance criteria clarity", effort: "medium", impact: "high" },
        ],
        score: Math.round(insights.reworkRate * 100),
      });
    }
  }

  if (dora) {
    if (
      dora.changeFailureRate.rate !== null &&
      dora.changeFailureRate.rate > 0.15
    ) {
      risks.push({
        id: "quality-change-failure",
        category: "quality",
        severity: dora.changeFailureRate.rate > 0.3 ? "critical" : "high",
        title: `Change failure rate: ${Math.round(dora.changeFailureRate.rate * 100)}%`,
        description: "Too many changes require follow-up fixes",
        evidence: [
          `CFR: ${Math.round(dora.changeFailureRate.rate * 100)}%`,
          `Rating: ${dora.changeFailureRate.rating}`,
        ],
        trend: "stable",
        affectedAreas: [],
        affectedIssues: [],
        mitigations: [
          { action: "Add automated testing for regression-prone areas", effort: "high", impact: "high" },
          { action: "Implement pre-merge review gate", effort: "medium", impact: "high" },
        ],
        score: Math.round(dora.changeFailureRate.rate * 100) + 20,
      });
    }
  }

  // ─── Knowledge Risks ───────────────────────────────────
  if (knowledge) {
    if (knowledge.summary.averageBusFactor <= 1) {
      risks.push({
        id: "knowledge-bus-factor",
        category: "knowledge",
        severity: "high",
        title: "Bus factor is 1",
        description: "All knowledge concentrated in a single contributor",
        evidence: [
          `Average bus factor: ${knowledge.summary.averageBusFactor}`,
          `Critical risk files: ${knowledge.summary.criticalRiskFiles}`,
        ],
        trend: "stable",
        affectedAreas: knowledge.areaRisks.filter((a) => a.avgBusFactor <= 1).map((a) => a.area),
        affectedIssues: [],
        mitigations: [
          { action: "Onboard additional contributor", effort: "high", impact: "high" },
          { action: "Document architectural decisions", effort: "medium", impact: "medium" },
        ],
        score: 75,
      });
    }

    if (knowledge.summary.criticalRiskFiles > 5) {
      risks.push({
        id: "knowledge-critical-files",
        category: "knowledge",
        severity: "medium",
        title: `${knowledge.summary.criticalRiskFiles} critical-risk files`,
        description: "Files with single contributor + high churn",
        evidence: [
          `${knowledge.summary.criticalRiskFiles} files at critical risk`,
          `${knowledge.decayAlerts.length} decay alerts`,
        ],
        trend: knowledge.decayAlerts.length > 3 ? "worsening" : "stable",
        affectedAreas: [],
        affectedIssues: [],
        mitigations: [
          { action: "Pair review high-risk files", effort: "low", impact: "medium" },
          { action: "Add tests for critical files", effort: "medium", impact: "high" },
        ],
        score: Math.min(90, knowledge.summary.criticalRiskFiles * 10),
      });
    }
  }

  // ─── Process Risks ─────────────────────────────────────
  if (health) {
    const staleCount = health.issueHealth.filter((i) => i.stale).length;
    if (staleCount > 3) {
      risks.push({
        id: "process-stale-items",
        category: "process",
        severity: staleCount > 8 ? "high" : "medium",
        title: `${staleCount} stale issues`,
        description: "Issues with no recent activity",
        evidence: [`${staleCount} issues stale`],
        trend: "stable",
        affectedAreas: [],
        affectedIssues: health.issueHealth
          .filter((i) => i.stale)
          .slice(0, 5)
          .map((i) => i.issueNumber),
        mitigations: [
          { action: "Triage stale issues: close, deprioritize, or act", effort: "low", impact: "medium" },
        ],
        score: Math.min(80, staleCount * 8),
      });
    }

    if (board && board.activeIssues.length > 1) {
      risks.push({
        id: "process-wip-violation",
        category: "process",
        severity: "high",
        title: `WIP limit violated: ${board.activeIssues.length} active`,
        description: "AI WIP limit is 1 Active issue at a time",
        evidence: [
          `${board.activeIssues.length} issues in Active`,
          `Policy: max 1 Active`,
        ],
        trend: "new",
        affectedAreas: [],
        affectedIssues: board.activeIssues.map((i) => i.number),
        mitigations: [
          { action: "Move extra active items back to Ready", effort: "low", impact: "high" },
          { action: "Focus on completing one item before starting another", effort: "low", impact: "high" },
        ],
        score: 80,
      });
    }
  }

  // ─── Dependency Risks ──────────────────────────────────
  if (graph) {
    if (graph.cycles.length > 0) {
      risks.push({
        id: "dependency-cycles",
        category: "dependency",
        severity: "critical",
        title: `${graph.cycles.length} dependency cycle(s)`,
        description: "Circular dependencies block all involved issues",
        evidence: graph.cycles.map(
          (c) => `Cycle: ${c.issues.map((i) => `#${i}`).join(" → ")}`
        ),
        trend: "stable",
        affectedAreas: [],
        affectedIssues: graph.cycles.flatMap((c) => c.issues),
        mitigations: [
          { action: "Break cycles by removing one edge", effort: "low", impact: "critical" as any },
        ],
        score: 90,
      });
    }

    const criticalBottlenecks = graph.bottlenecks.filter(
      (b) => b.severity === "critical" && b.state === "open" && b.workflow !== "Active"
    );
    if (criticalBottlenecks.length > 0) {
      risks.push({
        id: "dependency-bottlenecks",
        category: "dependency",
        severity: "high",
        title: `${criticalBottlenecks.length} critical bottleneck(s) not being worked`,
        description: "Issues blocking multiple downstream items are not Active",
        evidence: criticalBottlenecks.map(
          (b) => `#${b.number}: blocks ${b.transitiveBlocksCount} issues (${b.workflow})`
        ),
        trend: "stable",
        affectedAreas: [],
        affectedIssues: criticalBottlenecks.map((b) => b.number),
        mitigations: [
          { action: "Prioritize bottleneck issues to Active", effort: "low", impact: "high" },
        ],
        score: 75,
      });
    }

    if (graph.orphanedBlocked.length > 0) {
      risks.push({
        id: "dependency-orphaned",
        category: "dependency",
        severity: "medium",
        title: `${graph.orphanedBlocked.length} orphaned blocked issues`,
        description: "All blockers resolved but still marked blocked",
        evidence: graph.orphanedBlocked.map(
          (o) => `#${o.number}: blockers ${o.blockedBy.map((b) => `#${b}`).join(", ")} all resolved`
        ),
        trend: "stable",
        affectedAreas: [],
        affectedIssues: graph.orphanedBlocked.map((o) => o.number),
        mitigations: [
          { action: "Remove blocked: labels", effort: "low", impact: "medium" },
        ],
        score: 40,
      });
    }
  }

  // ─── Capacity Risks ────────────────────────────────────
  if (capacity) {
    const decelerating = capacity.contributors.filter(
      (c) => c.velocityTrend === "decelerating"
    );
    if (decelerating.length > 0) {
      risks.push({
        id: "capacity-deceleration",
        category: "capacity",
        severity: "medium",
        title: `${decelerating.length} contributor(s) decelerating`,
        description: "Contributors showing declining velocity",
        evidence: decelerating.map(
          (c) => `@${c.login}: ${c.velocityTrend}`
        ),
        trend: "worsening",
        affectedAreas: [],
        affectedIssues: [],
        mitigations: [
          { action: "Check for blockers or context-switching overhead", effort: "low", impact: "medium" },
        ],
        score: 45,
      });
    }
  }

  // ─── Incorporate anomaly signals ───────────────────────
  if (anomalies) {
    for (const anomaly of anomalies.anomalies) {
      // Avoid duplicating risks already captured above
      const isDuplicate = risks.some(
        (r) => r.affectedIssues.some((i) => anomaly.affectedIssues.includes(i)) &&
          r.category === anomaly.category
      );
      if (isDuplicate) continue;

      // Add unique anomaly signals
      if (
        anomaly.severity === "critical" &&
        !risks.some((r) => r.id === anomaly.id)
      ) {
        risks.push({
          id: `anomaly-${anomaly.id}`,
          category: (anomaly.category as Risk["category"]) || "process",
          severity: "high",
          title: anomaly.title,
          description: anomaly.description,
          evidence: [anomaly.evidence],
          trend: anomaly.trend as Risk["trend"],
          affectedAreas: [],
          affectedIssues: anomaly.affectedIssues,
          mitigations: [
            { action: anomaly.suggestedAction, effort: "medium", impact: "medium" },
          ],
          score: 65,
        });
      }
    }
  }

  // ─── Score and sort ────────────────────────────────────
  risks.sort((a, b) => b.score - a.score);

  // Overall risk score (weighted average of top risks)
  const topN = risks.slice(0, 5);
  const overallRiskScore =
    topN.length > 0
      ? Math.round(
          topN.reduce((sum, r, i) => sum + r.score * (1 - i * 0.15), 0) /
            topN.reduce((_, __, i) => _ + (1 - i * 0.15), 0)
        )
      : 0;

  const riskLevel: RiskRadarResult["riskLevel"] =
    overallRiskScore > 75
      ? "critical"
      : overallRiskScore > 50
        ? "high"
        : overallRiskScore > 25
          ? "medium"
          : "low";

  // Category counts
  const risksByCategory: Record<string, number> = {};
  for (const r of risks) {
    risksByCategory[r.category] = (risksByCategory[r.category] || 0) + 1;
  }

  // Trend summary
  const trendSummary = {
    worsening: risks.filter((r) => r.trend === "worsening").length,
    stable: risks.filter((r) => r.trend === "stable").length,
    improving: risks.filter((r) => r.trend === "improving").length,
    new: risks.filter((r) => r.trend === "new").length,
  };

  // Health indicators
  const healthIndicators: RiskRadarResult["healthIndicators"] = {
    velocityHealth: risks.some(
      (r) => r.category === "delivery" && r.severity === "critical"
    )
      ? "critical"
      : risks.some(
            (r) => r.category === "delivery" && r.severity === "high"
          )
        ? "warning"
        : "healthy",
    qualityHealth: risks.some(
      (r) => r.category === "quality" && r.severity === "critical"
    )
      ? "critical"
      : risks.some(
            (r) => r.category === "quality" && r.severity === "high"
          )
        ? "warning"
        : "healthy",
    processHealth: risks.some(
      (r) => r.category === "process" && r.severity === "critical"
    )
      ? "critical"
      : risks.some(
            (r) => r.category === "process" && r.severity === "high"
          )
        ? "warning"
        : "healthy",
    knowledgeHealth: risks.some(
      (r) => r.category === "knowledge" && r.severity === "critical"
    )
      ? "critical"
      : risks.some(
            (r) => r.category === "knowledge" && r.severity === "high"
          )
        ? "warning"
        : "healthy",
    dependencyHealth: risks.some(
      (r) => r.category === "dependency" && r.severity === "critical"
    )
      ? "critical"
      : risks.some(
            (r) => r.category === "dependency" && r.severity === "high"
          )
        ? "warning"
        : "healthy",
    capacityHealth: risks.some(
      (r) => r.category === "capacity" && r.severity === "critical"
    )
      ? "critical"
      : risks.some(
            (r) => r.category === "capacity" && r.severity === "high"
          )
        ? "warning"
        : "healthy",
  };

  // Recommendations (top mitigations by impact/effort ratio)
  const allMitigations = risks
    .slice(0, 5)
    .flatMap((r) =>
      r.mitigations.map((m) => ({
        ...m,
        riskId: r.id,
        riskSeverity: r.severity,
      }))
    );
  const recommendations = allMitigations
    .filter((m) => m.effort !== "high" || m.impact === "high")
    .slice(0, 5)
    .map((m) => m.action);

  const summary =
    `Risk level: ${riskLevel} (${overallRiskScore}/100). ` +
    `${risks.length} risk${risks.length !== 1 ? "s" : ""} detected across ` +
    `${Object.keys(risksByCategory).length} categories. ` +
    `${trendSummary.worsening > 0 ? `${trendSummary.worsening} worsening. ` : ""}` +
    `${trendSummary.new > 0 ? `${trendSummary.new} new. ` : ""}` +
    `Top risk: ${risks[0]?.title || "none"}.`;

  return {
    overallRiskScore,
    riskLevel,
    risks,
    topRisks: risks.slice(0, 5),
    risksByCategory,
    trendSummary,
    healthIndicators,
    recommendations,
    summary,
  };
}
