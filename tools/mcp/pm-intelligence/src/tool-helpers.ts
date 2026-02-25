/**
 * Shared helpers for MCP tool registration.
 *
 * Eliminates the 52x duplicated error handling pattern and provides
 * consistent logging across all tools.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { withLogging } from "./logger.js";

/** Re-export McpServer type for tool group files */
export type { McpServer };

/** Standard MCP tool response wrapping data as JSON */
export function toolResponse(data: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: typeof data === "string" ? data : JSON.stringify(data, null, 2),
      },
    ],
  };
}

/** Standard MCP tool error response */
export function toolError(error: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: `Error: ${error instanceof Error ? error.message : String(error)}`,
      },
    ],
    isError: true as const,
  };
}

/**
 * Wrap an async tool handler with try/catch error handling and logging.
 * Replaces the 52x duplicated try/catch pattern.
 */
export function wrapTool<T>(
  toolName: string,
  handler: (params: T) => Promise<ReturnType<typeof toolResponse>>
): (params: T) => Promise<ReturnType<typeof toolResponse> | ReturnType<typeof toolError>> {
  return async (params: T) => {
    try {
      return await withLogging(toolName, () => handler(params));
    } catch (error) {
      return toolError(error);
    }
  };
}
