/**
 * Context Recovery — Cross-session intelligence for seamless work resumption
 *
 * Tools:
 *   - getSessionHistory: What happened in past sessions for an issue
 *   - recoverContext: Load everything needed to resume work — previous plans,
 *     decisions, PR state, review feedback, event timeline
 */

import { getIssue } from "./db.js";
import {
  getDecisions,
  getOutcomes,
  getEvents,
} from "./memory.js";
import { getIssueDependencies } from "./graph.js";
import { predictCompletion, predictRework } from "./predict.js";
import { execSync } from "child_process";

// ─── Types ───────────────────────────────────────────────

interface SessionEvent {
  timestamp: string;
  event: string;
  detail: string;
}

interface SessionHistoryResult {
  issueNumber: number;
  title: string;
  totalSessions: number;
  totalEvents: number;
  timeline: SessionEvent[];
  workflowTransitions: Array<{
    from: string;
    to: string;
    timestamp: string;
  }>;
  decisions: Array<{
    timestamp: string;
    decision: string;
    rationale: string | null;
  }>;
  outcomes: Array<{
    timestamp: string;
    result: string;
    summary: string | null;
    lessons: string | null;
  }>;
  sessionGaps: Array<{
    from: string;
    to: string;
    gapDays: number;
  }>;
  summary: string;
}

interface PRState {
  number: number;
  title: string;
  state: string;
  draft: boolean;
  reviewDecision: string | null;
  reviewComments: Array<{
    author: string;
    body: string;
    createdAt: string;
  }>;
  files: number;
  additions: number;
  deletions: number;
}

interface ContextRecovery {
  issueNumber: number;
  title: string;
  currentState: {
    workflow: string | null;
    issueState: string;
    labels: string[];
    assignees: string[];
  };
  previousPlans: Array<{
    path: string;
    lastModified: string;
    preview: string;
  }>;
  pr: PRState | null;
  reviewFeedback: string[];
  decisions: Array<{
    timestamp: string;
    decision: string;
    rationale: string | null;
  }>;
  recentEvents: SessionEvent[];
  dependencies: {
    blockedBy: Array<{ number: number; title: string; resolved: boolean }>;
    blocks: Array<{ number: number; title: string }>;
    isUnblocked: boolean;
  } | null;
  predictions: {
    completionP50: string | null;
    reworkProbability: number | null;
    riskScore: number | null;
  };
  issueComments: Array<{
    author: string;
    body: string;
    createdAt: string;
  }>;
  resumptionGuide: {
    mode: string;
    nextSteps: string[];
    warnings: string[];
    contextFiles: string[];
  };
  summary: string;
}

// ─── get_session_history ─────────────────────────────────

export async function getSessionHistory(
  issueNumber: number
): Promise<SessionHistoryResult> {
  const [statusOrNull, events, decisions, outcomes] = await Promise.all([
    getIssue(issueNumber),
    getEvents(500, { issueNumber }),
    getDecisions(50, issueNumber),
    getOutcomes(20, { issueNumber }),
  ]);

  if (!statusOrNull) {
    throw new Error(`Issue #${issueNumber} not found in local database. Run 'pm sync' first.`);
  }
  const status = statusOrNull;

  // Build timeline
  const timeline: SessionEvent[] = events.map((e) => ({
    timestamp: e.timestamp,
    event: e.event_type,
    detail:
      e.to_value ||
      (e.from_value && e.to_value
        ? `${e.from_value} → ${e.to_value}`
        : (e.metadata as any)?.tool || ""),
  }));

  // Extract workflow transitions
  const workflowTransitions = events
    .filter((e) => e.event_type === "workflow_transition" && e.from_value && e.to_value)
    .map((e) => ({
      from: e.from_value!,
      to: e.to_value!,
      timestamp: e.timestamp,
    }));

  // Detect session gaps (>24h between events)
  const sessionGaps: SessionHistoryResult["sessionGaps"] = [];
  const sortedEvents = [...events].sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
  );

  for (let i = 1; i < sortedEvents.length; i++) {
    const prev = new Date(sortedEvents[i - 1].timestamp);
    const curr = new Date(sortedEvents[i].timestamp);
    const gapMs = curr.getTime() - prev.getTime();
    const gapDays = Math.round((gapMs / 86400000) * 10) / 10;
    if (gapDays >= 1) {
      sessionGaps.push({
        from: sortedEvents[i - 1].timestamp,
        to: sortedEvents[i].timestamp,
        gapDays,
      });
    }
  }

  // Count approximate sessions (clusters of events within 4 hours)
  let sessionCount = 0;
  let lastEventTime = 0;
  for (const e of sortedEvents) {
    const t = new Date(e.timestamp).getTime();
    if (t - lastEventTime > 4 * 3600000) sessionCount++;
    lastEventTime = t;
  }

  const summary =
    `Issue #${issueNumber} (${status.title}): ${sessionCount} session${sessionCount !== 1 ? "s" : ""}, ` +
    `${events.length} events, ${workflowTransitions.length} workflow transitions, ` +
    `${decisions.length} decision${decisions.length !== 1 ? "s" : ""} recorded. ` +
    `${sessionGaps.length > 0 ? `${sessionGaps.length} gap${sessionGaps.length !== 1 ? "s" : ""} >1 day. ` : ""}` +
    `${outcomes.length > 0 ? `Latest outcome: ${outcomes[0].result}.` : "No outcomes recorded yet."}`;

  return {
    issueNumber,
    title: status.title,
    totalSessions: sessionCount,
    totalEvents: events.length,
    timeline: timeline.slice(-50), // Last 50 events
    workflowTransitions,
    decisions: decisions.map((d) => ({
      timestamp: d.timestamp,
      decision: d.decision,
      rationale: d.rationale,
    })),
    outcomes: outcomes.map((o) => ({
      timestamp: o.timestamp,
      result: o.result,
      summary: o.approach_summary,
      lessons: o.lessons,
    })),
    sessionGaps,
    summary,
  };
}

// ─── recover_context ─────────────────────────────────────

export async function recoverContext(
  issueNumber: number
): Promise<ContextRecovery> {
  // Gather everything in parallel
  const [statusOrNull, events, decisions, outcomes, deps] = await Promise.all([
    getIssue(issueNumber),
    getEvents(100, { issueNumber }),
    getDecisions(20, issueNumber),
    getOutcomes(5, { issueNumber }),
    getIssueDependencies(issueNumber).catch(() => null),
  ]);

  if (!statusOrNull) {
    throw new Error(`Issue #${issueNumber} not found in local database. Run 'pm sync' first.`);
  }
  const status = statusOrNull;

  // Try to get predictions
  let completionP50: string | null = null;
  let reworkProbability: number | null = null;
  let riskScore: number | null = null;
  try {
    const completion = await predictCompletion(issueNumber);
    completionP50 = completion.prediction?.expectedDate?.p50 || null;
    riskScore = completion.riskScore;
  } catch {
    // Predictions not available
  }
  try {
    const rework = await predictRework(issueNumber);
    reworkProbability = rework.reworkProbability;
  } catch {
    // Rework prediction not available
  }

  // Find linked PRs
  let pr: PRState | null = null;
  try {
    const prSearch = execSync(
      `gh pr list --search "Fixes #${issueNumber}" --json number,title,state,isDraft,reviewDecision,files,additions,deletions --limit 1 2>/dev/null`,
      { encoding: "utf-8" }
    );
    const prs = JSON.parse(prSearch);
    if (prs.length > 0) {
      const p = prs[0];
      // Get review comments
      let reviewComments: PRState["reviewComments"] = [];
      try {
        const commentsJson = execSync(
          `gh pr view ${p.number} --json comments --jq '.comments[] | {author: .author.login, body: .body, createdAt: .createdAt}' 2>/dev/null`,
          { encoding: "utf-8" }
        );
        reviewComments = commentsJson
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => {
            try {
              return JSON.parse(line);
            } catch {
              return null;
            }
          })
          .filter(Boolean) as PRState["reviewComments"];
      } catch {
        // Comments not available
      }

      pr = {
        number: p.number,
        title: p.title,
        state: p.state,
        draft: p.isDraft || false,
        reviewDecision: p.reviewDecision || null,
        reviewComments,
        files: p.files?.length || 0,
        additions: p.additions || 0,
        deletions: p.deletions || 0,
      };
    }
  } catch {
    // PR search failed
  }

  // Get issue comments
  let issueComments: ContextRecovery["issueComments"] = [];
  try {
    const commentsJson = execSync(
      `gh issue view ${issueNumber} --json comments --jq '.comments[] | {author: .author.login, body: .body, createdAt: .createdAt}' 2>/dev/null`,
      { encoding: "utf-8" }
    );
    issueComments = commentsJson
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean) as ContextRecovery["issueComments"];
  } catch {
    // Comments not available
  }

  // Find previous plans
  const previousPlans: ContextRecovery["previousPlans"] = [];
  try {
    const planSearch = execSync(
      `find .claude/plans -name '*.md' -exec grep -l "#${issueNumber}" {} \\; 2>/dev/null | head -5`,
      { encoding: "utf-8" }
    );
    for (const path of planSearch.trim().split("\n").filter(Boolean)) {
      try {
        const stat = execSync(`stat -f '%m' "${path}" 2>/dev/null || stat -c '%Y' "${path}" 2>/dev/null`, {
          encoding: "utf-8",
        }).trim();
        const content = execSync(`head -20 "${path}" 2>/dev/null`, {
          encoding: "utf-8",
        });
        previousPlans.push({
          path,
          lastModified: new Date(parseInt(stat) * 1000).toISOString(),
          preview: content.trim().substring(0, 500),
        });
      } catch {
        previousPlans.push({
          path,
          lastModified: "unknown",
          preview: "(could not read)",
        });
      }
    }
  } catch {
    // No plans found
  }

  // Extract review feedback from PR comments
  const reviewFeedback: string[] = [];
  if (pr?.reviewComments) {
    for (const comment of pr.reviewComments) {
      if (comment.body.length > 20) {
        reviewFeedback.push(
          `@${comment.author} (${comment.createdAt.split("T")[0]}): ${comment.body.substring(0, 200)}`
        );
      }
    }
  }

  // Build resumption guide
  const nextSteps: string[] = [];
  const warnings: string[] = [];
  const contextFiles: string[] = [];

  // Determine mode
  let mode = "unknown";
  if (!status.workflow) {
    mode = "NOT_IN_PROJECT";
    nextSteps.push("Add issue to project first");
  } else if (status.workflow === "Active") {
    mode = "CONTINUE";
    if (pr) {
      nextSteps.push(`PR #${pr.number} exists — continue implementation`);
      if (pr.reviewDecision === "CHANGES_REQUESTED") {
        mode = "REWORK";
        nextSteps.push("Address review feedback before re-submitting");
      }
    } else {
      nextSteps.push("No PR yet — create branch and implement");
    }
  } else if (status.workflow === "Review") {
    mode = "REVIEW";
    nextSteps.push("Waiting for review — check PR status");
  } else if (status.workflow === "Rework") {
    mode = "REWORK";
    nextSteps.push("Address review feedback");
    if (reviewFeedback.length > 0) {
      nextSteps.push(`${reviewFeedback.length} review comments to address`);
    }
  } else if (status.workflow === "Done") {
    mode = "DONE";
    nextSteps.push("Issue is complete — no action needed");
  } else if (
    status.workflow === "Ready" ||
    status.workflow === "Backlog"
  ) {
    mode = "START";
    nextSteps.push("Move to Active and begin implementation");
  }

  // Warnings
  if (deps && !deps.isUnblocked) {
    warnings.push(
      `Issue is blocked by: ${deps.blockedBy.filter((b) => !b.resolved).map((b) => `#${b.number}`).join(", ")}`
    );
  }
  if (reworkProbability !== null && reworkProbability > 0.5) {
    warnings.push(
      `High rework probability (${Math.round(reworkProbability * 100)}%) — review carefully before submitting`
    );
  }
  if (riskScore !== null && riskScore > 70) {
    warnings.push(`High completion risk (${riskScore}/100)`);
  }

  // Context files based on area
  const area = status.labels.find((l) => l.startsWith("area:"))?.replace("area:", "") ?? null;
  if (area) {
    const areaFiles: Record<string, string[]> = {
      frontend: ["docs/development/LOCAL_DEV.md", "docs/architecture/OVERVIEW.md"],
      backend: ["docs/architecture/DATABASE.md", "docs/architecture/OVERVIEW.md"],
      contracts: ["docs/contracts/GAME_CONTRACT_INTERFACE.md"],
      infra: ["docs/ENV_WORKFLOW.md", "docs/SECRETS.md"],
    };
    contextFiles.push(...(areaFiles[area] || []));
  }
  contextFiles.push("CLAUDE.md", "docs/PM_PLAYBOOK.md");

  const recentEvents: SessionEvent[] = events.slice(-20).map((e) => ({
    timestamp: e.timestamp,
    event: e.event_type,
    detail:
      e.to_value ||
      (e.from_value && e.to_value
        ? `${e.from_value} → ${e.to_value}`
        : (e.metadata as any)?.tool || ""),
  }));

  const summary =
    `Issue #${issueNumber} (${status.title}) — Mode: ${mode}. ` +
    `${pr ? `PR #${pr.number} (${pr.state}${pr.reviewDecision ? `, ${pr.reviewDecision}` : ""}). ` : "No PR. "}` +
    `${decisions.length} decisions, ${previousPlans.length} plans on disk. ` +
    `${reviewFeedback.length > 0 ? `${reviewFeedback.length} review comments to address. ` : ""}` +
    `${warnings.length > 0 ? `Warnings: ${warnings.join("; ")}. ` : ""}` +
    `Next: ${nextSteps[0] || "determine approach"}.`;

  return {
    issueNumber,
    title: status.title,
    currentState: {
      workflow: status.workflow,
      issueState: status.state,
      labels: status.labels,
      assignees: status.assignees,
    },
    previousPlans,
    pr,
    reviewFeedback,
    decisions: decisions.map((d) => ({
      timestamp: d.timestamp,
      decision: d.decision,
      rationale: d.rationale,
    })),
    recentEvents,
    dependencies: deps
      ? {
          blockedBy: deps.blockedBy.map((b) => ({
            number: b.number,
            title: b.title,
            resolved: b.resolved,
          })),
          blocks: deps.blocks.map((b) => ({
            number: b.number,
            title: b.title,
          })),
          isUnblocked: deps.isUnblocked,
        }
      : null,
    predictions: {
      completionP50,
      reworkProbability,
      riskScore,
    },
    issueComments,
    resumptionGuide: {
      mode,
      nextSteps,
      warnings,
      contextFiles,
    },
    summary,
  };
}
