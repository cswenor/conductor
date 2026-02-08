/**
 * Tool Registry
 *
 * Manages tool definitions and converts them to Anthropic SDK format.
 * Each tool is registered once; duplicates throw.
 */

import type Anthropic from '@anthropic-ai/sdk';
import type { ToolDefinition } from './types.ts';

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition>();

  register(tool: ToolDefinition): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool already registered: ${tool.name}`);
    }
    this.tools.set(tool.name, tool);
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  names(): string[] {
    return Array.from(this.tools.keys());
  }

  toAnthropicTools(): Anthropic.Tool[] {
    return Array.from(this.tools.values()).map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: {
        type: 'object' as const,
        properties: tool.inputSchema.properties,
        required: tool.inputSchema.required,
      },
    }));
  }
}

export function createToolRegistry(): ToolRegistry {
  return new ToolRegistry();
}
