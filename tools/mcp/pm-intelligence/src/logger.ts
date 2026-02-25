/**
 * Structured logging for MCP tool execution.
 *
 * Logs to stderr (MCP protocol uses stdout for JSON-RPC).
 * Provides a tool execution wrapper that captures timing, errors, and context.
 */

// ─── Types ──────────────────────────────────────────────

interface LogEntry {
  timestamp: string;
  level: "info" | "warn" | "error" | "debug";
  tool?: string;
  duration_ms?: number;
  message: string;
  context?: Record<string, unknown>;
}

// ─── Logger ─────────────────────────────────────────────

function formatEntry(entry: LogEntry): string {
  const parts = [
    entry.timestamp,
    entry.level.toUpperCase().padEnd(5),
  ];

  if (entry.tool) {
    parts.push(`[${entry.tool}]`);
  }

  parts.push(entry.message);

  if (entry.duration_ms !== undefined) {
    parts.push(`(${entry.duration_ms}ms)`);
  }

  return parts.join(" ");
}

export function log(
  level: LogEntry["level"],
  message: string,
  context?: Record<string, unknown>
): void {
  const entry: LogEntry = {
    timestamp: new Date().toISOString(),
    level,
    message,
    context,
  };
  console.error(formatEntry(entry));
}

export function logTool(
  tool: string,
  level: LogEntry["level"],
  message: string,
  duration_ms?: number,
  context?: Record<string, unknown>
): void {
  const entry: LogEntry = {
    timestamp: new Date().toISOString(),
    level,
    tool,
    duration_ms,
    message,
    context,
  };
  console.error(formatEntry(entry));
}

// ─── Tool Metrics ───────────────────────────────────────

interface ToolMetrics {
  calls: number;
  errors: number;
  totalMs: number;
  lastCallAt: string | null;
}

const metrics = new Map<string, ToolMetrics>();

export function recordToolCall(
  tool: string,
  durationMs: number,
  isError: boolean
): void {
  const existing = metrics.get(tool) || {
    calls: 0,
    errors: 0,
    totalMs: 0,
    lastCallAt: null,
  };

  existing.calls++;
  if (isError) existing.errors++;
  existing.totalMs += durationMs;
  existing.lastCallAt = new Date().toISOString();

  metrics.set(tool, existing);
}

export function getToolMetrics(): Record<string, ToolMetrics & { avgMs: number }> {
  const result: Record<string, ToolMetrics & { avgMs: number }> = {};
  for (const [tool, m] of metrics) {
    result[tool] = {
      ...m,
      avgMs: m.calls > 0 ? Math.round(m.totalMs / m.calls) : 0,
    };
  }
  return result;
}

/**
 * Wrap a tool handler with logging and metrics.
 * Returns the same result but logs execution time and errors.
 */
export async function withLogging<T>(
  toolName: string,
  fn: () => Promise<T>
): Promise<T> {
  const start = Date.now();
  try {
    const result = await fn();
    const duration = Date.now() - start;
    recordToolCall(toolName, duration, false);
    if (duration > 1000) {
      logTool(toolName, "warn", "slow execution", duration);
    }
    return result;
  } catch (error) {
    const duration = Date.now() - start;
    recordToolCall(toolName, duration, true);
    logTool(
      toolName,
      "error",
      error instanceof Error ? error.message : String(error),
      duration
    );
    throw error;
  }
}
