import { z } from "zod";
import {
  triageIssue,
  analyzePRImpact,
  decomposeIssue,
} from "./triage.js";
import { reviewPR, autoLabel } from "./review-intel.js";
import { getSessionHistory, recoverContext } from "./context.js";
import { bulkTriage, bulkMove } from "./batch.js";
import {
  McpServer,
  toolResponse,
  toolError,
  wrapTool,
} from "./tool-helpers.js";

export function register(server: McpServer) {
  server.registerTool(
    "triage_issue",
    {
      title: "Triage Issue",
      description:
        "One-call complete issue intelligence. Auto-classifies tier, type, area, " +
        "priority (with factor analysis), size estimate, risk assessment, rework " +
        "probability, similar past work, suggested assignees, relevant docs to load, " +
        "and spec readiness score. Use when picking up any new issue to get full " +
        "context in one call instead of querying multiple tools.",
      inputSchema: {
        issueNumber: z
          .number()
          .int()
          .positive()
          .describe("GitHub issue number to triage"),
      },
    },
    wrapTool("triage_issue", async ({ issueNumber }) => {
      const result = await triageIssue(issueNumber);
      return toolResponse(result);
    })
  );

  server.registerTool(
    "analyze_pr_impact",
    {
      title: "Analyze PR Impact",
      description:
        "Blast radius analysis before merging a PR. Shows dependency impact (what " +
        "issues get unblocked), knowledge risk (bus factor for affected files), " +
        "coupling analysis (files that often change together), hotspot overlap, " +
        "and merge readiness score. Use before merging to understand systemic impact.",
      inputSchema: {
        prNumber: z
          .number()
          .int()
          .positive()
          .describe("Pull request number to analyze"),
      },
    },
    wrapTool("analyze_pr_impact", async ({ prNumber }) => {
      const result = await analyzePRImpact(prNumber);
      return toolResponse(result);
    })
  );

  server.registerTool(
    "decompose_issue",
    {
      title: "Decompose Issue",
      description:
        "Break a large issue or epic into smaller, dependency-ordered subtasks. " +
        "Generates subtask suggestions with titles, types, acceptance criteria, " +
        "size estimates, risk levels, and dependency relationships. Calculates " +
        "critical path, parallelization speedup ratio, and execution order phases. " +
        "Use for sprint planning or when an issue feels too large to start.",
      inputSchema: {
        issueNumber: z
          .number()
          .int()
          .positive()
          .describe("GitHub issue number to decompose"),
      },
    },
    wrapTool("decompose_issue", async ({ issueNumber }) => {
      const result = await decomposeIssue(issueNumber);
      return toolResponse(result);
    })
  );

  server.registerTool(
    "review_pr",
    {
      title: "Review PR",
      description:
        "Structured PR analysis: file classification, scope check, acceptance " +
        "criteria verification, risk assessment (secrets, knowledge risk, large files), " +
        "quality signals (tests, types, config changes), and verdict recommendation. " +
        "Returns approve/request_changes/needs_discussion with specific blockers and suggestions.",
      inputSchema: {
        prNumber: z
          .number()
          .int()
          .positive()
          .describe("Pull request number to review"),
      },
    },
    wrapTool("review_pr", async ({ prNumber }) => {
      const result = await reviewPR(prNumber);
      return toolResponse(result);
    })
  );

  server.registerTool(
    "auto_label",
    {
      title: "Auto Label",
      description:
        "Automatic issue classification from content analysis. Suggests type " +
        "(bug/feature/spike/epic/chore), area (frontend/backend/contracts/infra), " +
        "priority, risk level, and spec readiness based on title and body keyword matching. " +
        "Returns suggestions with confidence scores — labels are NOT applied automatically.",
      inputSchema: {
        issueNumber: z
          .number()
          .int()
          .positive()
          .describe("Issue number to classify"),
      },
    },
    wrapTool("auto_label", async ({ issueNumber }) => {
      const result = await autoLabel(issueNumber);
      return toolResponse(result);
    })
  );

  server.registerTool(
    "get_session_history",
    {
      title: "Get Session History",
      description:
        "Cross-session event history for an issue. Shows workflow transitions, " +
        "decisions made, outcomes recorded, session gaps (>1 day), and approximate " +
        "session count. Use to understand what happened with an issue over time.",
      inputSchema: {
        issueNumber: z
          .number()
          .int()
          .positive()
          .describe("Issue number to get history for"),
      },
    },
    wrapTool("get_session_history", async ({ issueNumber }) => {
      const result = await getSessionHistory(issueNumber);
      return toolResponse(result);
    })
  );

  server.registerTool(
    "recover_context",
    {
      title: "Recover Context",
      description:
        "Full context recovery to resume work on an issue. Loads: current state, " +
        "previous plans, linked PR status, review feedback, decisions, event timeline, " +
        "dependencies, predictions, and issue comments. Returns a resumption guide " +
        "with detected mode (START/CONTINUE/REWORK/etc), next steps, warnings, " +
        "and context files to load. The 'pick up where you left off' tool.",
      inputSchema: {
        issueNumber: z
          .number()
          .int()
          .positive()
          .describe("Issue number to recover context for"),
      },
    },
    wrapTool("recover_context", async ({ issueNumber }) => {
      const result = await recoverContext(issueNumber);
      return toolResponse(result);
    })
  );

  server.registerTool(
    "bulk_triage",
    {
      title: "Bulk Triage",
      description:
        "Triage all untriaged issues in one call. Finds open issues missing type: " +
        "or area: labels and suggests classifications for each. Labels are suggestions " +
        "only — not applied automatically. Use for backlog grooming and project cleanup.",
      inputSchema: {
        maxIssues: z
          .number()
          .int()
          .positive()
          .optional()
          .default(20)
          .describe("Maximum issues to process. Default 20"),
      },
    },
    wrapTool("bulk_triage", async ({ maxIssues }) => {
      const result = await bulkTriage(maxIssues);
      return toolResponse(result);
    })
  );

  server.registerTool(
    "bulk_move",
    {
      title: "Bulk Move",
      description:
        "Move multiple issues between workflow states in one call. Supports dry " +
        "run mode to preview changes. Use for sprint transitions (Ready → Active), " +
        "cleanup (stale → Backlog), or batch state corrections.",
      inputSchema: {
        issueNumbers: z
          .array(z.number().int().positive())
          .describe("Array of issue numbers to move"),
        targetState: z
          .string()
          .describe("Target workflow state (Backlog, Ready, Active, Review, Rework, Done)"),
        dryRun: z
          .boolean()
          .optional()
          .default(false)
          .describe("If true, preview changes without applying them"),
      },
    },
    wrapTool("bulk_move", async ({ issueNumbers, targetState, dryRun }) => {
      const result = await bulkMove(issueNumbers, targetState, dryRun);
      return toolResponse(result);
    })
  );
}
