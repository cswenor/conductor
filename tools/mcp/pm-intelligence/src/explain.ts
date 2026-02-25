/**
 * Explanatory Intelligence Module
 *
 * Tools that answer "why?" questions about project state:
 *   - explain_delay: Root cause analysis for slow/stuck issues
 *   - compare_estimates: Prediction accuracy tracking for calibration
 */

import { getVelocity } from "./github.js";
import { getIssue } from "./db.js";
import { getEvents, getOutcomes, getInsights } from "./memory.js";
import { getSprintAnalytics } from "./analytics.js";
import { getIssueDependencies } from "./graph.js";
import { predictCompletion, predictRework } from "./predict.js";

// ─── TYPES ────────────────────────────────────────────

interface DelayFactor {
  category: "dependency" | "rework" | "bottleneck" | "scope" | "capacity" | "external";
  severity: "critical" | "high" | "medium" | "low";
  description: string;
  evidence: string;
  daysContributed: number | null;
  suggestion: string;
}

interface DelayExplanation {
  issueNumber: number;
  title: string;
  currentState: string;
  totalAgeDays: number;
  activeTimeDays: number | null;
  waitTimeDays: number | null;
  factors: DelayFactor[];
  timeline: Array<{
    date: string;
    event: string;
    detail: string;
  }>;
  summary: string;
  recommendation: string;
}

interface EstimateComparison {
  issueNumber: number;
  title: string;
  area: string | null;
  predicted: {
    p50Days: number;
    p80Days: number;
    p95Days: number;
    riskScore: number;
    reworkProbability: number;
  };
  actual: {
    cycleDays: number;
    reviewRounds: number | null;
    hadRework: boolean;
    result: string;
  };
  accuracy: {
    withinP50: boolean;
    withinP80: boolean;
    withinP95: boolean;
    overrunDays: number;
    overrunPercent: number;
    reworkPredictionCorrect: boolean;
  };
}

interface EstimateCalibration {
  period: { from: string; to: string };
  comparisons: EstimateComparison[];
  calibration: {
    totalCompared: number;
    withinP50Rate: number;
    withinP80Rate: number;
    withinP95Rate: number;
    avgOverrunPercent: number;
    reworkPredictionAccuracy: number;
    bias: "optimistic" | "calibrated" | "pessimistic";
    biasReason: string;
  };
  insights: string[];
  recommendations: string[];
}

// ─── EXPLAIN DELAY ────────────────────────────────────

export async function explainDelay(
  issueNumber: number
): Promise<DelayExplanation> {
  // Gather all data in parallel
  const [issueOrNull, deps, events, completion, rework, analytics] =
    await Promise.all([
      getIssue(issueNumber),
      getIssueDependencies(issueNumber).catch(() => null),
      getEvents(500, { issueNumber }),
      predictCompletion(issueNumber).catch(() => null),
      predictRework(issueNumber).catch(() => null),
      getSprintAnalytics(60).catch(() => null),
    ]);

  if (!issueOrNull) {
    throw new Error(`Issue #${issueNumber} not found in local database. Run 'pm sync' first.`);
  }
  const status = issueOrNull;

  const factors: DelayFactor[] = [];
  const timeline: DelayExplanation["timeline"] = [];

  // Build timeline from events
  const issueEvents = events.filter(
    (e) => e.issue_number === issueNumber
  );

  for (const evt of issueEvents) {
    if (evt.event_type === "state_transition") {
      timeline.push({
        date: evt.timestamp.split("T")[0],
        event: `${evt.from_value} → ${evt.to_value}`,
        detail: evt.to_value ?? "",
      });
    } else if (evt.event_type === "tool_use" && (evt.metadata as any)?.tool) {
      // Only include significant tool uses
      const tool = (evt.metadata as any).tool as string;
      if (["move_issue", "pm move", "pm add"].some((t) => tool.includes(t))) {
        timeline.push({
          date: evt.timestamp.split("T")[0],
          event: evt.event_type,
          detail: tool,
        });
      }
    }
  }

  // Sort timeline chronologically
  timeline.sort((a, b) => a.date.localeCompare(b.date));

  // Calculate time metrics
  const firstEvent = issueEvents.length > 0
    ? new Date(issueEvents[issueEvents.length - 1].timestamp)
    : null;
  const now = new Date();
  const totalAgeDays = firstEvent
    ? (now.getTime() - firstEvent.getTime()) / (1000 * 60 * 60 * 24)
    : 0;

  // Calculate active vs wait time from state transitions
  let activeTimeDays: number | null = null;
  let waitTimeDays: number | null = null;

  if (analytics) {
    const stateTime = analytics.timeInState;
    const activeHours = stateTime["Active"]?.avgHours ?? 0;
    const reviewHours = stateTime["Review"]?.avgHours ?? 0;
    const reworkHours = stateTime["Rework"]?.avgHours ?? 0;
    const readyHours = stateTime["Ready"]?.avgHours ?? 0;
    const backlogHours = stateTime["Backlog"]?.avgHours ?? 0;

    activeTimeDays = activeHours / 24;
    waitTimeDays = (reviewHours + reworkHours + readyHours + backlogHours) / 24;
  }

  // ─── Factor Analysis ─────────────────────────────

  // 1. Dependency delays
  if (deps) {
    const unresolvedBlockers = deps.blockedBy.filter((b) => !b.resolved);
    if (unresolvedBlockers.length > 0) {
      factors.push({
        category: "dependency",
        severity: "critical",
        description: `Blocked by ${unresolvedBlockers.length} unresolved dependency(ies)`,
        evidence: unresolvedBlockers
          .map((b) => `#${b.number} (${b.title}) — ${b.workflow ?? b.state}`)
          .join("; "),
        daysContributed: null,
        suggestion: `Prioritize resolving: ${unresolvedBlockers.map((b) => `#${b.number}`).join(", ")}`,
      });
    }

    if (deps.upstreamChain.length > 3) {
      factors.push({
        category: "dependency",
        severity: "medium",
        description: `Deep dependency chain (${deps.upstreamChain.length} upstream issues)`,
        evidence: `Chain: ${deps.upstreamChain.map((n) => `#${n}`).join(" → ")}`,
        daysContributed: null,
        suggestion: "Consider parallelizing work or breaking the chain",
      });
    }
  }

  // 2. Rework cycles
  const reworkTransitions = issueEvents.filter(
    (e) => e.event_type === "state_transition" && e.to_value === "Rework"
  );
  if (reworkTransitions.length > 0) {
    const reworkReasons = reworkTransitions
      .map((e) => e.to_value)
      .filter(Boolean);

    factors.push({
      category: "rework",
      severity: reworkTransitions.length > 2 ? "critical" : reworkTransitions.length > 1 ? "high" : "medium",
      description: `${reworkTransitions.length} rework cycle(s)`,
      evidence: reworkReasons.length > 0
        ? `Reasons: ${reworkReasons.join("; ")}`
        : `${reworkTransitions.length} round-trips between Review and Rework`,
      daysContributed: null,
      suggestion: reworkTransitions.length > 2
        ? "Issue may need spec clarification. Consider a design review before more code changes."
        : "Review feedback more carefully before submitting for review.",
    });
  }

  // 3. Bottleneck states
  if (analytics) {
    for (const bottleneck of analytics.bottlenecks) {
      if (bottleneck.severity === "high") {
        factors.push({
          category: "bottleneck",
          severity: "high",
          description: `Bottleneck in ${bottleneck.state} state`,
          evidence: `Avg ${bottleneck.avgHours.toFixed(0)} hours in ${bottleneck.state}. ${bottleneck.reason}`,
          daysContributed: bottleneck.avgHours / 24,
          suggestion: bottleneck.state === "Review"
            ? "Speed up reviews — use /pm-review for automated pre-review"
            : `Investigate root cause of ${bottleneck.state} bottleneck`,
        });
      }
    }
  }

  // 4. High completion risk signals
  if (completion && completion.riskScore > 60) {
    for (const risk of completion.riskFactors) {
      if (risk.severity === "high") {
        factors.push({
          category: "scope",
          severity: "high",
          description: risk.factor,
          evidence: risk.detail,
          daysContributed: null,
          suggestion: "Break the issue into smaller, more predictable chunks",
        });
      }
    }
  }

  // 5. Rework probability signals
  if (rework && rework.reworkProbability > 0.5) {
    const presentSignals = rework.signals.filter((s) => s.present);
    for (const signal of presentSignals) {
      if (signal.weight > 0.15) {
        factors.push({
          category: "scope",
          severity: "medium",
          description: signal.signal,
          evidence: signal.detail,
          daysContributed: null,
          suggestion: rework.mitigations[0] ?? "Review spec and acceptance criteria for clarity",
        });
      }
    }
  }

  // 6. Time in Backlog/Ready (capacity constraint)
  if (analytics) {
    const backlogHours = analytics.timeInState["Backlog"]?.avgHours ?? 0;
    const readyHours = analytics.timeInState["Ready"]?.avgHours ?? 0;
    const waitingHours = backlogHours + readyHours;
    if (waitingHours > 48) {
      factors.push({
        category: "capacity",
        severity: waitingHours > 168 ? "high" : "medium",
        description: `Spent ${(waitingHours / 24).toFixed(1)} days waiting before work started`,
        evidence: `Backlog: ${(backlogHours / 24).toFixed(1)}d, Ready: ${(readyHours / 24).toFixed(1)}d`,
        daysContributed: waitingHours / 24,
        suggestion: "Reduce WIP to pull work through faster",
      });
    }
  }

  // Sort factors by severity
  const severityOrder: Record<string, number> = {
    critical: 0,
    high: 1,
    medium: 2,
    low: 3,
  };
  factors.sort(
    (a, b) => (severityOrder[a.severity] ?? 3) - (severityOrder[b.severity] ?? 3)
  );

  // Build summary
  let summary: string;
  if (factors.length === 0) {
    summary = `Issue #${issueNumber} is ${totalAgeDays.toFixed(0)} days old. ` +
      "No specific delay factors identified — progress appears normal.";
  } else {
    const critical = factors.filter((f) => f.severity === "critical");
    const high = factors.filter((f) => f.severity === "high");
    summary = `Issue #${issueNumber} is ${totalAgeDays.toFixed(0)} days old with ` +
      `${factors.length} delay factor(s) identified`;
    if (critical.length > 0) {
      summary += ` (${critical.length} critical)`;
    }
    summary += ". ";
    summary += `Primary cause: ${factors[0].description}. `;
    if (activeTimeDays !== null && waitTimeDays !== null && waitTimeDays > activeTimeDays) {
      const waitPercent = (waitTimeDays / (activeTimeDays + waitTimeDays)) * 100;
      summary += `${waitPercent.toFixed(0)}% of time spent waiting (not working).`;
    }
  }

  // Build recommendation
  let recommendation: string;
  if (factors.length === 0) {
    recommendation = "No action needed — issue is progressing normally.";
  } else if (factors[0].category === "dependency") {
    recommendation = `Focus on unblocking dependencies first: ${factors[0].suggestion}`;
  } else if (factors[0].category === "rework") {
    recommendation = `Address rework root cause: ${factors[0].suggestion}`;
  } else {
    recommendation = factors[0].suggestion;
  }

  return {
    issueNumber,
    title: status.title,
    currentState: status.workflow ?? status.state,
    totalAgeDays: Math.round(totalAgeDays * 10) / 10,
    activeTimeDays: activeTimeDays !== null ? Math.round(activeTimeDays * 10) / 10 : null,
    waitTimeDays: waitTimeDays !== null ? Math.round(waitTimeDays * 10) / 10 : null,
    factors,
    timeline,
    summary,
    recommendation,
  };
}

// ─── COMPARE ESTIMATES ────────────────────────────────

export async function compareEstimates(
  days = 30
): Promise<EstimateCalibration> {
  const now = new Date();
  const cutoff = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  const cutoffISO = cutoff.toISOString();

  // Get completed outcomes in the period
  const outcomes = await getOutcomes(100, { result: "merged" });
  const recentOutcomes = outcomes.filter(
    (o) => o.timestamp >= cutoffISO
  );

  const comparisons: EstimateComparison[] = [];

  for (const outcome of recentOutcomes.slice(0, 20)) {
    // Limit for performance
    try {
      const [statusOrNull, completion, rework] = await Promise.all([
        getIssue(outcome.issue_number),
        predictCompletion(outcome.issue_number).catch(() => null),
        predictRework(outcome.issue_number).catch(() => null),
      ]);

      if (!statusOrNull || !completion) continue;
      const status = statusOrNull;
      const area = status.labels.find((l) => l.startsWith("area:"))?.replace("area:", "") ?? null;

      // Calculate actual cycle time from events
      const events = await getEvents(100, { issueNumber: outcome.issue_number });
      const activeEvent = events.find(
        (e) =>
          e.event_type === "state_transition" && e.to_value === "Active"
      );
      const doneEvent = events.find(
        (e) =>
          e.event_type === "state_transition" && e.to_value === "Done"
      );

      let actualCycleDays: number;
      if (activeEvent && doneEvent) {
        actualCycleDays =
          (new Date(doneEvent.timestamp).getTime() -
            new Date(activeEvent.timestamp).getTime()) /
          (1000 * 60 * 60 * 24);
      } else {
        // Fall back to outcome timestamp delta
        actualCycleDays = 0;
        continue; // Skip if we can't determine actual cycle
      }

      const hadRework =
        outcome.rework_reasons.length > 0 ||
        (outcome.review_rounds !== null && outcome.review_rounds > 1);

      const overrunDays = Math.max(0, actualCycleDays - completion.prediction.p50Days);
      const overrunPercent =
        completion.prediction.p50Days > 0
          ? (overrunDays / completion.prediction.p50Days) * 100
          : 0;

      comparisons.push({
        issueNumber: outcome.issue_number,
        title: status.title,
        area,
        predicted: {
          p50Days: completion.prediction.p50Days,
          p80Days: completion.prediction.p80Days,
          p95Days: completion.prediction.p95Days,
          riskScore: completion.riskScore,
          reworkProbability: rework?.reworkProbability ?? 0,
        },
        actual: {
          cycleDays: Math.round(actualCycleDays * 10) / 10,
          reviewRounds: outcome.review_rounds,
          hadRework,
          result: outcome.result,
        },
        accuracy: {
          withinP50: actualCycleDays <= completion.prediction.p50Days,
          withinP80: actualCycleDays <= completion.prediction.p80Days,
          withinP95: actualCycleDays <= completion.prediction.p95Days,
          overrunDays: Math.round(overrunDays * 10) / 10,
          overrunPercent: Math.round(overrunPercent),
          reworkPredictionCorrect:
            rework
              ? (rework.reworkProbability > 0.5) === hadRework
              : false,
        },
      });
    } catch {
      // Skip issues we can't analyze
    }
  }

  // Calculate calibration metrics
  const total = comparisons.length;
  const withinP50 = comparisons.filter((c) => c.accuracy.withinP50).length;
  const withinP80 = comparisons.filter((c) => c.accuracy.withinP80).length;
  const withinP95 = comparisons.filter((c) => c.accuracy.withinP95).length;
  const reworkCorrect = comparisons.filter(
    (c) => c.accuracy.reworkPredictionCorrect
  ).length;

  const withinP50Rate = total > 0 ? withinP50 / total : 0;
  const withinP80Rate = total > 0 ? withinP80 / total : 0;
  const withinP95Rate = total > 0 ? withinP95 / total : 0;
  const avgOverrunPercent =
    total > 0
      ? comparisons.reduce((sum, c) => sum + c.accuracy.overrunPercent, 0) / total
      : 0;
  const reworkAccuracy = total > 0 ? reworkCorrect / total : 0;

  // Determine bias
  let bias: "optimistic" | "calibrated" | "pessimistic";
  let biasReason: string;

  if (withinP50Rate >= 0.45 && withinP50Rate <= 0.55) {
    bias = "calibrated";
    biasReason = `P50 hit rate is ${(withinP50Rate * 100).toFixed(0)}% — close to the ideal 50%`;
  } else if (withinP50Rate < 0.45) {
    bias = "optimistic";
    biasReason = `P50 hit rate is only ${(withinP50Rate * 100).toFixed(0)}% — predictions are too optimistic (tasks take longer than predicted)`;
  } else {
    bias = "pessimistic";
    biasReason = `P50 hit rate is ${(withinP50Rate * 100).toFixed(0)}% — predictions are too pessimistic (tasks finish faster than predicted)`;
  }

  // Generate insights
  const insights: string[] = [];

  if (total === 0) {
    insights.push("No completed issues with prediction data in the period.");
  } else {
    insights.push(
      `Analyzed ${total} completed issues over ${days} days.`
    );

    if (withinP80Rate < 0.7) {
      insights.push(
        `P80 accuracy is ${(withinP80Rate * 100).toFixed(0)}% — should be ~80%. ` +
        "Predictions underestimate complexity."
      );
    }

    if (withinP95Rate < 0.9) {
      insights.push(
        `P95 accuracy is ${(withinP95Rate * 100).toFixed(0)}% — should be ~95%. ` +
        "Tail risks are being underestimated."
      );
    }

    // Area-specific patterns
    const areaMap = new Map<string, { overruns: number; total: number }>();
    for (const c of comparisons) {
      const area = c.area ?? "unknown";
      const entry = areaMap.get(area) ?? { overruns: 0, total: 0 };
      entry.total++;
      if (!c.accuracy.withinP50) entry.overruns++;
      areaMap.set(area, entry);
    }

    for (const [area, data] of areaMap) {
      if (data.total >= 3 && data.overruns / data.total > 0.7) {
        insights.push(
          `${area} issues consistently overrun predictions (${data.overruns}/${data.total} exceed P50).`
        );
      }
    }
  }

  // Generate recommendations
  const recommendations: string[] = [];

  if (bias === "optimistic") {
    recommendations.push(
      "Add a buffer to predictions — consider using P80 instead of P50 for planning."
    );
  }

  if (reworkAccuracy < 0.6 && total > 3) {
    recommendations.push(
      "Rework prediction needs calibration — consider adding more signals to predict_rework."
    );
  }

  if (total < 5) {
    recommendations.push(
      "Insufficient data for reliable calibration. Complete more issues to improve prediction accuracy."
    );
  } else {
    recommendations.push(
      `Use P80 estimates for commitments (${(withinP80Rate * 100).toFixed(0)}% accuracy) ` +
      "and P50 for internal targets."
    );
  }

  return {
    period: { from: cutoffISO, to: now.toISOString() },
    comparisons,
    calibration: {
      totalCompared: total,
      withinP50Rate: Math.round(withinP50Rate * 1000) / 1000,
      withinP80Rate: Math.round(withinP80Rate * 1000) / 1000,
      withinP95Rate: Math.round(withinP95Rate * 1000) / 1000,
      avgOverrunPercent: Math.round(avgOverrunPercent),
      reworkPredictionAccuracy: Math.round(reworkAccuracy * 1000) / 1000,
      bias,
      biasReason,
    },
    insights,
    recommendations,
  };
}
