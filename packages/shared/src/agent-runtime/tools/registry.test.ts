/**
 * Tool Registry Tests
 */

import { describe, it, expect } from 'vitest';
import type { ToolDefinition } from './types.js';
import { ToolRegistry, createToolRegistry } from './registry.js';

function makeTool(name: string): ToolDefinition {
  return {
    name,
    description: `Test tool: ${name}`,
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    },
    execute: async () => ({ content: 'ok', meta: {} }),
  };
}

describe('ToolRegistry', () => {
  it('registers and retrieves a tool', () => {
    const registry = createToolRegistry();
    const tool = makeTool('read_file');
    registry.register(tool);

    expect(registry.get('read_file')).toBe(tool);
  });

  it('throws on duplicate registration', () => {
    const registry = createToolRegistry();
    registry.register(makeTool('read_file'));

    expect(() => registry.register(makeTool('read_file'))).toThrow(
      'Tool already registered: read_file'
    );
  });

  it('has() returns true for registered tools', () => {
    const registry = createToolRegistry();
    registry.register(makeTool('read_file'));

    expect(registry.has('read_file')).toBe(true);
    expect(registry.has('write_file')).toBe(false);
  });

  it('get() returns undefined for unknown tools', () => {
    const registry = createToolRegistry();
    expect(registry.get('nonexistent')).toBeUndefined();
  });

  it('names() returns all registered tool names', () => {
    const registry = createToolRegistry();
    registry.register(makeTool('read_file'));
    registry.register(makeTool('write_file'));
    registry.register(makeTool('list_files'));

    expect(registry.names()).toEqual(['read_file', 'write_file', 'list_files']);
  });

  it('toAnthropicTools() produces correct SDK format', () => {
    const registry = createToolRegistry();
    registry.register(makeTool('read_file'));
    registry.register(makeTool('write_file'));

    const tools = registry.toAnthropicTools();
    expect(tools).toHaveLength(2);
    expect(tools[0]).toEqual({
      name: 'read_file',
      description: 'Test tool: read_file',
      input_schema: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
      },
    });
  });

  it('createToolRegistry() returns an empty registry', () => {
    const registry = createToolRegistry();
    expect(registry.names()).toHaveLength(0);
  });
});
