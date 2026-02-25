import { z } from "zod";
import {
  detectScopeCreep,
  getContextEfficiency,
  getWorkflowHealth,
} from "./guardrails.js";
import { getRiskRadar } from "./risk-radar.js";
import {
  McpServer,
  toolResponse,
  toolError,
  wrapTool,
} from "./tool-helpers.js";

export function register(server: McpServer) {
  server.registerTool(
    "detect_scope_creep",
    {
      title: "Detect Scope Creep",
      description:
        "Compare the implementation plan to actual file changes in the working tree. Identifies out-of-scope files (changed but not in plan), untouched plan files, and calculates a scope creep ratio. Flags infrastructure changes, dependency changes, and patterns that indicate scope mixing. Use this during implementation to catch drift early — before it becomes unmergeable.",
      inputSchema: {
        issueNumber: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Issue number to find the plan for (searches .claude/plans/)"),
      },
    },
    wrapTool("detect_scope_creep", async ({ issueNumber }) => {
      const report = await detectScopeCreep(issueNumber);
      return toolResponse(report);
    })
  );

  server.registerTool(
    "get_context_efficiency",
    {
      title: "Context Efficiency Report",
      description:
        "Measure AI context efficiency for a specific issue: session count, rework cycles, needs-input frequency, error rate, time-in-state metrics, session timing patterns, and an overall efficiency score (0-100). Identifies context waste patterns (long gaps between sessions, excessive rework, high error rates) and provides specific recommendations. Use this after completing an issue to learn from the process, or during work to identify inefficiencies.",
      inputSchema: {
        issueNumber: z.number().int().positive().describe("Issue number to analyze"),
      },
    },
    wrapTool("get_context_efficiency", async ({ issueNumber }) => {
      const report = await getContextEfficiency(issueNumber);
      return toolResponse(report);
    })
  );

  server.registerTool(
    "get_workflow_health",
    {
      title: "Workflow Health Analysis",
      description:
        "Cross-issue workflow health analysis: per-issue health scores, stale issue detection, bottleneck identification (which workflow state has the most stuck items), and systemic pattern detection. Returns a portfolio-level view of project health. Use this during sprint planning, weekly reviews, or when you suspect workflow issues.",
      inputSchema: {
        days: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Analysis period in days (default 30)"),
      },
    },
    wrapTool("get_workflow_health", async ({ days }) => {
      const health = await getWorkflowHealth(days ?? 30);
      return toolResponse(health);
    })
  );

  server.registerTool(
    "get_risk_radar",
    {
      title: "Get Risk Radar",
      description:
        "Comprehensive risk assessment synthesizing ALL intelligence signals: " +
        "delivery velocity, quality (rework rate, DORA CFR), knowledge (bus factor, " +
        "critical files), process (stale items, WIP violations), dependencies " +
        "(cycles, bottlenecks, orphaned), and capacity (deceleration). Returns " +
        "overall risk score (0-100), prioritized risk list with trend arrows, " +
        "health indicators per category, and actionable mitigations. " +
        "The executive risk dashboard in one call.",
      inputSchema: {},
    },
    wrapTool("get_risk_radar", async () => {
      const result = await getRiskRadar();
      return toolResponse(result);
    })
  );
}
