/**
 * MCP Tool Adapter
 *
 * Wraps our ToolRegistry tools as SDK MCP tools, routing all execution
 * through the shared `executeAuditedToolCall()` so policy, telemetry,
 * and tool_invocations records are identical to the raw tool-loop path.
 */

import { z } from 'zod/v4';
import { createSdkMcpServer, tool as sdkTool } from '@anthropic-ai/claude-agent-sdk';
import type { SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk';
import type { Database } from 'better-sqlite3';
import type { ToolRegistry } from './registry.ts';
import type { PolicyRule } from './policy.ts';
import type { ToolExecutionContext, ToolInputSchema } from './types.ts';
import { executeAuditedToolCall } from '../executor.ts';
import { recordToolResult } from './protocol.ts';
export type { ToolResultEntry } from './protocol.ts';
import type { ToolResultEntry } from './protocol.ts';

// =============================================================================
// Constants
// =============================================================================

export const MCP_SERVER_NAME = 'conductor-tools';

// =============================================================================
// Zod Schema Conversion
// =============================================================================

/**
 * Convert a JSON Schema property spec to a Zod schema.
 * Our tool schemas are flat objects with simple property types.
 */
function jsonPropertyToZod(prop: Record<string, unknown>): z.ZodType {
  const type = prop['type'] as string | undefined;
  const enumValues = prop['enum'] as string[] | undefined;

  if (enumValues !== undefined && enumValues.length > 0) {
    // Enum of string literals
    if (enumValues.length === 1) return z.literal(enumValues[0] ?? '');
    return z.enum(enumValues as [string, string, ...string[]]);
  }

  switch (type) {
    case 'string':
      return z.string();
    case 'number':
    case 'integer':
      return z.number();
    case 'boolean':
      return z.boolean();
    case 'array':
      return z.array(z.unknown());
    case 'object':
      return z.record(z.string(), z.unknown());
    default:
      return z.unknown();
  }
}

/**
 * Convert a ToolInputSchema (Anthropic JSON Schema format) to a Zod raw shape.
 */
function inputSchemaToZodShape(schema: ToolInputSchema): Record<string, z.ZodType> {
  const shape: Record<string, z.ZodType> = {};
  const properties = schema.properties ?? {};
  const required = new Set(schema.required ?? []);

  for (const [key, propSpec] of Object.entries(properties)) {
    const prop = propSpec as Record<string, unknown>;
    let zodType = jsonPropertyToZod(prop);
    if (!required.has(key)) {
      zodType = zodType.optional();
    }
    shape[key] = zodType;
  }

  return shape;
}

// =============================================================================
// MCP Server Factory
// =============================================================================

/**
 * Create MCP tool definitions that wrap all tools from the registry.
 * Each tool handler calls `executeAuditedToolCall()` and pushes
 * the result to the shared `pendingToolResults` array via `recordToolResult()`.
 */
export function createMcpToolDefinitions(
  registry: ToolRegistry,
  policyRules: PolicyRule[],
  context: ToolExecutionContext,
  db: Database,
  pendingToolResults: ToolResultEntry[],
  pendingToolUseIds: string[],
): SdkMcpToolDefinition[] {
  const tools: SdkMcpToolDefinition[] = [];

  for (const toolName of registry.names()) {
    const toolDef = registry.get(toolName);
    if (toolDef === undefined) continue;

    const zodShape = inputSchemaToZodShape(toolDef.inputSchema);

    tools.push(sdkTool(
      toolName,
      toolDef.description,
      zodShape,
      async (args: Record<string, unknown>) => {
        const audited = await executeAuditedToolCall(
          toolName,
          args,
          registry,
          policyRules,
          context,
          db,
        );

        recordToolResult(pendingToolUseIds, pendingToolResults, toolName, audited);

        return {
          content: [{ type: 'text' as const, text: audited.content }],
          isError: audited.isError ?? false,
        };
      },
    ));
  }

  return tools;
}

/**
 * Create an MCP server that wraps all tools from the registry.
 * Thin wrapper around `createMcpToolDefinitions()`.
 */
export function createAgentMcpServer(
  registry: ToolRegistry,
  policyRules: PolicyRule[],
  context: ToolExecutionContext,
  db: Database,
  pendingToolResults: ToolResultEntry[],
  pendingToolUseIds: string[],
): ReturnType<typeof createSdkMcpServer> {
  const tools = createMcpToolDefinitions(
    registry, policyRules, context, db, pendingToolResults, pendingToolUseIds,
  );

  return createSdkMcpServer({
    name: MCP_SERVER_NAME,
    version: '1.0.0',
    tools,
  });
}

// =============================================================================
// Helpers
// =============================================================================

/**
 * Derive the SDK-format allowed tool names from the registry.
 * The SDK names MCP tools as `mcp__<server-name>__<tool-name>`.
 */
export function getAllowedToolNames(registry: ToolRegistry): string[] {
  return registry.names().map(name => `mcp__${MCP_SERVER_NAME}__${name}`);
}

/** @deprecated Use createAgentMcpServer */
export const createImplementerMcpServer = createAgentMcpServer;
