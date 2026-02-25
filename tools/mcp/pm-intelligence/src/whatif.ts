/**
 * What-If Simulation — Dependency impact and schedule modeling
 *
 * Tools:
 *   - simulateDependencyChange: "What happens if issue #X slips by N days?"
 *     Models cascading delay through the dependency graph, shows which issues
 *     are impacted, quantifies total schedule slip, and suggests mitigations.
 */

import { analyzeDependencyGraph } from "./graph.js";
import { getIssue, getLocalBoardSummary } from "./db.js";
import { predictCompletion } from "./predict.js";

// ─── simulate_dependency_change ──────────────────────────

interface SlipImpact {
  issueNumber: number;
  title: string;
  workflow: string | null;
  directDelay: number;
  cascadingDelay: number;
  originalEstimate: string | null;
  adjustedEstimate: string | null;
  impactSeverity: "critical" | "high" | "medium" | "low";
}

interface WhatIfResult {
  scenario: {
    issueNumber: number;
    title: string;
    slipDays: number;
    currentWorkflow: string | null;
  };
  directImpact: {
    blockedIssues: number;
    transitivelyBlocked: number;
    criticalPathAffected: boolean;
  };
  cascadeAnalysis: SlipImpact[];
  scheduleImpact: {
    totalDelayDays: number;
    worstCaseDelayDays: number;
    issuesDelayed: number;
    sprintCapacityLost: number;
  };
  mitigations: Array<{
    action: string;
    impact: string;
    effort: "low" | "medium" | "high";
  }>;
  alternativeScenarios: Array<{
    description: string;
    delayReduction: number;
  }>;
  summary: string;
}

export async function simulateDependencyChange(
  issueNumber: number,
  slipDays: number,
  removeIssue = false
): Promise<WhatIfResult> {
  // Gather data in parallel
  const [graph, statusOrNull, board] = await Promise.all([
    analyzeDependencyGraph(),
    getIssue(issueNumber),
    getLocalBoardSummary(),
  ]);

  if (!statusOrNull) {
    throw new Error(`Issue #${issueNumber} not found in local database. Run 'pm sync' first.`);
  }
  const status = statusOrNull;

  // Find the node in the graph
  const node = graph.nodes.find((n) => n.number === issueNumber);
  if (!node) {
    throw new Error(
      `Issue #${issueNumber} not found in dependency graph. It may have no dependency relationships.`
    );
  }

  // Build adjacency map: issue -> issues it blocks
  const blocksMap = new Map<number, number[]>();
  const blockedByMap = new Map<number, number[]>();
  for (const edge of graph.edges) {
    if (!edge.resolved) {
      const existing = blocksMap.get(edge.to) || [];
      existing.push(edge.from);
      blocksMap.set(edge.to, existing);

      const rev = blockedByMap.get(edge.from) || [];
      rev.push(edge.to);
      blockedByMap.set(edge.from, rev);
    }
  }

  // Find all transitively blocked issues using BFS
  const directlyBlocked = blocksMap.get(issueNumber) || [];
  const allBlocked = new Set<number>();
  const queue = [...directlyBlocked];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (allBlocked.has(current)) continue;
    allBlocked.add(current);
    const downstream = blocksMap.get(current) || [];
    queue.push(...downstream);
  }

  // Check if critical path is affected
  const criticalPathNumbers = graph.criticalPath.issues.map((i) => i.number);
  const criticalPathAffected =
    criticalPathNumbers.includes(issueNumber) ||
    [...allBlocked].some((n) => criticalPathNumbers.includes(n));

  // Calculate cascade delays using topological order
  const delayMap = new Map<number, number>();
  delayMap.set(issueNumber, slipDays);

  // Process in waves (BFS from the slipping issue)
  const processed = new Set<number>([issueNumber]);
  let currentWave = [...directlyBlocked];
  let wave = 1;

  while (currentWave.length > 0) {
    const nextWave: number[] = [];
    for (const blocked of currentWave) {
      if (processed.has(blocked)) continue;
      processed.add(blocked);

      // Delay is the max delay of all its blockers (only those in our cascade)
      const blockers = blockedByMap.get(blocked) || [];
      let maxBlockerDelay = 0;
      for (const blocker of blockers) {
        const d = delayMap.get(blocker);
        if (d !== undefined && d > maxBlockerDelay) maxBlockerDelay = d;
      }

      // Cascading delay dampens with distance (90% propagation per hop)
      const cascadingDelay = Math.round(maxBlockerDelay * 0.9 * 10) / 10;
      if (cascadingDelay >= 0.5) {
        delayMap.set(blocked, cascadingDelay);
        const downstream = blocksMap.get(blocked) || [];
        nextWave.push(...downstream);
      }
    }
    currentWave = nextWave;
    wave++;
    if (wave > 20) break; // safety
  }

  // Build impact list
  const cascadeAnalysis: SlipImpact[] = [];
  for (const [num, delay] of delayMap.entries()) {
    if (num === issueNumber) continue; // skip the source issue
    const impactNode = graph.nodes.find((n) => n.number === num);
    if (!impactNode) continue;

    // Try to get completion prediction for context
    let originalEstimate: string | null = null;
    let adjustedEstimate: string | null = null;
    try {
      const prediction = await predictCompletion(num);
      if (prediction.prediction?.expectedDate?.p50) {
        originalEstimate = prediction.prediction.expectedDate.p50;
        const orig = new Date(prediction.prediction.expectedDate.p50);
        orig.setDate(orig.getDate() + Math.ceil(delay));
        adjustedEstimate = orig.toISOString().split("T")[0];
      }
    } catch {
      // Prediction not available for all issues
    }

    const severity: SlipImpact["impactSeverity"] =
      delay >= slipDays * 0.8
        ? "critical"
        : delay >= slipDays * 0.5
          ? "high"
          : delay >= slipDays * 0.25
            ? "medium"
            : "low";

    cascadeAnalysis.push({
      issueNumber: num,
      title: impactNode.title,
      workflow: impactNode.workflow,
      directDelay: directlyBlocked.includes(num) ? delay : 0,
      cascadingDelay: directlyBlocked.includes(num) ? 0 : delay,
      originalEstimate,
      adjustedEstimate,
      impactSeverity: severity,
    });
  }

  // Sort by delay descending
  cascadeAnalysis.sort(
    (a, b) =>
      b.directDelay + b.cascadingDelay - (a.directDelay + a.cascadingDelay)
  );

  // Schedule impact
  const totalDelayDays = Math.max(...[...delayMap.values()], 0);
  const issuesDelayed = cascadeAnalysis.length;
  const avgCycleTime = 5; // rough estimate days per issue
  const sprintCapacityLost = Math.round(
    (issuesDelayed * totalDelayDays) / (avgCycleTime * 10)
  );

  // Generate mitigations
  const mitigations: WhatIfResult["mitigations"] = [];

  if (directlyBlocked.length > 1) {
    mitigations.push({
      action: `Parallelize work on the ${directlyBlocked.length} directly blocked issues by resolving #${issueNumber} incrementally`,
      impact: `Could reduce cascade by ${Math.round(slipDays * 0.3)} days`,
      effort: "medium",
    });
  }

  if (removeIssue) {
    mitigations.push({
      action: `Remove #${issueNumber} from dependency chain entirely`,
      impact: `Eliminates all ${issuesDelayed} cascading delays`,
      effort: "high",
    });
  }

  // Check for alternative paths
  const criticalBottleneck = graph.bottlenecks.find(
    (b) => b.number === issueNumber
  );
  if (criticalBottleneck) {
    mitigations.push({
      action: `Split #${issueNumber} into smaller deliverables to unblock dependents sooner`,
      impact: `Unblock ${criticalBottleneck.transitiveBlocksCount} transitive dependents`,
      effort: "medium",
    });
  }

  if (status.workflow === "Backlog" || status.workflow === "Ready") {
    mitigations.push({
      action: `Prioritize #${issueNumber} to Active immediately to reduce slip`,
      impact: `Starting now reduces slip by days already in queue`,
      effort: "low",
    });
  }

  if (cascadeAnalysis.some((i) => i.workflow === "Active")) {
    mitigations.push({
      action: `Pause actively blocked issues to avoid wasted context-switching`,
      impact: `Saves ${Math.round(issuesDelayed * 0.5)} dev-days of rework`,
      effort: "low",
    });
  }

  // Alternative scenarios
  const alternativeScenarios: WhatIfResult["alternativeScenarios"] = [];
  if (slipDays > 3) {
    alternativeScenarios.push({
      description: `Slip only ${Math.ceil(slipDays / 2)} days instead of ${slipDays}`,
      delayReduction: Math.round(totalDelayDays * 0.5),
    });
  }
  alternativeScenarios.push({
    description: `Remove dependency on #${issueNumber} (find workaround)`,
    delayReduction: totalDelayDays,
  });
  if (directlyBlocked.length > 0) {
    alternativeScenarios.push({
      description: `Deliver partial fix for #${issueNumber} to unblock first dependent`,
      delayReduction: Math.round(totalDelayDays * 0.4),
    });
  }

  const summary = removeIssue
    ? `Removing #${issueNumber} (${status.title}) from the dependency chain would unblock ${issuesDelayed} issues. ` +
      `${criticalPathAffected ? "This issue is on the critical path — removal would shorten the project timeline. " : ""}` +
      `Mitigations available: ${mitigations.length}.`
    : `If #${issueNumber} (${status.title}) slips by ${slipDays} days, it cascades to ${issuesDelayed} downstream issues ` +
      `with up to ${totalDelayDays} days total delay. ` +
      `${criticalPathAffected ? "CRITICAL: This issue is on the critical path. " : ""}` +
      `${directlyBlocked.length} directly blocked, ${allBlocked.size - directlyBlocked.length} transitively affected. ` +
      `${mitigations.length} mitigations available.`;

  return {
    scenario: {
      issueNumber,
      title: status.title,
      slipDays,
      currentWorkflow: status.workflow,
    },
    directImpact: {
      blockedIssues: directlyBlocked.length,
      transitivelyBlocked: allBlocked.size,
      criticalPathAffected,
    },
    cascadeAnalysis,
    scheduleImpact: {
      totalDelayDays,
      worstCaseDelayDays: Math.round(totalDelayDays * 1.5),
      issuesDelayed,
      sprintCapacityLost,
    },
    mitigations,
    alternativeScenarios,
    summary,
  };
}
