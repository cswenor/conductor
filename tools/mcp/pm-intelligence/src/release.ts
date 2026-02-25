/**
 * Release Intelligence — Automated release notes and change documentation
 *
 * Tools:
 *   - generateReleaseNotes: Build structured release notes from merged PRs
 *     and closed issues. Groups by area, classifies changes by type,
 *     highlights breaking changes, and generates stakeholder summaries.
 */

import { getVelocity } from "./github.js";
import { getLocalBoardSummary } from "./db.js";
import { getEvents, getOutcomes } from "./memory.js";
import { getConfig } from "./config.js";
import { execSync } from "child_process";

// ─── Types ───────────────────────────────────────────────

interface MergedPR {
  number: number;
  title: string;
  mergedAt: string;
  author: string;
  labels: string[];
  body: string;
  closesIssues: number[];
  files: number;
  additions: number;
  deletions: number;
}

interface ReleaseChange {
  type: "feature" | "fix" | "refactor" | "chore" | "docs" | "breaking";
  area: string;
  title: string;
  prNumber: number;
  issueNumbers: number[];
  author: string;
  description: string;
  breaking: boolean;
}

interface ReleaseNotes {
  version: string;
  dateRange: { from: string; to: string };
  summary: {
    totalChanges: number;
    features: number;
    fixes: number;
    breaking: number;
    contributors: string[];
    areas: string[];
  };
  changes: ReleaseChange[];
  breakingChanges: ReleaseChange[];
  highlights: string[];
  stakeholderSummary: string;
  technicalNotes: string[];
  issuesClosed: number[];
  markdown: string;
}

// ─── Helpers ─────────────────────────────────────────────

function classifyPR(title: string, labels: string[]): ReleaseChange["type"] {
  const lower = title.toLowerCase();

  // Check labels first
  if (labels.some((l) => l.includes("breaking"))) return "breaking";
  if (labels.some((l) => l.includes("feature") || l.includes("enhancement")))
    return "feature";
  if (labels.some((l) => l.includes("bug") || l.includes("fix"))) return "fix";

  // Parse conventional commit prefix
  if (lower.startsWith("feat")) return "feature";
  if (lower.startsWith("fix")) return "fix";
  if (lower.startsWith("refactor")) return "refactor";
  if (lower.startsWith("docs")) return "docs";
  if (lower.startsWith("chore") || lower.startsWith("ci")) return "chore";

  // Check for breaking indicators
  if (lower.includes("breaking") || lower.includes("!:")) return "breaking";

  return "chore";
}

function extractArea(title: string, labels: string[]): string {
  // Check labels for area
  const areaLabel = labels.find((l) => l.startsWith("area:"));
  if (areaLabel) return areaLabel.replace("area:", "");

  // Parse scope from conventional commit: type(scope): desc
  const scopeMatch = title.match(/^\w+\(([^)]+)\)/);
  if (scopeMatch) {
    const scope = scopeMatch[1].toLowerCase();
    if (scope.includes("web") || scope.includes("frontend")) return "frontend";
    if (scope.includes("api") || scope.includes("backend")) return "backend";
    if (scope.includes("contract")) return "contracts";
    if (
      scope.includes("infra") ||
      scope.includes("ci") ||
      scope.includes("docker")
    )
      return "infra";
    return scope;
  }

  return "general";
}

function extractClosedIssues(body: string): number[] {
  const issues: number[] = [];
  const patterns = [
    /(?:fixes|closes|resolves)\s+#(\d+)/gi,
    /(?:fix|close|resolve)\s+#(\d+)/gi,
  ];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(body)) !== null) {
      issues.push(parseInt(match[1], 10));
    }
  }
  return [...new Set(issues)];
}

function cleanTitle(title: string): string {
  // Remove conventional commit prefix for human-readable version
  return title
    .replace(/^\w+(\([^)]+\))?:\s*/, "")
    .replace(/^#\d+\s*/, "")
    .trim();
}

async function getMergedPRs(since: string, until: string): Promise<MergedPR[]> {
  try {
    const config = await getConfig();
    const owner = config.owner;
    const cmd =
      `gh pr list --repo ${owner}/$(gh repo view --json name -q .name 2>/dev/null || echo "unknown") ` +
      `--state merged --json number,title,mergedAt,author,labels,body,files,additions,deletions ` +
      `--search "merged:${since}..${until}" --limit 100 2>/dev/null`;

    // Fallback: use git log to find merge commits
    const gitCmd =
      `git log --merges --format='%H %s' --since="${since}" --until="${until}" 2>/dev/null`;
    const gitOutput = execSync(gitCmd, { encoding: "utf-8" }).trim();

    if (!gitOutput) return [];

    // Parse merge commits for PR numbers
    const prs: MergedPR[] = [];
    const lines = gitOutput.split("\n").filter(Boolean);

    for (const line of lines) {
      const prMatch = line.match(
        /Merge pull request #(\d+)|#(\d+)\s|pull request.*?(\d+)/i
      );
      if (!prMatch) continue;

      const prNum = parseInt(prMatch[1] || prMatch[2] || prMatch[3], 10);
      if (isNaN(prNum)) continue;

      // Get PR details from gh CLI
      try {
        const prJson = execSync(
          `gh pr view ${prNum} --json number,title,mergedAt,author,labels,body,files,additions,deletions 2>/dev/null`,
          { encoding: "utf-8" }
        );
        const pr = JSON.parse(prJson);
        prs.push({
          number: pr.number,
          title: pr.title || "",
          mergedAt: pr.mergedAt || "",
          author: pr.author?.login || "unknown",
          labels: (pr.labels || []).map(
            (l: { name: string }) => l.name
          ),
          body: pr.body || "",
          closesIssues: extractClosedIssues(pr.body || ""),
          files: pr.files?.length || 0,
          additions: pr.additions || 0,
          deletions: pr.deletions || 0,
        });
      } catch {
        // PR details not available, use git info
        const title = line.substring(41).trim(); // after SHA
        prs.push({
          number: prNum,
          title,
          mergedAt: since,
          author: "unknown",
          labels: [],
          body: "",
          closesIssues: [],
          files: 0,
          additions: 0,
          deletions: 0,
        });
      }
    }

    return prs;
  } catch {
    return [];
  }
}

// ─── Main Tool ───────────────────────────────────────────

export async function generateReleaseNotes(
  since?: string,
  until?: string,
  version?: string
): Promise<ReleaseNotes> {
  // Defaults: last 7 days
  const now = new Date();
  const untilDate = until || now.toISOString().split("T")[0];
  const sinceDate =
    since || new Date(now.getTime() - 7 * 86400000).toISOString().split("T")[0];
  const releaseVersion = version || `${untilDate}`;

  // Gather data in parallel
  const [velocity, board, events, outcomes] = await Promise.all([
    getVelocity().catch(() => null),
    getLocalBoardSummary().catch(() => null),
    getEvents(200, { eventType: "workflow_transition" }).catch(() => []),
    getOutcomes(50).catch(() => []),
  ]);

  // Get merged PRs from git history
  const mergedPRs = await getMergedPRs(sinceDate, untilDate);

  // Classify each PR
  const changes: ReleaseChange[] = mergedPRs.map((pr) => {
    const type = classifyPR(pr.title, pr.labels);
    return {
      type: type === "breaking" ? "breaking" : type,
      area: extractArea(pr.title, pr.labels),
      title: cleanTitle(pr.title),
      prNumber: pr.number,
      issueNumbers: pr.closesIssues,
      author: pr.author,
      description: pr.body
        ? pr.body.split("\n").slice(0, 3).join(" ").substring(0, 200)
        : "",
      breaking: type === "breaking" || pr.title.includes("!:"),
    };
  });

  // Extract breaking changes
  const breakingChanges = changes.filter((c) => c.breaking);

  // Count by type
  const features = changes.filter((c) => c.type === "feature").length;
  const fixes = changes.filter((c) => c.type === "fix").length;

  // Unique contributors and areas
  const contributors = [...new Set(changes.map((c) => c.author))];
  const areas = [...new Set(changes.map((c) => c.area))];

  // All closed issues
  const issuesClosed = [
    ...new Set(changes.flatMap((c) => c.issueNumbers)),
  ].sort((a, b) => a - b);

  // Count completed issues from events
  const completedFromEvents = events.filter(
    (e) =>
      e.to_value === "Done" &&
      e.timestamp >= sinceDate &&
      e.timestamp <= untilDate + "T23:59:59Z"
  );

  // Generate highlights
  const highlights: string[] = [];
  if (features > 0) highlights.push(`${features} new feature${features > 1 ? "s" : ""} shipped`);
  if (fixes > 0) highlights.push(`${fixes} bug fix${fixes > 1 ? "es" : ""}`);
  if (breakingChanges.length > 0)
    highlights.push(
      `${breakingChanges.length} breaking change${breakingChanges.length > 1 ? "s" : ""} — review before upgrading`
    );
  if (contributors.length > 1)
    highlights.push(`${contributors.length} contributors active`);
  if (issuesClosed.length > 0)
    highlights.push(`${issuesClosed.length} issue${issuesClosed.length > 1 ? "s" : ""} resolved`);

  // Stakeholder summary (non-technical)
  const stakeholderParts: string[] = [];
  if (features > 0) {
    const featureChanges = changes.filter((c) => c.type === "feature");
    stakeholderParts.push(
      `New capabilities: ${featureChanges.map((f) => f.title).join(", ")}.`
    );
  }
  if (fixes > 0) {
    stakeholderParts.push(
      `${fixes} issue${fixes > 1 ? "s" : ""} fixed improving stability.`
    );
  }
  if (breakingChanges.length > 0) {
    stakeholderParts.push(
      `Important: ${breakingChanges.length} change${breakingChanges.length > 1 ? "s" : ""} may require action.`
    );
  }
  if (velocity) {
    stakeholderParts.push(
      `Team velocity: ${velocity.last7Days.merged} PRs merged this period.`
    );
  }
  const stakeholderSummary =
    stakeholderParts.length > 0
      ? stakeholderParts.join(" ")
      : "Maintenance period — foundation work with no user-facing changes.";

  // Technical notes
  const technicalNotes: string[] = [];
  const infraChanges = changes.filter((c) => c.area === "infra");
  if (infraChanges.length > 0) {
    technicalNotes.push(
      `Infrastructure: ${infraChanges.map((c) => c.title).join(", ")}`
    );
  }
  const refactors = changes.filter((c) => c.type === "refactor");
  if (refactors.length > 0) {
    technicalNotes.push(
      `Refactoring: ${refactors.map((c) => c.title).join(", ")}`
    );
  }
  if (completedFromEvents.length > issuesClosed.length) {
    technicalNotes.push(
      `Note: ${completedFromEvents.length - issuesClosed.length} additional issues completed via project board (not linked in PRs)`
    );
  }

  // Generate markdown
  const md = generateMarkdown({
    version: releaseVersion,
    dateRange: { from: sinceDate, to: untilDate },
    changes,
    breakingChanges,
    highlights,
    stakeholderSummary,
    technicalNotes,
    issuesClosed,
    contributors,
    areas,
  });

  return {
    version: releaseVersion,
    dateRange: { from: sinceDate, to: untilDate },
    summary: {
      totalChanges: changes.length,
      features,
      fixes,
      breaking: breakingChanges.length,
      contributors,
      areas,
    },
    changes,
    breakingChanges,
    highlights,
    stakeholderSummary,
    technicalNotes,
    issuesClosed,
    markdown: md,
  };
}

function generateMarkdown(data: {
  version: string;
  dateRange: { from: string; to: string };
  changes: ReleaseChange[];
  breakingChanges: ReleaseChange[];
  highlights: string[];
  stakeholderSummary: string;
  technicalNotes: string[];
  issuesClosed: number[];
  contributors: string[];
  areas: string[];
}): string {
  const lines: string[] = [];

  lines.push(`# Release ${data.version}`);
  lines.push(`> ${data.dateRange.from} — ${data.dateRange.to}`);
  lines.push("");

  // Highlights
  if (data.highlights.length > 0) {
    lines.push("## Highlights");
    for (const h of data.highlights) {
      lines.push(`- ${h}`);
    }
    lines.push("");
  }

  // Breaking changes (prominent)
  if (data.breakingChanges.length > 0) {
    lines.push("## Breaking Changes");
    for (const bc of data.breakingChanges) {
      lines.push(
        `- **${bc.title}** (PR #${bc.prNumber})${bc.issueNumbers.length > 0 ? ` — fixes ${bc.issueNumbers.map((n) => `#${n}`).join(", ")}` : ""}`
      );
    }
    lines.push("");
  }

  // Changes by area
  const byArea = new Map<string, ReleaseChange[]>();
  for (const c of data.changes) {
    if (c.breaking) continue; // already listed above
    const arr = byArea.get(c.area) || [];
    arr.push(c);
    byArea.set(c.area, arr);
  }

  if (byArea.size > 0) {
    lines.push("## Changes");
    for (const [area, areaChanges] of byArea.entries()) {
      lines.push(`### ${area.charAt(0).toUpperCase() + area.slice(1)}`);
      for (const c of areaChanges) {
        const typeEmoji =
          c.type === "feature"
            ? "feat"
            : c.type === "fix"
              ? "fix"
              : c.type === "refactor"
                ? "refactor"
                : c.type === "docs"
                  ? "docs"
                  : "chore";
        const issueRef =
          c.issueNumbers.length > 0
            ? ` (${c.issueNumbers.map((n) => `#${n}`).join(", ")})`
            : "";
        lines.push(`- **[${typeEmoji}]** ${c.title} — PR #${c.prNumber}${issueRef}`);
      }
      lines.push("");
    }
  }

  // Issues closed
  if (data.issuesClosed.length > 0) {
    lines.push("## Issues Resolved");
    lines.push(data.issuesClosed.map((n) => `#${n}`).join(", "));
    lines.push("");
  }

  // Contributors
  if (data.contributors.length > 0) {
    lines.push("## Contributors");
    lines.push(data.contributors.map((c) => `@${c}`).join(", "));
    lines.push("");
  }

  // Technical notes
  if (data.technicalNotes.length > 0) {
    lines.push("## Technical Notes");
    for (const n of data.technicalNotes) {
      lines.push(`- ${n}`);
    }
    lines.push("");
  }

  // Stakeholder summary
  lines.push("## Summary for Stakeholders");
  lines.push(data.stakeholderSummary);
  lines.push("");

  return lines.join("\n");
}
