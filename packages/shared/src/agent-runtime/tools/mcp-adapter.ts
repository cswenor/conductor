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
import { createLogger } from '../../logger/index.ts';
import type { ToolRegistry } from './registry.ts';
import type { PolicyRule } from './policy.ts';
import type { ToolExecutionContext, ToolInputSchema } from './types.ts';
import { executeAuditedToolCall } from '../executor.ts';

const log = createLogger({ name: 'conductor:mcp-adapter' });

// =============================================================================
// Constants
// =============================================================================

export const MCP_SERVER_NAME = 'conductor-tools';

// =============================================================================
// Types
// =============================================================================

export interface ToolResultEntry {
  type: 'tool_result';
  tool_use_id: string;
  content: string;
  is_error: boolean;
}

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
 * Create an MCP server that wraps all tools from the registry.
 * Each tool handler calls `executeAuditedToolCall()` and pushes
 * the result to the shared `pendingToolResults` array.
 */
export function createImplementerMcpServer(
  registry: ToolRegistry,
  policyRules: PolicyRule[],
  context: ToolExecutionContext,
  db: Database,
  pendingToolResults: ToolResultEntry[],
  pendingToolUseIds: string[],
): ReturnType<typeof createSdkMcpServer> {
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

        // Dequeue tool_use_id from FIFO (populated by stream iterator)
        const toolUseId = pendingToolUseIds.shift()
          ?? `synth_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

        if (toolUseId.startsWith('synth_')) {
          log.warn({ toolName }, 'Using synthetic tool_use_id — queue was empty');
        }

        pendingToolResults.push({
          type: 'tool_result',
          tool_use_id: toolUseId,
          content: audited.content,
          is_error: audited.isError ?? false,
        });

        return {
          content: [{ type: 'text' as const, text: audited.content }],
          isError: audited.isError ?? false,
        };
      },
    ));
  }

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
