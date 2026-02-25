/**
 * Sprint planning assistant — AI-powered sprint plan recommendations.
 *
 * The "tier 1" feature that ties all intelligence modules together:
 * - Dependency graph → what's unblocked and ready to work on
 * - Team capacity → who can work on what, at what velocity
 * - Monte Carlo simulation → probability of completing the proposed plan
 * - Backlog state → what's waiting, what's in progress, what's blocked
 *
 * Tools:
 *   - planSprint: Generate a recommended sprint plan with confidence scoring
 */

import { analyzeDependencyGraph } from "./graph.js";
import { getTeamCapacity, type TeamCapacityResult } from "./capacity.js";
import { simulateSprint, type SprintSimulationResult } from "./simulate.js";
import { getWorkflowHealth, type WorkflowHealth } from "./guardrails.js";
import { getDb } from "./db.js";

// ─── Types ──────────────────────────────────────────────

interface BacklogItem {
  number: number;
  title: string;
  workflow: string;
  priority: string;
  area: string;
  estimate: string;
  labels: string[];
  isBlocked: boolean;
  blockedBy: number[];
  assignees: string[];
}

interface SprintCandidate {
  number: number;
  title: string;
  priority: string;
  area: string;
  estimate: string;
  /** Why this was selected for the sprint */
  reason: string;
  /** Suggested assignee based on capacity/area match */
  suggestedAssignee: string | null;
  /** Issues that should be done before this one */
  prerequisites: number[];
  /** Execution order within the sprint */
  order: number;
}

export interface SprintPlanResult {
  /** Sprint parameters */
  sprint: {
    durationDays: number;
    startDate: string;
    endDate: string;
  };
  /** Current backlog state */
  backlogState: {
    totalOpen: number;
    ready: number;
    active: number;
    blocked: number;
    inReview: number;
    inRework: number;
  };
  /** Recommended sprint items (ordered by priority + dependencies) */
  recommended: SprintCandidate[];
  /** Stretch goals (if capacity allows) */
  stretch: SprintCandidate[];
  /** Items explicitly NOT recommended with reasons */
  deferred: Array<{
    number: number;
    title: string;
    reason: string;
  }>;
  /** Items currently in progress that should continue */
  carryOver: Array<{
    number: number;
    title: string;
    workflow: string;
    reason: string;
  }>;
  /** Monte Carlo confidence for the recommended plan */
  confidence: {
    /** Probability of completing all recommended items */
    allItems: number;
    /** Probability of completing at least the top priority items */
    topPriority: number;
    /** Risk level for the plan */
    riskLevel: "low" | "medium" | "high";
    /** Factors affecting confidence */
    factors: string[];
  };
  /** Team capacity summary */
  capacitySummary: {
    totalContributors: number;
    activeContributors: number;
    estimatedThroughput: number;
    areaCoverage: Array<{ area: string; capacity: number }>;
  };
  /** Dependency warnings */
  dependencyWarnings: string[];
  /** Actionable recommendations */
  recommendations: string[];
}

// ─── Sprint Planning Engine ─────────────────────────────

/**
 * Fetch all backlog items with project board metadata.
 */
async function fetchBacklogItems(): Promise<BacklogItem[]> {
  const db = await getDb();

  // Query all open issues from local SQLite
  const rows = db.prepare(`
    SELECT i.number, i.title, i.workflow, i.priority, i.state,
           GROUP_CONCAT(DISTINCT il.label) as labels,
           GROUP_CONCAT(DISTINCT ia.login) as assignees
    FROM issues i
    LEFT JOIN issue_labels il ON i.number = il.issue_number
    LEFT JOIN issue_assignees ia ON i.number = ia.issue_number
    WHERE i.state = 'open'
    GROUP BY i.number
  `).all() as Array<{
    number: number;
    title: string;
    workflow: string;
    priority: string;
    state: string;
    labels: string | null;
    assignees: string | null;
  }>;

  return rows.map((row) => {
    const labels = row.labels ? row.labels.split(",") : [];
    const areaLabel = labels.find((l) => l.startsWith("area:"));
    return {
      number: row.number,
      title: row.title,
      workflow: row.workflow || "Backlog",
      priority: row.priority || "Normal",
      area: areaLabel ? areaLabel.replace("area:", "") : "None",
      estimate: "Medium", // TODO: add estimate field to local DB if needed
      labels,
      isBlocked: labels.some((l) => l.startsWith("blocked:")),
      blockedBy: [],
      assignees: row.assignees ? row.assignees.split(",") : [],
    };
  });
}

/**
 * Score an issue for sprint inclusion.
 * Higher score = higher priority for sprint.
 */
function scoreItem(item: BacklogItem, dependencyInfo: {
  isBlocked: boolean;
  blocksCount: number;
}): number {
  let score = 0;

  // Priority scoring
  switch (item.priority) {
    case "Critical": score += 100; break;
    case "High": score += 70; break;
    case "Normal": score += 40; break;
    default: score += 20;
  }

  // Workflow state scoring (items already in progress get priority)
  switch (item.workflow) {
    case "Active": score += 50; break;
    case "Rework": score += 45; break;
    case "Review": score += 40; break;
    case "Ready": score += 30; break;
    case "Backlog": score += 10; break;
  }

  // Blocking bonus — items that unblock other work get priority
  score += dependencyInfo.blocksCount * 15;

  // Penalty for blocked items
  if (dependencyInfo.isBlocked) score -= 50;

  // Estimate scoring — smaller items are easier to complete
  switch (item.estimate) {
    case "Small": score += 15; break;
    case "Medium": score += 5; break;
    case "Large": score -= 10; break;
  }

  return score;
}

/**
 * Match items to contributors based on area expertise.
 */
function suggestAssignee(
  item: BacklogItem,
  capacity: TeamCapacityResult
): string | null {
  const itemArea = item.area.toLowerCase();

  // Find contributors who work in this area, sorted by throughput
  const matches = capacity.contributors
    .filter((c) => c.areas.some((a) => a === itemArea))
    .sort((a, b) => b.estimatedThroughput - a.estimatedThroughput);

  return matches.length > 0 ? matches[0].login : null;
}

/**
 * Estimate item count from estimate labels.
 */
function estimateToWeight(estimate: string): number {
  switch (estimate) {
    case "Small": return 0.5;
    case "Medium": return 1;
    case "Large": return 2;
    default: return 1; // Unknown defaults to medium
  }
}

// ─── Public Function ────────────────────────────────────

/**
 * Generate a recommended sprint plan.
 *
 * Combines dependency analysis, team capacity, Monte Carlo simulation,
 * and backlog state into actionable recommendations.
 */
export async function planSprint(
  durationDays = 14
): Promise<SprintPlanResult> {
  // Gather all intelligence in parallel
  const [backlogItems, dependencyGraph, capacity, workflowHealth] = await Promise.all([
    fetchBacklogItems(),
    analyzeDependencyGraph().catch(() => null), // Non-fatal if graph fails
    getTeamCapacity(60).catch(() => null),
    getWorkflowHealth(30).catch(() => null),
  ]);

  const now = new Date();
  const endDate = new Date(now.getTime() + durationDays * 86400000);

  // Build dependency lookup from graph
  const depLookup = new Map<number, { isBlocked: boolean; blocksCount: number }>();
  if (dependencyGraph) {
    for (const node of dependencyGraph.nodes) {
      depLookup.set(node.number, {
        isBlocked: node.inDegree > 0,
        blocksCount: node.outDegree,
      });
    }
    // Check for unresolved blockers more precisely
    for (const edge of dependencyGraph.edges) {
      if (!edge.resolved) {
        const existing = depLookup.get(edge.to) || { isBlocked: false, blocksCount: 0 };
        existing.isBlocked = true;
        depLookup.set(edge.to, existing);
      }
    }
  }

  // Categorize backlog items
  const openItems = backlogItems.filter((i) => i.workflow !== "Done");
  const activeItems = openItems.filter((i) => i.workflow === "Active");
  const reviewItems = openItems.filter((i) => i.workflow === "Review");
  const reworkItems = openItems.filter((i) => i.workflow === "Rework");
  const readyItems = openItems.filter((i) => i.workflow === "Ready");
  const backlogOnlyItems = openItems.filter((i) => i.workflow === "Backlog");
  const blockedItems = openItems.filter((i) =>
    i.isBlocked || (depLookup.get(i.number)?.isBlocked ?? false)
  );

  // Carry-over: items already in progress
  const carryOver = [
    ...activeItems.map((i) => ({
      number: i.number,
      title: i.title,
      workflow: i.workflow,
      reason: "Currently in Active — continue work",
    })),
    ...reworkItems.map((i) => ({
      number: i.number,
      title: i.title,
      workflow: i.workflow,
      reason: "In Rework — address feedback first",
    })),
    ...reviewItems.map((i) => ({
      number: i.number,
      title: i.title,
      workflow: i.workflow,
      reason: "In Review — pending feedback",
    })),
  ];

  // Score and rank candidates (Ready + Backlog items that aren't blocked)
  const candidates = [...readyItems, ...backlogOnlyItems]
    .filter((i) => !i.isBlocked && !(depLookup.get(i.number)?.isBlocked ?? false))
    .map((i) => ({
      item: i,
      score: scoreItem(i, depLookup.get(i.number) || { isBlocked: false, blocksCount: 0 }),
      weight: estimateToWeight(i.estimate),
    }))
    .sort((a, b) => b.score - a.score);

  // Estimate available capacity
  const estimatedThroughput = capacity?.teamMetrics.teamThroughputPerSprint ?? 5;
  // Subtract carry-over items (they consume capacity)
  const carryOverWeight = carryOver.reduce(
    (s, i) => s + estimateToWeight(backlogItems.find((b) => b.number === i.number)?.estimate ?? "Medium"),
    0
  );
  const availableCapacity = Math.max(1, estimatedThroughput - carryOverWeight);

  // Fill sprint plan up to capacity
  const recommended: SprintCandidate[] = [];
  const stretch: SprintCandidate[] = [];
  let usedCapacity = 0;
  let order = carryOver.length + 1;

  for (const { item, weight } of candidates) {
    const depInfo = depLookup.get(item.number) || { isBlocked: false, blocksCount: 0 };
    const assignee = capacity ? suggestAssignee(item, capacity) : null;

    // Find prerequisites (blockers that are in this sprint or carry-over)
    const prereqs = dependencyGraph?.edges
      .filter((e) => e.to === item.number && !e.resolved)
      .map((e) => e.from)
      .filter((n) => recommended.some((r) => r.number === n) || carryOver.some((c) => c.number === n))
      || [];

    const candidate: SprintCandidate = {
      number: item.number,
      title: item.title,
      priority: item.priority,
      area: item.area,
      estimate: item.estimate,
      reason: buildSelectionReason(item, depInfo),
      suggestedAssignee: assignee,
      prerequisites: prereqs,
      order: order++,
    };

    if (usedCapacity + weight <= availableCapacity) {
      recommended.push(candidate);
      usedCapacity += weight;
    } else if (usedCapacity + weight <= availableCapacity * 1.3) {
      // Up to 30% stretch
      stretch.push(candidate);
      usedCapacity += weight;
    }
  }

  // Deferred items with reasons
  const recommendedNums = new Set([
    ...recommended.map((r) => r.number),
    ...stretch.map((s) => s.number),
    ...carryOver.map((c) => c.number),
  ]);

  const deferred = openItems
    .filter((i) => !recommendedNums.has(i.number) && i.workflow !== "Done")
    .slice(0, 10)
    .map((i) => ({
      number: i.number,
      title: i.title,
      reason: buildDeferralReason(i, depLookup.get(i.number)),
    }));

  // Run Monte Carlo for confidence scoring
  let allItemsProb = 0;
  let topPriorityProb = 0;
  const totalNewItems = recommended.length;
  const topPriorityCount = recommended.filter(
    (r) => r.priority === "Critical" || r.priority === "High"
  ).length;

  try {
    const sim = await simulateSprint({
      itemCount: totalNewItems + carryOver.length,
      sprintDays: durationDays,
      trials: 5000,
    });
    allItemsProb = sim.targetAnalysis.probabilityOfCompletion;

    if (topPriorityCount > 0 && topPriorityCount < totalNewItems) {
      const topSim = await simulateSprint({
        itemCount: topPriorityCount + carryOver.length,
        sprintDays: durationDays,
        trials: 5000,
      });
      topPriorityProb = topSim.targetAnalysis.probabilityOfCompletion;
    } else {
      topPriorityProb = allItemsProb;
    }
  } catch {
    // Simulation failed — estimate from capacity
    allItemsProb = totalNewItems <= estimatedThroughput ? 0.7 : 0.3;
    topPriorityProb = topPriorityCount <= estimatedThroughput ? 0.85 : 0.5;
  }

  // Build confidence factors
  const confidenceFactors: string[] = [];
  if (allItemsProb >= 0.8) {
    confidenceFactors.push("Historical velocity supports this plan size");
  } else if (allItemsProb < 0.5) {
    confidenceFactors.push("Plan may be overcommitted based on historical velocity");
  }
  if (carryOver.length > 0) {
    confidenceFactors.push(`${carryOver.length} carry-over items consume capacity`);
  }
  if (dependencyGraph && dependencyGraph.criticalPath.length > 2) {
    confidenceFactors.push(
      `Dependency chain of ${dependencyGraph.criticalPath.length} issues may cause cascading delays`
    );
  }
  if (capacity && capacity.teamMetrics.activeContributors < capacity.teamMetrics.totalContributors) {
    confidenceFactors.push(
      `Only ${capacity.teamMetrics.activeContributors}/${capacity.teamMetrics.totalContributors} contributors active recently`
    );
  }
  if (blockedItems.length > 0) {
    confidenceFactors.push(
      `${blockedItems.length} items blocked — resolve blockers to increase available work`
    );
  }

  // Dependency warnings
  const dependencyWarnings: string[] = [];
  if (dependencyGraph) {
    if (dependencyGraph.cycles.length > 0) {
      dependencyWarnings.push(
        `Circular dependencies detected: ${dependencyGraph.cycles.map((c) => c.issues.map((n) => `#${n}`).join("→")).join("; ")}`
      );
    }
    if (dependencyGraph.orphanedBlocked.length > 0) {
      dependencyWarnings.push(
        `${dependencyGraph.orphanedBlocked.length} issues have resolved blockers but are still marked blocked — unblock them`
      );
    }
    for (const bottleneck of dependencyGraph.bottlenecks.slice(0, 3)) {
      if (bottleneck.severity === "critical") {
        dependencyWarnings.push(
          `#${bottleneck.number} blocks ${bottleneck.transitiveBlocksCount} issues — prioritize this`
        );
      }
    }
  }

  // Generate recommendations
  const recommendations: string[] = [];
  if (recommended.length === 0 && readyItems.length === 0) {
    recommendations.push("No items in Ready state — run backlog grooming to move items to Ready");
  }
  if (carryOver.length > estimatedThroughput * 0.5) {
    recommendations.push("High carry-over — focus on completing in-progress work before starting new items");
  }
  if (blockedItems.length > openItems.length * 0.3) {
    recommendations.push("30%+ of backlog is blocked — resolve dependency bottlenecks first");
  }
  if (dependencyGraph && dependencyGraph.bottlenecks.length > 0) {
    const topBottleneck = dependencyGraph.bottlenecks[0];
    recommendations.push(
      `Highest-impact unblock: #${topBottleneck.number} (${topBottleneck.title}) — unblocks ${topBottleneck.transitiveBlocksCount} issues`
    );
  }
  if (capacity && capacity.areaCoverage.some((a) => a.busFactor === 1)) {
    const singleAreas = capacity.areaCoverage.filter((a) => a.busFactor === 1).map((a) => a.area);
    recommendations.push(`Bus factor 1 in ${singleAreas.join(", ")} — avoid overloading these areas`);
  }
  if (allItemsProb < 0.5) {
    recommendations.push(
      `Plan confidence is low (${Math.round(allItemsProb * 100)}%) — consider reducing scope to ${Math.max(1, recommended.length - 2)} items`
    );
  }
  if (recommendations.length === 0) {
    recommendations.push("Sprint plan looks healthy — execute in order and monitor progress");
  }

  return {
    sprint: {
      durationDays,
      startDate: now.toISOString().split("T")[0],
      endDate: endDate.toISOString().split("T")[0],
    },
    backlogState: {
      totalOpen: openItems.length,
      ready: readyItems.length,
      active: activeItems.length,
      blocked: blockedItems.length,
      inReview: reviewItems.length,
      inRework: reworkItems.length,
    },
    recommended,
    stretch,
    deferred,
    carryOver,
    confidence: {
      allItems: Math.round(allItemsProb * 1000) / 1000,
      topPriority: Math.round(topPriorityProb * 1000) / 1000,
      riskLevel:
        allItemsProb >= 0.7 ? "low" : allItemsProb >= 0.4 ? "medium" : "high",
      factors: confidenceFactors,
    },
    capacitySummary: {
      totalContributors: capacity?.teamMetrics.totalContributors ?? 0,
      activeContributors: capacity?.teamMetrics.activeContributors ?? 0,
      estimatedThroughput: Math.round(estimatedThroughput * 10) / 10,
      areaCoverage: capacity?.areaCoverage.map((a) => ({
        area: a.area,
        capacity: a.throughput,
      })) ?? [],
    },
    dependencyWarnings,
    recommendations,
  };
}

// ─── Helpers ────────────────────────────────────────────

function buildSelectionReason(
  item: BacklogItem,
  depInfo: { isBlocked: boolean; blocksCount: number }
): string {
  const reasons: string[] = [];

  if (item.priority === "Critical") reasons.push("Critical priority");
  else if (item.priority === "High") reasons.push("High priority");

  if (depInfo.blocksCount > 0) {
    reasons.push(`Unblocks ${depInfo.blocksCount} other issue(s)`);
  }

  if (item.workflow === "Ready") reasons.push("Spec-ready");
  if (item.estimate === "Small") reasons.push("Quick win");

  return reasons.length > 0 ? reasons.join("; ") : "Normal priority, available for work";
}

function buildDeferralReason(
  item: BacklogItem,
  depInfo?: { isBlocked: boolean; blocksCount: number }
): string {
  if (item.isBlocked || depInfo?.isBlocked) return "Blocked by unresolved dependencies";
  if (item.workflow === "Backlog") return "Not yet groomed to Ready";
  if (item.priority === "Normal" || item.priority === "None") return "Lower priority — deferred to next sprint";
  return "Capacity limit reached";
}
