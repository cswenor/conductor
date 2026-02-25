/**
 * Runtime guardrails — scope creep detection and context efficiency tracking.
 *
 * These tools run DURING implementation to catch problems early:
 *   - detect_scope_creep: Compare plan files to actual changes in working tree
 *   - get_context_efficiency: Measure AI context waste per issue
 *   - get_workflow_health: Cross-issue workflow analysis with stale detection
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import {
  getOutcomes,
  getEvents,
  getDecisions,
  type Outcome,
  type PMEvent,
} from "./memory.js";

const execFileAsync = promisify(execFile);

// ─── Types ──────────────────────────────────────────────

export interface ScopeCreepReport {
  issueNumber: number | null;
  planFile: string | null;
  plannedFiles: string[];
  actualChanges: string[];
  analysis: {
    inScope: string[]; // Changed files that ARE in the plan
    outOfScope: string[]; // Changed files NOT in the plan
    untouched: string[]; // Plan files not yet changed
    scopeCreepRatio: number; // 0-1, higher = more creep
  };
  severity: "none" | "low" | "medium" | "high";
  alerts: string[];
  recommendation: string;
}

export interface ContextEfficiency {
  issueNumber: number;
  metrics: {
    totalSessions: number;
    totalEvents: number;
    stateChanges: number;
    reworkCycles: number;
    needsInputEvents: number;
    errorEvents: number;
    decisionsRecorded: number;
    timeInActiveDays: number | null;
    timeInReviewDays: number | null;
    timeInReworkDays: number | null;
  };
  efficiency: {
    score: number; // 0-100
    sessionsPerRework: number | null; // Lower is better
    needsInputRatio: number; // Ratio of needs-input to total events
    errorRatio: number; // Ratio of errors to total events
    reworkRatio: number; // Ratio of rework cycles to state changes
    decisionsPerSession: number; // Higher suggests more thoughtful work
  };
  patterns: {
    peakActivity: string | null; // Time of day with most activity
    avgSessionGap: number | null; // Average days between sessions
    longestGap: number | null; // Longest gap between sessions (context loss risk)
  };
  rating: "excellent" | "good" | "needs_improvement" | "poor";
  insights: string[];
  recommendations: string[];
}

export interface WorkflowHealth {
  period: { from: string; to: string; days: number };
  issueHealth: Array<{
    issueNumber: number;
    currentState: string;
    daysInState: number;
    totalAge: number;
    reworkCycles: number;
    stale: boolean;
    staleReason: string | null;
    healthScore: number; // 0-100
  }>;
  bottlenecks: Array<{
    state: string;
    count: number;
    avgDaysInState: number;
    issues: number[];
  }>;
  summary: {
    totalIssues: number;
    staleCount: number;
    avgAge: number;
    bottleneckState: string | null;
    healthScore: number; // 0-100
    recommendation: string;
  };
}

// ─── Scope Creep Detection ──────────────────────────────

/**
 * Extract file paths mentioned in a plan file.
 * Looks for patterns like `path/to/file.ts`, backtick-quoted paths,
 * and bullet-pointed file lists.
 */
function extractPlanFiles(planContent: string): string[] {
  const files = new Set<string>();

  // Match backtick-quoted paths (most common in plans)
  const backtickMatches = planContent.match(/`([^`]+\.[a-zA-Z]{1,10})`/g);
  if (backtickMatches) {
    for (const match of backtickMatches) {
      const path = match.replace(/`/g, "").trim();
      // Filter out command-like strings and very short paths
      if (
        path.includes("/") &&
        !path.startsWith("-") &&
        !path.startsWith("--") &&
        !path.includes(" ")
      ) {
        files.add(path);
      }
    }
  }

  // Match file paths after bullet points (- path/to/file.ts)
  const bulletMatches = planContent.match(
    /^[\s]*[-*]\s+([a-zA-Z0-9_./-]+\.[a-zA-Z]{1,10})/gm
  );
  if (bulletMatches) {
    for (const match of bulletMatches) {
      const path = match.replace(/^[\s]*[-*]\s+/, "").trim();
      if (path.includes("/")) {
        files.add(path);
      }
    }
  }

  // Match paths in "Files:" or "Key Files:" sections
  const filesSectionMatch = planContent.match(
    /(?:Files|Key Files|Affected Files|Changed Files):\s*\n((?:[\s]*[-*].*\n)+)/gi
  );
  if (filesSectionMatch) {
    for (const section of filesSectionMatch) {
      const lines = section.split("\n");
      for (const line of lines) {
        const pathMatch = line.match(/[-*]\s+([a-zA-Z0-9_./-]+\.[a-zA-Z]{1,10})/);
        if (pathMatch) {
          files.add(pathMatch[1]);
        }
      }
    }
  }

  return Array.from(files);
}

/**
 * Detect scope creep by comparing plan files to actual changes.
 */
export async function detectScopeCreep(
  issueNumber?: number
): Promise<ScopeCreepReport> {
  // Find the plan file
  let planFile: string | null = null;
  let planContent: string | null = null;

  if (issueNumber) {
    try {
      // Use find-plan.sh to locate the plan
      const { stdout } = await execFileAsync("bash", [
        "-c",
        `./tools/scripts/find-plan.sh ${issueNumber} --latest 2>/dev/null || true`,
      ]);
      const foundPath = stdout.trim();
      if (foundPath && existsSync(foundPath)) {
        planFile = foundPath;
        planContent = await readFile(foundPath, "utf-8");
      }
    } catch {
      // find-plan.sh may not exist or fail
    }
  }

  // Fallback: search .claude/plans/ for any plan mentioning the issue
  if (!planContent && issueNumber) {
    try {
      const { stdout } = await execFileAsync("bash", [
        "-c",
        `grep -rl "#${issueNumber}" .claude/plans/ 2>/dev/null | head -1 || true`,
      ]);
      const foundPath = stdout.trim();
      if (foundPath && existsSync(foundPath)) {
        planFile = foundPath;
        planContent = await readFile(foundPath, "utf-8");
      }
    } catch {
      // No plans directory or no match
    }
  }

  // Get actual changes from git
  let actualChanges: string[] = [];
  try {
    const { stdout } = await execFileAsync("git", [
      "diff",
      "--name-only",
      "HEAD",
      "--diff-filter=ACMRT",
    ]);
    actualChanges = stdout
      .trim()
      .split("\n")
      .filter((f) => f.trim());
  } catch {
    // Might be on initial commit
  }

  // Also include uncommitted changes
  try {
    const { stdout } = await execFileAsync("git", [
      "diff",
      "--name-only",
      "--diff-filter=ACMRT",
    ]);
    const uncommitted = stdout
      .trim()
      .split("\n")
      .filter((f) => f.trim());
    actualChanges = Array.from(new Set([...actualChanges, ...uncommitted]));
  } catch {
    // ok
  }

  // Also get staged changes
  try {
    const { stdout } = await execFileAsync("git", [
      "diff",
      "--cached",
      "--name-only",
      "--diff-filter=ACMRT",
    ]);
    const staged = stdout
      .trim()
      .split("\n")
      .filter((f) => f.trim());
    actualChanges = Array.from(new Set([...actualChanges, ...staged]));
  } catch {
    // ok
  }

  // Also get changes vs main branch
  try {
    const { stdout: defaultBranch } = await execFileAsync("bash", [
      "-c",
      "git rev-parse --abbrev-ref origin/HEAD 2>/dev/null | sed 's|origin/||' || echo main",
    ]);
    const base = defaultBranch.trim() || "main";
    const { stdout } = await execFileAsync("git", [
      "diff",
      "--name-only",
      `origin/${base}...HEAD`,
      "--diff-filter=ACMRT",
    ]);
    const branchChanges = stdout
      .trim()
      .split("\n")
      .filter((f) => f.trim());
    actualChanges = Array.from(new Set([...actualChanges, ...branchChanges]));
  } catch {
    // May not have remote
  }

  // Filter out noise (lockfiles, generated files, etc.)
  const noisePatterns = [
    /\.lock$/,
    /node_modules\//,
    /\.claude\/plans\//,
    /\.codex-work\//,
    /build\//,
    /dist\//,
    /\.gitkeep$/,
  ];
  actualChanges = actualChanges.filter(
    (f) => !noisePatterns.some((p) => p.test(f))
  );

  // If no plan found, we can only report what changed
  if (!planContent) {
    return {
      issueNumber: issueNumber ?? null,
      planFile: null,
      plannedFiles: [],
      actualChanges,
      analysis: {
        inScope: [],
        outOfScope: actualChanges,
        untouched: [],
        scopeCreepRatio: actualChanges.length > 0 ? 1.0 : 0,
      },
      severity: "low",
      alerts: planFile
        ? []
        : ["No implementation plan found — cannot assess scope creep"],
      recommendation:
        "Create an implementation plan with specific file paths to enable scope tracking",
    };
  }

  // Extract planned files from plan content
  const plannedFiles = extractPlanFiles(planContent);

  // Compare: in-scope, out-of-scope, untouched
  const inScope: string[] = [];
  const outOfScope: string[] = [];
  const untouched: string[] = [];

  for (const changed of actualChanges) {
    const isPlanned = plannedFiles.some(
      (p) => changed.endsWith(p) || changed.includes(p) || p.includes(changed)
    );
    if (isPlanned) {
      inScope.push(changed);
    } else {
      outOfScope.push(changed);
    }
  }

  for (const planned of plannedFiles) {
    const isTouched = actualChanges.some(
      (c) => c.endsWith(planned) || c.includes(planned) || planned.includes(c)
    );
    if (!isTouched) {
      untouched.push(planned);
    }
  }

  // Calculate scope creep ratio
  const totalChanges = inScope.length + outOfScope.length;
  const scopeCreepRatio =
    totalChanges > 0 ? outOfScope.length / totalChanges : 0;

  // Determine severity
  let severity: ScopeCreepReport["severity"] = "none";
  if (scopeCreepRatio > 0.6) severity = "high";
  else if (scopeCreepRatio > 0.3) severity = "medium";
  else if (outOfScope.length > 0) severity = "low";

  // Generate alerts
  const alerts: string[] = [];
  if (outOfScope.length > 3) {
    alerts.push(
      `${outOfScope.length} files changed outside the plan — consider splitting into separate issue`
    );
  }
  if (outOfScope.some((f) => f.includes("infra/") || f.includes("docker"))) {
    alerts.push(
      "Infrastructure files changed outside plan — this is a common scope mixing pattern"
    );
  }
  if (outOfScope.some((f) => f.includes("package.json") || f.includes(".lock"))) {
    alerts.push("Dependency changes detected outside plan — may need separate tracking");
  }
  if (untouched.length > plannedFiles.length * 0.5 && plannedFiles.length > 2) {
    alerts.push(
      `${untouched.length}/${plannedFiles.length} planned files not yet touched — plan may be incomplete`
    );
  }

  // Recommendation
  let recommendation: string;
  if (severity === "high") {
    recommendation =
      "Significant scope creep detected. Stop and run Discovered Work sub-playbook to create separate issues for out-of-scope changes.";
  } else if (severity === "medium") {
    recommendation =
      "Moderate scope creep. Review out-of-scope changes — if they're necessary for the feature, update the plan. If not, extract to separate issue.";
  } else if (severity === "low") {
    recommendation =
      "Minor scope drift. Likely acceptable — verify out-of-scope files are genuinely needed for this feature.";
  } else {
    recommendation = "On track — all changes align with the implementation plan.";
  }

  return {
    issueNumber: issueNumber ?? null,
    planFile,
    plannedFiles,
    actualChanges,
    analysis: {
      inScope,
      outOfScope,
      untouched,
      scopeCreepRatio: Math.round(scopeCreepRatio * 1000) / 1000,
    },
    severity,
    alerts,
    recommendation,
  };
}

// ─── Context Efficiency ─────────────────────────────────

/**
 * Measure AI context efficiency for a specific issue.
 * Analyzes sessions, events, rework cycles, and timing patterns.
 */
export async function getContextEfficiency(
  issueNumber: number
): Promise<ContextEfficiency> {
  const [allEvents, allOutcomes, allDecisions] = await Promise.all([
    getEvents(5000),
    getOutcomes(500),
    getDecisions(500, issueNumber),
  ]);

  const events = allEvents.filter((e) => e.issue_number === issueNumber);

  // Basic counts
  const sessions = events.filter((e) => e.event_type === "session_start");
  const stateChanges = events.filter((e) => e.event_type === "workflow_change");
  const reworkCycles = stateChanges.filter(
    (e) => e.to_value === "Rework"
  ).length;
  const needsInputEvents = events.filter(
    (e) => e.event_type === "needs_input"
  ).length;
  const errorEvents = events.filter((e) => e.event_type === "error").length;

  // Time in state calculations
  const stateTimeline: Array<{ state: string; timestamp: Date }> = stateChanges
    .filter((e) => e.to_value)
    .map((e) => ({ state: e.to_value!, timestamp: new Date(e.timestamp) }))
    .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

  let timeInActive: number | null = null;
  let timeInReview: number | null = null;
  let timeInRework: number | null = null;

  for (let i = 0; i < stateTimeline.length; i++) {
    const current = stateTimeline[i];
    const next = stateTimeline[i + 1];
    const endTime = next ? next.timestamp.getTime() : Date.now();
    const days = (endTime - current.timestamp.getTime()) / 86400000;

    if (current.state === "Active") {
      timeInActive = (timeInActive ?? 0) + days;
    } else if (current.state === "Review") {
      timeInReview = (timeInReview ?? 0) + days;
    } else if (current.state === "Rework") {
      timeInRework = (timeInRework ?? 0) + days;
    }
  }

  // Session timing patterns
  const sessionTimestamps = sessions
    .map((s) => new Date(s.timestamp))
    .sort((a, b) => a.getTime() - b.getTime());

  let peakActivity: string | null = null;
  let avgSessionGap: number | null = null;
  let longestGap: number | null = null;

  if (sessionTimestamps.length > 0) {
    // Peak activity hour
    const hours = sessionTimestamps.map((t) => t.getHours());
    const hourCounts = new Map<number, number>();
    for (const h of hours) {
      hourCounts.set(h, (hourCounts.get(h) || 0) + 1);
    }
    const peakHour = Array.from(hourCounts.entries()).sort(
      (a, b) => b[1] - a[1]
    )[0]?.[0];
    if (peakHour !== undefined) {
      peakActivity = `${peakHour.toString().padStart(2, "0")}:00`;
    }

    // Session gaps
    if (sessionTimestamps.length > 1) {
      const gaps: number[] = [];
      for (let i = 1; i < sessionTimestamps.length; i++) {
        const gap =
          (sessionTimestamps[i].getTime() -
            sessionTimestamps[i - 1].getTime()) /
          86400000;
        gaps.push(gap);
      }
      avgSessionGap =
        Math.round((gaps.reduce((s, g) => s + g, 0) / gaps.length) * 10) / 10;
      longestGap = Math.round(Math.max(...gaps) * 10) / 10;
    }
  }

  // Calculate efficiency metrics
  const totalEvents = events.length;
  const totalSessions = sessions.length;
  const sessionsPerRework =
    reworkCycles > 0 && totalSessions > 0
      ? Math.round((totalSessions / reworkCycles) * 10) / 10
      : null;
  const needsInputRatio =
    totalEvents > 0
      ? Math.round((needsInputEvents / totalEvents) * 1000) / 1000
      : 0;
  const errorRatio =
    totalEvents > 0
      ? Math.round((errorEvents / totalEvents) * 1000) / 1000
      : 0;
  const reworkRatio =
    stateChanges.length > 0
      ? Math.round((reworkCycles / stateChanges.length) * 1000) / 1000
      : 0;
  const decisionsPerSession =
    totalSessions > 0
      ? Math.round((allDecisions.length / totalSessions) * 10) / 10
      : 0;

  // Compute overall efficiency score (0-100)
  let score = 100;

  // Penalize rework cycles (-15 each)
  score -= reworkCycles * 15;

  // Penalize high error ratio (-20 if > 10%)
  if (errorRatio > 0.1) score -= 20;
  else if (errorRatio > 0.05) score -= 10;

  // Penalize high needs-input ratio (-10 if > 30%)
  if (needsInputRatio > 0.3) score -= 10;

  // Penalize long context gaps (-10 if > 3 days)
  if (longestGap && longestGap > 3) score -= 10;
  if (longestGap && longestGap > 7) score -= 10;

  // Penalize no decisions recorded (-5)
  if (allDecisions.length === 0 && totalSessions > 2) score -= 5;

  // Reward efficient completion (bonus for low session count relative to outcome)
  const outcome = allOutcomes.find((o) => o.issue_number === issueNumber);
  if (outcome?.result === "merged" && totalSessions <= 3) score += 5;

  score = Math.max(0, Math.min(100, score));

  // Rating
  const rating: ContextEfficiency["rating"] =
    score >= 80
      ? "excellent"
      : score >= 60
        ? "good"
        : score >= 40
          ? "needs_improvement"
          : "poor";

  // Generate insights
  const insights: string[] = [];
  if (reworkCycles > 0) {
    insights.push(
      `${reworkCycles} rework cycle(s) — each costs ~2 extra sessions of context`
    );
  }
  if (longestGap && longestGap > 3) {
    insights.push(
      `${longestGap}-day gap between sessions — significant context loss likely`
    );
  }
  if (needsInputRatio > 0.3) {
    insights.push(
      `${Math.round(needsInputRatio * 100)}% of events are needs-input — issue may need better spec`
    );
  }
  if (errorRatio > 0.05) {
    insights.push(
      `${Math.round(errorRatio * 100)}% of events are errors — investigate tooling issues`
    );
  }
  if (allDecisions.length === 0 && totalSessions > 2) {
    insights.push(
      "No decisions recorded despite multiple sessions — consider documenting key choices"
    );
  }
  if (timeInRework && timeInActive && timeInRework > timeInActive * 0.5) {
    insights.push(
      `${Math.round((timeInRework ?? 0) * 10) / 10} days in Rework vs ${Math.round((timeInActive ?? 0) * 10) / 10} days Active — review quality may need improvement`
    );
  }
  if (insights.length === 0) {
    insights.push("Efficient workflow — no significant waste detected");
  }

  // Generate recommendations
  const recommendations: string[] = [];
  if (reworkCycles > 1) {
    recommendations.push(
      "Run predict_rework before submitting for review to catch high-risk patterns"
    );
  }
  if (longestGap && longestGap > 5) {
    recommendations.push(
      "Use implementation plans to preserve context across sessions — run find-plan.sh on resume"
    );
  }
  if (needsInputRatio > 0.4) {
    recommendations.push(
      "Improve issue spec — add more detailed acceptance criteria and non-goals"
    );
  }
  if (allDecisions.length === 0) {
    recommendations.push(
      "Record key decisions with record_decision to reduce re-exploration in future sessions"
    );
  }
  if (recommendations.length === 0) {
    recommendations.push("Maintain current practices — workflow is efficient");
  }

  return {
    issueNumber,
    metrics: {
      totalSessions,
      totalEvents,
      stateChanges: stateChanges.length,
      reworkCycles,
      needsInputEvents,
      errorEvents,
      decisionsRecorded: allDecisions.length,
      timeInActiveDays:
        timeInActive !== null
          ? Math.round(timeInActive * 10) / 10
          : null,
      timeInReviewDays:
        timeInReview !== null
          ? Math.round(timeInReview * 10) / 10
          : null,
      timeInReworkDays:
        timeInRework !== null
          ? Math.round(timeInRework * 10) / 10
          : null,
    },
    efficiency: {
      score,
      sessionsPerRework,
      needsInputRatio,
      errorRatio,
      reworkRatio,
      decisionsPerSession,
    },
    patterns: {
      peakActivity,
      avgSessionGap,
      longestGap,
    },
    rating,
    insights,
    recommendations,
  };
}

// ─── Workflow Health ─────────────────────────────────────

/**
 * Cross-issue workflow health analysis.
 * Identifies bottlenecks, stale issues, and systemic patterns.
 */
export async function getWorkflowHealth(
  days = 30
): Promise<WorkflowHealth> {
  const since = new Date(Date.now() - days * 86400000);
  const allEvents = await getEvents(10000);

  const periodEvents = allEvents.filter(
    (e) => new Date(e.timestamp) >= since
  );

  // Group events by issue
  const issueMap = new Map<
    number,
    { events: PMEvent[]; states: Array<{ state: string; timestamp: Date }> }
  >();

  for (const event of periodEvents) {
    if (!event.issue_number) continue;
    if (!issueMap.has(event.issue_number)) {
      issueMap.set(event.issue_number, { events: [], states: [] });
    }
    const entry = issueMap.get(event.issue_number)!;
    entry.events.push(event);
    if (event.event_type === "workflow_change" && event.to_value) {
      entry.states.push({
        state: event.to_value,
        timestamp: new Date(event.timestamp),
      });
    }
  }

  // Analyze each issue
  const now = Date.now();
  const issueHealth: WorkflowHealth["issueHealth"] = [];

  for (const [issueNumber, data] of issueMap) {
    const sortedStates = data.states.sort(
      (a, b) => a.timestamp.getTime() - b.timestamp.getTime()
    );

    if (sortedStates.length === 0) continue;

    const currentState =
      sortedStates[sortedStates.length - 1].state;
    const firstEvent = data.events.reduce(
      (earliest, e) =>
        new Date(e.timestamp) < earliest ? new Date(e.timestamp) : earliest,
      new Date()
    );
    const lastEvent = sortedStates[sortedStates.length - 1].timestamp;

    const daysInState = Math.round(
      ((now - lastEvent.getTime()) / 86400000) * 10
    ) / 10;
    const totalAge = Math.round(
      ((now - firstEvent.getTime()) / 86400000) * 10
    ) / 10;
    const reworkCycles = sortedStates.filter(
      (s) => s.state === "Rework"
    ).length;

    // Stale detection
    let stale = false;
    let staleReason: string | null = null;
    if (currentState === "Active" && daysInState > 7) {
      stale = true;
      staleReason = `In Active for ${daysInState} days without state change`;
    } else if (currentState === "Review" && daysInState > 5) {
      stale = true;
      staleReason = `In Review for ${daysInState} days — needs reviewer attention`;
    } else if (currentState === "Rework" && daysInState > 3) {
      stale = true;
      staleReason = `In Rework for ${daysInState} days — feedback may be blocking`;
    }

    // Health score per issue (0-100)
    let health = 100;
    if (daysInState > 7) health -= 20;
    if (daysInState > 14) health -= 20;
    if (reworkCycles > 0) health -= reworkCycles * 10;
    if (totalAge > 30) health -= 15;
    health = Math.max(0, Math.min(100, health));

    issueHealth.push({
      issueNumber,
      currentState,
      daysInState,
      totalAge,
      reworkCycles,
      stale,
      staleReason,
      healthScore: health,
    });
  }

  // Sort by health score (worst first)
  issueHealth.sort((a, b) => a.healthScore - b.healthScore);

  // Bottleneck detection
  const stateGroups = new Map<string, { count: number; totalDays: number; issues: number[] }>();
  for (const issue of issueHealth) {
    if (issue.currentState === "Done") continue;
    if (!stateGroups.has(issue.currentState)) {
      stateGroups.set(issue.currentState, { count: 0, totalDays: 0, issues: [] });
    }
    const group = stateGroups.get(issue.currentState)!;
    group.count++;
    group.totalDays += issue.daysInState;
    group.issues.push(issue.issueNumber);
  }

  const bottlenecks: WorkflowHealth["bottlenecks"] = Array.from(
    stateGroups.entries()
  )
    .map(([state, data]) => ({
      state,
      count: data.count,
      avgDaysInState: Math.round((data.totalDays / data.count) * 10) / 10,
      issues: data.issues,
    }))
    .filter((b) => b.count > 1 || b.avgDaysInState > 5)
    .sort((a, b) => b.count * b.avgDaysInState - a.count * a.avgDaysInState);

  // Summary
  const nonDoneIssues = issueHealth.filter((i) => i.currentState !== "Done");
  const staleCount = issueHealth.filter((i) => i.stale).length;
  const avgAge =
    nonDoneIssues.length > 0
      ? Math.round(
          (nonDoneIssues.reduce((s, i) => s + i.totalAge, 0) /
            nonDoneIssues.length) *
            10
        ) / 10
      : 0;

  const bottleneckState =
    bottlenecks.length > 0 ? bottlenecks[0].state : null;

  let overallHealth = 100;
  if (staleCount > 0) overallHealth -= staleCount * 10;
  if (bottleneckState) overallHealth -= 15;
  if (avgAge > 14) overallHealth -= 10;
  overallHealth = Math.max(0, Math.min(100, overallHealth));

  let recommendation: string;
  if (staleCount > 2) {
    recommendation = `${staleCount} stale issues — prioritize clearing the backlog before starting new work`;
  } else if (bottleneckState) {
    recommendation = `Bottleneck in ${bottleneckState} (${bottlenecks[0].count} issues, avg ${bottlenecks[0].avgDaysInState}d) — focus on unblocking`;
  } else if (avgAge > 21) {
    recommendation = "Average issue age is high — consider closing abandoned work";
  } else {
    recommendation = "Workflow is healthy — no bottlenecks or stale items detected";
  }

  return {
    period: {
      from: since.toISOString().split("T")[0],
      to: new Date().toISOString().split("T")[0],
      days,
    },
    issueHealth: issueHealth.slice(0, 20), // Top 20
    bottlenecks,
    summary: {
      totalIssues: issueHealth.length,
      staleCount,
      avgAge,
      bottleneckState,
      healthScore: overallHealth,
      recommendation,
    },
  };
}
