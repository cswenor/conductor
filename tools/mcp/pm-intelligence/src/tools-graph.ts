import { z } from "zod";
import {
  analyzeDependencyGraph,
  getIssueDependencies,
} from "./graph.js";
import { getTeamCapacity } from "./capacity.js";
import { planSprint } from "./planner.js";
import { visualizeDependencies } from "./visualize.js";
import {
  McpServer,
  toolResponse,
  toolError,
  wrapTool,
} from "./tool-helpers.js";

export function register(server: McpServer) {
  server.registerTool(
    "analyze_dependency_graph",
    {
      title: "Dependency Graph Analysis",
      description:
        "Analyze the full issue dependency graph: build a DAG from blocked-by labels, cross-references, and body/comment markers. Returns critical path (longest unresolved dependency chain), bottleneck issues (blocking the most other work with transitive counts), cycle detection, orphaned blocked issues (all blockers resolved but still marked blocked), and network metrics (depth, density, connected components). Use this for sprint planning, prioritization, and identifying blocked chains.",
    },
    wrapTool("analyze_dependency_graph", async () => {
      const result = await analyzeDependencyGraph();
      return toolResponse(result);
    })
  );

  server.registerTool(
    "get_issue_dependencies",
    {
      title: "Issue Dependencies",
      description:
        "Get the full dependency tree for a single issue: direct blockers (with resolution status), issues it blocks, full upstream chain (transitive dependencies), full downstream chain (transitive dependents), whether it's unblocked (all blockers resolved), and its execution order position. Use this when evaluating if an issue is ready to work on or understanding its impact on the project.",
      inputSchema: {
        issueNumber: z.number().int().positive().describe("Issue number to analyze"),
      },
    },
    wrapTool("get_issue_dependencies", async ({ issueNumber }) => {
      const result = await getIssueDependencies(issueNumber);
      return toolResponse(result);
    })
  );

  server.registerTool(
    "get_team_capacity",
    {
      title: "Team Capacity Analysis",
      description:
        "Analyze team throughput capacity from git and GitHub history. Builds contributor profiles (velocity, areas, merge time, trend), calculates team-wide metrics (parallelism factor, combined throughput), forecasts sprint capacity (pessimistic/expected/optimistic), identifies area coverage gaps (bus factor), and provides recommendations. Use this for sprint planning, capacity allocation, and identifying bottlenecks in the development process.",
      inputSchema: {
        days: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Analysis period in days (default 60)"),
      },
    },
    wrapTool("get_team_capacity", async ({ days }) => {
      const result = await getTeamCapacity(days ?? 60);
      return toolResponse(result);
    })
  );

  server.registerTool(
    "plan_sprint",
    {
      title: "Sprint Planning Assistant",
      description:
        "AI-powered sprint planning that combines all intelligence modules: dependency graph (what's unblocked), team capacity (who can work on what), Monte Carlo simulation (confidence scoring), and backlog state (what's ready vs blocked). Returns a recommended sprint plan with: ordered items scored by priority/dependencies/capacity, stretch goals, deferred items with reasons, carry-over from in-progress work, confidence intervals, dependency warnings, and actionable recommendations. The 'killer feature' — use this for sprint planning, commitment decisions, and backlog prioritization.",
      inputSchema: {
        durationDays: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Sprint duration in days (default 14)"),
      },
    },
    wrapTool("plan_sprint", async ({ durationDays }) => {
      const result = await planSprint(durationDays ?? 14);
      return toolResponse(result);
    })
  );

  server.registerTool(
    "visualize_dependencies",
    {
      title: "Dependency Visualization",
      description:
        "Render the issue dependency graph as ASCII art and/or Mermaid diagram. Two modes: (1) Full graph — shows all connected issues, critical path highlighted, bottlenecks listed, dependency trees rendered. (2) Single issue — shows upstream blockers, downstream dependents, execution order, chain visualization. ASCII output is ready for terminal/monospace display. Mermaid output renders in GitHub, Notion, Obsidian. Color-coded by workflow state: green=Done, blue=Active, yellow=Review, gray=Ready, dashed=Backlog. Resolved dependencies shown as dotted lines.",
      inputSchema: {
        issueNumber: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Issue number for single-issue view. Omit for full graph."),
        format: z
          .enum(["both", "ascii", "mermaid"])
          .optional()
          .describe("Output format: 'both' (default), 'ascii' only, or 'mermaid' only"),
      },
    },
    async ({ issueNumber, format }) => {
      try {
        const result = await visualizeDependencies(issueNumber, format ?? "both");

        const parts: string[] = [];

        if (result.ascii) {
          parts.push(result.ascii);
        }

        if (result.mermaid) {
          if (parts.length > 0) {
            parts.push("\n---\n");
          }
          parts.push("MERMAID DIAGRAM (paste into GitHub/Notion/Obsidian):\n");
          parts.push(result.mermaid);
        }

        parts.push(`\n${result.summary}`);

        return toolResponse(parts.join("\n"));
      } catch (error) {
        return toolError(error);
      }
    }
  );
}
