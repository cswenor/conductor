/**
 * Batch Operations — Bulk issue management
 *
 * Tools:
 *   - bulkTriage: Triage all untriaged issues in one call
 *   - bulkMove: Move multiple issues between workflow states
 */

import { getIssue, getLocalBoardSummary, moveIssueWorkflow } from "./db.js";
import { autoLabel } from "./review-intel.js";
import { triageIssue } from "./triage.js";
import { execSync } from "child_process";

// ─── Types ───────────────────────────────────────────────

interface TriageResult {
  issueNumber: number;
  title: string;
  suggestedType: string | null;
  suggestedArea: string | null;
  suggestedPriority: string | null;
  suggestedRisk: string | null;
  specReadiness: number;
  status: "triaged" | "already_triaged" | "error";
  error?: string;
}

interface BulkTriageResult {
  total: number;
  triaged: number;
  alreadyTriaged: number;
  errors: number;
  results: TriageResult[];
  summary: string;
}

interface MoveResult {
  issueNumber: number;
  title: string;
  fromState: string | null;
  toState: string;
  status: "moved" | "already_in_state" | "error";
  error?: string;
}

interface BulkMoveResult {
  total: number;
  moved: number;
  alreadyInState: number;
  errors: number;
  results: MoveResult[];
  summary: string;
}

// ─── bulk_triage ─────────────────────────────────────────

export async function bulkTriage(
  maxIssues = 20,
  state?: string
): Promise<BulkTriageResult> {
  // Find untriaged issues (no type or area label)
  const board = await getLocalBoardSummary();

  // Get all open issues that lack labels
  let issues: Array<{ number: number; title: string }> = [];
  try {
    const targetState = state || "Backlog";
    const output = execSync(
      `gh issue list --state open --limit ${maxIssues * 2} --json number,title,labels 2>/dev/null`,
      { encoding: "utf-8" }
    );
    const allIssues = JSON.parse(output);

    // Filter to those missing type: or area: labels
    issues = allIssues
      .filter((issue: { labels: Array<{ name: string }> }) => {
        const labels = issue.labels.map((l: { name: string }) => l.name);
        const hasType = labels.some((l: string) => l.startsWith("type:"));
        const hasArea = labels.some((l: string) => l.startsWith("area:"));
        return !hasType || !hasArea;
      })
      .slice(0, maxIssues)
      .map((issue: { number: number; title: string }) => ({
        number: issue.number,
        title: issue.title,
      }));
  } catch {
    // Fall back to active + review issues from board
    const fallbackIssues = [...board.activeIssues, ...board.reviewIssues];
    issues = fallbackIssues.slice(0, maxIssues).map((s) => ({
      number: s.number,
      title: s.title,
    }));
  }

  const results: TriageResult[] = [];

  for (const issue of issues) {
    try {
      const labelSuggestion = await autoLabel(issue.number);

      if (
        labelSuggestion.suggestedLabels.length === 0 &&
        !labelSuggestion.suggestedType &&
        !labelSuggestion.suggestedArea
      ) {
        results.push({
          issueNumber: issue.number,
          title: issue.title,
          suggestedType: null,
          suggestedArea: null,
          suggestedPriority: null,
          suggestedRisk: null,
          specReadiness: 0,
          status: "already_triaged",
        });
        continue;
      }

      results.push({
        issueNumber: issue.number,
        title: issue.title,
        suggestedType: labelSuggestion.suggestedType?.value || null,
        suggestedArea: labelSuggestion.suggestedArea?.value || null,
        suggestedPriority: labelSuggestion.suggestedPriority?.value || null,
        suggestedRisk: labelSuggestion.suggestedRisk?.value || null,
        specReadiness:
          labelSuggestion.suggestedLabels.some((l) => l.label === "spec:ready")
            ? 1
            : 0,
        status: "triaged",
      });
    } catch (error) {
      results.push({
        issueNumber: issue.number,
        title: issue.title,
        suggestedType: null,
        suggestedArea: null,
        suggestedPriority: null,
        suggestedRisk: null,
        specReadiness: 0,
        status: "error",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const triaged = results.filter((r) => r.status === "triaged").length;
  const alreadyTriaged = results.filter(
    (r) => r.status === "already_triaged"
  ).length;
  const errors = results.filter((r) => r.status === "error").length;

  return {
    total: results.length,
    triaged,
    alreadyTriaged,
    errors,
    results,
    summary:
      `Processed ${results.length} issues: ${triaged} need triage, ` +
      `${alreadyTriaged} already triaged, ${errors} error${errors !== 1 ? "s" : ""}. ` +
      `Labels are suggestions only — apply with gh issue edit.`,
  };
}

// ─── bulk_move ───────────────────────────────────────────

export async function bulkMove(
  issueNumbers: number[],
  targetState: string,
  dryRun = false
): Promise<BulkMoveResult> {
  const results: MoveResult[] = [];

  for (const num of issueNumbers) {
    try {
      const status = await getIssue(num);
      if (!status) {
        results.push({
          issueNumber: num,
          title: `Issue #${num}`,
          fromState: null,
          toState: targetState,
          status: "error",
          error: `Issue #${num} not found in local database. Run 'pm sync' first.`,
        });
        continue;
      }

      if (status.workflow === targetState) {
        results.push({
          issueNumber: num,
          title: status.title,
          fromState: status.workflow,
          toState: targetState,
          status: "already_in_state",
        });
        continue;
      }

      if (!dryRun) {
        await moveIssueWorkflow(num, targetState as any);
      }

      results.push({
        issueNumber: num,
        title: status.title,
        fromState: status.workflow,
        toState: targetState,
        status: "moved",
      });
    } catch (error) {
      results.push({
        issueNumber: num,
        title: `Issue #${num}`,
        fromState: null,
        toState: targetState,
        status: "error",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const moved = results.filter((r) => r.status === "moved").length;
  const alreadyInState = results.filter(
    (r) => r.status === "already_in_state"
  ).length;
  const errors = results.filter((r) => r.status === "error").length;

  return {
    total: results.length,
    moved,
    alreadyInState,
    errors,
    results,
    summary: dryRun
      ? `DRY RUN: Would move ${moved} of ${results.length} issues to ${targetState}. ` +
        `${alreadyInState} already in ${targetState}.`
      : `Moved ${moved} of ${results.length} issues to ${targetState}. ` +
        `${alreadyInState} already in ${targetState}, ${errors} error${errors !== 1 ? "s" : ""}.`,
  };
}
