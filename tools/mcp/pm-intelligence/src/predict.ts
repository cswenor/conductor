/**
 * Predictive intelligence — forecasting and risk analysis.
 *
 * Uses historical data from SQLite memory, event stream, and git history
 * to predict outcomes and identify risks before they materialize.
 *
 * Tools:
 *   - predictCompletion: P50/P80/P95 completion dates + risk score
 *   - predictRework: Rework probability before Review
 *   - getDORAMetrics: Automated DORA metrics from git/GitHub data
 *   - getKnowledgeRisk: Bus factor + knowledge decay per file/area
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  getOutcomes,
  getEvents,
  getDecisions,
  type Outcome,
  type PMEvent,
} from "./memory.js";

const execFileAsync = promisify(execFile);

// ─── Types ──────────────────────────────────────────────

export interface CompletionPrediction {
  issueNumber: number;
  currentState: string;
  prediction: {
    p50Days: number; // 50% chance of completion within this many days
    p80Days: number; // 80% chance
    p95Days: number; // 95% chance
    expectedDate: { p50: string; p80: string; p95: string };
  };
  riskScore: number; // 0-100
  riskFactors: Array<{
    factor: string;
    severity: "low" | "medium" | "high";
    contribution: number; // 0-30 range, how much this contributes to risk
    detail: string;
  }>;
  confidence: "low" | "medium" | "high";
  confidenceReason: string;
  similarIssues: Array<{
    issueNumber: number;
    area: string | null;
    cycleDays: number;
    result: string;
  }>;
  recommendation: string;
}

export interface ReworkPrediction {
  issueNumber: number;
  reworkProbability: number; // 0-1
  riskLevel: "low" | "medium" | "high" | "very_high";
  signals: Array<{
    signal: string;
    weight: number;
    present: boolean;
    detail: string;
  }>;
  mitigations: string[];
  historicalComparison: {
    baselineReworkRate: number;
    areaReworkRate: number | null;
    area: string | null;
  };
}

export interface DORAMetrics {
  period: { from: string; to: string; days: number };
  deploymentFrequency: {
    mergesPerWeek: number;
    rating: "elite" | "high" | "medium" | "low";
    description: string;
  };
  leadTimeForChanges: {
    medianDays: number;
    p90Days: number;
    rating: "elite" | "high" | "medium" | "low";
    description: string;
  };
  changeFailureRate: {
    rate: number; // 0-1
    rating: "elite" | "high" | "medium" | "low";
    reworkCount: number;
    totalCount: number;
    description: string;
  };
  meanTimeToRestore: {
    medianHours: number | null;
    rating: "elite" | "high" | "medium" | "low" | "insufficient_data";
    bugFixCount: number;
    description: string;
  };
  overall: {
    rating: "elite" | "high" | "medium" | "low";
    summary: string;
    recommendations: string[];
  };
}

export interface KnowledgeRisk {
  period: { from: string; to: string; days: number };
  fileRisks: Array<{
    file: string;
    busFactor: number; // number of unique contributors
    primaryAuthor: string;
    primaryAuthorShare: number; // 0-1
    lastTouched: string; // ISO date
    daysSinceTouch: number;
    changes: number;
    knowledgeRisk: "low" | "medium" | "high" | "critical";
    reasons: string[];
  }>;
  areaRisks: Array<{
    area: string;
    avgBusFactor: number;
    fileCount: number;
    criticalFiles: number;
    knowledgeRisk: "low" | "medium" | "high" | "critical";
  }>;
  decayAlerts: Array<{
    file: string;
    daysSinceTouch: number;
    changes: number;
    alert: string;
  }>;
  summary: {
    totalFiles: number;
    criticalRiskFiles: number;
    averageBusFactor: number;
    recommendation: string;
  };
}

// ─── Helpers ────────────────────────────────────────────

/** Parse git log for commits with timing info */
async function getGitCommits(
  days: number
): Promise<
  Array<{
    hash: string;
    date: string;
    author: string;
    subject: string;
    files: string[];
  }>
> {
  const since = new Date(Date.now() - days * 86400000).toISOString();

  try {
    const { stdout } = await execFileAsync(
      "git",
      [
        "log",
        `--since=${since}`,
        "--pretty=format:%H|%aI|%an|%s",
        "--name-only",
        "--no-merges",
      ],
      { maxBuffer: 10 * 1024 * 1024 }
    );

    const commits: Array<{
      hash: string;
      date: string;
      author: string;
      subject: string;
      files: string[];
    }> = [];

    let current: (typeof commits)[0] | null = null;

    for (const line of stdout.split("\n")) {
      if (line.includes("|")) {
        const parts = line.split("|");
        if (parts.length >= 4) {
          if (current) commits.push(current);
          current = {
            hash: parts[0],
            date: parts[1],
            author: parts[2],
            subject: parts.slice(3).join("|"),
            files: [],
          };
        }
      } else if (line.trim() && current) {
        current.files.push(line.trim());
      }
    }
    if (current) commits.push(current);

    return commits;
  } catch {
    return [];
  }
}

/** Extract cycle times from outcomes (time between events) */
function computeCycleTimes(
  outcomes: Outcome[],
  events: PMEvent[]
): Map<number, number> {
  const cycleTimes = new Map<number, number>();

  for (const outcome of outcomes) {
    if (outcome.result !== "merged") continue;

    // Find Active→Done transition times from events
    const issueEvents = events.filter(
      (e) => e.issue_number === outcome.issue_number
    );

    const activeEvent = issueEvents.find(
      (e) => e.event_type === "workflow_change" && e.to_value === "Active"
    );
    const doneEvent = issueEvents.find(
      (e) => e.event_type === "workflow_change" && e.to_value === "Done"
    );

    if (activeEvent && doneEvent) {
      const days =
        (new Date(doneEvent.timestamp).getTime() -
          new Date(activeEvent.timestamp).getTime()) /
        86400000;
      if (days > 0 && days < 90) {
        cycleTimes.set(outcome.issue_number, days);
      }
    }
  }

  return cycleTimes;
}

/** Percentile calculation */
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil(sorted.length * p) - 1;
  return sorted[Math.max(0, Math.min(idx, sorted.length - 1))];
}

/** Detect current state from events */
function getCurrentState(events: PMEvent[]): string {
  const stateChanges = events
    .filter((e) => e.event_type === "workflow_change" && e.to_value)
    .sort(
      (a, b) =>
        new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
    );

  return stateChanges.length > 0
    ? stateChanges[stateChanges.length - 1].to_value!
    : "Unknown";
}

// ─── Prediction Functions ───────────────────────────────

/**
 * Predict when an issue will be completed based on historical patterns.
 * Uses cycle time distributions filtered by area and complexity signals.
 */
export async function predictCompletion(
  issueNumber: number
): Promise<CompletionPrediction> {
  const [allOutcomes, allEvents] = await Promise.all([
    getOutcomes(500),
    getEvents(2000),
  ]);

  // Get this issue's events
  const issueEvents = allEvents.filter(
    (e) => e.issue_number === issueNumber
  );
  const currentState = getCurrentState(issueEvents);

  // Get area from events or outcomes
  const area =
    allOutcomes.find((o) => o.issue_number === issueNumber)?.area ?? null;

  // Build cycle time dataset
  const cycleTimes = computeCycleTimes(allOutcomes, allEvents);
  const allCycles = Array.from(cycleTimes.values()).sort((a, b) => a - b);

  // Filter for same area if available
  const areaCycles = area
    ? allOutcomes
        .filter((o) => o.area === area && o.result === "merged")
        .map((o) => cycleTimes.get(o.issue_number))
        .filter((d): d is number => d !== undefined)
        .sort((a, b) => a - b)
    : [];

  // Use area-specific data if enough, else fall back to all
  const dataset =
    areaCycles.length >= 3 ? areaCycles : allCycles.length >= 3 ? allCycles : [];

  // Calculate percentiles
  let p50Days: number, p80Days: number, p95Days: number;

  if (dataset.length >= 3) {
    p50Days = Math.round(percentile(dataset, 0.5) * 10) / 10;
    p80Days = Math.round(percentile(dataset, 0.8) * 10) / 10;
    p95Days = Math.round(percentile(dataset, 0.95) * 10) / 10;
  } else {
    // Insufficient data — use reasonable defaults
    p50Days = 3;
    p80Days = 5;
    p95Days = 10;
  }

  // Adjust based on current state (remaining time)
  const stateMultipliers: Record<string, number> = {
    Backlog: 1.0,
    Ready: 0.95,
    Active: 0.7,
    Review: 0.15,
    Rework: 0.5,
  };
  const multiplier = stateMultipliers[currentState] ?? 1.0;

  p50Days = Math.round(p50Days * multiplier * 10) / 10;
  p80Days = Math.round(p80Days * multiplier * 10) / 10;
  p95Days = Math.round(p95Days * multiplier * 10) / 10;

  const now = new Date();
  const addDays = (d: number) =>
    new Date(now.getTime() + d * 86400000).toISOString().split("T")[0];

  // Risk scoring (0-100)
  const riskFactors: CompletionPrediction["riskFactors"] = [];
  let riskScore = 0;

  // Factor 1: Has rework history
  const reworkEvents = issueEvents.filter(
    (e) => e.event_type === "workflow_change" && e.to_value === "Rework"
  );
  if (reworkEvents.length > 0) {
    const contribution = Math.min(reworkEvents.length * 15, 30);
    riskScore += contribution;
    riskFactors.push({
      factor: "Rework history",
      severity: reworkEvents.length > 1 ? "high" : "medium",
      contribution,
      detail: `${reworkEvents.length} rework cycle(s) detected`,
    });
  }

  // Factor 2: Long time in current state
  const lastStateChange = issueEvents
    .filter((e) => e.event_type === "workflow_change")
    .sort(
      (a, b) =>
        new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
    )[0];

  if (lastStateChange) {
    const daysInState =
      (Date.now() - new Date(lastStateChange.timestamp).getTime()) / 86400000;
    if (daysInState > 5) {
      const contribution = Math.min(Math.round(daysInState * 3), 25);
      riskScore += contribution;
      riskFactors.push({
        factor: "Stale in current state",
        severity: daysInState > 10 ? "high" : "medium",
        contribution,
        detail: `${Math.round(daysInState)} days in ${currentState}`,
      });
    }
  }

  // Factor 3: High area rework rate
  if (area) {
    const areaOutcomes = allOutcomes.filter((o) => o.area === area);
    const areaReworkRate =
      areaOutcomes.length > 0
        ? areaOutcomes.filter((o) => o.result === "rework").length /
          areaOutcomes.length
        : 0;
    if (areaReworkRate > 0.3) {
      const contribution = Math.round(areaReworkRate * 25);
      riskScore += contribution;
      riskFactors.push({
        factor: "High-rework area",
        severity: areaReworkRate > 0.5 ? "high" : "medium",
        contribution,
        detail: `${area} has ${Math.round(areaReworkRate * 100)}% rework rate`,
      });
    }
  }

  // Factor 4: No decisions recorded
  const decisions = await getDecisions(100, issueNumber);
  if (decisions.length === 0 && currentState === "Active") {
    riskScore += 10;
    riskFactors.push({
      factor: "No decisions documented",
      severity: "low",
      contribution: 10,
      detail: "No architectural decisions recorded for this issue",
    });
  }

  // Factor 5: Few sessions (low activity)
  const sessions = issueEvents.filter(
    (e) => e.event_type === "session_start"
  );
  if (sessions.length <= 1 && currentState === "Active") {
    riskScore += 10;
    riskFactors.push({
      factor: "Low session activity",
      severity: "low",
      contribution: 10,
      detail: `Only ${sessions.length} development session(s) recorded`,
    });
  }

  riskScore = Math.min(riskScore, 100);

  // Confidence level
  const confidence =
    dataset.length >= 10 ? "high" : dataset.length >= 5 ? "medium" : "low";
  const confidenceReason =
    dataset.length >= 10
      ? `Based on ${dataset.length} historical completions`
      : dataset.length >= 3
        ? `Based on ${dataset.length} completions (limited data)`
        : "Insufficient historical data — using defaults";

  // Similar issues
  const similarIssues = allOutcomes
    .filter((o) => o.area === area && o.issue_number !== issueNumber)
    .slice(-5)
    .map((o) => ({
      issueNumber: o.issue_number,
      area: o.area,
      cycleDays: cycleTimes.get(o.issue_number) ?? 0,
      result: o.result,
    }))
    .filter((s) => s.cycleDays > 0);

  // Recommendation
  let recommendation: string;
  if (riskScore >= 60) {
    recommendation =
      "High risk — consider breaking into smaller pieces or allocating extra review time";
  } else if (riskScore >= 30) {
    recommendation =
      "Moderate risk — monitor closely and address rework patterns early";
  } else {
    recommendation = "On track — no special attention needed";
  }

  return {
    issueNumber,
    currentState,
    prediction: {
      p50Days,
      p80Days,
      p95Days,
      expectedDate: {
        p50: addDays(p50Days),
        p80: addDays(p80Days),
        p95: addDays(p95Days),
      },
    },
    riskScore,
    riskFactors,
    confidence,
    confidenceReason,
    similarIssues,
    recommendation,
  };
}

/**
 * Predict the probability that an issue will require rework
 * before it enters Review. Flags high-risk PRs early.
 */
export async function predictRework(
  issueNumber: number
): Promise<ReworkPrediction> {
  const [allOutcomes, allEvents, allDecisions] = await Promise.all([
    getOutcomes(500),
    getEvents(2000),
    getDecisions(500),
  ]);

  const issueEvents = allEvents.filter(
    (e) => e.issue_number === issueNumber
  );

  // Detect area
  const issueOutcome = allOutcomes.find(
    (o) => o.issue_number === issueNumber
  );
  const area = issueOutcome?.area ?? null;

  // Baseline rework rate
  const totalCompleted = allOutcomes.filter(
    (o) => o.result === "merged" || o.result === "rework"
  );
  const baselineReworkRate =
    totalCompleted.length > 0
      ? allOutcomes.filter((o) => o.result === "rework").length /
        totalCompleted.length
      : 0.2; // default 20% if no data

  // Area rework rate
  const areaOutcomes = area
    ? allOutcomes.filter((o) => o.area === area)
    : [];
  const areaCompleted = areaOutcomes.filter(
    (o) => o.result === "merged" || o.result === "rework"
  );
  const areaReworkRate =
    areaCompleted.length >= 3
      ? areaOutcomes.filter((o) => o.result === "rework").length /
        areaCompleted.length
      : null;

  // Signal detection
  const signals: ReworkPrediction["signals"] = [];
  let weightedScore = 0;

  // Signal 1: Multiple rework cycles in event history
  const reworkCycles = issueEvents.filter(
    (e) => e.event_type === "workflow_change" && e.to_value === "Rework"
  ).length;
  const hasReworkHistory = reworkCycles > 0;
  signals.push({
    signal: "Previous rework cycles",
    weight: 0.25,
    present: hasReworkHistory,
    detail: hasReworkHistory
      ? `${reworkCycles} previous rework cycle(s)`
      : "No rework history",
  });
  if (hasReworkHistory) weightedScore += 0.25;

  // Signal 2: High area rework rate
  const highAreaRework = areaReworkRate !== null && areaReworkRate > 0.3;
  signals.push({
    signal: "High-rework area",
    weight: 0.15,
    present: highAreaRework,
    detail:
      areaReworkRate !== null
        ? `${area}: ${Math.round(areaReworkRate * 100)}% rework rate`
        : "No area data",
  });
  if (highAreaRework) weightedScore += 0.15;

  // Signal 3: No decisions documented
  const issueDecisions = allDecisions.filter(
    (d) => d.issue_number === issueNumber
  );
  const noDecisions = issueDecisions.length === 0;
  signals.push({
    signal: "No decisions documented",
    weight: 0.15,
    present: noDecisions,
    detail: noDecisions
      ? "No architectural decisions recorded"
      : `${issueDecisions.length} decision(s) documented`,
  });
  if (noDecisions) weightedScore += 0.15;

  // Signal 4: Rapid state transitions (rushing)
  const stateChanges = issueEvents.filter(
    (e) => e.event_type === "workflow_change"
  );
  const hasActiveToReviewFast = (() => {
    const activeEvent = stateChanges.find((e) => e.to_value === "Active");
    const reviewEvent = stateChanges.find((e) => e.to_value === "Review");
    if (activeEvent && reviewEvent) {
      const hours =
        (new Date(reviewEvent.timestamp).getTime() -
          new Date(activeEvent.timestamp).getTime()) /
        3600000;
      return hours < 2; // Less than 2 hours Active→Review is suspiciously fast
    }
    return false;
  })();
  signals.push({
    signal: "Rushed to Review",
    weight: 0.2,
    present: hasActiveToReviewFast,
    detail: hasActiveToReviewFast
      ? "Moved Active→Review in under 2 hours"
      : "Normal development pace",
  });
  if (hasActiveToReviewFast) weightedScore += 0.2;

  // Signal 5: Few sessions
  const sessionCount = issueEvents.filter(
    (e) => e.event_type === "session_start"
  ).length;
  const fewSessions = sessionCount <= 1;
  signals.push({
    signal: "Minimal development sessions",
    weight: 0.1,
    present: fewSessions,
    detail: `${sessionCount} session(s) recorded`,
  });
  if (fewSessions) weightedScore += 0.1;

  // Signal 6: High needs-input rate (complexity indicator)
  const needsInputCount = issueEvents.filter(
    (e) => e.event_type === "needs_input"
  ).length;
  const highNeedsInput =
    sessionCount > 0 && needsInputCount / sessionCount > 0.5;
  signals.push({
    signal: "High user interaction rate",
    weight: 0.15,
    present: highNeedsInput,
    detail: `${needsInputCount} needs-input events across ${sessionCount} sessions`,
  });
  if (highNeedsInput) weightedScore += 0.15;

  // Combine baseline with signal-based prediction
  const effectiveBaseline = areaReworkRate ?? baselineReworkRate;
  const reworkProbability = Math.min(
    effectiveBaseline + weightedScore * (1 - effectiveBaseline),
    0.95
  );

  const riskLevel: ReworkPrediction["riskLevel"] =
    reworkProbability >= 0.7
      ? "very_high"
      : reworkProbability >= 0.5
        ? "high"
        : reworkProbability >= 0.3
          ? "medium"
          : "low";

  // Generate mitigations
  const mitigations: string[] = [];
  if (noDecisions) {
    mitigations.push(
      "Record architectural decisions before submitting for review"
    );
  }
  if (hasActiveToReviewFast) {
    mitigations.push(
      "Allow more development time — reviews find more issues in rushed work"
    );
  }
  if (fewSessions) {
    mitigations.push(
      "Consider breaking the work into smaller increments with more sessions"
    );
  }
  if (highAreaRework) {
    mitigations.push(
      `${area} area has high rework rate — review past issues for common patterns`
    );
  }
  if (hasReworkHistory) {
    mitigations.push(
      "Address all previous review feedback explicitly before re-submitting"
    );
  }
  if (mitigations.length === 0) {
    mitigations.push("No specific mitigations needed — proceed to review");
  }

  return {
    issueNumber,
    reworkProbability: Math.round(reworkProbability * 100) / 100,
    riskLevel,
    signals,
    mitigations,
    historicalComparison: {
      baselineReworkRate: Math.round(baselineReworkRate * 100) / 100,
      areaReworkRate:
        areaReworkRate !== null
          ? Math.round(areaReworkRate * 100) / 100
          : null,
      area,
    },
  };
}

/**
 * Calculate DORA metrics from git history and JSONL memory.
 *
 * - Deployment Frequency: PR merge rate
 * - Lead Time for Changes: First commit → merge
 * - Change Failure Rate: Rework ratio
 * - Mean Time to Restore: Bug fix cycle time
 */
export async function getDORAMetrics(days = 30): Promise<DORAMetrics> {
  const since = new Date(Date.now() - days * 86400000);
  const sinceISO = since.toISOString();

  const [commits, allOutcomes, allEvents] = await Promise.all([
    getGitCommits(days),
    getOutcomes(1000),
    getEvents(5000),
  ]);

  // Filter to period
  const periodOutcomes = allOutcomes.filter(
    (o) => new Date(o.timestamp) >= since
  );
  const periodEvents = allEvents.filter(
    (e) => new Date(e.timestamp) >= since
  );

  // ─── Deployment Frequency ───
  // Count merge commits (PRs merged)
  const mergedOutcomes = periodOutcomes.filter(
    (o) => o.result === "merged"
  );
  const weeks = days / 7;
  const mergesPerWeek =
    weeks > 0
      ? Math.round((mergedOutcomes.length / weeks) * 10) / 10
      : 0;

  // DORA benchmarks: Elite ≥7/week, High ≥1/week, Medium ≥1/month, Low <1/month
  const dfRating: DORAMetrics["deploymentFrequency"]["rating"] =
    mergesPerWeek >= 7
      ? "elite"
      : mergesPerWeek >= 1
        ? "high"
        : mergesPerWeek >= 0.25
          ? "medium"
          : "low";

  // ─── Lead Time for Changes ───
  // Time from first commit on branch to merge
  const cycleTimes = computeCycleTimes(allOutcomes, allEvents);
  const periodCycles = mergedOutcomes
    .map((o) => cycleTimes.get(o.issue_number))
    .filter((d): d is number => d !== undefined)
    .sort((a, b) => a - b);

  const ltMedian =
    periodCycles.length > 0
      ? Math.round(percentile(periodCycles, 0.5) * 10) / 10
      : 0;
  const ltP90 =
    periodCycles.length > 0
      ? Math.round(percentile(periodCycles, 0.9) * 10) / 10
      : 0;

  // DORA benchmarks: Elite <1 day, High <1 week, Medium <1 month, Low ≥1 month
  const ltRating: DORAMetrics["leadTimeForChanges"]["rating"] =
    ltMedian <= 1
      ? "elite"
      : ltMedian <= 7
        ? "high"
        : ltMedian <= 30
          ? "medium"
          : "low";

  // ─── Change Failure Rate ───
  // Ratio of outcomes that required rework
  const totalOutcomeCount = periodOutcomes.length;
  const reworkCount = periodOutcomes.filter(
    (o) => o.result === "rework"
  ).length;
  const cfRate =
    totalOutcomeCount > 0 ? reworkCount / totalOutcomeCount : 0;

  // DORA benchmarks: Elite <5%, High <10%, Medium <15%, Low ≥15%
  const cfRating: DORAMetrics["changeFailureRate"]["rating"] =
    cfRate <= 0.05
      ? "elite"
      : cfRate <= 0.1
        ? "high"
        : cfRate <= 0.15
          ? "medium"
          : "low";

  // ─── Mean Time to Restore ───
  // Cycle time for bug fixes specifically
  const bugCommits = commits.filter((c) =>
    c.subject.startsWith("fix")
  );
  const bugOutcomes = periodOutcomes.filter(
    (o) =>
      o.result === "merged" &&
      allOutcomes.some(
        (ao) =>
          ao.issue_number === o.issue_number &&
          // Bug fixes typically have fix: prefix
          bugCommits.some((bc) =>
            bc.subject.includes(`#${o.issue_number}`)
          )
      )
  );

  const bugCycles = bugOutcomes
    .map((o) => cycleTimes.get(o.issue_number))
    .filter((d): d is number => d !== undefined)
    .sort((a, b) => a - b);

  const mttrMedianHours =
    bugCycles.length > 0
      ? Math.round(percentile(bugCycles, 0.5) * 24 * 10) / 10
      : null;

  const mttrRating: DORAMetrics["meanTimeToRestore"]["rating"] =
    mttrMedianHours === null
      ? "insufficient_data"
      : mttrMedianHours <= 1
        ? "elite"
        : mttrMedianHours <= 24
          ? "high"
          : mttrMedianHours <= 168
            ? "medium"
            : "low";

  // ─── Overall Rating ───
  const ratings = [dfRating, ltRating, cfRating];
  if (mttrRating !== "insufficient_data") ratings.push(mttrRating);

  const ratingOrder = { elite: 4, high: 3, medium: 2, low: 1 };
  const avgRating =
    ratings.reduce((sum, r) => sum + ratingOrder[r], 0) / ratings.length;

  const overallRating: DORAMetrics["overall"]["rating"] =
    avgRating >= 3.5
      ? "elite"
      : avgRating >= 2.5
        ? "high"
        : avgRating >= 1.5
          ? "medium"
          : "low";

  const recommendations: string[] = [];
  if (dfRating === "low" || dfRating === "medium") {
    recommendations.push(
      "Increase merge frequency — smaller PRs merge faster and reduce risk"
    );
  }
  if (ltRating === "low" || ltRating === "medium") {
    recommendations.push(
      "Reduce lead time — identify review bottlenecks with sprint analytics"
    );
  }
  if (cfRating === "low" || cfRating === "medium") {
    recommendations.push(
      "Reduce change failure rate — improve acceptance criteria specificity and add pre-review checks"
    );
  }
  if (mttrRating === "low" || mttrRating === "medium") {
    recommendations.push(
      "Improve restoration time — prioritize bug fixes and establish on-call rotation"
    );
  }
  if (recommendations.length === 0) {
    recommendations.push(
      "Strong performance across all DORA metrics — maintain current practices"
    );
  }

  return {
    period: {
      from: sinceISO.split("T")[0],
      to: new Date().toISOString().split("T")[0],
      days,
    },
    deploymentFrequency: {
      mergesPerWeek,
      rating: dfRating,
      description: `${mergedOutcomes.length} merges in ${days} days (${mergesPerWeek}/week)`,
    },
    leadTimeForChanges: {
      medianDays: ltMedian,
      p90Days: ltP90,
      rating: ltRating,
      description:
        periodCycles.length > 0
          ? `Median ${ltMedian} days, P90 ${ltP90} days (${periodCycles.length} data points)`
          : "No completed cycle data available",
    },
    changeFailureRate: {
      rate: Math.round(cfRate * 1000) / 1000,
      rating: cfRating,
      reworkCount,
      totalCount: totalOutcomeCount,
      description: `${reworkCount}/${totalOutcomeCount} outcomes required rework (${Math.round(cfRate * 100)}%)`,
    },
    meanTimeToRestore: {
      medianHours: mttrMedianHours,
      rating: mttrRating,
      bugFixCount: bugCycles.length,
      description:
        mttrMedianHours !== null
          ? `Median ${mttrMedianHours} hours (${bugCycles.length} bug fixes)`
          : `Insufficient data (${bugOutcomes.length} bug fixes found, need cycle times)`,
    },
    overall: {
      rating: overallRating,
      summary: `${overallRating.toUpperCase()} performer — ${ratings.filter((r) => r === "elite" || r === "high").length}/${ratings.length} metrics at high/elite level`,
      recommendations,
    },
  };
}

/**
 * Analyze knowledge distribution and bus factor risks.
 * Identifies files where knowledge is concentrated in a single
 * contributor and areas where knowledge is decaying.
 */
export async function getKnowledgeRisk(
  days = 90
): Promise<KnowledgeRisk> {
  const since = new Date(Date.now() - days * 86400000);
  const sinceISO = since.toISOString();

  let commits: Array<{
    hash: string;
    date: string;
    author: string;
    subject: string;
    files: string[];
  }>;

  try {
    const { stdout } = await execFileAsync(
      "git",
      [
        "log",
        `--since=${sinceISO}`,
        "--pretty=format:%H|%aI|%an|%s",
        "--name-only",
        "--no-merges",
      ],
      { maxBuffer: 10 * 1024 * 1024 }
    );

    commits = [];
    let current: (typeof commits)[0] | null = null;

    for (const line of stdout.split("\n")) {
      if (line.includes("|")) {
        const parts = line.split("|");
        if (parts.length >= 4) {
          if (current) commits.push(current);
          current = {
            hash: parts[0],
            date: parts[1],
            author: parts[2],
            subject: parts.slice(3).join("|"),
            files: [],
          };
        }
      } else if (line.trim() && current) {
        current.files.push(line.trim());
      }
    }
    if (current) commits.push(current);
  } catch {
    commits = [];
  }

  // Build per-file knowledge map
  const fileKnowledge = new Map<
    string,
    {
      authors: Map<string, number>;
      lastTouched: string;
      totalChanges: number;
    }
  >();

  for (const commit of commits) {
    for (const file of commit.files) {
      if (!fileKnowledge.has(file)) {
        fileKnowledge.set(file, {
          authors: new Map(),
          lastTouched: commit.date,
          totalChanges: 0,
        });
      }
      const info = fileKnowledge.get(file)!;
      info.authors.set(
        commit.author,
        (info.authors.get(commit.author) || 0) + 1
      );
      info.totalChanges++;
      if (new Date(commit.date) > new Date(info.lastTouched)) {
        info.lastTouched = commit.date;
      }
    }
  }

  // Compute per-file risks
  const now = Date.now();
  const fileRisks: KnowledgeRisk["fileRisks"] = [];

  for (const [file, info] of fileKnowledge) {
    if (info.totalChanges < 2) continue; // Skip rarely-changed files

    const busFactor = info.authors.size;
    const sortedAuthors = Array.from(info.authors.entries()).sort(
      (a, b) => b[1] - a[1]
    );
    const primaryAuthor = sortedAuthors[0][0];
    const primaryAuthorShare = sortedAuthors[0][1] / info.totalChanges;

    const daysSinceTouch = Math.round(
      (now - new Date(info.lastTouched).getTime()) / 86400000
    );

    const reasons: string[] = [];
    let riskLevel: "low" | "medium" | "high" | "critical" = "low";

    // Bus factor risk
    if (busFactor === 1) {
      reasons.push(`Single contributor: ${primaryAuthor}`);
      riskLevel = "high";
    } else if (primaryAuthorShare > 0.8) {
      reasons.push(
        `${primaryAuthor} owns ${Math.round(primaryAuthorShare * 100)}% of changes`
      );
      riskLevel = "medium";
    }

    // Knowledge decay risk
    if (daysSinceTouch > 60 && info.totalChanges >= 5) {
      reasons.push(`Not touched in ${daysSinceTouch} days despite ${info.totalChanges} historical changes`);
      if (riskLevel === "low") riskLevel = "medium";
      if (busFactor === 1) riskLevel = "critical";
    }

    // High churn + single author = critical
    if (info.totalChanges >= 10 && busFactor === 1) {
      riskLevel = "critical";
      reasons.push(
        `High-churn file (${info.totalChanges} changes) with single contributor`
      );
    }

    if (reasons.length > 0) {
      fileRisks.push({
        file,
        busFactor,
        primaryAuthor,
        primaryAuthorShare: Math.round(primaryAuthorShare * 100) / 100,
        lastTouched: info.lastTouched.split("T")[0],
        daysSinceTouch,
        changes: info.totalChanges,
        knowledgeRisk: riskLevel,
        reasons,
      });
    }
  }

  // Sort by risk level then changes
  const riskOrder = { critical: 0, high: 1, medium: 2, low: 3 };
  fileRisks.sort(
    (a, b) =>
      riskOrder[a.knowledgeRisk] - riskOrder[b.knowledgeRisk] ||
      b.changes - a.changes
  );

  // Compute area-level risks
  const areaMap = new Map<
    string,
    { files: number; critical: number; busFactors: number[] }
  >();

  for (const fr of fileRisks) {
    // Derive area from path
    let area = "other";
    if (fr.file.includes("web/") || fr.file.includes("frontend/")) {
      area = "frontend";
    } else if (fr.file.includes("backend/") || fr.file.includes("api/")) {
      area = "backend";
    } else if (fr.file.includes("contracts/")) {
      area = "contracts";
    } else if (
      fr.file.includes("infra/") ||
      fr.file.includes("tools/") ||
      fr.file.includes(".github/") ||
      fr.file.includes("docker")
    ) {
      area = "infra";
    }

    if (!areaMap.has(area)) {
      areaMap.set(area, { files: 0, critical: 0, busFactors: [] });
    }
    const areaInfo = areaMap.get(area)!;
    areaInfo.files++;
    if (
      fr.knowledgeRisk === "critical" ||
      fr.knowledgeRisk === "high"
    ) {
      areaInfo.critical++;
    }
    areaInfo.busFactors.push(fr.busFactor);
  }

  const areaRisks: KnowledgeRisk["areaRisks"] = Array.from(
    areaMap.entries()
  )
    .map(([area, info]) => {
      const avgBusFactor =
        info.busFactors.reduce((s, b) => s + b, 0) /
        info.busFactors.length;
      const critRatio = info.critical / info.files;
      const risk: "low" | "medium" | "high" | "critical" =
        critRatio > 0.5
          ? "critical"
          : critRatio > 0.3
            ? "high"
            : avgBusFactor < 2
              ? "medium"
              : "low";

      return {
        area,
        avgBusFactor: Math.round(avgBusFactor * 10) / 10,
        fileCount: info.files,
        criticalFiles: info.critical,
        knowledgeRisk: risk,
      };
    })
    .sort(
      (a, b) =>
        riskOrder[a.knowledgeRisk] - riskOrder[b.knowledgeRisk]
    );

  // Decay alerts: files with high historical activity but stale
  const decayAlerts: KnowledgeRisk["decayAlerts"] = fileRisks
    .filter((fr) => fr.daysSinceTouch > 30 && fr.changes >= 5)
    .slice(0, 10)
    .map((fr) => ({
      file: fr.file,
      daysSinceTouch: fr.daysSinceTouch,
      changes: fr.changes,
      alert: `${fr.file} had ${fr.changes} changes but hasn't been touched in ${fr.daysSinceTouch} days`,
    }));

  // Summary
  const totalFiles = fileRisks.length;
  const criticalCount = fileRisks.filter(
    (f) => f.knowledgeRisk === "critical"
  ).length;
  const allBusFactors = fileRisks.map((f) => f.busFactor);
  const avgBusFactor =
    allBusFactors.length > 0
      ? Math.round(
          (allBusFactors.reduce((s, b) => s + b, 0) /
            allBusFactors.length) *
            10
        ) / 10
      : 0;

  let recommendation: string;
  if (criticalCount > 3) {
    recommendation = `${criticalCount} critical-risk files — prioritize cross-training or pair programming`;
  } else if (criticalCount > 0) {
    recommendation = `${criticalCount} critical-risk file(s) — consider knowledge sharing sessions`;
  } else if (avgBusFactor < 2) {
    recommendation =
      "Low average bus factor — encourage code reviews from diverse team members";
  } else {
    recommendation = "Knowledge distribution is healthy";
  }

  return {
    period: {
      from: sinceISO.split("T")[0],
      to: new Date().toISOString().split("T")[0],
      days,
    },
    fileRisks: fileRisks.slice(0, 20), // Top 20
    areaRisks,
    decayAlerts,
    summary: {
      totalFiles,
      criticalRiskFiles: criticalCount,
      averageBusFactor: avgBusFactor,
      recommendation,
    },
  };
}
