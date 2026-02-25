/**
 * Git history mining — learn from past PRs, commits, and file change patterns.
 *
 * Analyzes git log to extract:
 *   - File change hotspots (which files change most → highest risk)
 *   - PR merge patterns (time-to-merge, files per PR, rework indicators)
 *   - Coupling analysis (files that always change together)
 *   - Contributor patterns (who works on what areas)
 *   - Commit frequency (active hours, productivity patterns)
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// ─── Types ──────────────────────────────────────────────

export interface HistoryInsights {
  period: { from: string; to: string; totalCommits: number };
  hotspots: Array<{
    file: string;
    changes: number;
    additions: number;
    deletions: number;
    churn: number; // additions + deletions (high churn = high risk)
  }>;
  coupling: Array<{
    files: [string, string];
    coChangeCount: number;
    confidence: number; // 0-1, how often they change together
  }>;
  prPatterns: {
    totalPRs: number;
    avgFilesPerPR: number;
    avgTimeToMergeDays: number | null;
    largestPRFiles: number;
    mergesByType: Record<string, number>;
  };
  commitPatterns: {
    byType: Record<string, number>;
    byScope: Record<string, number>;
    avgCommitsPerDay: number;
    peakDayOfWeek: string;
    peakHour: number;
  };
  riskAreas: Array<{
    path: string;
    riskScore: number; // 0-100
    reasons: string[];
  }>;
}

// ─── Git Log Parsing ────────────────────────────────────

interface GitCommit {
  hash: string;
  date: string;
  author: string;
  subject: string;
  files: Array<{ additions: number; deletions: number; path: string }>;
}

/** Parse git log with numstat into structured commits */
async function getGitLog(days: number): Promise<GitCommit[]> {
  const since = `${days} days ago`;

  const { stdout } = await execFileAsync(
    "git",
    [
      "log",
      `--since=${since}`,
      "--pretty=format:%H|%aI|%an|%s",
      "--numstat",
      "--no-merges",
    ],
    { timeout: 30_000, maxBuffer: 10 * 1024 * 1024 }
  );

  const commits: GitCommit[] = [];
  let current: GitCommit | null = null;

  for (const line of stdout.split("\n")) {
    if (!line.trim()) {
      if (current) {
        commits.push(current);
        current = null;
      }
      continue;
    }

    // Header line: hash|date|author|subject
    if (line.includes("|") && !line.startsWith("\t") && line.length > 40) {
      const parts = line.split("|");
      if (parts.length >= 4 && parts[0].length === 40) {
        if (current) commits.push(current);
        current = {
          hash: parts[0],
          date: parts[1],
          author: parts[2],
          subject: parts.slice(3).join("|"),
          files: [],
        };
        continue;
      }
    }

    // Numstat line: additions\tdeletions\tfilepath
    if (current) {
      const match = line.match(/^(\d+|-)\t(\d+|-)\t(.+)$/);
      if (match) {
        current.files.push({
          additions: match[1] === "-" ? 0 : parseInt(match[1]),
          deletions: match[2] === "-" ? 0 : parseInt(match[2]),
          path: match[3],
        });
      }
    }
  }
  if (current) commits.push(current);

  return commits;
}

/** Get merged PRs from git log */
async function getMergedPRs(days: number): Promise<Array<{
  number: number;
  mergeDate: string;
  subject: string;
  fileCount: number;
  commitType: string;
}>> {
  const since = `${days} days ago`;

  const { stdout } = await execFileAsync(
    "git",
    [
      "log",
      "--merges",
      `--since=${since}`,
      "--pretty=format:%H|%aI|%s",
      "--numstat",
    ],
    { timeout: 30_000, maxBuffer: 10 * 1024 * 1024 }
  );

  const prs: Array<{
    number: number;
    mergeDate: string;
    subject: string;
    fileCount: number;
    commitType: string;
  }> = [];

  let currentSubject = "";
  let currentDate = "";
  let fileCount = 0;

  for (const line of stdout.split("\n")) {
    if (!line.trim()) {
      if (currentSubject) {
        // Extract PR number from subject
        const prMatch = currentSubject.match(/#(\d+)/);
        if (prMatch) {
          const typeMatch = currentSubject.match(/^(\w+)[\(:]/) || currentSubject.match(/Merge.*?(\w+)[\/:]/) || [];
          prs.push({
            number: parseInt(prMatch[1]),
            mergeDate: currentDate,
            subject: currentSubject,
            fileCount,
            commitType: typeMatch[1] || "unknown",
          });
        }
        currentSubject = "";
        fileCount = 0;
      }
      continue;
    }

    if (line.includes("|") && line.length > 40) {
      const parts = line.split("|");
      if (parts[0].length === 40) {
        currentSubject = parts.slice(2).join("|");
        currentDate = parts[1];
        fileCount = 0;
        continue;
      }
    }

    if (line.match(/^\d+\t\d+\t/)) {
      fileCount++;
    }
  }

  return prs;
}

// ─── Analysis Functions ─────────────────────────────────

/** Find files with most changes (hotspots = risk areas) */
function findHotspots(
  commits: GitCommit[],
  limit: number
): HistoryInsights["hotspots"] {
  const fileStats = new Map<
    string,
    { changes: number; additions: number; deletions: number }
  >();

  for (const commit of commits) {
    for (const file of commit.files) {
      const existing = fileStats.get(file.path) || {
        changes: 0,
        additions: 0,
        deletions: 0,
      };
      existing.changes++;
      existing.additions += file.additions;
      existing.deletions += file.deletions;
      fileStats.set(file.path, existing);
    }
  }

  return Array.from(fileStats.entries())
    .map(([file, stats]) => ({
      file,
      changes: stats.changes,
      additions: stats.additions,
      deletions: stats.deletions,
      churn: stats.additions + stats.deletions,
    }))
    .sort((a, b) => b.churn - a.churn)
    .slice(0, limit);
}

/** Find files that frequently change together (coupling) */
function findCoupling(
  commits: GitCommit[],
  limit: number
): HistoryInsights["coupling"] {
  // Count co-occurrences
  const pairCounts = new Map<string, number>();
  const fileCounts = new Map<string, number>();

  for (const commit of commits) {
    const files = commit.files.map((f) => f.path);
    for (const file of files) {
      fileCounts.set(file, (fileCounts.get(file) || 0) + 1);
    }

    // Only analyze commits with 2-15 files (too many = bulk change, not coupling)
    if (files.length >= 2 && files.length <= 15) {
      for (let i = 0; i < files.length; i++) {
        for (let j = i + 1; j < files.length; j++) {
          const key = [files[i], files[j]].sort().join("|||");
          pairCounts.set(key, (pairCounts.get(key) || 0) + 1);
        }
      }
    }
  }

  return Array.from(pairCounts.entries())
    .filter(([, count]) => count >= 3) // At least 3 co-changes
    .map(([key, count]) => {
      const [a, b] = key.split("|||");
      const maxCount = Math.max(fileCounts.get(a) || 1, fileCounts.get(b) || 1);
      return {
        files: [a, b] as [string, string],
        coChangeCount: count,
        confidence: Math.round((count / maxCount) * 100) / 100,
      };
    })
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, limit);
}

/** Analyze commit message patterns */
function analyzeCommitPatterns(commits: GitCommit[]): HistoryInsights["commitPatterns"] {
  const byType: Record<string, number> = {};
  const byScope: Record<string, number> = {};
  const byDayOfWeek: Record<string, number> = {};
  const byHour: Record<number, number> = {};

  const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

  for (const commit of commits) {
    // Parse type and scope from conventional commit
    const match = commit.subject.match(
      /^(feat|fix|docs|refactor|test|chore|contracts|ci|perf|revert)(?:\(([^)]+)\))?:/
    );
    if (match) {
      byType[match[1]] = (byType[match[1]] || 0) + 1;
      if (match[2]) byScope[match[2]] = (byScope[match[2]] || 0) + 1;
    } else {
      byType["other"] = (byType["other"] || 0) + 1;
    }

    const date = new Date(commit.date);
    const dayName = days[date.getDay()];
    byDayOfWeek[dayName] = (byDayOfWeek[dayName] || 0) + 1;
    byHour[date.getHours()] = (byHour[date.getHours()] || 0) + 1;
  }

  // Peak day
  const peakDay = Object.entries(byDayOfWeek).sort(
    (a, b) => b[1] - a[1]
  )[0]?.[0] || "Unknown";

  // Peak hour
  const peakHour = Object.entries(byHour)
    .sort((a, b) => b[1] - a[1])[0]?.[0] || "0";

  // Average commits per day
  const uniqueDays = new Set(
    commits.map((c) => new Date(c.date).toISOString().split("T")[0])
  );
  const avgPerDay = uniqueDays.size > 0
    ? Math.round((commits.length / uniqueDays.size) * 10) / 10
    : 0;

  return {
    byType,
    byScope,
    avgCommitsPerDay: avgPerDay,
    peakDayOfWeek: peakDay,
    peakHour: parseInt(peakHour),
  };
}

/** Identify high-risk areas based on hotspots, coupling, and churn */
function identifyRiskAreas(
  hotspots: HistoryInsights["hotspots"],
  coupling: HistoryInsights["coupling"]
): HistoryInsights["riskAreas"] {
  const riskMap = new Map<string, { score: number; reasons: string[] }>();

  // Hotspot risk: high churn files are risky
  for (const spot of hotspots) {
    const dir = spot.file.split("/").slice(0, -1).join("/") || ".";
    const existing = riskMap.get(dir) || { score: 0, reasons: [] };

    if (spot.churn > 200) {
      existing.score += 30;
      existing.reasons.push(`High churn: ${spot.file} (${spot.churn} lines)`);
    } else if (spot.churn > 50) {
      existing.score += 15;
      existing.reasons.push(`Moderate churn: ${spot.file} (${spot.churn} lines)`);
    }

    if (spot.changes > 10) {
      existing.score += 20;
      existing.reasons.push(`Frequently changed: ${spot.file} (${spot.changes} commits)`);
    }

    riskMap.set(dir, existing);
  }

  // Coupling risk: tightly coupled files are harder to change safely
  for (const pair of coupling) {
    if (pair.confidence > 0.7) {
      const dir = pair.files[0].split("/").slice(0, -1).join("/") || ".";
      const existing = riskMap.get(dir) || { score: 0, reasons: [] };
      existing.score += 15;
      existing.reasons.push(
        `Tight coupling: ${pair.files[0]} ↔ ${pair.files[1]} (${Math.round(pair.confidence * 100)}%)`
      );
      riskMap.set(dir, existing);
    }
  }

  return Array.from(riskMap.entries())
    .map(([path, data]) => ({
      path,
      riskScore: Math.min(100, data.score),
      reasons: data.reasons.slice(0, 5),
    }))
    .sort((a, b) => b.riskScore - a.riskScore)
    .slice(0, 10);
}

// ─── Main Export ────────────────────────────────────────

/** Mine git history for insights */
export async function getHistoryInsights(days = 30): Promise<HistoryInsights> {
  const commits = await getGitLog(days);
  const prs = await getMergedPRs(days);

  const now = new Date();
  const from = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);

  const hotspots = findHotspots(commits, 20);
  const coupling = findCoupling(commits, 15);
  const commitPatterns = analyzeCommitPatterns(commits);
  const riskAreas = identifyRiskAreas(hotspots, coupling);

  // PR patterns
  const avgFiles = prs.length > 0
    ? Math.round(prs.reduce((sum, p) => sum + p.fileCount, 0) / prs.length)
    : 0;
  const largestPR = prs.reduce((max, p) => Math.max(max, p.fileCount), 0);
  const mergesByType: Record<string, number> = {};
  for (const pr of prs) {
    mergesByType[pr.commitType] = (mergesByType[pr.commitType] || 0) + 1;
  }

  return {
    period: {
      from: from.toISOString().split("T")[0],
      to: now.toISOString().split("T")[0],
      totalCommits: commits.length,
    },
    hotspots,
    coupling,
    prPatterns: {
      totalPRs: prs.length,
      avgFilesPerPR: avgFiles,
      avgTimeToMergeDays: null, // Would need created-at data not in git log
      largestPRFiles: largestPR,
      mergesByType,
    },
    commitPatterns,
    riskAreas,
  };
}
