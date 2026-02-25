import { z } from "zod";
import { getLocalBoardSummary } from "./db.js";
import {
  getDecisions,
  getOutcomes,
  getInsights,
  getEvents,
  getBoardCache,
} from "./memory.js";
import { getSprintAnalytics } from "./analytics.js";
import { getDORAMetrics } from "./predict.js";
import {
  McpServer,
  toolResponse,
  toolError,
  wrapTool,
} from "./tool-helpers.js";

export function register(server: McpServer) {
  server.registerResource(
    "board-overview",
    "pm://board/overview",
    {
      title: "Project Board Overview",
      description:
        "Current project board state with workflow distribution and health score",
      mimeType: "application/json",
    },
    async (uri) => {
      try {
        const cache = await getBoardCache();
        if (cache) {
          return {
            contents: [{ uri: uri.href, text: JSON.stringify(cache, null, 2) }],
          };
        }

        const summary = await getLocalBoardSummary();
        return {
          contents: [{ uri: uri.href, text: JSON.stringify(summary, null, 2) }],
        };
      } catch (error) {
        return {
          contents: [
            {
              uri: uri.href,
              text: JSON.stringify({
                error: error instanceof Error ? error.message : String(error),
              }),
            },
          ],
        };
      }
    }
  );

  server.registerResource(
    "memory-decisions",
    "pm://memory/decisions",
    {
      title: "Recent Decisions",
      description:
        "Last 20 architectural and technical decisions from project memory",
      mimeType: "application/json",
    },
    async (uri) => {
      const decisions = await getDecisions(20);
      return {
        contents: [{ uri: uri.href, text: JSON.stringify(decisions, null, 2) }],
      };
    }
  );

  server.registerResource(
    "memory-outcomes",
    "pm://memory/outcomes",
    {
      title: "Recent Outcomes",
      description: "Last 20 work outcomes (merged, rework, reverted) from memory",
      mimeType: "application/json",
    },
    async (uri) => {
      const outcomes = await getOutcomes(20);
      return {
        contents: [{ uri: uri.href, text: JSON.stringify(outcomes, null, 2) }],
      };
    }
  );

  server.registerResource(
    "memory-insights",
    "pm://memory/insights",
    {
      title: "Memory Insights",
      description:
        "Analytics from project memory: rework rate, review patterns, area distribution",
      mimeType: "application/json",
    },
    async (uri) => {
      const insights = await getInsights();
      return {
        contents: [{ uri: uri.href, text: JSON.stringify(insights, null, 2) }],
      };
    }
  );

  server.registerResource(
    "event-stream",
    "pm://events/recent",
    {
      title: "Recent Events",
      description:
        "Last 50 events from the structured event stream (sessions, state changes, tool use)",
      mimeType: "application/json",
    },
    async (uri) => {
      const events = await getEvents(50);
      return {
        contents: [{ uri: uri.href, text: JSON.stringify(events, null, 2) }],
      };
    }
  );

  server.registerResource(
    "sprint-analytics",
    "pm://analytics/sprint",
    {
      title: "Sprint Analytics",
      description:
        "Current sprint analytics: cycle time, bottlenecks, flow efficiency, rework analysis",
      mimeType: "application/json",
    },
    async (uri) => {
      try {
        const analytics = await getSprintAnalytics(14);
        return {
          contents: [{ uri: uri.href, text: JSON.stringify(analytics, null, 2) }],
        };
      } catch (error) {
        return {
          contents: [
            {
              uri: uri.href,
              text: JSON.stringify({
                error: error instanceof Error ? error.message : String(error),
              }),
            },
          ],
        };
      }
    }
  );

  server.registerResource(
    "dora-metrics",
    "pm://analytics/dora",
    {
      title: "DORA Metrics",
      description:
        "DORA performance metrics: deployment frequency, lead time, change failure rate, MTTR",
      mimeType: "application/json",
    },
    async (uri) => {
      try {
        const metrics = await getDORAMetrics(30);
        return {
          contents: [{ uri: uri.href, text: JSON.stringify(metrics, null, 2) }],
        };
      } catch (error) {
        return {
          contents: [
            {
              uri: uri.href,
              text: JSON.stringify({
                error: error instanceof Error ? error.message : String(error),
              }),
            },
          ],
        };
      }
    }
  );
}
