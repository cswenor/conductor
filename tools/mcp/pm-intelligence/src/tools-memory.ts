import { z } from "zod";
import {
  recordDecision,
  recordOutcome,
  getInsights,
  getEvents,
} from "./memory.js";
import {
  recordReviewOutcome,
  getReviewCalibration,
  checkDecisionDecay,
} from "./review-learning.js";
import {
  McpServer,
  toolResponse,
  toolError,
  wrapTool,
} from "./tool-helpers.js";

export function register(server: McpServer) {
  server.registerTool(
    "record_decision",
    {
      title: "Record Decision",
      description:
        "Record an architectural or technical decision to persistent JSONL memory. Decisions are git-tracked and shared across sessions. Use this when making significant choices about approach, libraries, or architecture.",
      inputSchema: {
        decision: z.string().describe("The decision made"),
        issueNumber: z.number().int().optional().describe("Related issue number"),
        area: z
          .enum(["frontend", "backend", "contracts", "infra"])
          .optional()
          .describe("Area of the codebase"),
        type: z
          .enum(["architectural", "library", "approach", "workaround"])
          .optional()
          .describe("Decision type"),
        rationale: z.string().optional().describe("Why this was chosen"),
        alternatives: z.array(z.string()).optional().describe("Alternatives considered"),
        files: z.array(z.string()).optional().describe("Affected file paths"),
      },
    },
    async ({ decision, issueNumber, area, type, rationale, alternatives, files }) => {
      try {
        await recordDecision({
          decision,
          issueNumber,
          area,
          type,
          rationale,
          alternatives,
          files,
        });
        return toolResponse(`Decision recorded: ${decision}`);
      } catch (error) {
        return toolError(error);
      }
    }
  );

  server.registerTool(
    "record_outcome",
    {
      title: "Record Outcome",
      description:
        "Record a work outcome (merged, rework, reverted, abandoned) to persistent memory. Automatically called on Done transitions, but can be called directly for manual recording with richer detail.",
      inputSchema: {
        issueNumber: z.number().int().positive().describe("Issue number"),
        result: z
          .enum(["merged", "rework", "reverted", "abandoned"])
          .describe("Outcome result"),
        prNumber: z.number().int().optional().describe("PR number"),
        reviewRounds: z
          .number()
          .int()
          .optional()
          .describe("Number of review rounds"),
        reworkReasons: z.array(z.string()).optional().describe("Reasons for rework"),
        area: z.string().optional().describe("Area"),
        summary: z.string().optional().describe("Approach summary"),
        lessons: z.string().optional().describe("Lessons learned"),
      },
    },
    async ({
      issueNumber,
      result,
      prNumber,
      reviewRounds,
      reworkReasons,
      area,
      summary,
      lessons,
    }) => {
      try {
        await recordOutcome({
          issueNumber,
          result,
          prNumber,
          reviewRounds,
          reworkReasons,
          area,
          summary,
          lessons,
        });
        return toolResponse(`Outcome recorded: Issue #${issueNumber} → ${result}`);
      } catch (error) {
        return toolError(error);
      }
    }
  );

  server.registerTool(
    "get_memory_insights",
    {
      title: "Memory Insights",
      description:
        "Analyze persistent memory for patterns: rework rate, average review rounds, top areas, recent lessons, decision type distribution. Use this to learn from past work and identify improvement areas.",
    },
    wrapTool("get_memory_insights", async () => {
      const insights = await getInsights();
      return toolResponse(insights);
    })
  );

  server.registerTool(
    "get_event_stream",
    {
      title: "Get Event Stream",
      description:
        "Query the structured event stream — session starts, state transitions, tool use, errors. Use this for debugging, analytics, and understanding what happened in previous sessions.",
      inputSchema: {
        limit: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Max events to return (default 50, most recent)"),
        issueNumber: z.number().int().optional().describe("Filter by issue number"),
        eventType: z
          .string()
          .optional()
          .describe(
            "Filter by event type (session_start, workflow_change, needs_input, error, etc.)"
          ),
      },
    },
    wrapTool("get_event_stream", async ({ limit, issueNumber, eventType }) => {
      const events = await getEvents(limit ?? 50, { issueNumber, eventType });
      return toolResponse(events);
    })
  );

  server.registerTool(
    "record_review_outcome",
    {
      title: "Record Review Finding Outcome",
      description:
        "Record the disposition of a review finding (accepted, dismissed, modified, deferred). Called after a review cycle completes. This data is used to calibrate future reviews — tracking which finding types have high hit rates vs high false positive rates. Use this after /pm-review to close the feedback loop.",
      inputSchema: {
        issueNumber: z.number().int().positive().describe("Issue number"),
        prNumber: z.number().int().optional().describe("PR number"),
        findingType: z
          .string()
          .describe("Finding category (e.g., scope_verification, failure_mode, comment_verification, adversarial_edge_case, hook_overhead, path_robustness)"),
        severity: z
          .enum(["blocking", "non_blocking", "suggestion"])
          .describe("Finding severity"),
        disposition: z
          .enum(["accepted", "dismissed", "modified", "deferred"])
          .describe("What happened: accepted (fixed), dismissed (not valid), modified (partially addressed), deferred (tracked for later)"),
        reason: z
          .string()
          .optional()
          .describe("Why this disposition was chosen (especially important for dismissals)"),
        area: z.string().optional().describe("Area of the finding"),
        files: z.array(z.string()).optional().describe("Files related to the finding"),
      },
    },
    wrapTool(
      "record_review_outcome",
      async ({ issueNumber, prNumber, findingType, severity, disposition, reason, area, files }) => {
        const result = await recordReviewOutcome({
          issueNumber,
          prNumber,
          findingType,
          severity,
          disposition,
          reason,
          area,
          files,
        });
        return toolResponse(result);
      }
    )
  );

  server.registerTool(
    "get_review_calibration",
    {
      title: "Review Calibration Report",
      description:
        "Analyze review finding history to calculate hit rates (accepted vs dismissed), identify false positive patterns, and generate calibration data by finding type, severity, and area. Includes trend analysis (improving/stable/declining) and specific recommendations for adjusting review focus. Use this to improve review quality over time.",
      inputSchema: {
        days: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Analysis period in days (default 90)"),
      },
    },
    wrapTool("get_review_calibration", async ({ days }) => {
      const calibration = await getReviewCalibration(days ?? 90);
      return toolResponse(calibration);
    })
  );

  server.registerTool(
    "check_decision_decay",
    {
      title: "Check Decision Decay",
      description:
        "Detect stale architectural decisions whose context has drifted. Analyzes decisions based on: age, file churn (referenced files changed since), potential supersession (newer decisions in same area), and area activity level. Returns a decay score (0-100) per decision with specific signals and recommendations. Use this periodically to maintain decision hygiene.",
      inputSchema: {
        days: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Look-back period in days (default 180)"),
      },
    },
    wrapTool("check_decision_decay", async ({ days }) => {
      const report = await checkDecisionDecay(days ?? 180);
      return toolResponse(report);
    })
  );
}
