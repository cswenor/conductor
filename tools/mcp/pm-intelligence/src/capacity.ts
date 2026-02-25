/**
 * Team capacity modeling — multi-contributor throughput analysis and simulation.
 *
 * Goes beyond single-contributor Monte Carlo by modeling individual contributor
 * velocities, availability patterns, and concurrent work capacity.
 *
 * Tools:
 *   - getTeamCapacity: Analyze team throughput capacity from git/GitHub history
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getConfig } from "./config.js";

const execFileAsync = promisify(execFile);

async function gh(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("gh", args, {
    timeout: 30_000,
    maxBuffer: 10 * 1024 * 1024,
  });
  return stdout.trim();
}

async function getRepoName(): Promise<string> {
  const { stdout } = await execFileAsync("git", ["remote", "get-url", "origin"]);
  const url = stdout.trim();
  const match = url.match(/(?:github\.com[:/])([^/]+\/[^/.\s]+)/);
  if (!match) throw new Error(`Cannot parse repo from remote URL: ${url}`);
  return match[1].replace(/\.git$/, "").split("/")[1];
}

// ─── Types ──────────────────────────────────────────────

interface ContributorProfile {
  login: string;
  /** PRs merged in the analysis period */
  prsMerged: number;
  /** Issues closed in the analysis period */
  issuesClosed: number;
  /** Average days from PR open to merge */
  avgDaysToMerge: number;
  /** Average lines changed per PR (additions + deletions) */
  avgLinesPerPR: number;
  /** Areas they've worked in (from PR labels/paths) */
  areas: string[];
  /** Days of the week they typically commit */
  activeDays: number[];
  /** Estimated throughput: items per sprint (14 days) */
  estimatedThroughput: number;
  /** Velocity trend: comparing recent half to earlier half */
  velocityTrend: "accelerating" | "stable" | "decelerating";
}

export interface TeamCapacityResult {
  /** Analysis period */
  period: {
    days: number;
    startDate: string;
    endDate: string;
  };
  /** Individual contributor profiles */
  contributors: ContributorProfile[];
  /** Team-wide metrics */
  teamMetrics: {
    totalContributors: number;
    activeContributors: number; // Contributed in last 14 days
    totalPRsMerged: number;
    totalIssuesClosed: number;
    teamThroughputPerSprint: number; // Combined estimated throughput
    avgDaysToMerge: number;
    parallelismFactor: number; // How many contributors work concurrently
  };
  /** Capacity forecast for upcoming sprint */
  sprintForecast: {
    /** Conservative estimate (P25) */
    pessimistic: number;
    /** Median estimate (P50) */
    expected: number;
    /** Optimistic estimate (P75) */
    optimistic: number;
    /** Factors that could affect capacity */
    risks: string[];
    /** Opportunities to increase throughput */
    opportunities: string[];
  };
  /** Area coverage — which areas have capacity */
  areaCoverage: Array<{
    area: string;
    contributorCount: number;
    contributors: string[];
    throughput: number;
    busFactor: number; // 1 = single point of failure
  }>;
  /** Recommendations for improving team capacity */
  recommendations: string[];
}

// ─── Data Gathering ─────────────────────────────────────

interface PRData {
  number: number;
  author: string;
  createdAt: string;
  mergedAt: string | null;
  additions: number;
  deletions: number;
  labels: string[];
  files: string[];
}

async function fetchMergedPRs(days: number): Promise<PRData[]> {
  const config = await getConfig();
  const fullRepo = `${config.owner}/${config.repo}`;

  const since = new Date(Date.now() - days * 86400000).toISOString().split("T")[0];

  const raw = await gh([
    "pr",
    "list",
    "--repo",
    fullRepo,
    "--state",
    "merged",
    "--json",
    "number,author,createdAt,mergedAt,additions,deletions,labels,files",
    "--limit",
    "200",
    "--search",
    `merged:>=${since}`,
  ]);

  const prs: Array<{
    number: number;
    author: { login: string };
    createdAt: string;
    mergedAt: string;
    additions: number;
    deletions: number;
    labels: Array<{ name: string }>;
    files: Array<{ path: string }>;
  }> = JSON.parse(raw);

  return prs.map((pr) => ({
    number: pr.number,
    author: pr.author.login,
    createdAt: pr.createdAt,
    mergedAt: pr.mergedAt,
    additions: pr.additions,
    deletions: pr.deletions,
    labels: pr.labels.map((l) => l.name),
    files: pr.files?.map((f) => f.path) ?? [],
  }));
}

/** Infer area from file paths */
function inferArea(files: string[]): string[] {
  const areas = new Set<string>();
  for (const file of files) {
    if (file.startsWith("packages/web/") || file.includes("/frontend/")) {
      areas.add("frontend");
    } else if (file.startsWith("packages/contracts/") || file.includes("/contracts/")) {
      areas.add("contracts");
    } else if (
      file.startsWith("packages/clients/") ||
      file.startsWith("packages/shared/") ||
      file.includes("/backend/") ||
      file.includes("/api/")
    ) {
      areas.add("backend");
    } else if (
      file.startsWith("infra/") ||
      file.startsWith(".github/") ||
      file.startsWith("tools/") ||
      file.includes("Dockerfile") ||
      file.includes("docker-compose")
    ) {
      areas.add("infra");
    }
  }
  return [...areas];
}

/** Extract day-of-week from dates (0=Sun, 6=Sat) */
function getActiveDays(dates: string[]): number[] {
  const daySet = new Set<number>();
  for (const d of dates) {
    daySet.add(new Date(d).getDay());
  }
  return [...daySet].sort();
}

// ─── Analysis ───────────────────────────────────────────

function buildContributorProfiles(
  prs: PRData[],
  days: number
): ContributorProfile[] {
  // Group PRs by author
  const byAuthor = new Map<string, PRData[]>();
  for (const pr of prs) {
    if (!byAuthor.has(pr.author)) byAuthor.set(pr.author, []);
    byAuthor.get(pr.author)!.push(pr);
  }

  const sprintDays = 14;
  const sprintsInPeriod = days / sprintDays;

  const profiles: ContributorProfile[] = [];

  for (const [login, authorPRs] of byAuthor) {
    // Sort by merge date
    const sorted = authorPRs
      .filter((p) => p.mergedAt)
      .sort((a, b) => new Date(a.mergedAt!).getTime() - new Date(b.mergedAt!).getTime());

    if (sorted.length === 0) continue;

    // Average days to merge
    const mergeTimes = sorted.map(
      (p) =>
        (new Date(p.mergedAt!).getTime() - new Date(p.createdAt).getTime()) /
        86400000
    );
    const avgDaysToMerge =
      mergeTimes.length > 0
        ? Math.round((mergeTimes.reduce((s, t) => s + t, 0) / mergeTimes.length) * 10) / 10
        : 0;

    // Average lines per PR
    const avgLines =
      sorted.length > 0
        ? Math.round(
            sorted.reduce((s, p) => s + p.additions + p.deletions, 0) / sorted.length
          )
        : 0;

    // Areas worked in
    const allFiles = sorted.flatMap((p) => p.files);
    const areas = inferArea(allFiles);

    // Active days
    const mergeDates = sorted.map((p) => p.mergedAt!);
    const activeDays = getActiveDays(mergeDates);

    // Estimated throughput (PRs per sprint)
    const throughput =
      sprintsInPeriod > 0
        ? Math.round((sorted.length / sprintsInPeriod) * 10) / 10
        : sorted.length;

    // Velocity trend (compare first half to second half)
    const midpoint = Math.floor(sorted.length / 2);
    let velocityTrend: ContributorProfile["velocityTrend"] = "stable";
    if (sorted.length >= 4) {
      const firstHalf = sorted.slice(0, midpoint);
      const secondHalf = sorted.slice(midpoint);

      // Calculate merge rate for each half
      const firstSpan =
        firstHalf.length > 1
          ? (new Date(firstHalf[firstHalf.length - 1].mergedAt!).getTime() -
              new Date(firstHalf[0].mergedAt!).getTime()) /
            86400000
          : days / 2;
      const secondSpan =
        secondHalf.length > 1
          ? (new Date(secondHalf[secondHalf.length - 1].mergedAt!).getTime() -
              new Date(secondHalf[0].mergedAt!).getTime()) /
            86400000
          : days / 2;

      const firstRate = firstSpan > 0 ? firstHalf.length / firstSpan : 0;
      const secondRate = secondSpan > 0 ? secondHalf.length / secondSpan : 0;

      if (secondRate > firstRate * 1.3) {
        velocityTrend = "accelerating";
      } else if (secondRate < firstRate * 0.7) {
        velocityTrend = "decelerating";
      }
    }

    profiles.push({
      login,
      prsMerged: sorted.length,
      issuesClosed: sorted.length, // Approximate: 1 PR ≈ 1 issue
      avgDaysToMerge,
      avgLinesPerPR: avgLines,
      areas,
      activeDays,
      estimatedThroughput: throughput,
      velocityTrend,
    });
  }

  return profiles.sort((a, b) => b.prsMerged - a.prsMerged);
}

// ─── Public Function ────────────────────────────────────

/**
 * Analyze team capacity from git and GitHub history.
 *
 * Builds contributor profiles, estimates throughput, and forecasts
 * sprint capacity with risk factors.
 */
export async function getTeamCapacity(
  days = 60
): Promise<TeamCapacityResult> {
  const prs = await fetchMergedPRs(days);
  const profiles = buildContributorProfiles(prs, days);

  const now = new Date();
  const startDate = new Date(now.getTime() - days * 86400000);
  const recentCutoff = 14 * 86400000; // 14 days

  // Active contributors (merged PR in last 14 days)
  const activeContributors = profiles.filter((p) => {
    const authorPRs = prs.filter((pr) => pr.author === p.login && pr.mergedAt);
    return authorPRs.some(
      (pr) => now.getTime() - new Date(pr.mergedAt!).getTime() < recentCutoff
    );
  });

  // Team throughput
  const teamThroughput = profiles.reduce(
    (s, p) => s + p.estimatedThroughput,
    0
  );

  // Average days to merge across team
  const teamAvgMerge =
    profiles.length > 0
      ? Math.round(
          (profiles.reduce((s, p) => s + p.avgDaysToMerge * p.prsMerged, 0) /
            prs.filter((p) => p.mergedAt).length) *
            10
        ) / 10
      : 0;

  // Parallelism factor: how many contributors have overlapping merge dates
  const parallelismFactor = Math.min(activeContributors.length, profiles.length);

  // Area coverage
  const areaCoverageMap = new Map<string, { contributors: Set<string>; throughput: number }>();
  for (const profile of profiles) {
    for (const area of profile.areas) {
      if (!areaCoverageMap.has(area)) {
        areaCoverageMap.set(area, { contributors: new Set(), throughput: 0 });
      }
      areaCoverageMap.get(area)!.contributors.add(profile.login);
      areaCoverageMap.get(area)!.throughput += profile.estimatedThroughput / profile.areas.length;
    }
  }

  const areaCoverage = [...areaCoverageMap.entries()].map(([area, data]) => ({
    area,
    contributorCount: data.contributors.size,
    contributors: [...data.contributors],
    throughput: Math.round(data.throughput * 10) / 10,
    busFactor: data.contributors.size,
  }));

  // Sprint forecast
  const risks: string[] = [];
  const opportunities: string[] = [];

  if (activeContributors.length < profiles.length) {
    risks.push(
      `${profiles.length - activeContributors.length} contributor(s) inactive in last 14 days`
    );
  }
  if (areaCoverage.some((a) => a.busFactor === 1)) {
    const singleAreas = areaCoverage
      .filter((a) => a.busFactor === 1)
      .map((a) => a.area);
    risks.push(`Bus factor 1 in: ${singleAreas.join(", ")}`);
  }
  if (profiles.some((p) => p.velocityTrend === "decelerating")) {
    const decelerating = profiles.filter((p) => p.velocityTrend === "decelerating");
    risks.push(
      `${decelerating.length} contributor(s) decelerating: ${decelerating.map((p) => p.login).join(", ")}`
    );
  }
  if (teamAvgMerge > 3) {
    risks.push(
      `Average merge time is ${teamAvgMerge} days — review bottleneck may reduce throughput`
    );
  }

  if (profiles.some((p) => p.velocityTrend === "accelerating")) {
    const accelerating = profiles.filter((p) => p.velocityTrend === "accelerating");
    opportunities.push(
      `${accelerating.length} contributor(s) accelerating: ${accelerating.map((p) => p.login).join(", ")}`
    );
  }
  if (parallelismFactor > 1) {
    opportunities.push(
      `${parallelismFactor} parallel contributors — use worktrees for concurrent work`
    );
  }
  if (areaCoverage.length >= 3) {
    opportunities.push(
      `Broad area coverage (${areaCoverage.length} areas) — can parallelize across domains`
    );
  }

  // Conservative/expected/optimistic estimates
  const activeThrough = activeContributors.reduce(
    (s, p) => s + p.estimatedThroughput,
    0
  );
  const pessimistic = Math.max(1, Math.round(activeThrough * 0.6));
  const expected = Math.round(activeThrough);
  const optimistic = Math.round(teamThroughput * 1.2);

  // Recommendations
  const recommendations: string[] = [];
  if (areaCoverage.some((a) => a.busFactor === 1)) {
    recommendations.push(
      "Cross-train contributors to reduce bus factor in single-contributor areas"
    );
  }
  if (teamAvgMerge > 2) {
    recommendations.push(
      "Reduce review turnaround time — consider async reviews or review rotations"
    );
  }
  if (profiles.length === 1) {
    recommendations.push(
      "Single contributor — throughput limited by individual capacity. Consider onboarding."
    );
  }
  if (profiles.length > 1 && parallelismFactor < profiles.length) {
    recommendations.push(
      "Not all contributors active recently — check for blockers or availability changes"
    );
  }
  if (recommendations.length === 0) {
    recommendations.push(
      "Team capacity is healthy — maintain current velocity and review practices"
    );
  }

  return {
    period: {
      days,
      startDate: startDate.toISOString().split("T")[0],
      endDate: now.toISOString().split("T")[0],
    },
    contributors: profiles,
    teamMetrics: {
      totalContributors: profiles.length,
      activeContributors: activeContributors.length,
      totalPRsMerged: prs.filter((p) => p.mergedAt).length,
      totalIssuesClosed: prs.filter((p) => p.mergedAt).length, // Approximate
      teamThroughputPerSprint: Math.round(teamThroughput * 10) / 10,
      avgDaysToMerge: teamAvgMerge,
      parallelismFactor,
    },
    sprintForecast: {
      pessimistic,
      expected,
      optimistic,
      risks,
      opportunities,
    },
    areaCoverage,
    recommendations,
  };
}
