/**
 * GitHub API integration via `gh` CLI.
 *
 * v0.15.0: Stripped all GitHub Projects operations (GraphQL field mutations,
 * board queries, project item lookups). Those are now local SQLite operations.
 *
 * Remaining GitHub operations:
 *   - Issue/PR queries (for sync adapter)
 *   - Velocity metrics (from merged PRs / closed issues)
 *   - Repo detection
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getConfig, getRepoSlug } from "./config.js";

const execFileAsync = promisify(execFile);

/** Execute a gh CLI command and return stdout */
export async function gh(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("gh", args, {
    timeout: 30_000,
    maxBuffer: 10 * 1024 * 1024,
  });
  return stdout.trim();
}

// ─── Repo Detection ──────────────────────────────────────

/** Get the repo name from git remote */
export async function getRepoName(): Promise<string> {
  const config = await getConfig();
  return config.repo;
}

// ─── Velocity (from GitHub API — still needed for cross-repo context) ─

export interface VelocityMetrics {
  last7Days: { merged: number; closed: number; opened: number };
  last30Days: { merged: number; closed: number; opened: number };
  avgDaysToMerge: number | null;
}

/** Calculate velocity metrics from recent GitHub activity */
export async function getVelocity(): Promise<VelocityMetrics> {
  const fullRepo = await getRepoSlug();

  // Recent merged PRs
  const merged7 = await gh([
    "pr",
    "list",
    "--repo",
    fullRepo,
    "--state",
    "merged",
    "--json",
    "number,mergedAt,createdAt",
    "--limit",
    "50",
  ]);
  const mergedPRs: Array<{ mergedAt: string; createdAt: string }> =
    JSON.parse(merged7);

  const now = Date.now();
  const day7 = 7 * 24 * 60 * 60 * 1000;
  const day30 = 30 * 24 * 60 * 60 * 1000;

  const merged7Count = mergedPRs.filter(
    (p) => now - new Date(p.mergedAt).getTime() < day7
  ).length;
  const merged30Count = mergedPRs.filter(
    (p) => now - new Date(p.mergedAt).getTime() < day30
  ).length;

  // Average days to merge (from recent PRs)
  const mergeTimes = mergedPRs
    .filter((p) => now - new Date(p.mergedAt).getTime() < day30)
    .map(
      (p) =>
        (new Date(p.mergedAt).getTime() - new Date(p.createdAt).getTime()) /
        (1000 * 60 * 60 * 24)
    );
  const avgDaysToMerge =
    mergeTimes.length > 0
      ? Math.round(
          (mergeTimes.reduce((a, b) => a + b, 0) / mergeTimes.length) * 10
        ) / 10
      : null;

  // Recent issues
  const closed7 = await gh([
    "issue",
    "list",
    "--repo",
    fullRepo,
    "--state",
    "closed",
    "--json",
    "closedAt",
    "--limit",
    "50",
  ]);
  const closedIssues: Array<{ closedAt: string }> = JSON.parse(closed7);
  const closed7Count = closedIssues.filter(
    (i) => now - new Date(i.closedAt).getTime() < day7
  ).length;
  const closed30Count = closedIssues.filter(
    (i) => now - new Date(i.closedAt).getTime() < day30
  ).length;

  const opened = await gh([
    "issue",
    "list",
    "--repo",
    fullRepo,
    "--state",
    "all",
    "--json",
    "createdAt",
    "--limit",
    "50",
  ]);
  const openedIssues: Array<{ createdAt: string }> = JSON.parse(opened);
  const opened7Count = openedIssues.filter(
    (i) => now - new Date(i.createdAt).getTime() < day7
  ).length;
  const opened30Count = openedIssues.filter(
    (i) => now - new Date(i.createdAt).getTime() < day30
  ).length;

  return {
    last7Days: {
      merged: merged7Count,
      closed: closed7Count,
      opened: opened7Count,
    },
    last30Days: {
      merged: merged30Count,
      closed: closed30Count,
      opened: opened30Count,
    },
    avgDaysToMerge,
  };
}
