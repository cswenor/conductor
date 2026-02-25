import { z } from "zod";
import {
  suggestNextIssue,
  generateStandup,
  generateRetro,
} from "./operations.js";
import { explainDelay } from "./explain.js";
import { detectPatterns } from "./anomaly.js";
import { generateReleaseNotes } from "./release.js";
import { optimizeSession } from "./session.js";
import { getProjectDashboard } from "./dashboard.js";
import {
  McpServer,
  toolResponse,
  toolError,
  wrapTool,
} from "./tool-helpers.js";

export function register(server: McpServer) {
  server.registerTool(
    "suggest_next_issue",
    {
      title: "Suggest Next Issue",
      description:
        "Recommends the best issue to work on next based on priority, dependencies, " +
        "rework risk, estimated effort, and bottleneck impact. Scores and ranks all " +
        "unblocked Ready/Backlog issues. Returns top recommendation with alternatives.",
      inputSchema: {},
    },
    wrapTool("suggest_next_issue", async () => {
      const suggestion = await suggestNextIssue();
      return toolResponse(suggestion);
    })
  );

  server.registerTool(
    "generate_standup",
    {
      title: "Generate Standup",
      description:
        "Auto-generates a daily standup report from project activity. Shows what was " +
        "completed, what's in progress, what's blocked, and what's coming up next. " +
        "Includes velocity metrics and flow efficiency.",
      inputSchema: {
        lookbackHours: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Hours to look back for activity (default: 24)"),
      },
    },
    wrapTool("generate_standup", async ({ lookbackHours }) => {
      const standup = await generateStandup(lookbackHours ?? 24);
      return toolResponse(standup);
    })
  );

  server.registerTool(
    "generate_retro",
    {
      title: "Generate Retrospective",
      description:
        "Generates a data-driven sprint retrospective. Analyzes velocity trends, " +
        "rework patterns, bottlenecks, cycle times, and dependency health to produce " +
        "What Went Well / What Could Improve / Action Items. Includes patterns and " +
        "metrics evidence for each observation.",
      inputSchema: {
        days: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Sprint length in days to analyze (default: 14)"),
      },
    },
    wrapTool("generate_retro", async ({ days }) => {
      const retro = await generateRetro(days ?? 14);
      return toolResponse(retro);
    })
  );

  server.registerTool(
    "explain_delay",
    {
      title: "Explain Delay",
      description:
        "Root cause analysis for why an issue is slow or stuck. Examines dependency " +
        "chains, rework cycles, bottleneck states, completion risk signals, and time " +
        "allocation (active vs waiting). Returns prioritized delay factors with evidence, " +
        "a chronological timeline, and actionable recommendations.",
      inputSchema: {
        issueNumber: z
          .number()
          .int()
          .positive()
          .describe("GitHub issue number to analyze"),
      },
    },
    wrapTool("explain_delay", async ({ issueNumber }) => {
      const explanation = await explainDelay(issueNumber);
      return toolResponse(explanation);
    })
  );

  server.registerTool(
    "detect_patterns",
    {
      title: "Detect Patterns",
      description:
        "Cross-cutting anomaly detection that surfaces unusual patterns and early " +
        "warning signals across the project. Checks velocity drops, backlog growth, " +
        "rework trends, process violations (WIP limits, stale items), dependency " +
        "cycles and bottlenecks, capacity risks (bus factor, decelerating contributors), " +
        "and knowledge decay. Returns anomalies sorted by severity with evidence, " +
        "trend direction, affected issues, and suggested actions. The 'things you " +
        "should know about' early warning system.",
      inputSchema: {},
    },
    wrapTool("detect_patterns", async () => {
      const report = await detectPatterns();
      return toolResponse(report);
    })
  );

  server.registerTool(
    "generate_release_notes",
    {
      title: "Generate Release Notes",
      description:
        "Build structured release notes from merged PRs and closed issues. " +
        "Groups changes by area, classifies by type (feature/fix/breaking/etc), " +
        "generates stakeholder summary, technical notes, and full markdown. " +
        "Defaults to last 7 days if no date range specified.",
      inputSchema: {
        since: z
          .string()
          .optional()
          .describe("Start date (YYYY-MM-DD). Defaults to 7 days ago"),
        until: z.string().optional().describe("End date (YYYY-MM-DD). Defaults to today"),
        version: z
          .string()
          .optional()
          .describe("Version label for the release. Defaults to the end date"),
      },
    },
    wrapTool("generate_release_notes", async ({ since, until, version }) => {
      const result = await generateReleaseNotes(since, until, version);
      return toolResponse(result);
    })
  );

  server.registerTool(
    "optimize_session",
    {
      title: "Optimize Session",
      description:
        "Context-aware session planning. Analyzes current project state — active " +
        "issues, review queue, rework pending, dependency bottlenecks, stale items, " +
        "anomalies — and recommends the most impactful work for this session. " +
        "Returns a prioritized plan with time estimates, quick wins, and deferrals. " +
        "Use at the start of every coding session for maximum impact.",
      inputSchema: {
        availableMinutes: z
          .number()
          .int()
          .positive()
          .optional()
          .default(120)
          .describe("Available minutes for this session. Default 120"),
        focusArea: z
          .string()
          .optional()
          .describe("Optional: focus on a specific area (frontend, backend, etc)"),
      },
    },
    wrapTool("optimize_session", async ({ availableMinutes, focusArea }) => {
      const result = await optimizeSession(availableMinutes, focusArea);
      return toolResponse(result);
    })
  );

  server.registerTool(
    "get_project_dashboard",
    {
      title: "Project Health Dashboard",
      description:
        "Comprehensive project health report that synthesizes ALL intelligence modules into one view. Gathers board state, velocity, DORA metrics, workflow health, dependency graph, team capacity, and sprint simulation in parallel. Returns: overall health score (0-100) with status, individual health signals for 7 dimensions (velocity, DORA, workflow, dependencies, capacity, knowledge risk, learning), formatted markdown report with board snapshot, velocity table, dependency summary, team capacity breakdown, Monte Carlo histogram, and top 5 actionable recommendations prioritized by impact. Use this as the first call when starting a session or when asked 'how is the project doing?'",
    },
    async () => {
      try {
        const result = await getProjectDashboard();
        return toolResponse(result.report);
      } catch (error) {
        return toolError(error);
      }
    }
  );
}
