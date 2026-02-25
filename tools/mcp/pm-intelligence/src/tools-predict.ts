import { z } from "zod";
import { predictCompletion, predictRework } from "./predict.js";
import { simulateSprint, forecastBacklog } from "./simulate.js";
import { simulateDependencyChange } from "./whatif.js";
import {
  McpServer,
  toolResponse,
  toolError,
  wrapTool,
} from "./tool-helpers.js";

export function register(server: McpServer) {
  server.registerTool(
    "predict_completion",
    {
      title: "Predict Issue Completion",
      description:
        "Predict when an issue will be completed using historical cycle time data. Returns P50/P80/P95 completion dates, a risk score (0-100) with specific risk factors, confidence level based on data quality, and similar issues for comparison. Use this when planning timelines or evaluating if an issue is on track.",
      inputSchema: {
        issueNumber: z
          .number()
          .int()
          .positive()
          .describe("Issue number to predict completion for"),
      },
    },
    wrapTool("predict_completion", async ({ issueNumber }) => {
      const prediction = await predictCompletion(issueNumber);
      return toolResponse(prediction);
    })
  );

  server.registerTool(
    "predict_rework",
    {
      title: "Predict Rework Probability",
      description:
        "Predict the probability that an issue will require rework before it's approved. Analyzes historical rework patterns, development signals (pace, session count, decisions documented), and area-specific baselines. Returns probability (0-1), risk level, weighted signals, and specific mitigations. Use this before moving to Review to catch high-risk PRs early.",
      inputSchema: {
        issueNumber: z
          .number()
          .int()
          .positive()
          .describe("Issue number to predict rework for"),
      },
    },
    wrapTool("predict_rework", async ({ issueNumber }) => {
      const prediction = await predictRework(issueNumber);
      return toolResponse(prediction);
    })
  );

  server.registerTool(
    "simulate_sprint",
    {
      title: "Monte Carlo Sprint Simulation",
      description:
        "Run a Monte Carlo simulation to forecast sprint throughput. Randomly samples from historical cycle time distributions across thousands of trials to produce probabilistic forecasts: 'How many items will we likely finish in N days?' Returns throughput percentiles (P10-P90), completion probability for a target item count, histogram distribution, and data quality assessment. Use this for sprint planning and commitment decisions.",
      inputSchema: {
        itemCount: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Target number of items to evaluate against (default 10)"),
        sprintDays: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Sprint duration in days (default 14)"),
        trials: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Number of simulation trials (default 10000, max 50000)"),
        area: z
          .string()
          .optional()
          .describe("Filter cycle times to a specific area (frontend, backend, contracts, infra)"),
        wipLimit: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Max concurrent items — WIP limit (default 1)"),
      },
    },
    wrapTool("simulate_sprint", async ({ itemCount, sprintDays, trials, area, wipLimit }) => {
      const result = await simulateSprint({
        itemCount,
        sprintDays,
        trials,
        area,
        wipLimit,
      });
      return toolResponse(result);
    })
  );

  server.registerTool(
    "forecast_backlog",
    {
      title: "Monte Carlo Backlog Forecast",
      description:
        "Run a Monte Carlo simulation to answer 'When will we finish these N items?' Produces completion date forecasts with confidence intervals (P50/P80/P95), sprint-by-sprint breakdown showing cumulative progress, and risk analysis (tail risk, variability). Use this for roadmap planning, stakeholder communication, and identifying when a backlog will be cleared.",
      inputSchema: {
        itemCount: z
          .number()
          .int()
          .positive()
          .describe("Total number of items to forecast completing"),
        trials: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Number of simulation trials (default 10000, max 50000)"),
        area: z.string().optional().describe("Filter cycle times to a specific area"),
        wipLimit: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Max concurrent items — WIP limit (default 1)"),
      },
    },
    wrapTool("forecast_backlog", async ({ itemCount, trials, area, wipLimit }) => {
      const result = await forecastBacklog({
        itemCount,
        trials,
        area,
        wipLimit,
      });
      return toolResponse(result);
    })
  );

  server.registerTool(
    "simulate_dependency_change",
    {
      title: "Simulate Dependency Change",
      description:
        "What-if analysis: 'What happens if issue #X slips by N days?' " +
        "Models cascading delay through the dependency graph, shows which issues " +
        "are impacted and by how much, quantifies total schedule slip, critical " +
        "path impact, and suggests mitigations with alternative scenarios. " +
        "Set removeIssue=true to model removing an issue from the dependency chain entirely.",
      inputSchema: {
        issueNumber: z
          .number()
          .int()
          .positive()
          .describe("Issue number to model slipping"),
        slipDays: z.number().positive().describe("Number of days the issue would slip"),
        removeIssue: z
          .boolean()
          .optional()
          .default(false)
          .describe("If true, model removing this issue from the dependency chain"),
      },
    },
    wrapTool("simulate_dependency_change", async ({ issueNumber, slipDays, removeIssue }) => {
      const result = await simulateDependencyChange(issueNumber, slipDays, removeIssue);
      return toolResponse(result);
    })
  );
}
