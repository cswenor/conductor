#!/usr/bin/env node

/**
 * PM Intelligence MCP Server
 *
 * Thin orchestrator that initializes the MCP server and registers tool groups.
 * Business logic lives in domain modules; tool registration lives in tools-*.ts files.
 * See tool-helpers.ts for shared response/error/logging utilities.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { syncFromGitHub, isSyncStale } from "./sync.js";
import { log } from "./logger.js";
import { invalidateAll } from "./cache.js";

// Tool group registrations
import { register as registerBoard } from "./tools-board.js";
import { register as registerMemory } from "./tools-memory.js";
import { register as registerAnalytics } from "./tools-analytics.js";
import { register as registerPredict } from "./tools-predict.js";
import { register as registerGuardrails } from "./tools-guardrails.js";
import { register as registerGraph } from "./tools-graph.js";
import { register as registerOperations } from "./tools-operations.js";
import { register as registerTriage } from "./tools-triage.js";
import { register as registerResources } from "./tools-resources.js";

const server = new McpServer({
  name: "pm-intelligence",
  version: "0.15.0",
});

// Register all tool groups
registerBoard(server);
registerMemory(server);
registerAnalytics(server);
registerPredict(server);
registerGuardrails(server);
registerGraph(server);
registerOperations(server);
registerTriage(server);
registerResources(server);

// ─── MAIN ───────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log("info", "PM Intelligence MCP Server v0.15.0 running on stdio (52 tools)");

  // Lazy auto-sync: if database is empty, trigger initial sync in background
  try {
    const stale = await isSyncStale();
    if (stale) {
      log("info", "Database empty or stale — triggering background sync");
      syncFromGitHub().then((result) => {
        log("info", `Auto-sync complete: ${result.issues.synced} issues, ${result.prs.synced} PRs (${result.duration_ms}ms)`);
        invalidateAll();
      }).catch((err) => {
        log("warn", `Auto-sync failed: ${err instanceof Error ? err.message : String(err)}`);
      });
    }
  } catch {
    // Non-fatal: server works without sync
  }
}

process.on("SIGINT", async () => {
  console.error("Shutting down PM Intelligence MCP server...");
  await server.close();
  process.exit(0);
});

main().catch((error) => {
  console.error("Fatal error in PM Intelligence MCP server:", error);
  process.exit(1);
});
