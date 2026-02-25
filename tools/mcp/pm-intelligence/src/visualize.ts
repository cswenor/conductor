/**
 * Dependency visualization — ASCII graph and Mermaid diagram output.
 *
 * Renders the issue dependency graph in human-readable formats:
 *   - ASCII: Tree-style diagram with status indicators, for terminal display
 *   - Mermaid: Flowchart syntax that GitHub/Notion/Obsidian renders as diagrams
 *
 * Uses the existing graph module for data; this module is purely presentation.
 *
 * Tools:
 *   - visualizeDependencies: Full graph in ASCII + Mermaid
 */

import {
  analyzeDependencyGraph,
  getIssueDependencies,
  type DependencyGraphResult,
  type IssueDependenciesResult,
} from "./graph.js";

// ─── Types ──────────────────────────────────────────────

export interface VisualizationResult {
  /** ASCII art graph — paste into terminal or monospace block */
  ascii: string;
  /** Mermaid flowchart syntax — renders in GitHub, Notion, Obsidian */
  mermaid: string;
  /** Summary statistics line */
  summary: string;
  /** Focus issue number (if single-issue view) */
  focusIssue: number | null;
  /** Visualization mode used */
  mode: "full" | "single";
}

// ─── Status Indicators ─────────────────────────────────

function stateIcon(state: string, workflow: string | null): string {
  if (state === "CLOSED" || workflow === "Done") return "[x]";
  if (workflow === "Active") return "[>]";
  if (workflow === "Review") return "[?]";
  if (workflow === "Rework") return "[!]";
  if (workflow === "Ready") return "[ ]";
  if (workflow === "Backlog") return "[-]";
  return "[ ]";
}

function stateLabel(state: string, workflow: string | null): string {
  if (state === "CLOSED" || workflow === "Done") return "Done";
  if (workflow) return workflow;
  return state === "OPEN" ? "Open" : "Closed";
}

function mermaidNodeClass(state: string, workflow: string | null): string {
  if (state === "CLOSED" || workflow === "Done") return "done";
  if (workflow === "Active") return "active";
  if (workflow === "Review" || workflow === "Rework") return "review";
  if (workflow === "Ready") return "ready";
  return "backlog";
}

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 3) + "...";
}

// ─── ASCII Rendering ────────────────────────────────────

/**
 * Render full dependency graph as ASCII art.
 *
 * Output looks like:
 * ```
 * DEPENDENCY GRAPH
 * ================
 *
 * Critical Path (3 issues deep):
 *   #100 [>] Upgrade algod  ──>  #200 [ ] Demo wallet  ──>  #300 [ ] Game integration
 *
 * Bottlenecks:
 *   [>] #100 Upgrade algod (blocks 5 issues)
 *   [ ] #150 Auth system (blocks 3 issues)
 *
 * Dependency Tree:
 *   #100 [>] Upgrade algod
 *   ├── #200 [ ] Demo wallet
 *   │   └── #300 [ ] Game integration
 *   └── #250 [-] Token support
 *
 *   #150 [ ] Auth system
 *   └── #175 [-] User profiles
 * ```
 */
function renderFullGraphAscii(graph: DependencyGraphResult): string {
  const lines: string[] = [];

  lines.push("DEPENDENCY GRAPH");
  lines.push("=" .repeat(60));
  lines.push("");

  // Summary line
  lines.push(
    `${graph.connectedIssues} issues with dependencies | ` +
    `${graph.totalEdges} edges | ` +
    `${graph.metrics.connectedComponents} component${graph.metrics.connectedComponents !== 1 ? "s" : ""} | ` +
    `max depth: ${graph.metrics.maxDepth}`
  );
  lines.push("");

  // Critical path
  if (graph.criticalPath.length > 0) {
    lines.push(`Critical Path (${graph.criticalPath.length} issues deep):`);
    const pathStr = graph.criticalPath.issues
      .map((i) => `#${i.number} ${stateIcon(i.workflow === "Done" ? "CLOSED" : "OPEN", i.workflow)} ${truncate(i.title, 30)}`)
      .join("  -->  ");
    lines.push(`  ${pathStr}`);
    lines.push("");
  }

  // Bottlenecks
  if (graph.bottlenecks.length > 0) {
    lines.push("Bottlenecks:");
    for (const b of graph.bottlenecks.slice(0, 5)) {
      const icon = stateIcon(b.state, b.workflow);
      const transitiveNote = b.transitiveBlocksCount > b.blocksCount
        ? ` (${b.transitiveBlocksCount} transitive)`
        : "";
      lines.push(
        `  ${icon} #${b.number} ${truncate(b.title, 40)} ` +
        `blocks ${b.blocksCount} direct${transitiveNote} [${b.severity.toUpperCase()}]`
      );
    }
    lines.push("");
  }

  // Cycles
  if (graph.cycles.length > 0) {
    lines.push("WARNING: Circular Dependencies Detected:");
    for (const cycle of graph.cycles) {
      lines.push(`  ${cycle.description}`);
    }
    lines.push("");
  }

  // Orphaned blocked
  if (graph.orphanedBlocked.length > 0) {
    lines.push("Orphaned (blockers resolved, still marked blocked):");
    for (const o of graph.orphanedBlocked) {
      lines.push(`  #${o.number} ${truncate(o.title, 40)} — ${o.recommendation}`);
    }
    lines.push("");
  }

  // Dependency tree — group by connected components
  lines.push("Dependency Trees:");
  lines.push("-".repeat(60));

  // Build adjacency: parent (blocker) → children (blocked issues)
  const childMap = new Map<number, number[]>();
  const nodeMap = new Map(graph.nodes.map((n) => [n.number, n]));

  for (const edge of graph.edges) {
    if (!childMap.has(edge.from)) childMap.set(edge.from, []);
    childMap.get(edge.from)!.push(edge.to);
  }

  // Find roots: nodes that are blockers but not blocked by anything in the graph
  const blockedNodes = new Set(graph.edges.map((e) => e.to));
  const roots = graph.nodes
    .filter((n) => !blockedNodes.has(n.number) && (childMap.get(n.number)?.length ?? 0) > 0)
    .sort((a, b) => b.outDegree - a.outDegree);

  // Also find isolated pairs where parent isn't in nodes (might be closed)
  const renderedNodes = new Set<number>();

  function renderTree(num: number, prefix: string, isLast: boolean, depth: number): void {
    if (renderedNodes.has(num) || depth > 8) {
      const node = nodeMap.get(num);
      if (node && depth <= 8) {
        lines.push(`${prefix}${isLast ? "└── " : "├── "}#${num} (see above)`);
      }
      return;
    }
    renderedNodes.add(num);

    const node = nodeMap.get(num);
    const icon = node ? stateIcon(node.state, node.workflow) : "[?]";
    const title = node ? truncate(node.title, 45) : "Unknown";
    const connector = depth === 0 ? "" : isLast ? "└── " : "├── ";

    lines.push(`${prefix}${connector}${icon} #${num} ${title}`);

    const children = (childMap.get(num) || [])
      .filter((c) => nodeMap.has(c))
      .sort((a, b) => {
        const na = nodeMap.get(a)!;
        const nb = nodeMap.get(b)!;
        return (nb.outDegree ?? 0) - (na.outDegree ?? 0);
      });

    for (let i = 0; i < children.length; i++) {
      const childIsLast = i === children.length - 1;
      const childPrefix = depth === 0
        ? "  "
        : `${prefix}${isLast ? "    " : "│   "}`;
      renderTree(children[i], childPrefix, childIsLast, depth + 1);
    }
  }

  if (roots.length === 0 && graph.nodes.length > 0) {
    lines.push("  (All dependency chains are cycles or single-link pairs)");
  }

  for (const root of roots) {
    lines.push("");
    renderTree(root.number, "  ", true, 0);
  }

  // Render any remaining unvisited connected nodes (part of cycles, etc.)
  const unvisited = graph.nodes.filter(
    (n) => !renderedNodes.has(n.number) && (n.inDegree > 0 || n.outDegree > 0)
  );
  if (unvisited.length > 0) {
    lines.push("");
    lines.push("  Other connected issues:");
    for (const n of unvisited.slice(0, 10)) {
      const icon = stateIcon(n.state, n.workflow);
      lines.push(
        `  ${icon} #${n.number} ${truncate(n.title, 45)} ` +
        `(in:${n.inDegree} out:${n.outDegree})`
      );
    }
  }

  lines.push("");
  return lines.join("\n");
}

/**
 * Render single-issue dependency view as ASCII art.
 *
 * Output looks like:
 * ```
 * DEPENDENCIES: #200 Demo wallet
 * ====================================
 *
 * Blocked By (upstream):
 *   [x] #100 Upgrade algod (Done) ✓ resolved
 *   [>] #150 Auth system (Active) ✗ unresolved
 *
 * Blocks (downstream):
 *   [ ] #300 Game integration (Ready)
 *   [-] #350 Multiplayer (Backlog)
 *
 * Execution order: 2nd (1 unresolved blocker)
 * Status: BLOCKED — waiting on #150
 * ```
 */
function renderSingleIssueAscii(deps: IssueDependenciesResult): string {
  const lines: string[] = [];

  lines.push(`DEPENDENCIES: #${deps.issueNumber} ${deps.title}`);
  lines.push("=".repeat(60));
  lines.push("");

  lines.push(`State: ${stateLabel(deps.state, deps.workflow)}`);
  lines.push(`Unblocked: ${deps.isUnblocked ? "YES — ready to work" : "NO — has unresolved blockers"}`);
  lines.push(`Execution order: ${deps.executionOrder}${ordinalSuffix(deps.executionOrder)}`);
  lines.push("");

  // Upstream
  if (deps.blockedBy.length > 0) {
    lines.push("Blocked By (upstream):");
    for (const b of deps.blockedBy) {
      const icon = stateIcon(b.state, b.workflow);
      const status = b.resolved ? "resolved" : "UNRESOLVED";
      const marker = b.resolved ? "  " : "<<";
      lines.push(
        `  ${icon} #${b.number} ${truncate(b.title, 35)} (${stateLabel(b.state, b.workflow)}) ${marker} ${status}`
      );
    }
    if (deps.upstreamChain.length > deps.blockedBy.length) {
      lines.push(
        `  ... plus ${deps.upstreamChain.length - deps.blockedBy.length} transitive upstream`
      );
    }
  } else {
    lines.push("Blocked By: (none — no upstream dependencies)");
  }
  lines.push("");

  // Downstream
  if (deps.blocks.length > 0) {
    lines.push("Blocks (downstream):");
    for (const b of deps.blocks) {
      const icon = stateIcon(b.state, b.workflow);
      lines.push(
        `  ${icon} #${b.number} ${truncate(b.title, 35)} (${stateLabel(b.state, b.workflow)})`
      );
    }
    if (deps.downstreamChain.length > deps.blocks.length) {
      lines.push(
        `  ... plus ${deps.downstreamChain.length - deps.blocks.length} transitive downstream`
      );
    }
  } else {
    lines.push("Blocks: (none — no downstream dependents)");
  }
  lines.push("");

  // Full chain visualization
  if (deps.upstreamChain.length > 0 || deps.downstreamChain.length > 0) {
    lines.push("Chain:");
    const upstream = deps.upstreamChain.map((n) => `#${n}`).reverse();
    const downstream = deps.downstreamChain.map((n) => `#${n}`);
    const chain = [...upstream, `[#${deps.issueNumber}]`, ...downstream].join(" --> ");
    lines.push(`  ${chain}`);
    lines.push("");
  }

  return lines.join("\n");
}

function ordinalSuffix(n: number): string {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return s[(v - 20) % 10] || s[v] || s[0];
}

// ─── Mermaid Rendering ──────────────────────────────────

/**
 * Render full graph as Mermaid flowchart.
 *
 * Output:
 * ```mermaid
 * flowchart TD
 *   100["#100 Upgrade algod"]:::active
 *   200["#200 Demo wallet"]:::ready
 *   300["#300 Game integration"]:::backlog
 *   100 --> 200
 *   200 --> 300
 *
 *   classDef done fill:#86efac,stroke:#166534
 *   classDef active fill:#93c5fd,stroke:#1e40af
 *   classDef review fill:#fde68a,stroke:#92400e
 *   classDef ready fill:#e2e8f0,stroke:#475569
 *   classDef backlog fill:#f1f5f9,stroke:#94a3b8,stroke-dasharray: 5 5
 * ```
 */
function renderFullGraphMermaid(graph: DependencyGraphResult): string {
  const lines: string[] = [];

  lines.push("```mermaid");
  lines.push("flowchart TD");

  // Nodes — only include connected issues
  const nodeSet = new Set<number>();
  for (const edge of graph.edges) {
    nodeSet.add(edge.from);
    nodeSet.add(edge.to);
  }

  const nodeMap = new Map(graph.nodes.map((n) => [n.number, n]));

  // Render nodes
  for (const num of nodeSet) {
    const node = nodeMap.get(num);
    if (!node) continue;
    const label = escapeMermaid(`#${num} ${truncate(node.title, 35)}`);
    const cls = mermaidNodeClass(node.state, node.workflow);
    lines.push(`  n${num}["${label}"]:::${cls}`);
  }

  lines.push("");

  // Render edges
  for (const edge of graph.edges) {
    if (!nodeSet.has(edge.from) || !nodeSet.has(edge.to)) continue;
    const style = edge.resolved ? "-.->" : "-->";
    lines.push(`  n${edge.from} ${style} n${edge.to}`);
  }

  lines.push("");

  // Style definitions
  lines.push("  classDef done fill:#86efac,stroke:#166534,color:#052e16");
  lines.push("  classDef active fill:#93c5fd,stroke:#1e40af,color:#1e3a5f");
  lines.push("  classDef review fill:#fde68a,stroke:#92400e,color:#451a03");
  lines.push("  classDef ready fill:#e2e8f0,stroke:#475569,color:#1e293b");
  lines.push("  classDef backlog fill:#f1f5f9,stroke:#94a3b8,stroke-dasharray:5 5,color:#475569");

  // Highlight critical path
  if (graph.criticalPath.length > 0 && graph.criticalPath.issues.length > 1) {
    lines.push("");
    lines.push(`  %% Critical path: ${graph.criticalPath.description}`);
    for (let i = 0; i < graph.criticalPath.issues.length - 1; i++) {
      const from = graph.criticalPath.issues[i].number;
      const to = graph.criticalPath.issues[i + 1].number;
      lines.push(`  linkStyle ${findEdgeIndex(graph.edges, from, to)} stroke:#ef4444,stroke-width:3px`);
    }
  }

  lines.push("```");
  return lines.join("\n");
}

/**
 * Render single-issue view as Mermaid flowchart.
 */
function renderSingleIssueMermaid(deps: IssueDependenciesResult): string {
  const lines: string[] = [];

  lines.push("```mermaid");
  lines.push("flowchart LR");

  // Upstream (blockers)
  if (deps.blockedBy.length > 0) {
    lines.push("  subgraph upstream [\"Blocked By\"]");
    for (const b of deps.blockedBy) {
      const label = escapeMermaid(`#${b.number} ${truncate(b.title, 25)}`);
      const cls = mermaidNodeClass(b.state, b.workflow);
      lines.push(`    n${b.number}["${label}"]:::${cls}`);
    }
    lines.push("  end");
  }

  // Focus issue
  const focusLabel = escapeMermaid(`#${deps.issueNumber} ${truncate(deps.title, 30)}`);
  const focusCls = mermaidNodeClass(deps.state, deps.workflow);
  lines.push(`  focus["${focusLabel}"]:::${focusCls}`);
  lines.push(`  style focus stroke-width:3px`);

  // Downstream (blocks)
  if (deps.blocks.length > 0) {
    lines.push("  subgraph downstream [\"Blocks\"]");
    for (const b of deps.blocks) {
      const label = escapeMermaid(`#${b.number} ${truncate(b.title, 25)}`);
      const cls = mermaidNodeClass(b.state, b.workflow);
      lines.push(`    n${b.number}["${label}"]:::${cls}`);
    }
    lines.push("  end");
  }

  lines.push("");

  // Edges: blockers → focus
  for (const b of deps.blockedBy) {
    const style = b.resolved ? "-.->" : "-->";
    lines.push(`  n${b.number} ${style} focus`);
  }

  // Edges: focus → blocks
  for (const b of deps.blocks) {
    lines.push(`  focus --> n${b.number}`);
  }

  lines.push("");

  // Style definitions
  lines.push("  classDef done fill:#86efac,stroke:#166534,color:#052e16");
  lines.push("  classDef active fill:#93c5fd,stroke:#1e40af,color:#1e3a5f");
  lines.push("  classDef review fill:#fde68a,stroke:#92400e,color:#451a03");
  lines.push("  classDef ready fill:#e2e8f0,stroke:#475569,color:#1e293b");
  lines.push("  classDef backlog fill:#f1f5f9,stroke:#94a3b8,stroke-dasharray:5 5,color:#475569");

  lines.push("```");
  return lines.join("\n");
}

function escapeMermaid(text: string): string {
  return text.replace(/"/g, "'").replace(/[[\]{}()]/g, "");
}

function findEdgeIndex(
  edges: DependencyGraphResult["edges"],
  from: number,
  to: number
): number {
  // Mermaid linkStyle index matches the order edges appear in the flowchart
  let idx = 0;
  for (const edge of edges) {
    if (edge.from === from && edge.to === to) return idx;
    idx++;
  }
  return 0;
}

// ─── Public Functions ───────────────────────────────────

/**
 * Visualize the dependency graph.
 *
 * @param issueNumber - If provided, shows single-issue view. If omitted, shows full graph.
 * @param format - "both" (default), "ascii", or "mermaid"
 */
export async function visualizeDependencies(
  issueNumber?: number,
  format: "both" | "ascii" | "mermaid" = "both"
): Promise<VisualizationResult> {
  if (issueNumber) {
    // Single-issue view
    const deps = await getIssueDependencies(issueNumber);
    const graph = await analyzeDependencyGraph();

    const ascii = format !== "mermaid" ? renderSingleIssueAscii(deps) : "";
    const mermaid = format !== "ascii" ? renderSingleIssueMermaid(deps) : "";

    const blockerStatus = deps.isUnblocked
      ? "unblocked, ready to work"
      : `blocked by ${deps.blockedBy.filter((b) => !b.resolved).length} unresolved issue(s)`;

    return {
      ascii,
      mermaid,
      summary: `#${issueNumber}: ${blockerStatus} | ${deps.blockedBy.length} upstream, ${deps.blocks.length} downstream`,
      focusIssue: issueNumber,
      mode: "single",
    };
  } else {
    // Full graph view
    const graph = await analyzeDependencyGraph();

    const ascii = format !== "mermaid" ? renderFullGraphAscii(graph) : "";
    const mermaid = format !== "ascii" ? renderFullGraphMermaid(graph) : "";

    return {
      ascii,
      mermaid,
      summary:
        `${graph.connectedIssues} connected issues | ` +
        `${graph.totalEdges} edges | ` +
        `${graph.bottlenecks.length} bottleneck${graph.bottlenecks.length !== 1 ? "s" : ""} | ` +
        `critical path: ${graph.criticalPath.length} deep`,
      focusIssue: null,
      mode: "full",
    };
  }
}
