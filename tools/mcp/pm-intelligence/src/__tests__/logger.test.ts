import { describe, it, expect, vi, beforeEach } from "vitest";
import { log, logTool, recordToolCall, getToolMetrics, withLogging } from "../logger.js";

// Capture stderr output
const stderrSpy = vi.spyOn(console, "error").mockImplementation(() => {});

beforeEach(() => {
  stderrSpy.mockClear();
});

describe("log()", () => {
  it("writes to stderr", () => {
    log("info", "test message");
    expect(stderrSpy).toHaveBeenCalledOnce();
    const output = stderrSpy.mock.calls[0][0] as string;
    expect(output).toContain("INFO");
    expect(output).toContain("test message");
  });

  it("includes timestamp in ISO format", () => {
    log("warn", "warning");
    const output = stderrSpy.mock.calls[0][0] as string;
    expect(output).toMatch(/\d{4}-\d{2}-\d{2}T/);
  });
});

describe("logTool()", () => {
  it("includes tool name and duration", () => {
    logTool("sync_from_github", "info", "completed", 150);
    const output = stderrSpy.mock.calls[0][0] as string;
    expect(output).toContain("[sync_from_github]");
    expect(output).toContain("(150ms)");
    expect(output).toContain("completed");
  });
});

describe("recordToolCall() / getToolMetrics()", () => {
  it("tracks call counts and errors", () => {
    recordToolCall("test_tool", 100, false);
    recordToolCall("test_tool", 200, false);
    recordToolCall("test_tool", 50, true);

    const metrics = getToolMetrics();
    expect(metrics["test_tool"].calls).toBe(3);
    expect(metrics["test_tool"].errors).toBe(1);
    expect(metrics["test_tool"].totalMs).toBe(350);
    expect(metrics["test_tool"].avgMs).toBe(117); // Math.round(350/3)
    expect(metrics["test_tool"].lastCallAt).toBeTruthy();
  });
});

describe("withLogging()", () => {
  it("returns the function result", async () => {
    const result = await withLogging("my_tool", async () => "done");
    expect(result).toBe("done");
  });

  it("records metrics on success", async () => {
    await withLogging("logged_tool", async () => 42);
    const metrics = getToolMetrics();
    expect(metrics["logged_tool"]).toBeDefined();
    expect(metrics["logged_tool"].calls).toBeGreaterThanOrEqual(1);
    expect(metrics["logged_tool"].errors).toBe(0);
  });

  it("records metrics and rethrows on error", async () => {
    await expect(
      withLogging("error_tool", async () => {
        throw new Error("boom");
      })
    ).rejects.toThrow("boom");

    const metrics = getToolMetrics();
    expect(metrics["error_tool"].errors).toBeGreaterThanOrEqual(1);
  });
});
