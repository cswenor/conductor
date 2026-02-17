/**
 * Agent Tools Module
 *
 * Barrel export for all tool-related types, registry, policy, and tool definitions.
 */

export * from './types.ts';
export { ToolRegistry, createToolRegistry } from './registry.ts';
export * from './policy.ts';
export { resolveRealTarget, checkSymlinkEscape } from './path-safety.ts';
export { registerFilesystemTools, registerReadOnlyFilesystemTools } from './filesystem.ts';
export { registerTestRunnerTool, runTestsTool, isAllowedTestCommand, detectTestCommand, ALLOWED_TEST_COMMANDS, MAX_TEST_OUTPUT_BYTES, DEFAULT_TEST_TIMEOUT_MS } from './test-runner.ts';
export { type ToolResultEntry, recordToolResult, flushToolResults } from './protocol.ts';
export { createMcpToolDefinitions } from './mcp-adapter.ts';
export {
  registerToolsForProfile,
  isValidToolProfile,
  validateProfileForStep,
  VALID_TOOL_PROFILES,
  WRITE_CAPABLE_PROFILES,
  NON_WRITE_PROFILES,
  STEP_PROFILE_CONSTRAINTS,
  type ToolProfile,
} from './profiles.ts';
