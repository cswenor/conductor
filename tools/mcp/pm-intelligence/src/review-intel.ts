/**
 * Review Intelligence — Automated PR analysis and issue labeling
 *
 * Tools:
 *   - reviewPR: Structured PR analysis with acceptance criteria verification,
 *     scope check, risk assessment, and verdict recommendation
 *   - autoLabel: Automatic issue/PR classification from content analysis —
 *     suggests type, area, priority, and risk labels
 */

import { getIssue } from "./db.js";
import { getHistoryInsights } from "./history.js";
import { predictRework } from "./predict.js";
import { getKnowledgeRisk } from "./predict.js";
import { execSync } from "child_process";

// ─── Types ───────────────────────────────────────────────

interface PRFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  patch?: string;
}

interface CriterionCheck {
  criterion: string;
  status: "met" | "partial" | "unmet" | "unclear";
  evidence: string;
}

interface PRReview {
  prNumber: number;
  title: string;
  author: string;
  linkedIssues: number[];
  files: {
    total: number;
    byArea: Record<string, number>;
    riskFiles: Array<{ file: string; reason: string }>;
  };
  scopeCheck: {
    scopeAligned: boolean;
    concerns: string[];
    extraFiles: string[];
  };
  acceptanceCriteria: CriterionCheck[];
  riskAssessment: {
    overallRisk: "low" | "medium" | "high";
    factors: Array<{ factor: string; severity: string; detail: string }>;
  };
  qualitySignals: {
    hasTests: boolean;
    testFiles: string[];
    hasTypeChanges: boolean;
    touchesConfig: boolean;
    touchesInfra: boolean;
    largeFiles: string[];
  };
  verdict: {
    recommendation: "approve" | "request_changes" | "needs_discussion";
    reason: string;
    blockers: string[];
    suggestions: string[];
  };
  summary: string;
}

interface LabelSuggestion {
  issueNumber: number;
  title: string;
  currentLabels: string[];
  suggestedLabels: Array<{
    label: string;
    confidence: number;
    reason: string;
  }>;
  suggestedType: { value: string; confidence: number; reason: string } | null;
  suggestedArea: { value: string; confidence: number; reason: string } | null;
  suggestedPriority: {
    value: string;
    confidence: number;
    reason: string;
  } | null;
  suggestedRisk: { value: string; confidence: number; reason: string } | null;
}

// ─── Helpers ─────────────────────────────────────────────

function classifyArea(filename: string): string {
  if (filename.match(/web\/|frontend\/|\.svelte$|\.tsx?$/)) return "frontend";
  if (filename.match(/api\/|backend\/|server\//)) return "backend";
  if (filename.match(/contract|\.py$/)) return "contracts";
  if (
    filename.match(
      /infra\/|docker|\.yml$|\.yaml$|Makefile|Dockerfile|\.sh$/
    )
  )
    return "infra";
  return "general";
}

function getPRFiles(prNumber: number): PRFile[] {
  try {
    const output = execSync(
      `gh pr view ${prNumber} --json files --jq '.files[] | {filename: .path, status: .additions > .deletions | if . then "modified" else "modified" end, additions: .additions, deletions: .deletions}' 2>/dev/null`,
      { encoding: "utf-8" }
    );

    // Fallback: use gh pr diff --stat
    const diffStat = execSync(
      `gh pr diff ${prNumber} --stat 2>/dev/null`,
      { encoding: "utf-8" }
    );

    const files: PRFile[] = [];
    const lines = diffStat.trim().split("\n");
    for (const line of lines) {
      const match = line.match(
        /^\s*(.+?)\s+\|\s+(\d+)\s+(\+*)(-*)\s*$/
      );
      if (match) {
        files.push({
          filename: match[1].trim(),
          status: "modified",
          additions: (match[3] || "").length,
          deletions: (match[4] || "").length,
        });
      }
    }

    return files.length > 0 ? files : [];
  } catch {
    return [];
  }
}

function getPRBody(prNumber: number): string {
  try {
    return execSync(
      `gh pr view ${prNumber} --json body --jq .body 2>/dev/null`,
      { encoding: "utf-8" }
    ).trim();
  } catch {
    return "";
  }
}

function extractLinkedIssues(body: string): number[] {
  const issues: number[] = [];
  const patterns = [
    /(?:fixes|closes|resolves)\s+#(\d+)/gi,
    /(?:fix|close|resolve)\s+#(\d+)/gi,
  ];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(body)) !== null) {
      issues.push(parseInt(match[1], 10));
    }
  }
  return [...new Set(issues)];
}

function extractAcceptanceCriteria(issueBody: string): string[] {
  const criteria: string[] = [];
  const acSection = issueBody.match(
    /## Acceptance Criteria\s*\n([\s\S]*?)(?=\n##|\n$|$)/i
  );
  if (acSection) {
    const lines = acSection[1].split("\n");
    for (const line of lines) {
      const match = line.match(/^[-*]\s+\[[ x]\]\s+(.+)/);
      if (match) criteria.push(match[1].trim());
    }
  }
  return criteria;
}

// ─── review_pr ───────────────────────────────────────────

export async function reviewPR(prNumber: number): Promise<PRReview> {
  // Get PR metadata
  let prTitle = "";
  let prAuthor = "";
  try {
    const prJson = execSync(
      `gh pr view ${prNumber} --json title,author --jq '{title: .title, author: .author.login}' 2>/dev/null`,
      { encoding: "utf-8" }
    );
    const parsed = JSON.parse(prJson);
    prTitle = parsed.title || "";
    prAuthor = parsed.author || "";
  } catch {
    prTitle = `PR #${prNumber}`;
    prAuthor = "unknown";
  }

  const body = getPRBody(prNumber);
  const linkedIssues = extractLinkedIssues(body);
  const prFiles = getPRFiles(prNumber);

  // File analysis
  const byArea: Record<string, number> = {};
  const riskFiles: Array<{ file: string; reason: string }> = [];
  const testFiles: string[] = [];
  let touchesConfig = false;
  let touchesInfra = false;
  let hasTypeChanges = false;
  const largeFiles: string[] = [];

  for (const file of prFiles) {
    const area = classifyArea(file.filename);
    byArea[area] = (byArea[area] || 0) + 1;

    // Risk detection
    if (file.filename.match(/\.env|secret|credential|token/i)) {
      riskFiles.push({ file: file.filename, reason: "Potential secret exposure" });
    }
    if (file.additions + file.deletions > 300) {
      largeFiles.push(file.filename);
    }
    if (file.filename.match(/\.test\.|\.spec\.|test\/|tests\//)) {
      testFiles.push(file.filename);
    }
    if (file.filename.match(/config|\.json$|\.yml$|\.yaml$|\.toml$/)) {
      touchesConfig = true;
    }
    if (file.filename.match(/docker|infra\/|\.sh$|Makefile/)) {
      touchesInfra = true;
    }
    if (file.filename.match(/\.d\.ts$|types\//)) {
      hasTypeChanges = true;
    }
  }

  // Get acceptance criteria from linked issues
  const criteriaChecks: CriterionCheck[] = [];
  for (const issueNum of linkedIssues) {
    try {
      const issueBody = execSync(
        `gh issue view ${issueNum} --json body --jq .body 2>/dev/null`,
        { encoding: "utf-8" }
      ).trim();
      const criteria = extractAcceptanceCriteria(issueBody);
      for (const c of criteria) {
        criteriaChecks.push({
          criterion: c,
          status: "unclear", // Would need diff analysis for precise matching
          evidence: "Requires manual verification against diff",
        });
      }
    } catch {
      // Issue not accessible
    }
  }

  // Scope check
  const scopeConcerns: string[] = [];
  const extraFiles: string[] = [];
  const areas = Object.keys(byArea);
  if (areas.length > 2) {
    scopeConcerns.push(
      `Touches ${areas.length} areas (${areas.join(", ")}) — possible scope mixing`
    );
  }
  if (touchesInfra && areas.length > 1) {
    scopeConcerns.push("Combines infrastructure changes with non-infra work");
  }
  if (prFiles.length > 20) {
    scopeConcerns.push(
      `Large PR: ${prFiles.length} files changed — consider splitting`
    );
  }

  // Risk assessment
  const riskFactors: Array<{
    factor: string;
    severity: string;
    detail: string;
  }> = [];

  if (riskFiles.length > 0) {
    riskFactors.push({
      factor: "Secret exposure risk",
      severity: "high",
      detail: `Files with sensitive names: ${riskFiles.map((f) => f.file).join(", ")}`,
    });
  }
  if (prFiles.length > 30) {
    riskFactors.push({
      factor: "Large changeset",
      severity: "medium",
      detail: `${prFiles.length} files — harder to review thoroughly`,
    });
  }
  if (testFiles.length === 0 && prFiles.length > 5) {
    riskFactors.push({
      factor: "No test changes",
      severity: "medium",
      detail: "No test files modified despite significant code changes",
    });
  }
  if (linkedIssues.length === 0) {
    riskFactors.push({
      factor: "No linked issue",
      severity: "low",
      detail: "PR body does not reference any issues with Fixes/Closes/Resolves",
    });
  }

  // Get knowledge risk for changed files
  let knowledgeRiskFiles: string[] = [];
  try {
    const kr = await getKnowledgeRisk();
    const changedPaths = prFiles.map((f) => f.filename);
    knowledgeRiskFiles = kr.fileRisks
      .filter((fr) => changedPaths.some((cp) => fr.file.includes(cp)))
      .filter((fr) => fr.knowledgeRisk === "critical" || fr.knowledgeRisk === "high")
      .map((fr) => fr.file);
    if (knowledgeRiskFiles.length > 0) {
      riskFactors.push({
        factor: "Knowledge risk",
        severity: "medium",
        detail: `${knowledgeRiskFiles.length} high-risk files being modified (bus factor concern)`,
      });
    }
  } catch {
    // Knowledge risk not available
  }

  const overallRisk: PRReview["riskAssessment"]["overallRisk"] =
    riskFactors.some((f) => f.severity === "high")
      ? "high"
      : riskFactors.some((f) => f.severity === "medium")
        ? "medium"
        : "low";

  // Verdict
  const blockers: string[] = [];
  const suggestions: string[] = [];

  if (riskFiles.length > 0) blockers.push("Potential secret exposure in changed files");
  if (linkedIssues.length === 0 && prFiles.length > 5) {
    suggestions.push("Add issue link (Fixes #X) for tracking");
  }
  if (testFiles.length === 0 && prFiles.length > 5) {
    suggestions.push("Consider adding tests for changed functionality");
  }
  if (scopeConcerns.length > 0) {
    suggestions.push(...scopeConcerns);
  }
  if (largeFiles.length > 0) {
    suggestions.push(
      `Review large files carefully: ${largeFiles.slice(0, 3).join(", ")}`
    );
  }

  const recommendation: PRReview["verdict"]["recommendation"] =
    blockers.length > 0
      ? "request_changes"
      : overallRisk === "high"
        ? "needs_discussion"
        : "approve";

  const summary =
    `PR #${prNumber} by @${prAuthor}: ${prFiles.length} files across ${areas.join("/")}. ` +
    `${criteriaChecks.length > 0 ? `${criteriaChecks.length} acceptance criteria to verify. ` : ""}` +
    `Risk: ${overallRisk}. ` +
    `${blockers.length > 0 ? `${blockers.length} blocker(s). ` : ""}` +
    `${suggestions.length > 0 ? `${suggestions.length} suggestion(s). ` : ""}` +
    `Verdict: ${recommendation}.`;

  return {
    prNumber,
    title: prTitle,
    author: prAuthor,
    linkedIssues,
    files: {
      total: prFiles.length,
      byArea,
      riskFiles,
    },
    scopeCheck: {
      scopeAligned: scopeConcerns.length === 0,
      concerns: scopeConcerns,
      extraFiles,
    },
    acceptanceCriteria: criteriaChecks,
    riskAssessment: {
      overallRisk,
      factors: riskFactors,
    },
    qualitySignals: {
      hasTests: testFiles.length > 0,
      testFiles,
      hasTypeChanges,
      touchesConfig,
      touchesInfra,
      largeFiles,
    },
    verdict: {
      recommendation,
      reason:
        recommendation === "approve"
          ? "No blockers found. Standard review recommended."
          : recommendation === "request_changes"
            ? `Blockers found: ${blockers.join("; ")}`
            : `High risk areas need discussion: ${riskFactors.filter((f) => f.severity === "high").map((f) => f.factor).join(", ")}`,
      blockers,
      suggestions,
    },
    summary,
  };
}

// ─── auto_label ──────────────────────────────────────────

export async function autoLabel(issueNumber: number): Promise<LabelSuggestion> {
  const status = await getIssue(issueNumber);
  if (!status) {
    throw new Error(`Issue #${issueNumber} not found in local database. Run 'pm sync' first.`);
  }

  let body = "";
  try {
    body = execSync(
      `gh issue view ${issueNumber} --json body --jq .body 2>/dev/null`,
      { encoding: "utf-8" }
    ).trim();
  } catch {
    // Body not available
  }

  const titleLower = status.title.toLowerCase();
  const bodyLower = body.toLowerCase();
  const combined = titleLower + " " + bodyLower;

  const suggestedLabels: LabelSuggestion["suggestedLabels"] = [];

  // Type detection
  let suggestedType: LabelSuggestion["suggestedType"] = null;
  if (combined.match(/bug|broken|error|crash|fix|fail|wrong/)) {
    suggestedType = {
      value: "type:bug",
      confidence: 0.8,
      reason: "Bug keywords detected in title/body",
    };
  } else if (combined.match(/feat|add|new|implement|create|build/)) {
    suggestedType = {
      value: "type:feature",
      confidence: 0.8,
      reason: "Feature keywords detected",
    };
  } else if (combined.match(/spike|research|explore|investigate|prototype/)) {
    suggestedType = {
      value: "type:spike",
      confidence: 0.85,
      reason: "Research/exploration keywords detected",
    };
  } else if (combined.match(/epic|initiative|project|umbrella|milestone/)) {
    suggestedType = {
      value: "type:epic",
      confidence: 0.7,
      reason: "Epic/initiative keywords detected",
    };
  } else if (combined.match(/chore|cleanup|refactor|update|upgrade|migrate/)) {
    suggestedType = {
      value: "type:chore",
      confidence: 0.7,
      reason: "Maintenance/chore keywords detected",
    };
  }

  if (suggestedType && !status.labels.includes(suggestedType.value)) {
    suggestedLabels.push({
      label: suggestedType.value,
      confidence: suggestedType.confidence,
      reason: suggestedType.reason,
    });
  }

  // Area detection
  let suggestedArea: LabelSuggestion["suggestedArea"] = null;
  if (
    combined.match(
      /ui|component|page|button|svelte|frontend|tailwind|layout|css|style/
    )
  ) {
    suggestedArea = {
      value: "area:frontend",
      confidence: 0.8,
      reason: "Frontend/UI keywords detected",
    };
  } else if (
    combined.match(/api|endpoint|database|supabase|postgres|backend|server/)
  ) {
    suggestedArea = {
      value: "area:backend",
      confidence: 0.8,
      reason: "Backend/API keywords detected",
    };
  } else if (
    combined.match(
      /contract|on-?chain|algorand|voi|blockchain|wallet|signing/
    )
  ) {
    suggestedArea = {
      value: "area:contracts",
      confidence: 0.85,
      reason: "Blockchain/contract keywords detected",
    };
  } else if (
    combined.match(/docker|ci|deploy|infra|workflow|github action|makefile/)
  ) {
    suggestedArea = {
      value: "area:infra",
      confidence: 0.8,
      reason: "Infrastructure keywords detected",
    };
  }

  if (suggestedArea && !status.labels.includes(suggestedArea.value)) {
    suggestedLabels.push({
      label: suggestedArea.value,
      confidence: suggestedArea.confidence,
      reason: suggestedArea.reason,
    });
  }

  // Priority detection
  let suggestedPriority: LabelSuggestion["suggestedPriority"] = null;
  if (combined.match(/critical|urgent|emergency|production|outage|security/)) {
    suggestedPriority = {
      value: "critical",
      confidence: 0.75,
      reason: "Critical/urgent keywords detected",
    };
  } else if (combined.match(/important|high|blocker|blocking|asap/)) {
    suggestedPriority = {
      value: "high",
      confidence: 0.65,
      reason: "High priority keywords detected",
    };
  }

  // Risk detection
  let suggestedRisk: LabelSuggestion["suggestedRisk"] = null;
  if (
    combined.match(
      /security|auth|permission|secret|credential|encryption|migration/
    )
  ) {
    suggestedRisk = {
      value: "high",
      confidence: 0.7,
      reason: "Security/migration keywords indicate high risk",
    };
  } else if (combined.match(/refactor|breaking|rewrite|overhaul/)) {
    suggestedRisk = {
      value: "medium",
      confidence: 0.65,
      reason: "Refactoring/breaking changes indicate medium risk",
    };
  }

  // Check for spec readiness indicators
  const hasAC = body.includes("## Acceptance Criteria");
  const hasNonGoals = body.includes("## Non-goals");
  if (hasAC && hasNonGoals) {
    suggestedLabels.push({
      label: "spec:ready",
      confidence: 0.7,
      reason: "Issue has Acceptance Criteria and Non-goals sections",
    });
  }

  // Check for blocked indicators
  if (combined.match(/blocked by|depends on|prerequisite|waiting on/)) {
    suggestedLabels.push({
      label: "blocked:prerequisite",
      confidence: 0.6,
      reason: "Dependency/blocker language detected",
    });
  }

  return {
    issueNumber,
    title: status.title,
    currentLabels: status.labels,
    suggestedLabels,
    suggestedType,
    suggestedArea,
    suggestedPriority,
    suggestedRisk,
  };
}
