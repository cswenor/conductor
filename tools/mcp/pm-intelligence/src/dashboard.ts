/**
 * Project health dashboard — synthesizes ALL intelligence into one report.
 *
 * Instead of calling 5+ tools to understand project state, this single tool
 * combines: board summary, velocity, DORA metrics, workflow health, dependency
 * graph, team capacity, and sprint simulation into one actionable report.
 *
 * The output is a formatted markdown report that Claude can present directly.
 *
 * Tools:
 *   - get_project_dashboard: Full project health report
 */

import {
  getVelocity,
  type VelocityMetrics,
} from "./github.js";
import { getLocalBoardSummary } from "./db.js";
import {
  getDORAMetrics,
  getKnowledgeRisk,
  type DORAMetrics,
  type KnowledgeRisk,
} from "./predict.js";
import { getWorkflowHealth, type WorkflowHealth } from "./guardrails.js";
import { analyzeDependencyGraph, type DependencyGraphResult } from "./graph.js";
import { getTeamCapacity, type TeamCapacityResult } from "./capacity.js";
import { simulateSprint, type SprintSimulationResult } from "./simulate.js";
import { getInsights, type MemoryInsights } from "./memory.js";

// ─── Types ──────────────────────────────────────────────

interface HealthSignal {
  name: string;
  score: number;      // 0-100
  status: "healthy" | "warning" | "critical";
  detail: string;
}

export interface ProjectDashboard {
  /** Overall health score (0-100) */
  overallScore: number;
  /** Overall status */
  overallStatus: "healthy" | "warning" | "critical";
  /** Individual health signals */
  signals: HealthSignal[];
  /** Formatted markdown report */
  report: string;
  /** Top 5 actionable recommendations */
  recommendations: string[];
  /** Timestamp */
  generatedAt: string;
}

// ─── Data Gathering ─────────────────────────────────────

type LocalBoardSummary = Awaited<ReturnType<typeof getLocalBoardSummary>>;

interface DashboardData {
  board: LocalBoardSummary | null;
  velocity: VelocityMetrics | null;
  dora: DORAMetrics | null;
  knowledgeRisk: KnowledgeRisk | null;
  workflowHealth: WorkflowHealth | null;
  graph: DependencyGraphResult | null;
  capacity: TeamCapacityResult | null;
  simulation: SprintSimulationResult | null;
  memoryInsights: MemoryInsights | null;
}

async function gatherData(): Promise<DashboardData> {
  // Run all data gathering in parallel — each one is independent
  const [
    board,
    velocity,
    dora,
    knowledgeRisk,
    workflowHealth,
    graph,
    capacity,
    simulation,
    memoryInsights,
  ] = await Promise.allSettled([
    getLocalBoardSummary(),
    getVelocity(),
    getDORAMetrics(30),
    getKnowledgeRisk(90),
    getWorkflowHealth(),
    analyzeDependencyGraph(),
    getTeamCapacity(30),
    simulateSprint({ sprintDays: 14 }),
    getInsights(),
  ]);

  return {
    board: board.status === "fulfilled" ? board.value : null,
    velocity: velocity.status === "fulfilled" ? velocity.value : null,
    dora: dora.status === "fulfilled" ? dora.value : null,
    knowledgeRisk: knowledgeRisk.status === "fulfilled" ? knowledgeRisk.value : null,
    workflowHealth: workflowHealth.status === "fulfilled" ? workflowHealth.value : null,
    graph: graph.status === "fulfilled" ? graph.value : null,
    capacity: capacity.status === "fulfilled" ? capacity.value : null,
    simulation: simulation.status === "fulfilled" ? simulation.value : null,
    memoryInsights: memoryInsights.status === "fulfilled" ? memoryInsights.value : null,
  };
}

// ─── Health Scoring ─────────────────────────────────────

function scoreVelocity(velocity: VelocityMetrics | null): HealthSignal {
  if (!velocity) {
    return { name: "Velocity", score: 50, status: "warning", detail: "No velocity data available" };
  }

  // VelocityMetrics: { last7Days: { merged, closed, opened }, last30Days: { ... }, avgDaysToMerge }
  const merged7d = velocity.last7Days.merged;
  const merged30d = velocity.last30Days.merged;
  const weeklyAvg = merged30d / 4;

  let score: number;
  let detail: string;

  if (merged7d === 0 && merged30d === 0) {
    score = 20;
    detail = "No merges in 30 days — stalled";
  } else if (merged7d === 0) {
    score = 40;
    detail = `No merges this week (avg ${weeklyAvg.toFixed(1)}/week over 30d)`;
  } else if (merged7d >= weeklyAvg * 1.2) {
    score = 90;
    detail = `${merged7d} merged this week — above average (${weeklyAvg.toFixed(1)}/week)`;
  } else if (merged7d >= weeklyAvg * 0.8) {
    score = 75;
    detail = `${merged7d} merged this week — on pace (${weeklyAvg.toFixed(1)}/week)`;
  } else {
    score = 55;
    detail = `${merged7d} merged this week — below average (${weeklyAvg.toFixed(1)}/week)`;
  }

  return {
    name: "Velocity",
    score,
    status: score >= 70 ? "healthy" : score >= 40 ? "warning" : "critical",
    detail,
  };
}

function scoreDORA(dora: DORAMetrics | null): HealthSignal {
  if (!dora) {
    return { name: "DORA", score: 50, status: "warning", detail: "No DORA data available" };
  }

  const ratingToScore: Record<string, number> = {
    elite: 95,
    high: 80,
    medium: 60,
    low: 35,
    unknown: 50,
  };

  const scores = [
    ratingToScore[dora.deploymentFrequency?.rating ?? "unknown"] ?? 50,
    ratingToScore[dora.leadTimeForChanges?.rating ?? "unknown"] ?? 50,
    ratingToScore[dora.changeFailureRate?.rating ?? "unknown"] ?? 50,
    ratingToScore[dora.meanTimeToRestore?.rating ?? "unknown"] ?? 50,
  ];

  const avg = Math.round(scores.reduce((a, b) => a + b, 0) / scores.length);
  const summary = `DF:${dora.deploymentFrequency?.rating ?? "?"} LT:${dora.leadTimeForChanges?.rating ?? "?"} CFR:${dora.changeFailureRate?.rating ?? "?"} MTTR:${dora.meanTimeToRestore?.rating ?? "?"}`;

  return {
    name: "DORA Metrics",
    score: avg,
    status: avg >= 70 ? "healthy" : avg >= 45 ? "warning" : "critical",
    detail: summary,
  };
}

function scoreWorkflow(health: WorkflowHealth | null): HealthSignal {
  if (!health) {
    return { name: "Workflow", score: 50, status: "warning", detail: "No workflow data available" };
  }

  // WorkflowHealth has summary.healthScore and issueHealth[].stale
  const score = health.summary.healthScore;
  const staleCount = health.issueHealth.filter((i) => i.stale).length;
  const bottleneckState = health.bottlenecks[0]?.state ?? "none";

  let detail = `Health: ${score}/100`;
  if (staleCount > 0) detail += ` | ${staleCount} stale issue${staleCount > 1 ? "s" : ""}`;
  if (bottleneckState !== "none") detail += ` | bottleneck: ${bottleneckState}`;

  return {
    name: "Workflow Health",
    score,
    status: score >= 70 ? "healthy" : score >= 45 ? "warning" : "critical",
    detail,
  };
}

function scoreDependencies(graph: DependencyGraphResult | null): HealthSignal {
  if (!graph) {
    return { name: "Dependencies", score: 80, status: "healthy", detail: "No dependency data" };
  }

  let score = 90;
  const issues: string[] = [];

  if (graph.cycles.length > 0) {
    score -= 30;
    issues.push(`${graph.cycles.length} cycle${graph.cycles.length > 1 ? "s" : ""} detected`);
  }

  const criticalBottlenecks = graph.bottlenecks.filter((b) => b.severity === "critical");
  if (criticalBottlenecks.length > 0) {
    score -= 15 * criticalBottlenecks.length;
    issues.push(`${criticalBottlenecks.length} critical bottleneck${criticalBottlenecks.length > 1 ? "s" : ""}`);
  }

  if (graph.orphanedBlocked.length > 0) {
    score -= 5 * graph.orphanedBlocked.length;
    issues.push(`${graph.orphanedBlocked.length} orphaned blocked`);
  }

  if (graph.criticalPath.length > 4) {
    score -= 10;
    issues.push(`critical path ${graph.criticalPath.length} deep`);
  }

  score = Math.max(0, Math.min(100, score));
  const detail = issues.length > 0 ? issues.join(" | ") : "No dependency issues";

  return {
    name: "Dependencies",
    score,
    status: score >= 70 ? "healthy" : score >= 45 ? "warning" : "critical",
    detail,
  };
}

function scoreCapacity(capacity: TeamCapacityResult | null): HealthSignal {
  if (!capacity) {
    return { name: "Capacity", score: 50, status: "warning", detail: "No capacity data" };
  }

  const forecast = capacity.sprintForecast;
  const expected = forecast.expected;
  const busFactor = capacity.areaCoverage
    .map((a) => a.busFactor)
    .sort((a, b) => a - b)[0] ?? 0;

  let score = 70;
  const details: string[] = [`expected: ${expected} items/sprint`];

  if (expected === 0) {
    score = 20;
  } else if (expected >= 5) {
    score = 85;
  }

  if (busFactor <= 1) {
    score -= 15;
    details.push(`bus factor: ${busFactor} (single point of failure)`);
  }

  const activeContributors = capacity.contributors.filter(
    (c) => c.velocityTrend === "accelerating" || c.velocityTrend === "stable"
  ).length;

  if (activeContributors === 0) {
    score -= 20;
    details.push("no active contributors");
  }

  score = Math.max(0, Math.min(100, score));

  return {
    name: "Team Capacity",
    score,
    status: score >= 70 ? "healthy" : score >= 45 ? "warning" : "critical",
    detail: details.join(" | "),
  };
}

function scoreKnowledgeRisk(risk: KnowledgeRisk | null): HealthSignal {
  if (!risk) {
    return { name: "Knowledge", score: 70, status: "healthy", detail: "No knowledge data" };
  }

  // KnowledgeRisk: { fileRisks[].knowledgeRisk, summary.averageBusFactor, summary.criticalRiskFiles }
  const busFactor = risk.summary.averageBusFactor;
  const criticalFiles = risk.summary.criticalRiskFiles;

  let score = 80;
  const details: string[] = [];

  if (busFactor <= 1) {
    score -= 25;
    details.push(`avg bus factor: ${busFactor.toFixed(1)}`);
  } else if (busFactor <= 2) {
    score -= 10;
    details.push(`avg bus factor: ${busFactor.toFixed(1)}`);
  }

  if (criticalFiles > 0) {
    score -= Math.min(30, criticalFiles * 5);
    details.push(`${criticalFiles} critical-risk file${criticalFiles > 1 ? "s" : ""}`);
  }

  score = Math.max(0, Math.min(100, score));

  return {
    name: "Knowledge Risk",
    score,
    status: score >= 70 ? "healthy" : score >= 45 ? "warning" : "critical",
    detail: details.length > 0 ? details.join(" | ") : "Knowledge distribution healthy",
  };
}

function scoreMemory(insights: MemoryInsights | null): HealthSignal {
  if (!insights) {
    return { name: "Learning", score: 50, status: "warning", detail: "No memory data" };
  }

  // MemoryInsights: { reworkRate: number, ... }
  const reworkRate = insights.reworkRate;
  let score = 75;
  const details: string[] = [];

  if (reworkRate > 0.3) {
    score = 35;
    details.push(`rework rate: ${(reworkRate * 100).toFixed(0)}% (high)`);
  } else if (reworkRate > 0.15) {
    score = 55;
    details.push(`rework rate: ${(reworkRate * 100).toFixed(0)}% (moderate)`);
  } else {
    score = 85;
    details.push(`rework rate: ${(reworkRate * 100).toFixed(0)}% (healthy)`);
  }

  return {
    name: "Learning",
    score,
    status: score >= 70 ? "healthy" : score >= 45 ? "warning" : "critical",
    detail: details.join(" | "),
  };
}

// ─── Report Generation ──────────────────────────────────

function generateRecommendations(
  signals: HealthSignal[],
  data: DashboardData
): string[] {
  const recs: string[] = [];
  const sorted = [...signals].sort((a, b) => a.score - b.score);

  for (const signal of sorted) {
    if (signal.status === "critical") {
      switch (signal.name) {
        case "Velocity":
          recs.push("URGENT: No recent merges. Review blocked items and unblock the pipeline.");
          break;
        case "Dependencies":
          if (data.graph?.cycles.length) {
            recs.push(`FIX: Dependency cycles detected (${data.graph.cycles.map((c) => c.issues.map((n) => `#${n}`).join(",")).join("; ")}). Break cycles to unblock work.`);
          }
          if (data.graph?.bottlenecks.some((b) => b.severity === "critical")) {
            const top = data.graph.bottlenecks[0];
            recs.push(`PRIORITIZE: #${top.number} "${top.title}" blocks ${top.transitiveBlocksCount} issues. Complete it first.`);
          }
          break;
        case "Team Capacity":
          recs.push("RISK: No active contributors or very low throughput. Review team availability.");
          break;
        case "Workflow Health":
          if (data.workflowHealth) {
            const stale = data.workflowHealth.issueHealth.filter((i) => i.stale);
            if (stale.length > 0) {
              recs.push(`CLEANUP: ${stale.length} stale issues. Review and close or re-activate them.`);
            }
          }
          break;
      }
    } else if (signal.status === "warning") {
      switch (signal.name) {
        case "Knowledge Risk":
          recs.push("Consider: Spread knowledge across more contributors to reduce bus factor risk.");
          break;
        case "Learning":
          recs.push("Track: Record decisions and outcomes to build project memory for better future estimates.");
          break;
        case "Velocity":
          recs.push("Monitor: Velocity is below average. Check for blockers or process friction.");
          break;
      }
    }

    if (recs.length >= 5) break;
  }

  if (recs.length === 0) {
    recs.push("Project is healthy across all dimensions. Continue current cadence.");
  }

  if (data.graph?.orphanedBlocked.length) {
    const count = data.graph.orphanedBlocked.length;
    recs.push(`Quick win: ${count} issue${count > 1 ? "s are" : " is"} marked blocked but all blockers are resolved. Remove blocked labels.`);
  }

  return recs.slice(0, 5);
}

function formatReport(
  signals: HealthSignal[],
  overallScore: number,
  overallStatus: string,
  recommendations: string[],
  data: DashboardData
): string {
  const lines: string[] = [];

  const statusLabel = overallStatus === "healthy" ? "GREEN" : overallStatus === "warning" ? "YELLOW" : "RED";
  lines.push(`# Project Health Dashboard`);
  lines.push("");
  lines.push(`**Overall: ${overallScore}/100 [${statusLabel}]**`);
  lines.push("");

  // Signal table
  lines.push("## Health Signals");
  lines.push("");
  lines.push("| Signal | Score | Status | Detail |");
  lines.push("|--------|-------|--------|--------|");
  for (const s of signals) {
    const icon = s.status === "healthy" ? "OK" : s.status === "warning" ? "WARN" : "CRIT";
    lines.push(`| ${s.name} | ${s.score}/100 | ${icon} | ${s.detail} |`);
  }
  lines.push("");

  // Board snapshot
  if (data.board) {
    lines.push("## Board Snapshot");
    lines.push("");
    const b = data.board;
    const parts: string[] = [];
    for (const [state, count] of Object.entries(b.byWorkflow)) {
      parts.push(`${state}: ${count}`);
    }
    lines.push(`**${b.total} items** — ${parts.join(" | ")}`);
    lines.push(`Board health: ${b.healthScore}/100`);

    if (b.activeIssues.length > 0) {
      lines.push("");
      lines.push("Active:");
      for (const item of b.activeIssues) {
        lines.push(`- #${item.number} ${item.title}`);
      }
    }

    if (b.blockedIssues.length > 0) {
      lines.push("");
      lines.push("Blocked:");
      for (const item of b.blockedIssues.slice(0, 5)) {
        lines.push(`- #${item.issue.number} ${item.issue.title} (by ${item.blockedBy.map((n) => `#${n}`).join(", ")})`);
      }
    }
    lines.push("");
  }

  // Velocity
  if (data.velocity) {
    lines.push("## Velocity (7d / 30d)");
    lines.push("");
    const v = data.velocity;
    lines.push(`| Metric | 7 days | 30 days |`);
    lines.push(`|--------|--------|---------|`);
    lines.push(`| Merged | ${v.last7Days.merged} | ${v.last30Days.merged} |`);
    lines.push(`| Closed | ${v.last7Days.closed} | ${v.last30Days.closed} |`);
    lines.push(`| Opened | ${v.last7Days.opened} | ${v.last30Days.opened} |`);
    if (v.avgDaysToMerge !== null) {
      lines.push(`| Avg merge time | ${v.avgDaysToMerge.toFixed(1)}d | — |`);
    }
    lines.push("");
  }

  // Dependencies summary
  if (data.graph && data.graph.connectedIssues > 0) {
    lines.push("## Dependencies");
    lines.push("");
    lines.push(`**${data.graph.connectedIssues} connected issues**, ${data.graph.totalEdges} edges, ${data.graph.metrics.connectedComponents} component${data.graph.metrics.connectedComponents !== 1 ? "s" : ""}`);

    if (data.graph.criticalPath.length > 0) {
      const cp = data.graph.criticalPath.issues.map((i) => `#${i.number}`).join(" -> ");
      lines.push(`Critical path (${data.graph.criticalPath.length} deep): ${cp}`);
    }

    if (data.graph.bottlenecks.length > 0) {
      lines.push("");
      lines.push("Top bottlenecks:");
      for (const b of data.graph.bottlenecks.slice(0, 3)) {
        lines.push(`- #${b.number} "${b.title}" — blocks ${b.transitiveBlocksCount} issues [${b.severity}]`);
      }
    }

    if (data.graph.cycles.length > 0) {
      lines.push("");
      lines.push("**Cycles (must fix):**");
      for (const c of data.graph.cycles) {
        lines.push(`- ${c.description}`);
      }
    }
    lines.push("");
  }

  // Team capacity
  if (data.capacity) {
    lines.push("## Team Capacity");
    lines.push("");
    const c = data.capacity;
    const forecast = c.sprintForecast;
    lines.push(`Sprint forecast (14d): ${forecast.pessimistic} / ${forecast.expected} / ${forecast.optimistic} items (pessimistic/expected/optimistic)`);

    if (c.contributors.length > 0) {
      lines.push(`Active contributors: ${c.contributors.length}`);
      for (const contrib of c.contributors.slice(0, 5)) {
        const trend = contrib.velocityTrend === "accelerating" ? "^"
          : contrib.velocityTrend === "decelerating" ? "v" : "=";
        lines.push(`- @${contrib.login}: ${contrib.prsMerged} PRs/30d, trend: ${trend}`);
      }
    }
    lines.push("");
  }

  // Sprint simulation
  if (data.simulation) {
    lines.push("## Sprint Simulation (Monte Carlo)");
    lines.push("");
    const s = data.simulation;
    const tf = s.throughputForecast;
    lines.push(`Throughput: P10=${tf.p10} | P50=${tf.p50} | P90=${tf.p90} items`);
    if (s.histogram.length > 0) {
      const maxCount = Math.max(...s.histogram.map((h) => h.count));
      if (maxCount > 0) {
        lines.push("");
        for (const bin of s.histogram) {
          const barLen = Math.round((bin.count / maxCount) * 30);
          const bar = "#".repeat(barLen);
          lines.push(`  ${String(bin.items).padStart(3)} items: ${bar} (${bin.percentage.toFixed(0)}%)`);
        }
      }
    }
    lines.push("");
  }

  // DORA details
  if (data.dora) {
    lines.push("## DORA Metrics");
    lines.push("");
    const d = data.dora;
    lines.push("| Metric | Value | Rating |");
    lines.push("|--------|-------|--------|");
    lines.push(`| Deploy Frequency | ${d.deploymentFrequency.mergesPerWeek.toFixed(1)}/week | ${d.deploymentFrequency.rating} |`);
    lines.push(`| Lead Time | ${d.leadTimeForChanges.medianDays.toFixed(1)}d median | ${d.leadTimeForChanges.rating} |`);
    lines.push(`| Change Failure Rate | ${(d.changeFailureRate.rate * 100).toFixed(0)}% | ${d.changeFailureRate.rating} |`);
    lines.push(`| MTTR | ${d.meanTimeToRestore.medianHours !== null ? `${d.meanTimeToRestore.medianHours.toFixed(1)}h` : "—"} | ${d.meanTimeToRestore.rating} |`);
    lines.push(`| **Overall** | — | **${d.overall.rating}** |`);
    lines.push("");
  }

  // Recommendations
  lines.push("## Recommendations");
  lines.push("");
  for (let i = 0; i < recommendations.length; i++) {
    lines.push(`${i + 1}. ${recommendations[i]}`);
  }
  lines.push("");

  return lines.join("\n");
}

// ─── Public Function ────────────────────────────────────

/**
 * Generate a comprehensive project health dashboard.
 *
 * Gathers data from all intelligence modules in parallel, scores each
 * dimension, computes an overall health score, and generates a formatted
 * markdown report with actionable recommendations.
 */
export async function getProjectDashboard(): Promise<ProjectDashboard> {
  const data = await gatherData();

  const signals: HealthSignal[] = [
    scoreVelocity(data.velocity),
    scoreDORA(data.dora),
    scoreWorkflow(data.workflowHealth),
    scoreDependencies(data.graph),
    scoreCapacity(data.capacity),
    scoreKnowledgeRisk(data.knowledgeRisk),
    scoreMemory(data.memoryInsights),
  ];

  // Weighted average across dimensions
  const weights: Record<string, number> = {
    "Velocity": 20,
    "DORA Metrics": 15,
    "Workflow Health": 20,
    "Dependencies": 15,
    "Team Capacity": 15,
    "Knowledge Risk": 10,
    "Learning": 5,
  };

  let weightedSum = 0;
  let totalWeight = 0;
  for (const signal of signals) {
    const weight = weights[signal.name] ?? 10;
    weightedSum += signal.score * weight;
    totalWeight += weight;
  }

  const overallScore = Math.round(weightedSum / totalWeight);
  const overallStatus: "healthy" | "warning" | "critical" =
    overallScore >= 70 ? "healthy" : overallScore >= 45 ? "warning" : "critical";

  const recommendations = generateRecommendations(signals, data);
  const report = formatReport(signals, overallScore, overallStatus, recommendations, data);

  return {
    overallScore,
    overallStatus,
    signals,
    report,
    recommendations,
    generatedAt: new Date().toISOString(),
  };
}
