/**
 * GitHub sync adapter — pulls issues and PRs into local SQLite.
 *
 * GitHub is the source of truth for issue content. This syncs:
 *   - Issues (title, body, state, labels, assignees)
 *   - Pull requests (state, review status, linked issues)
 *   - Comments (snapshot for context recovery)
 *
 * Sync is incremental: only fetches items updated since last sync.
 * Designed to run on session start (~2-5 seconds for typical projects).
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  upsertIssue,
  upsertPR,
  updateSyncState,
  getLastSync,
  getDb,
} from "./db.js";
import { getConfig } from "./config.js";

const execFileAsync = promisify(execFile);

/** Execute a gh CLI command and return stdout */
async function gh(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("gh", args, {
    timeout: 30_000,
    maxBuffer: 10 * 1024 * 1024,
  });
  return stdout.trim();
}

// ─── Issue Sync ──────────────────────────────────────────

interface GitHubIssue {
  number: number;
  title: string;
  body: string;
  state: string;
  author: { login: string };
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  labels: Array<{ name: string }>;
  assignees: Array<{ login: string }>;
}

/** Sync issues from GitHub to local DB */
async function syncIssues(
  since?: string
): Promise<{ synced: number; created: number; updated: number }> {
  const config = await getConfig();
  const fullRepo = `${config.owner}/${config.repo}`;

  // Fetch issues updated since last sync
  const args = [
    "issue",
    "list",
    "--repo",
    fullRepo,
    "--state",
    "all",
    "--json",
    "number,title,body,state,author,createdAt,updatedAt,closedAt,labels,assignees",
    "--limit",
    "200",
  ];

  const raw = await gh(args);
  const issues: GitHubIssue[] = JSON.parse(raw);

  let created = 0;
  let updated = 0;

  for (const issue of issues) {
    // Skip if not updated since last sync (when we have a since date)
    if (since && new Date(issue.updatedAt) < new Date(since)) {
      continue;
    }

    const result = await upsertIssue({
      number: issue.number,
      title: issue.title,
      body: issue.body || null,
      state: issue.state.toLowerCase(),
      author: issue.author?.login || null,
      created_at: issue.createdAt,
      updated_at: issue.updatedAt,
      closed_at: issue.closedAt || null,
      labels: issue.labels.map((l) => l.name),
      assignees: issue.assignees.map((a) => a.login),
    });

    if (result.isNew) created++;
    else updated++;
  }

  await updateSyncState("issues");

  return { synced: issues.length, created, updated };
}

// ─── PR Sync ─────────────────────────────────────────────

interface GitHubPR {
  number: number;
  title: string;
  state: string;
  author: { login: string };
  headRefName: string;
  baseRefName: string;
  createdAt: string;
  updatedAt: string;
  mergedAt: string | null;
  closedAt: string | null;
  additions: number;
  deletions: number;
  changedFiles: number;
  reviewDecision: string | null;
  isDraft: boolean;
  body: string;
}

/** Extract linked issue numbers from PR body */
function extractLinkedIssues(
  body: string
): Array<{ issue_number: number; link_type: string }> {
  const links: Array<{ issue_number: number; link_type: string }> = [];
  const patterns = [
    { regex: /(?:fixes|fix)\s+#(\d+)/gi, type: "fixes" },
    { regex: /(?:closes|close)\s+#(\d+)/gi, type: "closes" },
    { regex: /(?:resolves|resolve)\s+#(\d+)/gi, type: "resolves" },
  ];

  for (const { regex, type } of patterns) {
    let match;
    while ((match = regex.exec(body)) !== null) {
      links.push({ issue_number: parseInt(match[1]), link_type: type });
    }
  }

  return links;
}

/** Map GitHub review decision to our state */
function mapReviewState(decision: string | null): string | null {
  if (!decision) return null;
  const map: Record<string, string> = {
    APPROVED: "approved",
    CHANGES_REQUESTED: "changes_requested",
    REVIEW_REQUIRED: "pending",
  };
  return map[decision] || null;
}

/** Sync pull requests from GitHub to local DB */
async function syncPRs(
  since?: string
): Promise<{ synced: number }> {
  const config = await getConfig();
  const fullRepo = `${config.owner}/${config.repo}`;

  const args = [
    "pr",
    "list",
    "--repo",
    fullRepo,
    "--state",
    "all",
    "--json",
    "number,title,state,author,headRefName,baseRefName,createdAt,updatedAt,mergedAt,closedAt,additions,deletions,changedFiles,reviewDecision,isDraft,body",
    "--limit",
    "100",
  ];

  const raw = await gh(args);
  const prs: GitHubPR[] = JSON.parse(raw);

  let synced = 0;

  for (const pr of prs) {
    if (since && new Date(pr.updatedAt) < new Date(since)) {
      continue;
    }

    const linkedIssues = extractLinkedIssues(pr.body || "");

    await upsertPR({
      number: pr.number,
      title: pr.title,
      state: pr.mergedAt ? "merged" : pr.state.toLowerCase(),
      author: pr.author?.login || null,
      branch: pr.headRefName || null,
      base_branch: pr.baseRefName || null,
      created_at: pr.createdAt,
      updated_at: pr.updatedAt,
      merged_at: pr.mergedAt || null,
      closed_at: pr.closedAt || null,
      additions: pr.additions || 0,
      deletions: pr.deletions || 0,
      changed_files: pr.changedFiles || 0,
      review_state: mapReviewState(pr.reviewDecision),
      draft: pr.isDraft || false,
      linked_issues: linkedIssues,
    });

    synced++;
  }

  await updateSyncState("pull_requests");

  return { synced };
}

// ─── Full Sync ───────────────────────────────────────────

export interface SyncResult {
  issues: { synced: number; created: number; updated: number };
  prs: { synced: number };
  duration_ms: number;
  incremental: boolean;
}

/** Run a full sync from GitHub to local DB */
export async function syncFromGitHub(
  options?: { force?: boolean }
): Promise<SyncResult> {
  const start = Date.now();

  // Check last sync time for incremental sync
  let since: string | undefined;
  if (!options?.force) {
    const lastIssueSync = await getLastSync("issues");
    if (lastIssueSync) {
      since = lastIssueSync.last_sync;
    }
  }

  const [issueResult, prResult] = await Promise.all([
    syncIssues(since),
    syncPRs(since),
  ]);

  // Record sync event
  const db = await getDb();
  db.prepare(`
    INSERT INTO events (event_type, actor, metadata)
    VALUES ('sync', 'system', ?)
  `).run(
    JSON.stringify({
      issues_synced: issueResult.synced,
      issues_created: issueResult.created,
      issues_updated: issueResult.updated,
      prs_synced: prResult.synced,
      incremental: !!since,
    })
  );

  return {
    issues: issueResult,
    prs: prResult,
    duration_ms: Date.now() - start,
    incremental: !!since,
  };
}

/** Check if sync is needed (stale > 1 hour) */
export async function isSyncStale(): Promise<boolean> {
  const lastSync = await getLastSync("issues");
  if (!lastSync) return true;

  const age = Date.now() - new Date(lastSync.last_sync).getTime();
  return age > 60 * 60 * 1000; // 1 hour
}
