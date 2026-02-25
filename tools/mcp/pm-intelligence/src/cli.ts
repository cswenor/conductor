#!/usr/bin/env node

/**
 * PM CLI — local-first project management from the terminal.
 *
 * Commands:
 *   pm sync            Pull latest from GitHub into local DB
 *   pm board           Kanban board in the terminal
 *   pm status [num]    Issue detail or project overview
 *   pm move <num> <state>  Move issue to workflow state
 *   pm add <num> [priority]  Add issue to tracking (initial sync + set priority)
 *   pm dep <blocker> <blocked>  Add dependency
 *   pm history [num]   Event history for an issue
 *   pm dashboard       Open local web dashboard (future)
 *   pm init            First-time setup
 */

import {
  getDb,
  getIssue,
  getLocalBoardSummary,
  moveIssueWorkflow,
  addDependency,
  getDependencies,
  queryEvents,
  getCycleTimes,
  VALID_WORKFLOWS,
  VALID_PRIORITIES,
  type WorkflowState,
  type Priority,
} from "./db.js";
import { syncFromGitHub, isSyncStale } from "./sync.js";

// ─── ANSI Colors ─────────────────────────────────────────

const c = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  white: "\x1b[37m",
  bgRed: "\x1b[41m",
  bgGreen: "\x1b[42m",
  bgYellow: "\x1b[43m",
  bgBlue: "\x1b[44m",
  bgMagenta: "\x1b[45m",
  bgCyan: "\x1b[46m",
};

const WORKFLOW_COLORS: Record<string, string> = {
  Backlog: c.dim,
  Ready: c.cyan,
  Active: c.green,
  Review: c.yellow,
  Rework: c.red,
  Done: c.dim + c.green,
};

const PRIORITY_ICONS: Record<string, string> = {
  critical: `${c.red}!!!${c.reset}`,
  high: `${c.yellow}!!${c.reset}`,
  normal: `${c.dim} .${c.reset}`,
};

// ─── Commands ────────────────────────────────────────────

async function cmdSync(args: string[]): Promise<void> {
  const force = args.includes("--force");
  console.log(force ? "Full sync from GitHub..." : "Syncing from GitHub...");

  const result = await syncFromGitHub({ force });

  console.log(
    `${c.green}Done${c.reset} in ${result.duration_ms}ms` +
      (result.incremental ? " (incremental)" : " (full)") +
      `\n  Issues: ${result.issues.synced} synced (${result.issues.created} new, ${result.issues.updated} updated)` +
      `\n  PRs: ${result.prs.synced} synced`
  );
}

async function cmdBoard(): Promise<void> {
  // Auto-sync if stale
  if (await isSyncStale()) {
    console.log(`${c.dim}Syncing...${c.reset}`);
    await syncFromGitHub();
  }

  const board = await getLocalBoardSummary();
  const termWidth = process.stdout.columns || 100;

  // Header
  console.log(
    `\n${c.bold}PM Board${c.reset}  ${c.dim}(${board.total} open issues, health: ${formatHealth(board.healthScore)})${c.reset}\n`
  );

  // Kanban columns
  const columns: Array<{ name: string; items: Array<{ num: number; title: string; priority: string }> }> = [];

  for (const wf of VALID_WORKFLOWS) {
    if (wf === "Done") continue; // Skip Done in board view

    const db = await getDb();
    const issues = db
      .prepare(
        "SELECT number, title, priority FROM issues WHERE workflow = ? AND state = 'open' ORDER BY priority DESC, created_at ASC"
      )
      .all(wf) as Array<{ number: number; title: string; priority: string }>;

    columns.push({
      name: wf,
      items: issues.map((i) => ({
        num: i.number,
        title: i.title,
        priority: i.priority,
      })),
    });
  }

  // Calculate column width
  const colWidth = Math.min(
    Math.floor((termWidth - columns.length - 1) / columns.length),
    30
  );

  // Column headers
  const headers = columns.map((col) => {
    const color = WORKFLOW_COLORS[col.name] || "";
    const count = col.items.length;
    const header = `${col.name} (${count})`;
    return `${color}${c.bold}${header.padEnd(colWidth)}${c.reset}`;
  });
  console.log(headers.join("│"));
  console.log(columns.map(() => "─".repeat(colWidth)).join("┼"));

  // Find max items in any column
  const maxItems = Math.max(...columns.map((col) => col.items.length), 0);

  for (let i = 0; i < Math.max(maxItems, 1); i++) {
    const row = columns.map((col) => {
      const item = col.items[i];
      if (!item) return " ".repeat(colWidth);

      const pri = PRIORITY_ICONS[item.priority] || " .";
      const num = `#${item.num}`;
      const maxTitle = colWidth - num.length - 5;
      const title =
        item.title.length > maxTitle
          ? item.title.slice(0, maxTitle - 1) + "…"
          : item.title;

      return `${pri} ${c.bold}${num}${c.reset} ${title}`.padEnd(
        colWidth + 20 // extra for ANSI codes
      ).slice(0, colWidth + 20);
    });
    console.log(row.join("│"));
  }

  // Footer with metrics
  console.log();

  if (board.blockedIssues.length > 0) {
    console.log(
      `${c.red}Blocked:${c.reset} ${board.blockedIssues.map((b) => `#${b.issue.number} (by ${b.blockedBy.map((n) => `#${n}`).join(", ")})`).join(", ")}`
    );
  }

  // Cycle time from recent completions
  const cycleTimes = await getCycleTimes(30);
  if (cycleTimes.length > 0) {
    const avgHours =
      cycleTimes.reduce((s, ct) => s + ct.hours, 0) / cycleTimes.length;
    const avgDays = Math.round((avgHours / 24) * 10) / 10;
    console.log(
      `${c.dim}Avg cycle time (30d): ${avgDays}d | Completed: ${cycleTimes.length}${c.reset}`
    );
  }
}

async function cmdStatus(args: string[]): Promise<void> {
  const num = parseInt(args[0]);
  if (isNaN(num)) {
    // Project overview
    const board = await getLocalBoardSummary();
    console.log(`\n${c.bold}Project Status${c.reset}\n`);
    console.log(`  Total open: ${board.total}`);
    console.log(`  Health: ${formatHealth(board.healthScore)}`);
    console.log();
    for (const [wf, count] of Object.entries(board.byWorkflow)) {
      const color = WORKFLOW_COLORS[wf] || "";
      console.log(`  ${color}${wf.padEnd(10)}${c.reset} ${count}`);
    }
    console.log();
    for (const [pri, count] of Object.entries(board.byPriority)) {
      console.log(`  ${(PRIORITY_ICONS[pri] || pri).padEnd(12)} ${count}`);
    }
    return;
  }

  const issue = await getIssue(num);
  if (!issue) {
    console.error(`Issue #${num} not found. Run 'pm sync' first.`);
    process.exit(1);
  }

  const deps = await getDependencies(num);
  const color = WORKFLOW_COLORS[issue.workflow] || "";

  console.log(`\n${c.bold}#${num}: ${issue.title}${c.reset}`);
  console.log(
    `  ${color}${issue.workflow}${c.reset} | ${PRIORITY_ICONS[issue.priority] || issue.priority} ${issue.priority} | ${issue.state}`
  );

  if (issue.labels.length > 0) {
    console.log(`  Labels: ${issue.labels.map((l) => `${c.cyan}${l}${c.reset}`).join(", ")}`);
  }
  if (issue.assignees.length > 0) {
    console.log(`  Assignees: ${issue.assignees.join(", ")}`);
  }
  if (issue.estimate) {
    console.log(`  Estimate: ${issue.estimate}`);
  }

  if (deps.blockedBy.length > 0) {
    console.log(
      `  ${c.red}Blocked by:${c.reset} ${deps.blockedBy.filter((d) => !d.resolved).map((d) => `#${d.issue}`).join(", ")}`
    );
  }
  if (deps.blocks.length > 0) {
    console.log(
      `  ${c.yellow}Blocks:${c.reset} ${deps.blocks.filter((d) => !d.resolved).map((d) => `#${d.issue}`).join(", ")}`
    );
  }

  // Recent events
  const events = await queryEvents({ issueNumber: num, limit: 10 });
  if (events.length > 0) {
    console.log(`\n  ${c.bold}Recent Events${c.reset}`);
    for (const event of events.slice(0, 5)) {
      const time = new Date(event.timestamp).toLocaleDateString();
      const desc = formatEvent(event);
      console.log(`  ${c.dim}${time}${c.reset} ${desc}`);
    }
  }

  // Linked PRs
  const db = await getDb();
  const linkedPRs = db
    .prepare(`
      SELECT p.number, p.title, p.state, p.review_state
      FROM pull_requests p
      JOIN pr_issue_links l ON l.pr_number = p.number
      WHERE l.issue_number = ?
    `)
    .all(num) as Array<{
    number: number;
    title: string;
    state: string;
    review_state: string | null;
  }>;

  if (linkedPRs.length > 0) {
    console.log(`\n  ${c.bold}Linked PRs${c.reset}`);
    for (const pr of linkedPRs) {
      const stateColor =
        pr.state === "merged" ? c.magenta : pr.state === "open" ? c.green : c.red;
      console.log(
        `  ${stateColor}#${pr.number}${c.reset} ${pr.title} [${pr.state}${pr.review_state ? ` / ${pr.review_state}` : ""}]`
      );
    }
  }
}

async function cmdMove(args: string[]): Promise<void> {
  const num = parseInt(args[0]);
  const state = args[1] as WorkflowState;

  if (isNaN(num) || !state) {
    console.error("Usage: pm move <issue_number> <state>");
    console.error(`States: ${VALID_WORKFLOWS.join(", ")}`);
    process.exit(1);
  }

  if (!VALID_WORKFLOWS.includes(state)) {
    console.error(`Invalid state: ${state}`);
    console.error(`Valid states: ${VALID_WORKFLOWS.join(", ")}`);
    process.exit(1);
  }

  const result = await moveIssueWorkflow(num, state);
  console.log(`${c.green}${result.message}${c.reset}`);
}

async function cmdAdd(args: string[]): Promise<void> {
  const num = parseInt(args[0]);
  const priority = (args[1] || "normal") as Priority;

  if (isNaN(num)) {
    console.error("Usage: pm add <issue_number> [priority]");
    process.exit(1);
  }

  if (!VALID_PRIORITIES.includes(priority)) {
    console.error(`Invalid priority: ${priority}`);
    console.error(`Valid priorities: ${VALID_PRIORITIES.join(", ")}`);
    process.exit(1);
  }

  // Sync this specific issue if not in DB
  const existing = await getIssue(num);
  if (!existing) {
    console.log(`Syncing issue #${num} from GitHub...`);
    await syncFromGitHub({ force: true });
  }

  const issue = await getIssue(num);
  if (!issue) {
    console.error(`Issue #${num} not found on GitHub.`);
    process.exit(1);
  }

  // Set priority
  const db = await getDb();
  db.prepare("UPDATE issues SET priority = ? WHERE number = ?").run(priority, num);

  db.prepare(`
    INSERT INTO events (event_type, issue_number, from_value, to_value, actor)
    VALUES ('priority_change', ?, ?, ?, 'claude')
  `).run(num, issue.priority, priority);

  console.log(
    `${c.green}Issue #${num} tracked${c.reset} — ${issue.workflow}, priority: ${priority}`
  );
}

async function cmdDep(args: string[]): Promise<void> {
  const blocker = parseInt(args[0]);
  const blocked = parseInt(args[1]);

  if (isNaN(blocker) || isNaN(blocked)) {
    console.error("Usage: pm dep <blocker_issue> <blocked_issue>");
    console.error("Means: <blocker> must be done before <blocked> can proceed");
    process.exit(1);
  }

  await addDependency(blocker, blocked);
  console.log(
    `${c.green}Dependency added:${c.reset} #${blocker} blocks #${blocked}`
  );
}

async function cmdHistory(args: string[]): Promise<void> {
  const num = args[0] ? parseInt(args[0]) : undefined;
  const limit = parseInt(args.find((a) => a.startsWith("--limit="))?.split("=")[1] || "20");

  const events = await queryEvents({
    issueNumber: num,
    limit,
  });

  if (events.length === 0) {
    console.log("No events found.");
    return;
  }

  console.log(
    `\n${c.bold}Event History${c.reset}${num ? ` for #${num}` : ""} (${events.length} events)\n`
  );

  for (const event of events) {
    const time = new Date(event.timestamp).toLocaleString();
    const desc = formatEvent(event);
    console.log(`${c.dim}${time}${c.reset} ${desc}`);
  }
}

async function cmdInit(): Promise<void> {
  console.log(`${c.bold}PM Intelligence — First-time setup${c.reset}\n`);

  // Initialize DB
  await getDb();
  console.log(`${c.green}✓${c.reset} Database created at .pm/state.db`);

  // Run initial sync
  console.log("Syncing from GitHub...");
  const result = await syncFromGitHub({ force: true });
  console.log(
    `${c.green}✓${c.reset} Synced ${result.issues.synced} issues, ${result.prs.synced} PRs (${result.duration_ms}ms)`
  );

  console.log(
    `\n${c.green}Ready.${c.reset} Run ${c.bold}pm board${c.reset} to see your kanban board.`
  );
}

// ─── Helpers ─────────────────────────────────────────────

function formatHealth(score: number): string {
  if (score >= 80) return `${c.green}${score}/100${c.reset}`;
  if (score >= 60) return `${c.yellow}${score}/100${c.reset}`;
  return `${c.red}${score}/100${c.reset}`;
}

function formatEvent(event: {
  event_type: string;
  issue_number: number | null;
  from_value: string | null;
  to_value: string | null;
  actor: string | null;
}): string {
  const issue = event.issue_number ? `#${event.issue_number}` : "";

  switch (event.event_type) {
    case "workflow_change":
      return `${issue} ${c.dim}${event.from_value}${c.reset} → ${WORKFLOW_COLORS[event.to_value || ""] || ""}${event.to_value}${c.reset} (${event.actor})`;
    case "priority_change":
      return `${issue} priority: ${event.from_value} → ${event.to_value}`;
    case "dependency_added":
      return `${issue} blocked by #${event.to_value}`;
    case "dependency_resolved":
      return `${issue} unblocked (${event.to_value} resolved)`;
    case "sync":
      return `${c.dim}sync completed${c.reset}`;
    default:
      return `${issue} ${event.event_type}`;
  }
}

// ─── Main ────────────────────────────────────────────────

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);

  try {
    switch (command) {
      case "sync":
        await cmdSync(args);
        break;
      case "board":
        await cmdBoard(/* args */);
        break;
      case "status":
        await cmdStatus(args);
        break;
      case "move":
        await cmdMove(args);
        break;
      case "add":
        await cmdAdd(args);
        break;
      case "dep":
      case "dependency":
        await cmdDep(args);
        break;
      case "history":
      case "events":
        await cmdHistory(args);
        break;
      case "init":
        await cmdInit();
        break;
      case "dashboard":
        console.log("Dashboard coming in v0.16.0. Use 'pm board' for now.");
        break;
      default:
        printUsage();
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`${c.red}Error:${c.reset} ${message}`);
    process.exit(1);
  }
}

function printUsage(): void {
  console.log(`
${c.bold}pm${c.reset} — local-first project management

${c.bold}Commands:${c.reset}
  ${c.cyan}pm init${c.reset}                     First-time setup (create DB, sync from GitHub)
  ${c.cyan}pm sync${c.reset} [--force]            Pull latest from GitHub
  ${c.cyan}pm board${c.reset}                     Kanban board in the terminal
  ${c.cyan}pm status${c.reset} [issue_number]     Project overview or issue detail
  ${c.cyan}pm move${c.reset} <num> <state>        Move issue (${VALID_WORKFLOWS.join(", ")})
  ${c.cyan}pm add${c.reset} <num> [priority]      Start tracking issue (${VALID_PRIORITIES.join(", ")})
  ${c.cyan}pm dep${c.reset} <blocker> <blocked>   Add dependency
  ${c.cyan}pm history${c.reset} [num]             Event history
  ${c.cyan}pm dashboard${c.reset}                 Open web dashboard (coming soon)

${c.bold}Workflow:${c.reset}
  Backlog → Ready → Active → Review → Done
                              ↓
                           Rework → Active

${c.dim}Data stored in .pm/state.db (local, gitignored)
Issues synced from GitHub. Workflow state managed locally.${c.reset}
`);
}

main();
