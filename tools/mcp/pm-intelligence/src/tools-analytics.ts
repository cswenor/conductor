import { z } from "zod";
import {
  getSprintAnalytics,
  suggestApproach,
  checkReadiness,
} from "./analytics.js";
import { getHistoryInsights } from "./history.js";
import { getDORAMetrics, getKnowledgeRisk } from "./predict.js";
import { compareEstimates } from "./explain.js";
import {
  McpServer,
  toolResponse,
  toolError,
  wrapTool,
} from "./tool-helpers.js";

export function register(server: McpServer) {
  server.registerTool(
    "get_sprint_analytics",
    {
      title: "Sprint Analytics",
      description:
        "Deep sprint analytics: cycle time (avg/median/p90), time-in-state analysis, bottleneck detection, flow efficiency, rework patterns, session patterns, and velocity/rework trends comparing current vs previous period. Use this to understand team performance and identify improvement areas.",
      inputSchema: {
        days: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Sprint period in days (default 14)"),
      },
    },
    wrapTool("get_sprint_analytics", async ({ days }) => {
      const analytics = await getSprintAnalytics(days ?? 14);
      return toolResponse(analytics);
    })
  );

  server.registerTool(
    "suggest_approach",
    {
      title: "Suggest Approach",
      description:
        "Query past decisions and outcomes to suggest approaches for new work in a specific area. Returns relevant past decisions, lessons learned from similar issues, warnings about common rework reasons, and related issue history. Use this when starting work on a new issue to learn from past experience.",
      inputSchema: {
        area: z
          .enum(["frontend", "backend", "contracts", "infra"])
          .describe("Area of the codebase"),
        keywords: z
          .array(z.string())
          .describe("Keywords describing the work (e.g., ['wallet', 'connection', 'timeout'])"),
        issueNumber: z
          .number()
          .int()
          .optional()
          .describe("Current issue number (for context)"),
        issueTitle: z
          .string()
          .optional()
          .describe("Current issue title (for context)"),
      },
    },
    async ({ area, keywords, issueNumber, issueTitle }) => {
      try {
        const suggestion = await suggestApproach(area, keywords);
        suggestion.issueNumber = issueNumber ?? 0;
        suggestion.issueTitle = issueTitle ?? "";
        return toolResponse(suggestion);
      } catch (error) {
        return toolError(error);
      }
    }
  );

  server.registerTool(
    "check_readiness",
    {
      title: "Check Issue Readiness",
      description:
        "Pre-review validation: checks the event stream for an issue to verify that proper workflow was followed — issue was moved to Active, has development sessions, rework was addressed, sufficient development time, and decisions documented. Returns a readiness score (0-100) and specific checks with blocking/warning/info severity. Use this before moving to Review.",
      inputSchema: {
        issueNumber: z.number().int().positive().describe("Issue number to check"),
      },
    },
    wrapTool("check_readiness", async ({ issueNumber }) => {
      const readiness = await checkReadiness(issueNumber);
      return toolResponse(readiness);
    })
  );

  server.registerTool(
    "get_history_insights",
    {
      title: "Git History Insights",
      description:
        "Mine git history for actionable insights: file change hotspots (highest risk areas), coupling analysis (files that always change together), commit patterns (types, scopes, peak times), PR size patterns, and risk area identification. Use this to understand which parts of the codebase are most volatile and where extra care is needed.",
      inputSchema: {
        days: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("History period in days (default 30)"),
      },
    },
    wrapTool("get_history_insights", async ({ days }) => {
      const insights = await getHistoryInsights(days ?? 30);
      return toolResponse(insights);
    })
  );

  server.registerTool(
    "get_dora_metrics",
    {
      title: "DORA Metrics",
      description:
        "Calculate DORA (DevOps Research and Assessment) performance metrics: Deployment Frequency (merge rate), Lead Time for Changes (first commit to merge), Change Failure Rate (rework ratio), Mean Time to Restore (bug fix speed). Each metric is rated elite/high/medium/low per industry benchmarks. Use this for engineering health assessment and team performance tracking.",
      inputSchema: {
        days: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Analysis period in days (default 30)"),
      },
    },
    wrapTool("get_dora_metrics", async ({ days }) => {
      const metrics = await getDORAMetrics(days ?? 30);
      return toolResponse(metrics);
    })
  );

  server.registerTool(
    "get_knowledge_risk",
    {
      title: "Knowledge Risk Analysis",
      description:
        "Analyze knowledge distribution and bus factor risks across the codebase. Identifies files where knowledge is concentrated in a single contributor (bus factor 1), areas with high knowledge concentration, and files showing knowledge decay (active files that haven't been touched recently). Use this to identify cross-training needs and knowledge sharing priorities.",
      inputSchema: {
        days: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Analysis period in days (default 90)"),
      },
    },
    wrapTool("get_knowledge_risk", async ({ days }) => {
      const risk = await getKnowledgeRisk(days ?? 90);
      return toolResponse(risk);
    })
  );

  server.registerTool(
    "compare_estimates",
    {
      title: "Compare Estimates",
      description:
        "Compares predicted vs actual cycle times across completed issues. Measures " +
        "prediction accuracy at P50/P80/P95 levels, rework prediction hit rate, and " +
        "identifies systematic bias (optimistic/pessimistic/calibrated). Use to improve " +
        "future estimation accuracy and determine which confidence level to use for commitments.",
      inputSchema: {
        days: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Days to look back for completed issues (default: 30)"),
      },
    },
    wrapTool("compare_estimates", async ({ days }) => {
      const calibration = await compareEstimates(days ?? 30);
      return toolResponse(calibration);
    })
  );
}
