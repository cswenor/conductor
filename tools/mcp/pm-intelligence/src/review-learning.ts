/**
 * Review attribution learning — track which review findings get
 * accepted vs dismissed and use this to calibrate future reviews.
 *
 * Also includes decision decay detection — flags stale decisions
 * whose context has drifted significantly since they were made.
 *
 * Tools:
 *   - recordReviewOutcome: Log review finding disposition
 *   - getReviewCalibration: Hit rate by finding type
 *   - checkDecisionDecay: Flag stale decisions based on context drift
 */

import { readFile, appendFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getDecisions, type Decision } from "./memory.js";

const execFileAsync = promisify(execFile);

// ─── Types ──────────────────────────────────────────────

export interface ReviewFindingRecord {
  timestamp: string;
  issueNumber: number;
  prNumber: number | null;
  findingType: string; // e.g., "scope_verification", "failure_mode", "comment_verification"
  severity: "blocking" | "non_blocking" | "suggestion";
  disposition: "accepted" | "dismissed" | "modified" | "deferred";
  reason: string | null; // Why it was dismissed/deferred
  area: string | null;
  files: string[];
}

export interface ReviewCalibration {
  period: { from: string; to: string; totalFindings: number };
  overallHitRate: number; // fraction of findings accepted
  byFindingType: Array<{
    type: string;
    total: number;
    accepted: number;
    dismissed: number;
    modified: number;
    deferred: number;
    hitRate: number;
    trend: "improving" | "stable" | "declining";
  }>;
  bySeverity: Array<{
    severity: string;
    total: number;
    hitRate: number;
  }>;
  byArea: Array<{
    area: string;
    total: number;
    hitRate: number;
    topFalsePositive: string | null;
  }>;
  falsePositivePatterns: Array<{
    findingType: string;
    area: string | null;
    dismissalRate: number;
    commonReasons: string[];
    recommendation: string;
  }>;
  recommendations: string[];
}

export interface DecisionDecayReport {
  totalDecisions: number;
  staleDecisions: Array<{
    decision: Decision;
    ageDays: number;
    decaySignals: Array<{
      signal: string;
      severity: "low" | "medium" | "high";
      detail: string;
    }>;
    decayScore: number; // 0-100
    recommendation: string;
  }>;
  healthyDecisions: number;
  decayingDecisions: number;
  recommendation: string;
}

// ─── File Operations ────────────────────────────────────

async function getRepoRoot(): Promise<string> {
  const { stdout } = await execFileAsync("git", [
    "rev-parse",
    "--show-toplevel",
  ]);
  return stdout.trim();
}

const REVIEW_FILE = "review-findings.jsonl";

async function readReviewFindings(): Promise<ReviewFindingRecord[]> {
  const root = await getRepoRoot();
  const path = `${root}/.claude/memory/${REVIEW_FILE}`;
  if (!existsSync(path)) return [];

  const content = await readFile(path, "utf-8");
  return content
    .trim()
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as ReviewFindingRecord);
}

// ─── Tool Functions ─────────────────────────────────────

/**
 * Record the disposition of a review finding.
 * Called after a review cycle completes — for each finding,
 * record whether it was accepted, dismissed, modified, or deferred.
 */
export async function recordReviewOutcome(params: {
  issueNumber: number;
  prNumber?: number;
  findingType: string;
  severity: "blocking" | "non_blocking" | "suggestion";
  disposition: "accepted" | "dismissed" | "modified" | "deferred";
  reason?: string;
  area?: string;
  files?: string[];
}): Promise<{ recorded: boolean; message: string }> {
  const root = await getRepoRoot();
  const dir = `${root}/.claude/memory`;
  await mkdir(dir, { recursive: true });

  const record: ReviewFindingRecord = {
    timestamp: new Date().toISOString(),
    issueNumber: params.issueNumber,
    prNumber: params.prNumber ?? null,
    findingType: params.findingType,
    severity: params.severity,
    disposition: params.disposition,
    reason: params.reason ?? null,
    area: params.area ?? null,
    files: params.files ?? [],
  };

  await appendFile(
    `${dir}/${REVIEW_FILE}`,
    JSON.stringify(record) + "\n"
  );

  return {
    recorded: true,
    message: `Recorded: ${params.findingType} (${params.severity}) → ${params.disposition}`,
  };
}

/**
 * Analyze review finding history to calculate hit rates,
 * identify false positive patterns, and generate calibration data.
 */
export async function getReviewCalibration(
  days = 90
): Promise<ReviewCalibration> {
  const since = new Date(Date.now() - days * 86400000);
  const allFindings = await readReviewFindings();
  const findings = allFindings.filter(
    (f) => new Date(f.timestamp) >= since
  );

  // Overall hit rate
  const accepted = findings.filter(
    (f) => f.disposition === "accepted" || f.disposition === "modified"
  ).length;
  const overallHitRate =
    findings.length > 0 ? Math.round((accepted / findings.length) * 100) / 100 : 0;

  // By finding type
  const typeMap = new Map<
    string,
    { total: number; accepted: number; dismissed: number; modified: number; deferred: number }
  >();
  for (const f of findings) {
    if (!typeMap.has(f.findingType)) {
      typeMap.set(f.findingType, {
        total: 0,
        accepted: 0,
        dismissed: 0,
        modified: 0,
        deferred: 0,
      });
    }
    const entry = typeMap.get(f.findingType)!;
    entry.total++;
    entry[f.disposition]++;
  }

  // Calculate trend by comparing first half vs second half
  const midpoint = new Date(
    since.getTime() + (Date.now() - since.getTime()) / 2
  );

  const byFindingType = Array.from(typeMap.entries())
    .map(([type, stats]) => {
      const hitRate =
        stats.total > 0
          ? Math.round(
              ((stats.accepted + stats.modified) / stats.total) * 100
            ) / 100
          : 0;

      // Trend: compare hit rate in first half vs second half
      const firstHalf = findings.filter(
        (f) =>
          f.findingType === type && new Date(f.timestamp) < midpoint
      );
      const secondHalf = findings.filter(
        (f) =>
          f.findingType === type && new Date(f.timestamp) >= midpoint
      );

      const firstHitRate =
        firstHalf.length > 0
          ? firstHalf.filter(
              (f) =>
                f.disposition === "accepted" ||
                f.disposition === "modified"
            ).length / firstHalf.length
          : 0;
      const secondHitRate =
        secondHalf.length > 0
          ? secondHalf.filter(
              (f) =>
                f.disposition === "accepted" ||
                f.disposition === "modified"
            ).length / secondHalf.length
          : 0;

      const trend: "improving" | "stable" | "declining" =
        secondHitRate > firstHitRate + 0.1
          ? "improving"
          : secondHitRate < firstHitRate - 0.1
            ? "declining"
            : "stable";

      return {
        type,
        ...stats,
        hitRate,
        trend,
      };
    })
    .sort((a, b) => b.total - a.total);

  // By severity
  const severityMap = new Map<string, { total: number; accepted: number }>();
  for (const f of findings) {
    if (!severityMap.has(f.severity)) {
      severityMap.set(f.severity, { total: 0, accepted: 0 });
    }
    const entry = severityMap.get(f.severity)!;
    entry.total++;
    if (
      f.disposition === "accepted" ||
      f.disposition === "modified"
    ) {
      entry.accepted++;
    }
  }

  const bySeverity = Array.from(severityMap.entries()).map(
    ([severity, stats]) => ({
      severity,
      total: stats.total,
      hitRate:
        stats.total > 0
          ? Math.round((stats.accepted / stats.total) * 100) / 100
          : 0,
    })
  );

  // By area
  const areaMap = new Map<
    string,
    {
      total: number;
      accepted: number;
      dismissed: Map<string, number>;
    }
  >();

  for (const f of findings) {
    const area = f.area ?? "unknown";
    if (!areaMap.has(area)) {
      areaMap.set(area, {
        total: 0,
        accepted: 0,
        dismissed: new Map(),
      });
    }
    const entry = areaMap.get(area)!;
    entry.total++;
    if (
      f.disposition === "accepted" ||
      f.disposition === "modified"
    ) {
      entry.accepted++;
    }
    if (f.disposition === "dismissed") {
      entry.dismissed.set(
        f.findingType,
        (entry.dismissed.get(f.findingType) || 0) + 1
      );
    }
  }

  const byArea = Array.from(areaMap.entries())
    .map(([area, stats]) => {
      const topFP = Array.from(stats.dismissed.entries()).sort(
        (a, b) => b[1] - a[1]
      )[0];
      return {
        area,
        total: stats.total,
        hitRate:
          stats.total > 0
            ? Math.round((stats.accepted / stats.total) * 100) / 100
            : 0,
        topFalsePositive: topFP ? topFP[0] : null,
      };
    })
    .sort((a, b) => b.total - a.total);

  // False positive patterns
  const falsePositivePatterns: ReviewCalibration["falsePositivePatterns"] =
    [];

  for (const [type, stats] of typeMap) {
    const dismissalRate =
      stats.total > 0
        ? Math.round((stats.dismissed / stats.total) * 100) / 100
        : 0;

    if (dismissalRate > 0.4 && stats.total >= 3) {
      // High dismissal rate — this is a problematic finding type
      const dismissed = findings.filter(
        (f) =>
          f.findingType === type && f.disposition === "dismissed"
      );
      const commonReasons = Array.from(
        dismissed.reduce((map, f) => {
          if (f.reason) map.set(f.reason, (map.get(f.reason) || 0) + 1);
          return map;
        }, new Map<string, number>())
      )
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([reason]) => reason);

      // Check if it's area-specific
      const areaBreakdown = new Map<string, number>();
      for (const f of dismissed) {
        const a = f.area ?? "unknown";
        areaBreakdown.set(a, (areaBreakdown.get(a) || 0) + 1);
      }
      const topArea = Array.from(areaBreakdown.entries()).sort(
        (a, b) => b[1] - a[1]
      )[0];

      const areaSpecific =
        topArea && topArea[1] / dismissed.length > 0.7
          ? topArea[0]
          : null;

      falsePositivePatterns.push({
        findingType: type,
        area: areaSpecific,
        dismissalRate,
        commonReasons,
        recommendation:
          areaSpecific
            ? `Consider reducing ${type} checks for ${areaSpecific} area (${Math.round(dismissalRate * 100)}% dismissed)`
            : `${type} findings are dismissed ${Math.round(dismissalRate * 100)}% of the time — review relevance`,
      });
    }
  }

  // Recommendations
  const recommendations: string[] = [];
  if (overallHitRate < 0.5 && findings.length >= 10) {
    recommendations.push(
      `Overall hit rate is ${Math.round(overallHitRate * 100)}% — consider tightening review criteria to reduce noise`
    );
  }
  if (overallHitRate > 0.9 && findings.length >= 10) {
    recommendations.push(
      "Very high acceptance rate — reviews may not be catching enough issues. Consider deeper analysis."
    );
  }
  for (const fp of falsePositivePatterns) {
    recommendations.push(fp.recommendation);
  }
  if (recommendations.length === 0) {
    recommendations.push(
      `Review calibration looks healthy (${Math.round(overallHitRate * 100)}% hit rate across ${findings.length} findings)`
    );
  }

  return {
    period: {
      from: since.toISOString().split("T")[0],
      to: new Date().toISOString().split("T")[0],
      totalFindings: findings.length,
    },
    overallHitRate,
    byFindingType,
    bySeverity,
    byArea,
    falsePositivePatterns,
    recommendations,
  };
}

/**
 * Check for decision decay — decisions whose context has
 * drifted significantly since they were made.
 *
 * Decay signals:
 *   - Age (older decisions are more likely to be stale)
 *   - File changes (files mentioned in decision have high churn since)
 *   - New decisions in same area (may supersede)
 *   - Area activity level (high activity = fast context drift)
 */
export async function checkDecisionDecay(
  days = 180
): Promise<DecisionDecayReport> {
  const decisions = await getDecisions(500);
  const since = new Date(Date.now() - days * 86400000);

  // Filter to decisions within the period
  const periodDecisions = decisions.filter(
    (d) => new Date(d.timestamp) >= since
  );

  if (periodDecisions.length === 0) {
    return {
      totalDecisions: 0,
      staleDecisions: [],
      healthyDecisions: 0,
      decayingDecisions: 0,
      recommendation: "No decisions recorded — start documenting architectural choices",
    };
  }

  // Get recent git activity for decay analysis
  let recentFileChanges: Map<string, number>;
  try {
    const { stdout } = await execFileAsync(
      "git",
      [
        "log",
        "--since=30 days ago",
        "--pretty=format:",
        "--name-only",
        "--no-merges",
      ],
      { maxBuffer: 5 * 1024 * 1024 }
    );

    recentFileChanges = new Map();
    for (const line of stdout.split("\n")) {
      if (line.trim()) {
        recentFileChanges.set(
          line.trim(),
          (recentFileChanges.get(line.trim()) || 0) + 1
        );
      }
    }
  } catch {
    recentFileChanges = new Map();
  }

  // Count decisions per area for supersession detection
  const areaDecisionCounts = new Map<string, number>();
  for (const d of periodDecisions) {
    if (d.area) {
      areaDecisionCounts.set(
        d.area,
        (areaDecisionCounts.get(d.area) || 0) + 1
      );
    }
  }

  const staleDecisions: DecisionDecayReport["staleDecisions"] = [];
  const now = Date.now();

  for (const decision of periodDecisions) {
    const ageDays = Math.round(
      (now - new Date(decision.timestamp).getTime()) / 86400000
    );
    const decaySignals: DecisionDecayReport["staleDecisions"][0]["decaySignals"] =
      [];
    let decayScore = 0;

    // Signal 1: Age-based decay
    if (ageDays > 120) {
      decayScore += 30;
      decaySignals.push({
        signal: "Age",
        severity: "high",
        detail: `Decision is ${ageDays} days old`,
      });
    } else if (ageDays > 60) {
      decayScore += 15;
      decaySignals.push({
        signal: "Age",
        severity: "medium",
        detail: `Decision is ${ageDays} days old`,
      });
    } else if (ageDays > 30) {
      decayScore += 5;
      decaySignals.push({
        signal: "Age",
        severity: "low",
        detail: `Decision is ${ageDays} days old`,
      });
    }

    // Signal 2: Referenced files have high recent churn
    if (decision.files.length > 0) {
      let fileChurn = 0;
      for (const file of decision.files) {
        fileChurn += recentFileChanges.get(file) || 0;
      }
      if (fileChurn > 10) {
        decayScore += 25;
        decaySignals.push({
          signal: "File churn",
          severity: "high",
          detail: `Referenced files changed ${fileChurn} times in last 30 days`,
        });
      } else if (fileChurn > 3) {
        decayScore += 10;
        decaySignals.push({
          signal: "File churn",
          severity: "medium",
          detail: `Referenced files changed ${fileChurn} times in last 30 days`,
        });
      }
    }

    // Signal 3: Newer decisions in same area may supersede
    if (decision.area) {
      const newerInArea = periodDecisions.filter(
        (d) =>
          d.area === decision.area &&
          new Date(d.timestamp) > new Date(decision.timestamp) &&
          d.type === decision.type
      );
      if (newerInArea.length >= 2) {
        decayScore += 20;
        decaySignals.push({
          signal: "Potential supersession",
          severity: "medium",
          detail: `${newerInArea.length} newer ${decision.type} decisions in ${decision.area}`,
        });
      }
    }

    // Signal 4: High area activity since decision
    if (decision.area && areaDecisionCounts.has(decision.area)) {
      const areaDecisions = areaDecisionCounts.get(decision.area)!;
      if (areaDecisions > 5 && ageDays > 30) {
        decayScore += 15;
        decaySignals.push({
          signal: "High area activity",
          severity: "medium",
          detail: `${areaDecisions} decisions in ${decision.area} area — context is evolving rapidly`,
        });
      }
    }

    decayScore = Math.min(decayScore, 100);

    // Only report decisions with meaningful decay
    if (decayScore >= 25) {
      let recommendation: string;
      if (decayScore >= 60) {
        recommendation = "Review and confirm or supersede this decision";
      } else if (decayScore >= 40) {
        recommendation =
          "May need updating — check if assumptions still hold";
      } else {
        recommendation = "Monitor — approaching review threshold";
      }

      staleDecisions.push({
        decision,
        ageDays,
        decaySignals,
        decayScore,
        recommendation,
      });
    }
  }

  // Sort by decay score
  staleDecisions.sort((a, b) => b.decayScore - a.decayScore);

  const decayingCount = staleDecisions.length;
  const healthyCount = periodDecisions.length - decayingCount;

  let recommendation: string;
  if (decayingCount > periodDecisions.length * 0.5) {
    recommendation = `${decayingCount}/${periodDecisions.length} decisions showing decay — schedule a decision review session`;
  } else if (decayingCount > 0) {
    recommendation = `${decayingCount} decision(s) need review — top priority: "${staleDecisions[0].decision.decision.substring(0, 60)}..."`;
  } else {
    recommendation = "All decisions are current — no action needed";
  }

  return {
    totalDecisions: periodDecisions.length,
    staleDecisions: staleDecisions.slice(0, 10), // Top 10
    healthyDecisions: healthyCount,
    decayingDecisions: decayingCount,
    recommendation,
  };
}
