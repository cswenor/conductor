/**
 * Session Intelligence — Context-aware work optimization
 *
 * Tools:
 *   - optimizeSession: Analyzes current project state to recommend the most
 *     impactful work for this session. Considers: time available, context
 *     already loaded, dependency graph readiness, stale items, review queue,
 *     rework pending, and anomalies detected. Returns a prioritized session
 *     plan with estimated time and context requirements.
 */

import { getVelocity } from "./github.js";
import { getLocalBoardSummary } from "./db.js";
import { getEvents, getInsights } from "./memory.js";
import { analyzeDependencyGraph } from "./graph.js";
import { getWorkflowHealth } from "./guardrails.js";
import { detectPatterns } from "./anomaly.js";

// ─── Types ───────────────────────────────────────────────

interface SessionTask {
  rank: number;
  action: string;
  issueNumber: number | null;
  title: string;
  type: "implement" | "review" | "fix" | "unblock" | "triage" | "maintain";
  estimatedMinutes: number;
  reason: string;
  contextNeeded: string[];
  urgency: "immediate" | "high" | "normal" | "low";
  impactScore: number;
}

interface SessionPlan {
  sessionContext: {
    currentTime: string;
    availableMinutes: number;
    activeIssues: number;
    reviewQueue: number;
    reworkPending: number;
    anomaliesDetected: number;
    healthScore: number;
  };
  recommendedPlan: SessionTask[];
  quickWins: SessionTask[];
  deferrable: SessionTask[];
  warnings: string[];
  sessionGoal: string;
  estimatedCompletion: string;
  summary: string;
}

// ─── Main Tool ───────────────────────────────────────────

export async function optimizeSession(
  availableMinutes = 120,
  focusArea?: string
): Promise<SessionPlan> {
  // Gather all state in parallel
  const [board, velocity, events, insights, graph, health, anomalies] =
    await Promise.all([
      getLocalBoardSummary().catch(() => null),
      getVelocity().catch(() => null),
      getEvents(100).catch(() => []),
      getInsights().catch(() => null),
      analyzeDependencyGraph().catch(() => null),
      getWorkflowHealth().catch(() => null),
      detectPatterns().catch(() => null),
    ]);

  const tasks: SessionTask[] = [];
  let impactCounter = 100;

  // ─── 1. Urgent: Active issues with no recent activity ──────
  if (board?.activeIssues) {
    for (const item of board.activeIssues) {
      // Check if we have recent events for this issue
      const recentActivity = events.filter(
        (e) =>
          e.issue_number === item.number &&
          new Date(e.timestamp) >
            new Date(Date.now() - 24 * 60 * 60 * 1000)
      );

      if (recentActivity.length === 0) {
        tasks.push({
          rank: 0,
          action: `Continue work on active issue`,
          issueNumber: item.number,
          title: item.title,
          type: "implement",
          estimatedMinutes: 60,
          reason: "Issue is Active but has no recent activity — may be stalled",
          contextNeeded: [`Issue #${item.number} details`, "Previous plan"],
          urgency: "immediate",
          impactScore: impactCounter--,
        });
      } else {
        tasks.push({
          rank: 0,
          action: `Continue active implementation`,
          issueNumber: item.number,
          title: item.title,
          type: "implement",
          estimatedMinutes: 45,
          reason: "Active issue with recent progress — continue momentum",
          contextNeeded: [`Issue #${item.number} context`],
          urgency: "high",
          impactScore: impactCounter--,
        });
      }
    }
  }

  // ─── 2. Review queue (high priority — unblocks others) ─────
  if (board?.reviewIssues) {
    for (const item of board.reviewIssues) {
      tasks.push({
        rank: 0,
        action: `Review PR for issue`,
        issueNumber: item.number,
        title: item.title,
        type: "review",
        estimatedMinutes: 20,
        reason:
          "Review queue items block merging and Done transition — high leverage",
        contextNeeded: [
          `Issue #${item.number}`,
          "Linked PR",
          "Acceptance criteria",
        ],
        urgency: "high",
        impactScore: impactCounter--,
      });
    }
  }

  // ─── 3. Rework items (address feedback before new work) ────
  if (board?.reworkIssues) {
    for (const item of board.reworkIssues) {
      tasks.push({
        rank: 0,
        action: `Address review feedback`,
        issueNumber: item.number,
        title: item.title,
        type: "fix",
        estimatedMinutes: 30,
        reason:
          "Rework items have specific feedback — smaller scope than new features",
        contextNeeded: [
          `Issue #${item.number}`,
          "PR review comments",
          "Feedback thread",
        ],
        urgency: "high",
        impactScore: impactCounter--,
      });
    }
  }

  // ─── 4. Dependency bottlenecks (unblock the graph) ─────────
  if (graph?.bottlenecks) {
    for (const bottleneck of graph.bottlenecks.slice(0, 3)) {
      if (
        bottleneck.workflow !== "Active" &&
        bottleneck.workflow !== "Done" &&
        bottleneck.state === "open"
      ) {
        tasks.push({
          rank: 0,
          action: `Unblock dependency bottleneck`,
          issueNumber: bottleneck.number,
          title: bottleneck.title,
          type: "unblock",
          estimatedMinutes: 45,
          reason: `Blocks ${bottleneck.transitiveBlocksCount} downstream issues — high leverage`,
          contextNeeded: [
            `Issue #${bottleneck.number}`,
            "Dependency chain",
          ],
          urgency: "high",
          impactScore: impactCounter--,
        });
      }
    }
  }

  // ─── 5. Orphaned blocked issues (quick unblock) ────────────
  if (graph?.orphanedBlocked) {
    for (const orphan of graph.orphanedBlocked) {
      tasks.push({
        rank: 0,
        action: `Unblock orphaned issue (all blockers resolved)`,
        issueNumber: orphan.number,
        title: orphan.title,
        type: "maintain",
        estimatedMinutes: 5,
        reason:
          "All blockers resolved but still marked blocked — quick label fix",
        contextNeeded: [`Issue #${orphan.number}`],
        urgency: "normal",
        impactScore: impactCounter--,
      });
    }
  }

  // ─── 6. Blocked issues with resolved blockers (quick unblock) ──
  // (staleItems no longer available from local board — skipped)

  // ─── 7. Anomaly responses ─────────────────────────────────
  if (anomalies?.anomalies) {
    const criticalAnomalies = anomalies.anomalies.filter(
      (a) => a.severity === "critical" || a.severity === "warning"
    );
    for (const anomaly of criticalAnomalies.slice(0, 2)) {
      tasks.push({
        rank: 0,
        action: `Address detected anomaly: ${anomaly.title}`,
        issueNumber:
          anomaly.affectedIssues.length > 0
            ? anomaly.affectedIssues[0]
            : null,
        title: anomaly.title,
        type: "maintain",
        estimatedMinutes: 15,
        reason: `${anomaly.severity} anomaly detected: ${anomaly.description.substring(0, 100)}`,
        contextNeeded: ["Project dashboard", anomaly.suggestedAction],
        urgency: anomaly.severity === "critical" ? "immediate" : "high",
        impactScore: impactCounter--,
      });
    }
  }

  // ─── Filter by focus area if specified ─────────────────────
  let filteredTasks = tasks;
  if (focusArea) {
    const areaLower = focusArea.toLowerCase();
    filteredTasks = tasks.filter((t) => {
      // Keep urgent items regardless of area
      if (t.urgency === "immediate") return true;
      // Filter by area in title or context
      return (
        t.title.toLowerCase().includes(areaLower) ||
        t.contextNeeded.some((c) => c.toLowerCase().includes(areaLower))
      );
    });
    // If filtering removed everything, fall back to all tasks
    if (filteredTasks.length === 0) filteredTasks = tasks;
  }

  // ─── Score and rank ────────────────────────────────────────
  const urgencyMultiplier: Record<string, number> = {
    immediate: 4,
    high: 3,
    normal: 2,
    low: 1,
  };

  const typeMultiplier: Record<string, number> = {
    implement: 1.0,
    review: 1.5, // reviews unblock others
    fix: 1.3, // fixes clear debt
    unblock: 1.8, // unblocking has highest leverage
    triage: 0.5,
    maintain: 0.7,
  };

  filteredTasks.sort((a, b) => {
    const scoreA =
      a.impactScore *
      (urgencyMultiplier[a.urgency] || 1) *
      (typeMultiplier[a.type] || 1);
    const scoreB =
      b.impactScore *
      (urgencyMultiplier[b.urgency] || 1) *
      (typeMultiplier[b.type] || 1);
    return scoreB - scoreA;
  });

  // Assign ranks
  filteredTasks.forEach((t, i) => {
    t.rank = i + 1;
  });

  // ─── Split into plan / quick wins / deferrable ─────────────
  let timeRemaining = availableMinutes;
  const recommendedPlan: SessionTask[] = [];
  const quickWins: SessionTask[] = [];
  const deferrable: SessionTask[] = [];

  for (const task of filteredTasks) {
    if (task.estimatedMinutes <= 10 && task.urgency !== "immediate") {
      quickWins.push(task);
    } else if (timeRemaining >= task.estimatedMinutes) {
      recommendedPlan.push(task);
      timeRemaining -= task.estimatedMinutes;
    } else {
      deferrable.push(task);
    }
  }

  // ─── Warnings ──────────────────────────────────────────────
  const warnings: string[] = [];
  if (board && board.activeIssues.length > 1) {
    warnings.push(
      `WIP limit violation: ${board.activeIssues.length} active issues (limit: 1)`
    );
  }
  if (anomalies && anomalies.anomalies.filter((a) => a.severity === "critical").length > 0) {
    warnings.push("Critical anomalies detected — address before new work");
  }
  if (board && board.reviewIssues.length > 2) {
    warnings.push(
      `Review queue backing up: ${board.reviewIssues.length} items waiting`
    );
  }
  if (
    health?.summary &&
    health.summary.healthScore < 50
  ) {
    warnings.push(
      `Project health is low (${health.summary.healthScore}/100) — consider maintenance focus`
    );
  }

  // ─── Session goal ──────────────────────────────────────────
  let sessionGoal: string;
  if (recommendedPlan.length === 0) {
    sessionGoal = "No actionable items found — project is healthy!";
  } else if (recommendedPlan[0].type === "implement") {
    sessionGoal = `Ship progress on #${recommendedPlan[0].issueNumber}: ${recommendedPlan[0].title}`;
  } else if (recommendedPlan[0].type === "review") {
    sessionGoal = `Clear review queue (${board?.reviewIssues.length || 0} items) to unblock merging`;
  } else if (recommendedPlan[0].type === "fix") {
    sessionGoal = `Address rework feedback to move items back to Review`;
  } else if (recommendedPlan[0].type === "unblock") {
    sessionGoal = `Unblock dependency bottleneck to enable downstream work`;
  } else {
    sessionGoal = `${recommendedPlan[0].action}`;
  }

  // ─── Estimated completion ──────────────────────────────────
  const totalPlannedMinutes = recommendedPlan.reduce(
    (sum, t) => sum + t.estimatedMinutes,
    0
  );
  const completionPercent = Math.min(
    100,
    Math.round((totalPlannedMinutes / availableMinutes) * 100)
  );
  const estimatedCompletion = `${recommendedPlan.length} tasks in ~${totalPlannedMinutes}min (${completionPercent}% of available ${availableMinutes}min)`;

  // ─── Summary ───────────────────────────────────────────────
  const parts: string[] = [];
  if (recommendedPlan.length > 0) {
    parts.push(
      `Recommended: ${recommendedPlan.length} tasks (${totalPlannedMinutes}min)`
    );
  }
  if (quickWins.length > 0) {
    parts.push(`${quickWins.length} quick wins available`);
  }
  if (deferrable.length > 0) {
    parts.push(`${deferrable.length} deferred to next session`);
  }
  if (warnings.length > 0) {
    parts.push(`${warnings.length} warning${warnings.length > 1 ? "s" : ""}`);
  }

  return {
    sessionContext: {
      currentTime: new Date().toISOString(),
      availableMinutes,
      activeIssues: board?.activeIssues.length || 0,
      reviewQueue: board?.reviewIssues.length || 0,
      reworkPending: board?.reworkIssues.length || 0,
      anomaliesDetected: anomalies?.anomalies.length || 0,
      healthScore: health?.summary?.healthScore || 0,
    },
    recommendedPlan,
    quickWins,
    deferrable,
    warnings,
    sessionGoal,
    estimatedCompletion,
    summary: parts.join(". ") + ".",
  };
}
