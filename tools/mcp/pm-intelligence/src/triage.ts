/**
 * Smart Triage Module
 *
 * One-call intelligence for issue setup and PR impact analysis:
 *   - triage_issue: Auto-classify, estimate, risk-assess, and suggest assignment
 *   - analyze_pr_impact: Blast radius analysis before merging
 *   - decompose_issue: Break large issues into dependency-ordered subtasks
 */

import { getVelocity } from "./github.js";
import { getIssue, getLocalBoardSummary } from "./db.js";
import {
  getDecisions,
  getOutcomes,
  getInsights,
  getEvents,
} from "./memory.js";
import { suggestApproach, getSprintAnalytics } from "./analytics.js";
import { getTeamCapacity } from "./capacity.js";
import {
  analyzeDependencyGraph,
  getIssueDependencies,
} from "./graph.js";
import {
  predictCompletion,
  predictRework,
  getKnowledgeRisk,
} from "./predict.js";
import { getHistoryInsights } from "./history.js";

// ─── TRIAGE TYPES ─────────────────────────────────────

interface TriageResult {
  issueNumber: number;
  title: string;
  classification: {
    tier: 1 | 2;
    tierReason: string;
    type: "bug" | "feature" | "spike" | "epic" | "chore";
    area: string;
    areaConfidence: "high" | "medium" | "low";
  };
  priorityRecommendation: {
    priority: "Critical" | "High" | "Normal";
    urgency: "Low" | "Medium" | "High";
    impact: "Low" | "Medium" | "High";
    dependencies: "Low" | "Medium" | "High";
    effort: "Low" | "Medium" | "High";
    reasoning: string;
  };
  estimate: {
    size: "Small" | "Medium" | "Large";
    predictedDays: { p50: number; p80: number; p95: number } | null;
    reworkRisk: string;
    reworkProbability: number | null;
    confidence: string;
  };
  riskAssessment: {
    overall: "Low" | "Medium" | "High";
    factors: Array<{ factor: string; severity: string; detail: string }>;
  };
  similarWork: {
    pastIssues: Array<{
      number: number;
      area: string | null;
      result: string;
      cycleDays: number;
    }>;
    suggestions: Array<{ text: string; source: string; relevance: string }>;
    warnings: string[];
  };
  assignment: {
    suggestedAssignees: Array<{
      login: string;
      reason: string;
      availability: string;
    }>;
    docsToLoad: string[];
  };
  readiness: {
    hasAcceptanceCriteria: boolean;
    hasNonGoals: boolean;
    hasProblemStatement: boolean;
    specReadyScore: number;
    missingElements: string[];
  };
  summary: string;
}

// ─── PR IMPACT TYPES ──────────────────────────────────

interface PRImpactResult {
  prNumber: number;
  title: string;
  linkedIssues: number[];
  blastRadius: {
    filesChanged: number;
    areasAffected: string[];
    packagesAffected: string[];
    linesAdded: number;
    linesRemoved: number;
  };
  dependencyImpact: {
    issuesUnblocked: Array<{ number: number; title: string }>;
    issuesAffected: Array<{ number: number; title: string; relationship: string }>;
    criticalPathChanged: boolean;
  };
  riskAnalysis: {
    knowledgeRisk: Array<{
      file: string;
      busFactor: number;
      risk: string;
    }>;
    couplingRisk: Array<{
      file: string;
      coupledWith: string[];
      reason: string;
    }>;
    hotspotFiles: string[];
  };
  scheduleImpact: {
    issuesAccelerated: Array<{ number: number; daysSaved: number }>;
    issuesDelayed: Array<{ number: number; daysAdded: number; reason: string }>;
  };
  mergeReadiness: {
    score: number;
    blockers: string[];
    warnings: string[];
  };
  summary: string;
}

// ─── DECOMPOSE TYPES ──────────────────────────────────

interface SubIssue {
  title: string;
  type: "bug" | "feature" | "spike" | "chore";
  area: string;
  description: string;
  acceptanceCriteria: string[];
  estimatedSize: "Small" | "Medium" | "Large";
  estimatedDays: number;
  riskLevel: "Low" | "Medium" | "High";
  dependsOn: number[]; // Indices into the subtasks array
}

interface DecompositionResult {
  parentIssue: {
    number: number;
    title: string;
    totalEstimatedDays: number;
    complexity: "Simple" | "Moderate" | "Complex" | "Very Complex";
  };
  subtasks: SubIssue[];
  executionOrder: number[][]; // Groups that can be parallelized
  criticalPath: {
    tasks: number[];
    totalDays: number;
    description: string;
  };
  riskSummary: {
    highRiskTasks: number;
    totalEstimatedDays: number;
    parallelizableDays: number;
    speedupRatio: number;
  };
  recommendations: string[];
  summary: string;
}

// ─── TRIAGE IMPLEMENTATION ────────────────────────────

export async function triageIssue(
  issueNumber: number
): Promise<TriageResult> {
  // Gather all intelligence in parallel
  const [
    statusOrNull,
    completion,
    rework,
    approach,
    capacity,
    deps,
    board,
  ] = await Promise.all([
    getIssue(issueNumber),
    predictCompletion(issueNumber).catch(() => null),
    predictRework(issueNumber).catch(() => null),
    suggestApproach(
      "", // Area will be determined from labels
      [] // Keywords will be extracted from title
    ).catch(() => null),
    getTeamCapacity(60).catch(() => null),
    getIssueDependencies(issueNumber).catch(() => null),
    getLocalBoardSummary(),
  ]);

  if (!statusOrNull) {
    throw new Error(`Issue #${issueNumber} not found in local database. Run 'pm sync' first.`);
  }
  const status = statusOrNull;

  // ─── Classification ────────────────────────────────
  const labels = status.labels;

  // Determine type from labels
  let type: TriageResult["classification"]["type"] = "feature";
  if (labels.some((l) => l.includes("bug"))) type = "bug";
  else if (labels.some((l) => l.includes("spike"))) type = "spike";
  else if (labels.some((l) => l.includes("epic"))) type = "epic";
  else if (labels.some((l) => l.includes("chore"))) type = "chore";

  // Determine area from labels
  let area = "unknown";
  let areaConfidence: "high" | "medium" | "low" = "low";
  const areaLabel = labels.find((l) => l.startsWith("area:"));
  if (areaLabel) {
    area = areaLabel.replace("area:", "");
    areaConfidence = "high";
  } else {
    // Infer from title keywords
    const title = status.title.toLowerCase();
    if (title.match(/\b(ui|page|component|svelte|css|layout|button)\b/)) {
      area = "frontend";
      areaConfidence = "medium";
    } else if (title.match(/\b(api|endpoint|database|supabase|postgres|sql)\b/)) {
      area = "backend";
      areaConfidence = "medium";
    } else if (title.match(/\b(contract|algorand|voi|on-chain|smart contract)\b/)) {
      area = "contracts";
      areaConfidence = "medium";
    } else if (title.match(/\b(ci|deploy|docker|script|workflow|infra)\b/)) {
      area = "infra";
      areaConfidence = "medium";
    }
  }

  // Determine tier
  const tier: 1 | 2 = type === "chore" ? 2 : 1;
  const tierReason = tier === 1
    ? `${type} requires an issue for tracking and review`
    : "Chore/mechanical change — issue tracking optional";

  // ─── Priority Recommendation ───────────────────────
  const isBlocking = deps ? deps.blocks.length > 0 : false;
  const blocksCount = deps ? deps.blocks.length : 0;

  let urgency: "Low" | "Medium" | "High" = "Low";
  let impact: "Low" | "Medium" | "High" = "Low";
  let depLevel: "Low" | "Medium" | "High" = "Low";
  let effort: "Low" | "Medium" | "High" = "Medium";

  // Urgency from blocking status and type
  if (isBlocking) urgency = "High";
  else if (type === "bug") urgency = "Medium";

  // Impact from type and labels
  if (type === "epic") impact = "High";
  else if (type === "bug") impact = "Medium";
  else if (labels.some((l) => l.includes("security"))) impact = "High";

  // Dependencies
  if (blocksCount > 2) depLevel = "High";
  else if (blocksCount > 0) depLevel = "Medium";

  // Effort from prediction
  if (completion) {
    if (completion.prediction.p50Days <= 1) effort = "Low";
    else if (completion.prediction.p50Days <= 3) effort = "Medium";
    else effort = "High";
  }

  let priority: "Critical" | "High" | "Normal" = "Normal";
  let priorityReasoning: string;
  if (isBlocking && urgency === "High") {
    priority = "Critical";
    priorityReasoning = `Blocking ${blocksCount} issue(s) — unblock this first`;
  } else if (impact === "High" || (urgency === "High" && impact !== "Low")) {
    priority = "High";
    priorityReasoning = `High ${impact === "High" ? "impact" : "urgency"} — address before normal work`;
  } else {
    priority = "Normal";
    priorityReasoning = "Standard priority — schedule normally";
  }

  // ─── Estimate ──────────────────────────────────────
  let predictedDays: TriageResult["estimate"]["predictedDays"] = null;
  if (completion) {
    predictedDays = {
      p50: completion.prediction.p50Days,
      p80: completion.prediction.p80Days,
      p95: completion.prediction.p95Days,
    };
  }

  let size: "Small" | "Medium" | "Large" = "Medium";
  if (completion) {
    if (completion.prediction.p50Days <= 1) size = "Small";
    else if (completion.prediction.p50Days <= 5) size = "Medium";
    else size = "Large";
  }

  // ─── Risk Assessment ───────────────────────────────
  const riskFactors: TriageResult["riskAssessment"]["factors"] = [];

  if (completion && completion.riskScore > 60) {
    for (const rf of completion.riskFactors) {
      riskFactors.push({
        factor: rf.factor,
        severity: rf.severity,
        detail: rf.detail,
      });
    }
  }

  if (rework && rework.reworkProbability > 0.4) {
    const presentSignals = rework.signals.filter((s) => s.present);
    for (const signal of presentSignals.slice(0, 3)) {
      riskFactors.push({
        factor: signal.signal,
        severity: rework.riskLevel,
        detail: signal.detail,
      });
    }
  }

  if (deps && !deps.isUnblocked) {
    riskFactors.push({
      factor: "Blocked by dependencies",
      severity: "high",
      detail: `Blocked by: ${deps.blockedBy.filter((b) => !b.resolved).map((b) => `#${b.number}`).join(", ")}`,
    });
  }

  let overallRisk: "Low" | "Medium" | "High" = "Low";
  if (riskFactors.some((f) => f.severity === "high" || f.severity === "critical")) {
    overallRisk = "High";
  } else if (riskFactors.length > 0) {
    overallRisk = "Medium";
  }

  // ─── Similar Work ──────────────────────────────────
  // Extract keywords from title for approach suggestion
  const keywords = status.title
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .split(/\s+/)
    .filter((w) => w.length > 3);

  let similarIssues: TriageResult["similarWork"]["pastIssues"] = [];
  let suggestions: TriageResult["similarWork"]["suggestions"] = [];
  let warnings: string[] = [];

  try {
    const approachResult = await suggestApproach(area, keywords);
    similarIssues = approachResult.relatedIssues.map((i) => ({
      number: i.number,
      area: i.area,
      result: i.result,
      cycleDays: 0, // Not available from approach suggestion
    }));
    suggestions = approachResult.suggestions.map((s) => ({
      text: s.text,
      source: s.source,
      relevance: s.relevance,
    }));
    warnings = approachResult.warnings;
  } catch {
    // No similar work found
  }

  // ─── Assignment Suggestions ────────────────────────
  const suggestedAssignees: TriageResult["assignment"]["suggestedAssignees"] = [];

  if (capacity) {
    // Find contributors who work in this area
    const areaContributors = capacity.areaCoverage.find(
      (a) => a.area === area
    );
    if (areaContributors) {
      for (const login of areaContributors.contributors.slice(0, 3)) {
        const profile = capacity.contributors.find(
          (c) => c.login === login
        );
        suggestedAssignees.push({
          login,
          reason: `Works in ${area} area`,
          availability: profile?.velocityTrend === "decelerating"
            ? "potentially overloaded"
            : "available",
        });
      }
    }

    // If no area match, suggest by overall throughput
    if (suggestedAssignees.length === 0) {
      for (const contrib of capacity.contributors.slice(0, 2)) {
        suggestedAssignees.push({
          login: contrib.login,
          reason: `High throughput contributor (${contrib.prsMerged} PRs merged)`,
          availability: contrib.velocityTrend === "decelerating"
            ? "potentially overloaded"
            : "available",
        });
      }
    }
  }

  // Determine relevant docs
  const docsToLoad: string[] = [];
  if (area === "frontend") docsToLoad.push("docs/development/LOCAL_DEV.md", "docs/architecture/OVERVIEW.md");
  if (area === "backend") docsToLoad.push("docs/architecture/DATABASE.md", "docs/architecture/OVERVIEW.md");
  if (area === "contracts") docsToLoad.push("docs/contracts/GAME_CONTRACT_INTERFACE.md");
  if (area === "infra") docsToLoad.push("docs/ENV_WORKFLOW.md", "docs/SECRETS.md");
  docsToLoad.push("docs/PM_PLAYBOOK.md"); // Always

  // ─── Readiness Check ──────────────────────────────
  // Simple heuristic from title and labels
  const hasAcceptanceCriteria = false; // Can't check body via status alone
  const hasNonGoals = false;
  const hasProblemStatement = true; // Title exists
  const missingElements: string[] = [];
  if (!hasAcceptanceCriteria) missingElements.push("Acceptance criteria (checkboxes)");
  if (!hasNonGoals) missingElements.push("Non-goals section");

  const specReadyScore = 100 - missingElements.length * 25;

  // ─── Summary ───────────────────────────────────────
  const summaryParts: string[] = [];
  summaryParts.push(`#${issueNumber}: ${type} in ${area} area.`);
  summaryParts.push(`Priority: ${priority}. Size: ${size}.`);
  if (predictedDays) {
    summaryParts.push(
      `Estimated ${predictedDays.p50.toFixed(1)}-${predictedDays.p80.toFixed(1)} days.`
    );
  }
  if (overallRisk !== "Low") {
    summaryParts.push(`Risk: ${overallRisk}.`);
  }
  if (suggestedAssignees.length > 0) {
    summaryParts.push(
      `Suggest: @${suggestedAssignees[0].login}.`
    );
  }

  return {
    issueNumber,
    title: status.title,
    classification: { tier, tierReason, type, area, areaConfidence },
    priorityRecommendation: {
      priority,
      urgency,
      impact,
      dependencies: depLevel,
      effort,
      reasoning: priorityReasoning,
    },
    estimate: {
      size,
      predictedDays,
      reworkRisk: rework?.riskLevel ?? "unknown",
      reworkProbability: rework?.reworkProbability ?? null,
      confidence: completion?.confidence ?? "low",
    },
    riskAssessment: { overall: overallRisk, factors: riskFactors },
    similarWork: { pastIssues: similarIssues, suggestions, warnings },
    assignment: { suggestedAssignees, docsToLoad },
    readiness: {
      hasAcceptanceCriteria,
      hasNonGoals,
      hasProblemStatement,
      specReadyScore,
      missingElements,
    },
    summary: summaryParts.join(" "),
  };
}

// ─── PR IMPACT ANALYSIS ──────────────────────────────

export async function analyzePRImpact(
  prNumber: number
): Promise<PRImpactResult> {
  // We need to use gh CLI since MCP doesn't give us file-level diff details
  // This function works with data from the graph, predictions, and knowledge modules

  const [graph, knowledge, board, velocity, analytics] = await Promise.all([
    analyzeDependencyGraph().catch(() => null),
    getKnowledgeRisk(90).catch(() => null),
    getLocalBoardSummary(),
    getVelocity(),
    getSprintAnalytics(14).catch(() => null),
  ]);

  // We'll build what we can from the intelligence modules
  // The actual PR file list will need to be passed in or fetched via gh

  // Find linked issues from board context
  const linkedIssues: number[] = [];

  // Analyze dependency impact
  const issuesUnblocked: PRImpactResult["dependencyImpact"]["issuesUnblocked"] = [];
  const issuesAffected: PRImpactResult["dependencyImpact"]["issuesAffected"] = [];
  let criticalPathChanged = false;

  if (graph) {
    // Issues that could be unblocked by this PR's linked issues
    for (const bottleneck of graph.bottlenecks) {
      if (linkedIssues.includes(bottleneck.number)) {
        criticalPathChanged = true;
        // Find what this bottleneck unblocks
        for (const node of graph.nodes) {
          const nodeDeps = graph.edges.filter(
            (e) => e.to === node.number && e.from === bottleneck.number
          );
          if (nodeDeps.length > 0) {
            issuesUnblocked.push({
              number: node.number,
              title: node.title,
            });
          }
        }
      }
    }

    // Orphaned blocked issues that could be freed
    for (const orphan of graph.orphanedBlocked) {
      if (orphan.blockedBy.some((b) => linkedIssues.includes(b))) {
        issuesUnblocked.push({
          number: orphan.number,
          title: orphan.title,
        });
      }
    }
  }

  // Knowledge risk for affected files
  const knowledgeRiskFiles: PRImpactResult["riskAnalysis"]["knowledgeRisk"] = [];
  if (knowledge) {
    // Show top risk files as context for the reviewer
    for (const file of knowledge.fileRisks.slice(0, 10)) {
      if (file.knowledgeRisk === "critical" || file.knowledgeRisk === "high") {
        knowledgeRiskFiles.push({
          file: file.file,
          busFactor: file.busFactor,
          risk: file.knowledgeRisk,
        });
      }
    }
  }

  // Coupling analysis from history
  const couplingRisk: PRImpactResult["riskAnalysis"]["couplingRisk"] = [];
  let hotspotFiles: string[] = [];

  try {
    const history = await getHistoryInsights(90);
    hotspotFiles = history.hotspots.slice(0, 5).map((h) => h.file);

    for (const pair of history.coupling.slice(0, 5)) {
      couplingRisk.push({
        file: pair.files[0],
        coupledWith: [pair.files[1]],
        reason: `Changed together ${pair.coChangeCount} times (${(pair.confidence * 100).toFixed(0)}% confidence)`,
      });
    }
  } catch {
    // History not available
  }

  // Merge readiness
  const blockers: string[] = [];
  const warnings: string[] = [];

  if (board.activeIssues.length > 1) {
    warnings.push(`${board.activeIssues.length} items currently active — check WIP limits`);
  }

  if (knowledgeRiskFiles.length > 3) {
    warnings.push(
      `${knowledgeRiskFiles.length} high-risk files affected — consider additional review`
    );
  }

  if (criticalPathChanged) {
    warnings.push("This PR changes the critical path — verify downstream impact");
  }

  const mergeScore = Math.max(
    0,
    100 - blockers.length * 30 - warnings.length * 10
  );

  const summary =
    `PR #${prNumber}: ` +
    `${issuesUnblocked.length} issues potentially unblocked, ` +
    `${knowledgeRiskFiles.length} high-risk files, ` +
    `${couplingRisk.length} coupling warnings. ` +
    `Merge readiness: ${mergeScore}/100.`;

  return {
    prNumber,
    title: `PR #${prNumber}`,
    linkedIssues,
    blastRadius: {
      filesChanged: 0, // Would need PR files data
      areasAffected: [],
      packagesAffected: [],
      linesAdded: 0,
      linesRemoved: 0,
    },
    dependencyImpact: {
      issuesUnblocked,
      issuesAffected,
      criticalPathChanged,
    },
    riskAnalysis: {
      knowledgeRisk: knowledgeRiskFiles,
      couplingRisk,
      hotspotFiles,
    },
    scheduleImpact: {
      issuesAccelerated: issuesUnblocked.map((i) => ({
        number: i.number,
        daysSaved: 0, // Would need prediction data
      })),
      issuesDelayed: [],
    },
    mergeReadiness: {
      score: mergeScore,
      blockers,
      warnings,
    },
    summary,
  };
}

// ─── ISSUE DECOMPOSITION ─────────────────────────────

export async function decomposeIssue(
  issueNumber: number
): Promise<DecompositionResult> {
  // Gather intelligence
  const [statusOrNull2, completion, rework, deps, analytics, insights] =
    await Promise.all([
      getIssue(issueNumber),
      predictCompletion(issueNumber).catch(() => null),
      predictRework(issueNumber).catch(() => null),
      getIssueDependencies(issueNumber).catch(() => null),
      getSprintAnalytics(30).catch(() => null),
      getInsights(),
    ]);

  if (!statusOrNull2) {
    throw new Error(`Issue #${issueNumber} not found in local database. Run 'pm sync' first.`);
  }
  const status = statusOrNull2;

  const title = status.title;
  const area = status.labels.find((l) => l.startsWith("area:"))?.replace("area:", "") ?? "unknown";
  const labels = status.labels;

  // Determine complexity
  let complexity: DecompositionResult["parentIssue"]["complexity"] = "Moderate";
  if (completion) {
    if (completion.prediction.p50Days <= 1) complexity = "Simple";
    else if (completion.prediction.p50Days <= 3) complexity = "Moderate";
    else if (completion.prediction.p50Days <= 7) complexity = "Complex";
    else complexity = "Very Complex";
  }

  // Generate subtasks based on common patterns
  const subtasks: SubIssue[] = [];
  const isEpic = labels.some((l) => l.includes("epic"));
  const isBug = labels.some((l) => l.includes("bug"));

  if (isEpic || complexity === "Very Complex" || complexity === "Complex") {
    // For epics/complex issues, suggest common decomposition patterns

    // 1. Spike/research task (if complexity is high)
    if (complexity === "Very Complex") {
      subtasks.push({
        title: `spike: Research and design approach for ${title}`,
        type: "spike",
        area,
        description: `Investigate implementation options, identify risks, and produce a design document for ${title}.`,
        acceptanceCriteria: [
          "Design document with chosen approach and alternatives considered",
          "Risk assessment completed",
          "Dependencies identified",
        ],
        estimatedSize: "Small",
        estimatedDays: 1,
        riskLevel: "Low",
        dependsOn: [],
      });
    }

    // 2. Infrastructure/setup task
    subtasks.push({
      title: `chore: Setup infrastructure for ${title}`,
      type: "chore",
      area,
      description: `Create necessary scaffolding, types, and interfaces for ${title}.`,
      acceptanceCriteria: [
        "Types and interfaces defined",
        "File structure created",
        "Build passes with new structure",
      ],
      estimatedSize: "Small",
      estimatedDays: 0.5,
      riskLevel: "Low",
      dependsOn: complexity === "Very Complex" ? [0] : [], // Depends on spike if very complex
    });

    // 3. Core implementation
    const coreIdx = subtasks.length;
    subtasks.push({
      title: `feat: Implement core logic for ${title}`,
      type: "feature",
      area,
      description: `Build the primary functionality for ${title}.`,
      acceptanceCriteria: [
        "Core business logic implemented",
        "Unit tests passing",
        "Handles happy path",
      ],
      estimatedSize: "Medium",
      estimatedDays: 2,
      riskLevel: "Medium",
      dependsOn: [subtasks.length - 1], // Depends on setup
    });

    // 4. Edge cases and error handling
    subtasks.push({
      title: `feat: Add error handling and edge cases for ${title}`,
      type: "feature",
      area,
      description: `Handle failure modes, edge cases, and error paths for ${title}.`,
      acceptanceCriteria: [
        "Error cases handled with clear messages",
        "Edge cases identified and tested",
        "No silent failures",
      ],
      estimatedSize: "Small",
      estimatedDays: 1,
      riskLevel: "Medium",
      dependsOn: [coreIdx], // Depends on core
    });

    // 5. Integration/wiring
    subtasks.push({
      title: `feat: Integrate ${title} with existing system`,
      type: "feature",
      area,
      description: `Wire ${title} into the existing codebase, update imports, registrations.`,
      acceptanceCriteria: [
        "Feature accessible from existing entry points",
        "Integration tests passing",
        "No regressions in existing functionality",
      ],
      estimatedSize: "Small",
      estimatedDays: 1,
      riskLevel: "Low",
      dependsOn: [coreIdx, subtasks.length - 1], // Depends on core + error handling
    });

    // 6. Documentation and cleanup
    subtasks.push({
      title: `docs: Document ${title}`,
      type: "chore",
      area,
      description: `Update documentation, changelog, and README for ${title}.`,
      acceptanceCriteria: [
        "User-facing documentation updated",
        "CHANGELOG entry added",
        "README updated if applicable",
      ],
      estimatedSize: "Small",
      estimatedDays: 0.5,
      riskLevel: "Low",
      dependsOn: [subtasks.length - 1], // Depends on integration
    });
  } else if (isBug) {
    // Bug decomposition pattern
    subtasks.push({
      title: `spike: Reproduce and diagnose ${title}`,
      type: "spike",
      area,
      description: `Reproduce the bug, identify root cause, and determine fix approach.`,
      acceptanceCriteria: [
        "Bug reproduced with steps documented",
        "Root cause identified",
        "Fix approach determined",
      ],
      estimatedSize: "Small",
      estimatedDays: 0.5,
      riskLevel: "Low",
      dependsOn: [],
    });

    subtasks.push({
      title: `fix: ${title}`,
      type: "bug",
      area,
      description: `Implement the fix for the root cause.`,
      acceptanceCriteria: [
        "Root cause addressed",
        "Regression test added",
        "Existing tests still pass",
      ],
      estimatedSize: "Small",
      estimatedDays: 1,
      riskLevel: "Medium",
      dependsOn: [0],
    });

    subtasks.push({
      title: `test: Verify fix and add regression tests for ${title}`,
      type: "chore",
      area,
      description: `Ensure the fix works and add tests to prevent regression.`,
      acceptanceCriteria: [
        "Manual verification of fix",
        "Automated regression test added",
        "Edge cases covered",
      ],
      estimatedSize: "Small",
      estimatedDays: 0.5,
      riskLevel: "Low",
      dependsOn: [1],
    });
  } else {
    // Standard feature decomposition
    subtasks.push({
      title: `feat: Implement ${title}`,
      type: "feature",
      area,
      description: `Core implementation of ${title}.`,
      acceptanceCriteria: [
        "Feature implemented per acceptance criteria",
        "Unit tests passing",
      ],
      estimatedSize: "Medium",
      estimatedDays: 2,
      riskLevel: "Medium",
      dependsOn: [],
    });

    subtasks.push({
      title: `test: Add comprehensive tests for ${title}`,
      type: "chore",
      area,
      description: `Add unit and integration tests for ${title}.`,
      acceptanceCriteria: [
        "Happy path tested",
        "Error cases tested",
        "Edge cases covered",
      ],
      estimatedSize: "Small",
      estimatedDays: 1,
      riskLevel: "Low",
      dependsOn: [0],
    });
  }

  // Calculate execution order (topological sort by dependency groups)
  const executionOrder: number[][] = [];
  const completed = new Set<number>();

  while (completed.size < subtasks.length) {
    const group: number[] = [];
    for (let i = 0; i < subtasks.length; i++) {
      if (completed.has(i)) continue;
      const allDepsCompleted = subtasks[i].dependsOn.every((d) =>
        completed.has(d)
      );
      if (allDepsCompleted) {
        group.push(i);
      }
    }
    if (group.length === 0) break; // Circular dependency safety
    executionOrder.push(group);
    for (const idx of group) completed.add(idx);
  }

  // Calculate critical path (longest chain)
  function longestPath(idx: number, memo: Map<number, number>): number {
    if (memo.has(idx)) return memo.get(idx)!;
    const task = subtasks[idx];
    let maxUpstream = 0;
    for (const dep of task.dependsOn) {
      maxUpstream = Math.max(maxUpstream, longestPath(dep, memo));
    }
    const total = maxUpstream + task.estimatedDays;
    memo.set(idx, total);
    return total;
  }

  const memo = new Map<number, number>();
  let criticalPathEnd = 0;
  let criticalPathLength = 0;
  for (let i = 0; i < subtasks.length; i++) {
    const pathLen = longestPath(i, memo);
    if (pathLen > criticalPathLength) {
      criticalPathLength = pathLen;
      criticalPathEnd = i;
    }
  }

  // Trace back the critical path
  const criticalPathTasks: number[] = [];
  let current = criticalPathEnd;
  while (current >= 0) {
    criticalPathTasks.unshift(current);
    const task = subtasks[current];
    if (task.dependsOn.length === 0) break;
    // Follow the dependency with the longest path
    let maxDep = -1;
    let maxDepLen = -1;
    for (const dep of task.dependsOn) {
      const depLen = memo.get(dep) ?? 0;
      if (depLen > maxDepLen) {
        maxDepLen = depLen;
        maxDep = dep;
      }
    }
    current = maxDep;
  }

  // Total estimated days (parallel)
  const totalSequentialDays = subtasks.reduce(
    (sum, t) => sum + t.estimatedDays,
    0
  );
  const parallelizableDays = criticalPathLength;
  const speedupRatio =
    totalSequentialDays > 0
      ? totalSequentialDays / parallelizableDays
      : 1;

  const highRiskTasks = subtasks.filter(
    (t) => t.riskLevel === "High"
  ).length;

  const recommendations: string[] = [];

  if (speedupRatio > 1.5) {
    recommendations.push(
      `Parallelizable: ${speedupRatio.toFixed(1)}x speedup possible ` +
      `(${totalSequentialDays.toFixed(1)} days sequential → ${parallelizableDays.toFixed(1)} days parallel)`
    );
  }

  if (highRiskTasks > 0) {
    recommendations.push(
      `${highRiskTasks} high-risk subtask(s) — consider spike/research first`
    );
  }

  if (rework && rework.reworkProbability > 0.4) {
    recommendations.push(
      `Parent issue has ${(rework.reworkProbability * 100).toFixed(0)}% rework risk — ` +
      "invest extra time in spec clarity before starting"
    );
  }

  if (subtasks.length > 6) {
    recommendations.push(
      "Consider grouping related subtasks into milestones for progress tracking"
    );
  }

  const summary =
    `${title}: ${complexity} complexity, decomposed into ${subtasks.length} subtasks. ` +
    `Critical path: ${parallelizableDays.toFixed(1)} days ` +
    `(${totalSequentialDays.toFixed(1)} days if sequential). ` +
    `${executionOrder.length} execution phases.`;

  return {
    parentIssue: {
      number: issueNumber,
      title,
      totalEstimatedDays: totalSequentialDays,
      complexity,
    },
    subtasks,
    executionOrder,
    criticalPath: {
      tasks: criticalPathTasks,
      totalDays: parallelizableDays,
      description: criticalPathTasks
        .map((i) => subtasks[i].title.split(":")[0])
        .join(" → "),
    },
    riskSummary: {
      highRiskTasks,
      totalEstimatedDays: totalSequentialDays,
      parallelizableDays,
      speedupRatio: Math.round(speedupRatio * 10) / 10,
    },
    recommendations,
    summary,
  };
}
