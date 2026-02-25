/**
 * PM configuration — minimal, local-first.
 *
 * v0.15.0: Dropped all GitHub Projects field/option IDs.
 * Workflow state, priority, and dependencies live in local SQLite.
 * Only owner/repo are needed for GitHub API calls (issue sync, PR sync).
 *
 * Config is read from .claude-pm-toolkit.json in the repo root,
 * with fallback to git remote URL detection.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

const execFileAsync = promisify(execFile);

// ─── Config Types ────────────────────────────────────────

export interface PMConfig {
  owner: string;
  repo: string;
}

// ─── Config Loading ──────────────────────────────────────

let _config: PMConfig | null = null;
let _repoRoot: string | null = null;

/** Get the repo root */
export async function getRepoRoot(): Promise<string> {
  if (_repoRoot) return _repoRoot;
  const { stdout } = await execFileAsync("git", [
    "rev-parse",
    "--show-toplevel",
  ]);
  _repoRoot = stdout.trim();
  return _repoRoot;
}

/** Load PM config from .claude-pm-toolkit.json or git remote */
export async function getConfig(): Promise<PMConfig> {
  if (_config) return _config;

  const root = await getRepoRoot();
  const configPath = join(root, ".claude-pm-toolkit.json");

  // Try config file first
  if (existsSync(configPath)) {
    const content = await readFile(configPath, "utf-8");
    const json = JSON.parse(content);
    if (json.owner && json.repo) {
      _config = { owner: json.owner, repo: json.repo };
      return _config;
    }
  }

  // Fall back to git remote detection
  const { stdout } = await execFileAsync("git", [
    "remote",
    "get-url",
    "origin",
  ]);
  const url = stdout.trim();
  const match = url.match(/(?:github\.com[:/])([^/]+)\/([^/.\s]+)/);
  if (!match) throw new Error(`Cannot parse repo from remote URL: ${url}`);

  _config = {
    owner: match[1],
    repo: match[2].replace(/\.git$/, ""),
  };
  return _config;
}

/** Get full repo slug (owner/repo) */
export async function getRepoSlug(): Promise<string> {
  const config = await getConfig();
  return `${config.owner}/${config.repo}`;
}

// ─── Workflow Constants ──────────────────────────────────

/** Valid workflow states (managed locally, not on GitHub Projects) */
export const WORKFLOW_STATES = [
  "Backlog",
  "Ready",
  "Active",
  "Review",
  "Rework",
  "Done",
] as const;

export type WorkflowState = (typeof WORKFLOW_STATES)[number];

/** Valid priority levels */
export const PRIORITY_LEVELS = ["critical", "high", "normal"] as const;

export type Priority = (typeof PRIORITY_LEVELS)[number];

/** Valid issue types */
export const ISSUE_TYPES = [
  "bug",
  "feature",
  "spike",
  "epic",
  "chore",
] as const;

export type IssueType = (typeof ISSUE_TYPES)[number];

// ─── Operational Defaults ────────────────────────────────
// Centralized constants previously hardcoded across db.ts, sync.ts, analytics.ts

/** Max concurrent Active issues (WIP limit enforced by moveIssueWorkflow) */
export const WIP_LIMIT = 1;

/** Sync is considered stale after this many milliseconds (1 hour) */
export const SYNC_STALE_MS = 60 * 60 * 1000;

/** Bottleneck thresholds (hours) for analytics detectBottlenecks */
export const BOTTLENECK_THRESHOLDS = {
  reviewAvgHours: 24,
  reworkAvgHours: 8,
  readyAvgHours: 48,
  activeAvgHours: 72,
} as const;

/** Stale issue thresholds (days) for workflow health */
export const STALE_THRESHOLDS = {
  activeDays: 7,
  reviewDays: 5,
  reworkDays: 3,
} as const;

/** GitHub sync fetch limits */
export const SYNC_LIMITS = {
  issuesPerSync: 200,
  prsPerSync: 100,
  ghTimeoutMs: 30_000,
  ghMaxBuffer: 10 * 1024 * 1024,
} as const;
