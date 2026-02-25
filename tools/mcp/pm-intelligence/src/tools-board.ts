import { z } from "zod";
import { WORKFLOW_STATES } from "./config.js";
import {
  getIssue,
  getLocalBoardSummary,
  moveIssueWorkflow,
  addDependency,
  getDependencies,
  getCycleTimes,
  type WorkflowState,
} from "./db.js";
import { syncFromGitHub } from "./sync.js";
import { getVelocity } from "./github.js";
import { invalidateAll } from "./cache.js";
import { withLogging } from "./logger.js";
import {
  McpServer,
  toolResponse,
  toolError,
  wrapTool,
} from "./tool-helpers.js";

export function register(server: McpServer) {
  server.registerTool(
    "get_issue_status",
    {
      title: "Get Issue Status",
      description:
        "Get the current workflow state, priority, labels, assignees, and dependencies for an issue. Reads from local SQLite database (instant). Run sync_from_github first if data might be stale.",
      inputSchema: {
        issueNumber: z.number().int().positive().describe("Issue number"),
      },
    },
    async ({ issueNumber }) => {
      try {
        const issue = await getIssue(issueNumber);
        if (!issue) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Issue #${issueNumber} not found in local database. Run sync_from_github to pull from GitHub.`,
              },
            ],
            isError: true,
          };
        }

        const deps = await getDependencies(issueNumber);
        return toolResponse({ ...issue, dependencies: deps });
      } catch (error) {
        return toolError(error);
      }
    }
  );

  server.registerTool(
    "get_board_summary",
    {
      title: "Project Board Summary",
      description:
        "Get a comprehensive project board summary from local database: issue counts by workflow state, priority distribution, active/review/rework items, blocked items with dependency info, and a health score (0-100). Instant — no GitHub API calls.",
    },
    wrapTool("get_board_summary", async () => {
      const summary = await getLocalBoardSummary();
      return toolResponse(summary);
    })
  );

  server.registerTool(
    "move_issue",
    {
      title: "Move Issue",
      description:
        "Move an issue to a new workflow state in the local database. Enforces transition rules and WIP limits. Valid states: Backlog, Ready, Active, Review, Rework, Done. Every transition is recorded in the event log with timestamp.",
      inputSchema: {
        issueNumber: z.number().int().positive().describe("Issue number"),
        targetState: z
          .enum(WORKFLOW_STATES)
          .describe("Target workflow state"),
      },
    },
    wrapTool("move_issue", async ({ issueNumber, targetState }) => {
      const result = await moveIssueWorkflow(issueNumber, targetState as WorkflowState);
      return toolResponse(result);
    })
  );

  server.registerTool(
    "sync_from_github",
    {
      title: "Sync from GitHub",
      description:
        "Pull latest issues and PRs from GitHub into the local database. Runs incrementally (only items updated since last sync). Use force=true for a full refresh. Typically runs on session start.",
      inputSchema: {
        force: z.boolean().optional().describe("Force full sync instead of incremental"),
      },
    },
    async ({ force }) => {
      try {
        const result = await withLogging("sync_from_github", () =>
          syncFromGitHub({ force: force || false })
        );
        invalidateAll();
        return toolResponse(result);
      } catch (error) {
        return toolError(error);
      }
    }
  );

  server.registerTool(
    "add_dependency",
    {
      title: "Add Dependency",
      description:
        "Add a dependency between two issues. The blocker must be completed before the blocked issue can proceed. Includes cycle detection — will reject if adding the dependency would create a circular dependency.",
      inputSchema: {
        blockerIssue: z.number().int().positive().describe("Issue that blocks"),
        blockedIssue: z.number().int().positive().describe("Issue that is blocked"),
        depType: z.enum(["blocks", "prerequisite", "related"]).optional().describe("Dependency type"),
      },
    },
    wrapTool("add_dependency", async ({ blockerIssue, blockedIssue, depType }) => {
      await addDependency(blockerIssue, blockedIssue, depType || "blocks");
      return toolResponse(`Dependency added: #${blockerIssue} blocks #${blockedIssue}`);
    })
  );

  server.registerTool(
    "get_cycle_times",
    {
      title: "Get Cycle Times",
      description:
        "Get cycle times (Active → Done) for completed issues. Shows hours from first Active transition to Done, plus the full workflow path taken. Useful for velocity analysis and estimation.",
      inputSchema: {
        days: z.number().int().positive().optional().describe("Lookback period in days (default: 90)"),
      },
    },
    async ({ days }) => {
      try {
        const times = await getCycleTimes(days || 90);
        const avgHours =
          times.length > 0
            ? Math.round((times.reduce((sum, item) => sum + item.hours, 0) / times.length) * 10) /
              10
            : null;

        return toolResponse({
          count: times.length,
          averageHours: avgHours,
          averageDays: avgHours ? Math.round((avgHours / 24) * 10) / 10 : null,
          issues: times,
        });
      } catch (error) {
        return toolError(error);
      }
    }
  );

  server.registerTool(
    "get_velocity",
    {
      title: "Get Velocity Metrics",
      description:
        "Calculate project velocity: PRs merged, issues closed, issues opened for 7-day and 30-day windows. Also returns average days-to-merge for recent PRs.",
    },
    wrapTool("get_velocity", async () => {
      const metrics = await getVelocity();
      return toolResponse(metrics);
    })
  );
}
