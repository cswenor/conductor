/**
 * Issue dependency graph analysis — critical path, bottleneck detection, cycle detection.
 *
 * Builds a directed graph from issue relationships (blocked-by labels, cross-references,
 * "Blocks #X" / "Blocked by #X" comments) and analyzes the dependency structure.
 *
 * Tools:
 *   - analyzeDependencyGraph: Full dependency graph with critical path and bottlenecks
 *   - getIssueDependencies: Dependencies for a single issue
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getConfig } from "./config.js";
import { getDb, getIssuesByWorkflow } from "./db.js";

const execFileAsync = promisify(execFile);

async function gh(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("gh", args, {
    timeout: 30_000,
    maxBuffer: 10 * 1024 * 1024,
  });
  return stdout.trim();
}

// ─── Types ──────────────────────────────────────────────

interface GraphNode {
  number: number;
  title: string;
  state: "OPEN" | "CLOSED";
  workflow: string | null;
  labels: string[];
  blockedBy: number[];  // Issues this node depends on
  blocks: number[];     // Issues that depend on this node
}

interface DependencyEdge {
  from: number;  // Blocker issue
  to: number;    // Blocked issue
  type: "label" | "reference" | "comment";
  resolved: boolean;  // true if the blocker is closed/done
}

export interface DependencyGraphResult {
  /** Total issues analyzed */
  totalIssues: number;
  /** Total dependency relationships found */
  totalEdges: number;
  /** Issues involved in dependency chains */
  connectedIssues: number;
  /** The graph structure */
  nodes: Array<{
    number: number;
    title: string;
    state: string;
    workflow: string | null;
    inDegree: number;   // How many issues block this one
    outDegree: number;  // How many issues this blocks
    depth: number;      // Longest path from any root to this node
  }>;
  /** All dependency edges */
  edges: DependencyEdge[];
  /** Critical path — longest chain of unresolved dependencies */
  criticalPath: {
    length: number;
    issues: Array<{ number: number; title: string; workflow: string | null }>;
    totalEstimatedDays: number | null;
    description: string;
  };
  /** Bottleneck issues — blocking the most other work */
  bottlenecks: Array<{
    number: number;
    title: string;
    workflow: string | null;
    state: string;
    blocksCount: number;
    transitiveBlocksCount: number;  // Including transitive dependents
    severity: "critical" | "high" | "medium";
    recommendation: string;
  }>;
  /** Cycle detection (should be empty in a healthy project) */
  cycles: Array<{
    issues: number[];
    description: string;
  }>;
  /** Orphaned blocked issues — blocked by closed/resolved issues but still open */
  orphanedBlocked: Array<{
    number: number;
    title: string;
    blockedBy: number[];
    recommendation: string;
  }>;
  /** Network metrics */
  metrics: {
    maxDepth: number;
    avgDegree: number;
    density: number;  // edges / possible edges
    connectedComponents: number;
    largestComponent: number;
  };
}

export interface IssueDependenciesResult {
  issueNumber: number;
  title: string;
  state: string;
  workflow: string | null;
  /** Direct dependencies (issues this one is blocked by) */
  blockedBy: Array<{
    number: number;
    title: string;
    state: string;
    workflow: string | null;
    resolved: boolean;
  }>;
  /** Issues directly blocked by this one */
  blocks: Array<{
    number: number;
    title: string;
    state: string;
    workflow: string | null;
  }>;
  /** Full upstream chain (all transitive dependencies) */
  upstreamChain: number[];
  /** Full downstream chain (all transitive dependents) */
  downstreamChain: number[];
  /** Is this issue ready to work on? (all blockers resolved) */
  isUnblocked: boolean;
  /** Estimated position in dependency order */
  executionOrder: number;
}

// ─── Graph Construction ─────────────────────────────────

/**
 * Fetch all open issues with their relationships from the project board.
 */
async function fetchProjectIssues(): Promise<GraphNode[]> {
  const config = await getConfig();
  const fullRepo = `${config.owner}/${config.repo}`;

  // Get all open issues with labels
  const issuesRaw = await gh([
    "issue",
    "list",
    "--repo",
    fullRepo,
    "--state",
    "all",
    "--json",
    "number,title,state,labels,body",
    "--limit",
    "200",
  ]);

  const issues: Array<{
    number: number;
    title: string;
    state: string;
    labels: Array<{ name: string }>;
    body: string;
  }> = JSON.parse(issuesRaw);

  // Get workflow state from local DB instead of GitHub Projects
  const db = await getDb();
  const dbIssues = db
    .prepare("SELECT number, workflow FROM issues")
    .all() as Array<{ number: number; workflow: string }>;

  const workflowMap = new Map<number, string>();
  for (const row of dbIssues) {
    if (row.workflow) workflowMap.set(row.number, row.workflow);
  }

  // Parse relationships
  const nodes: GraphNode[] = [];
  const issueSet = new Set(issues.map((i) => i.number));

  for (const issue of issues) {
    const labelNames = issue.labels.map((l) => l.name);
    const blockedBy: number[] = [];
    const blocks: number[] = [];

    // Strategy 1: Parse "blocked:*" labels
    for (const label of labelNames) {
      if (label.startsWith("blocked:")) {
        // Label indicates this issue is blocked — extract blocker from body
        const bodyRefs = extractIssueReferences(issue.body, issueSet);
        blockedBy.push(...bodyRefs.blockedBy);
      }
    }

    // Strategy 2: Parse body for explicit dependency markers
    const bodyDeps = parseBodyDependencies(issue.body, issueSet);
    for (const dep of bodyDeps.blockedBy) {
      if (!blockedBy.includes(dep)) blockedBy.push(dep);
    }
    for (const dep of bodyDeps.blocks) {
      if (!blocks.includes(dep)) blocks.push(dep);
    }

    nodes.push({
      number: issue.number,
      title: issue.title,
      state: issue.state === "OPEN" ? "OPEN" : "CLOSED",
      workflow: workflowMap.get(issue.number) ?? null,
      labels: labelNames,
      blockedBy,
      blocks,
    });
  }

  // Cross-link: if A says it blocks B, add to B's blockedBy
  const nodeMap = new Map(nodes.map((n) => [n.number, n]));
  for (const node of nodes) {
    for (const blocksNum of node.blocks) {
      const target = nodeMap.get(blocksNum);
      if (target && !target.blockedBy.includes(node.number)) {
        target.blockedBy.push(node.number);
      }
    }
    for (const blockedByNum of node.blockedBy) {
      const source = nodeMap.get(blockedByNum);
      if (source && !source.blocks.includes(node.number)) {
        source.blocks.push(node.number);
      }
    }
  }

  return nodes;
}

/** Extract issue references from body text */
function extractIssueReferences(
  body: string,
  validIssues: Set<number>
): { blockedBy: number[]; blocks: number[] } {
  const blockedBy: number[] = [];
  const blocks: number[] = [];

  if (!body) return { blockedBy, blocks };

  // Match "Blocked by #123" or "depends on #123"
  const blockedByPattern = /(?:blocked\s+by|depends\s+on|waiting\s+(?:on|for))\s+#(\d+)/gi;
  let match;
  while ((match = blockedByPattern.exec(body)) !== null) {
    const num = parseInt(match[1], 10);
    if (validIssues.has(num) && !blockedBy.includes(num)) {
      blockedBy.push(num);
    }
  }

  // Match "Blocks #123" or "required by #123"
  const blocksPattern = /(?:blocks|required\s+by|prerequisite\s+for)\s+#(\d+)/gi;
  while ((match = blocksPattern.exec(body)) !== null) {
    const num = parseInt(match[1], 10);
    if (validIssues.has(num) && !blocks.includes(num)) {
      blocks.push(num);
    }
  }

  return { blockedBy, blocks };
}

/** Parse structured dependency sections in issue body */
function parseBodyDependencies(
  body: string,
  validIssues: Set<number>
): { blockedBy: number[]; blocks: number[] } {
  const blockedBy: number[] = [];
  const blocks: number[] = [];

  if (!body) return { blockedBy, blocks };

  // Look for "## Blocks" section
  const blocksSectionMatch = body.match(/##\s*Blocks\s*\n([\s\S]*?)(?=\n##|\n$|$)/i);
  if (blocksSectionMatch) {
    const refs = blocksSectionMatch[1].match(/#(\d+)/g) || [];
    for (const ref of refs) {
      const num = parseInt(ref.slice(1), 10);
      if (validIssues.has(num) && !blocks.includes(num)) blocks.push(num);
    }
  }

  // Look for "## Blocked by" or "## Dependencies" section
  const depSectionMatch = body.match(
    /##\s*(?:Blocked\s+by|Dependencies|Depends\s+on|Prerequisites)\s*\n([\s\S]*?)(?=\n##|\n$|$)/i
  );
  if (depSectionMatch) {
    const refs = depSectionMatch[1].match(/#(\d+)/g) || [];
    for (const ref of refs) {
      const num = parseInt(ref.slice(1), 10);
      if (validIssues.has(num) && !blockedBy.includes(num)) blockedBy.push(num);
    }
  }

  // Look for "Blocker: #X" inline pattern (used by discovered work sub-playbook)
  const blockerPattern = /\*\*Blocker:\*\*\s*#(\d+)/g;
  let match;
  while ((match = blockerPattern.exec(body)) !== null) {
    const num = parseInt(match[1], 10);
    if (validIssues.has(num) && !blockedBy.includes(num)) blockedBy.push(num);
  }

  return { blockedBy, blocks };
}

async function getRepoName(): Promise<string> {
  const { stdout } = await execFileAsync("git", ["remote", "get-url", "origin"]);
  const url = stdout.trim();
  const match = url.match(/(?:github\.com[:/])([^/]+\/[^/.\s]+)/);
  if (!match) throw new Error(`Cannot parse repo from remote URL: ${url}`);
  return match[1].replace(/\.git$/, "").split("/")[1];
}

// ─── Graph Analysis ─────────────────────────────────────

/** Build edges from nodes */
function buildEdges(nodes: GraphNode[]): DependencyEdge[] {
  const edges: DependencyEdge[] = [];
  const nodeMap = new Map(nodes.map((n) => [n.number, n]));

  for (const node of nodes) {
    for (const blockerNum of node.blockedBy) {
      const blocker = nodeMap.get(blockerNum);
      edges.push({
        from: blockerNum,
        to: node.number,
        type: node.labels.some((l) => l.startsWith("blocked:")) ? "label" : "reference",
        resolved: blocker ? blocker.state === "CLOSED" || blocker.workflow === "Done" : true,
      });
    }
  }

  return edges;
}

/** Detect cycles using DFS */
function detectCycles(nodes: GraphNode[]): number[][] {
  const cycles: number[][] = [];
  const adjacency = new Map<number, number[]>();

  for (const node of nodes) {
    adjacency.set(node.number, node.blockedBy);
  }

  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map<number, number>();
  const parent = new Map<number, number | null>();

  for (const node of nodes) {
    color.set(node.number, WHITE);
    parent.set(node.number, null);
  }

  function dfs(u: number, path: number[]): void {
    color.set(u, GRAY);
    path.push(u);

    for (const v of adjacency.get(u) || []) {
      if (color.get(v) === GRAY) {
        // Found a cycle — extract it
        const cycleStart = path.indexOf(v);
        if (cycleStart >= 0) {
          cycles.push(path.slice(cycleStart));
        }
      } else if (color.get(v) === WHITE) {
        parent.set(v, u);
        dfs(v, [...path]);
      }
    }

    color.set(u, BLACK);
  }

  for (const node of nodes) {
    if (color.get(node.number) === WHITE) {
      dfs(node.number, []);
    }
  }

  // Deduplicate cycles (same set of nodes in different order)
  const seen = new Set<string>();
  return cycles.filter((cycle) => {
    const key = [...cycle].sort((a, b) => a - b).join(",");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Calculate depth of each node (longest path from any root) */
function calculateDepths(nodes: GraphNode[]): Map<number, number> {
  const depths = new Map<number, number>();
  const nodeMap = new Map(nodes.map((n) => [n.number, n]));

  function getDepth(num: number, visited: Set<number>): number {
    if (depths.has(num)) return depths.get(num)!;
    if (visited.has(num)) return 0; // Cycle protection
    visited.add(num);

    const node = nodeMap.get(num);
    if (!node || node.blockedBy.length === 0) {
      depths.set(num, 0);
      return 0;
    }

    let maxParentDepth = 0;
    for (const parent of node.blockedBy) {
      if (nodeMap.has(parent)) {
        maxParentDepth = Math.max(maxParentDepth, getDepth(parent, visited) + 1);
      }
    }

    depths.set(num, maxParentDepth);
    return maxParentDepth;
  }

  for (const node of nodes) {
    getDepth(node.number, new Set());
  }

  return depths;
}

/** Find the critical path (longest chain of unresolved dependencies) */
function findCriticalPath(
  nodes: GraphNode[],
  edges: DependencyEdge[]
): DependencyGraphResult["criticalPath"] {
  // Only consider unresolved edges and open issues
  const unresolvedEdges = edges.filter((e) => !e.resolved);
  const openNodes = new Map(
    nodes
      .filter((n) => n.state === "OPEN" && n.workflow !== "Done")
      .map((n) => [n.number, n])
  );

  if (unresolvedEdges.length === 0) {
    return {
      length: 0,
      issues: [],
      totalEstimatedDays: null,
      description: "No unresolved dependency chains found",
    };
  }

  // Build adjacency for open issues only
  const adj = new Map<number, number[]>();
  for (const edge of unresolvedEdges) {
    if (openNodes.has(edge.from) && openNodes.has(edge.to)) {
      if (!adj.has(edge.from)) adj.set(edge.from, []);
      adj.get(edge.from)!.push(edge.to);
    }
  }

  // Find longest path using DFS from each root
  let longestPath: number[] = [];

  function dfs(node: number, path: number[], visited: Set<number>): void {
    if (path.length > longestPath.length) {
      longestPath = [...path];
    }

    for (const next of adj.get(node) || []) {
      if (!visited.has(next)) {
        visited.add(next);
        path.push(next);
        dfs(next, path, visited);
        path.pop();
        visited.delete(next);
      }
    }
  }

  // Find roots (issues with no unresolved blockers among open issues)
  const hasUnresolvedBlocker = new Set(
    unresolvedEdges
      .filter((e) => openNodes.has(e.from) && openNodes.has(e.to))
      .map((e) => e.to)
  );
  const roots = [...openNodes.keys()].filter((n) => !hasUnresolvedBlocker.has(n));

  // Also try all open issues with dependencies as starting points
  const startPoints = roots.length > 0 ? roots : [...adj.keys()];

  for (const start of startPoints) {
    const visited = new Set([start]);
    dfs(start, [start], visited);
  }

  const pathIssues = longestPath.map((num) => {
    const node = openNodes.get(num)!;
    return {
      number: num,
      title: node?.title ?? `Issue #${num}`,
      workflow: node?.workflow ?? null,
    };
  });

  return {
    length: longestPath.length,
    issues: pathIssues,
    totalEstimatedDays: null, // Could be estimated from cycle times
    description:
      longestPath.length > 0
        ? `Critical chain: ${longestPath.map((n) => `#${n}`).join(" → ")} (${longestPath.length} issues deep)`
        : "No critical dependency chain found",
  };
}

/** Calculate transitive dependents (all issues transitively blocked by a node) */
function getTransitiveDependents(
  nodeNum: number,
  nodes: GraphNode[]
): Set<number> {
  const nodeMap = new Map(nodes.map((n) => [n.number, n]));
  const visited = new Set<number>();

  function dfs(num: number): void {
    if (visited.has(num)) return;
    visited.add(num);
    const node = nodeMap.get(num);
    if (node) {
      for (const blocked of node.blocks) {
        dfs(blocked);
      }
    }
  }

  dfs(nodeNum);
  visited.delete(nodeNum); // Don't count self
  return visited;
}

/** Find connected components */
function findConnectedComponents(nodes: GraphNode[]): number[][] {
  const visited = new Set<number>();
  const components: number[][] = [];

  // Build undirected adjacency
  const adj = new Map<number, Set<number>>();
  for (const node of nodes) {
    if (!adj.has(node.number)) adj.set(node.number, new Set());
    for (const dep of node.blockedBy) {
      if (!adj.has(dep)) adj.set(dep, new Set());
      adj.get(node.number)!.add(dep);
      adj.get(dep)!.add(node.number);
    }
    for (const dep of node.blocks) {
      if (!adj.has(dep)) adj.set(dep, new Set());
      adj.get(node.number)!.add(dep);
      adj.get(dep)!.add(node.number);
    }
  }

  function bfs(start: number): number[] {
    const component: number[] = [];
    const queue = [start];
    visited.add(start);

    while (queue.length > 0) {
      const current = queue.shift()!;
      component.push(current);
      for (const neighbor of adj.get(current) || []) {
        if (!visited.has(neighbor)) {
          visited.add(neighbor);
          queue.push(neighbor);
        }
      }
    }

    return component;
  }

  // Only consider nodes with edges
  const nodesWithEdges = nodes.filter(
    (n) => n.blockedBy.length > 0 || n.blocks.length > 0
  );

  for (const node of nodesWithEdges) {
    if (!visited.has(node.number)) {
      components.push(bfs(node.number));
    }
  }

  return components;
}

// ─── Public Functions ───────────────────────────────────

/**
 * Analyze the full issue dependency graph.
 *
 * Builds a DAG from issue relationships, finds critical paths,
 * detects bottlenecks, and identifies cycles.
 */
export async function analyzeDependencyGraph(): Promise<DependencyGraphResult> {
  const nodes = await fetchProjectIssues();
  const edges = buildEdges(nodes);
  const depths = calculateDepths(nodes);
  const criticalPath = findCriticalPath(nodes, edges);
  const cycles = detectCycles(nodes);
  const components = findConnectedComponents(nodes);

  // Connected issues (those with at least one edge)
  const connectedSet = new Set<number>();
  for (const edge of edges) {
    connectedSet.add(edge.from);
    connectedSet.add(edge.to);
  }

  // Build node info with metrics
  const graphNodes = nodes
    .filter((n) => connectedSet.has(n.number))
    .map((n) => ({
      number: n.number,
      title: n.title,
      state: n.state,
      workflow: n.workflow,
      inDegree: n.blockedBy.length,
      outDegree: n.blocks.length,
      depth: depths.get(n.number) ?? 0,
    }))
    .sort((a, b) => b.outDegree - a.outDegree); // Most blocking first

  // Find bottlenecks (open issues that block the most work)
  const bottlenecks = nodes
    .filter((n) => n.blocks.length > 0 && n.state === "OPEN" && n.workflow !== "Done")
    .map((n) => {
      const transitiveCount = getTransitiveDependents(n.number, nodes).size;
      return {
        number: n.number,
        title: n.title,
        workflow: n.workflow,
        state: n.state,
        blocksCount: n.blocks.length,
        transitiveBlocksCount: transitiveCount,
        severity: (transitiveCount >= 5
          ? "critical"
          : transitiveCount >= 3
            ? "high"
            : "medium") as "critical" | "high" | "medium",
        recommendation:
          transitiveCount >= 5
            ? `CRITICAL: Unblocks ${transitiveCount} issues. Prioritize immediately.`
            : transitiveCount >= 3
              ? `HIGH: Unblocks ${transitiveCount} issues. Address this sprint.`
              : `MEDIUM: Blocks ${n.blocks.length} direct dependencies.`,
      };
    })
    .sort((a, b) => b.transitiveBlocksCount - a.transitiveBlocksCount)
    .slice(0, 10);

  // Orphaned blocked issues (blocked by resolved issues but still open)
  const orphanedBlocked = nodes
    .filter((n) => {
      if (n.state !== "OPEN") return false;
      if (n.blockedBy.length === 0) return false;
      const nodeMap = new Map(nodes.map((node) => [node.number, node]));
      // All blockers are resolved
      return n.blockedBy.every((blockerNum) => {
        const blocker = nodeMap.get(blockerNum);
        return blocker && (blocker.state === "CLOSED" || blocker.workflow === "Done");
      });
    })
    .map((n) => ({
      number: n.number,
      title: n.title,
      blockedBy: n.blockedBy,
      recommendation: `All blockers resolved — remove "blocked" label and move to Ready/Active`,
    }));

  // Network metrics
  const totalNodes = connectedSet.size;
  const totalDegree = graphNodes.reduce((s, n) => s + n.inDegree + n.outDegree, 0);
  const possibleEdges = totalNodes * (totalNodes - 1);
  const maxDepth = Math.max(...[...depths.values()], 0);

  return {
    totalIssues: nodes.length,
    totalEdges: edges.length,
    connectedIssues: connectedSet.size,
    nodes: graphNodes.slice(0, 30), // Top 30
    edges,
    criticalPath,
    bottlenecks,
    cycles: cycles.map((cycle) => ({
      issues: cycle,
      description: `Circular dependency: ${cycle.map((n) => `#${n}`).join(" → #")} → #${cycle[0]}`,
    })),
    orphanedBlocked,
    metrics: {
      maxDepth,
      avgDegree: totalNodes > 0 ? Math.round((totalDegree / totalNodes) * 10) / 10 : 0,
      density:
        possibleEdges > 0
          ? Math.round((edges.length / possibleEdges) * 10000) / 10000
          : 0,
      connectedComponents: components.length,
      largestComponent: components.length > 0 ? Math.max(...components.map((c) => c.length)) : 0,
    },
  };
}

/**
 * Get dependencies for a single issue — upstream and downstream chains.
 */
export async function getIssueDependencies(
  issueNumber: number
): Promise<IssueDependenciesResult> {
  const nodes = await fetchProjectIssues();
  const nodeMap = new Map(nodes.map((n) => [n.number, n]));
  const target = nodeMap.get(issueNumber);

  if (!target) {
    throw new Error(`Issue #${issueNumber} not found`);
  }

  // Direct blockers
  const blockedBy = target.blockedBy.map((num) => {
    const blocker = nodeMap.get(num);
    return {
      number: num,
      title: blocker?.title ?? `Issue #${num}`,
      state: blocker?.state ?? "CLOSED",
      workflow: blocker?.workflow ?? null,
      resolved: !blocker || blocker.state === "CLOSED" || blocker.workflow === "Done",
    };
  });

  // Direct blocks
  const blocks = target.blocks.map((num) => {
    const blocked = nodeMap.get(num);
    return {
      number: num,
      title: blocked?.title ?? `Issue #${num}`,
      state: blocked?.state ?? "CLOSED",
      workflow: blocked?.workflow ?? null,
    };
  });

  // Transitive upstream (all issues we depend on, recursively)
  const upstreamChain: number[] = [];
  function getUpstream(num: number, visited: Set<number>): void {
    const node = nodeMap.get(num);
    if (!node) return;
    for (const dep of node.blockedBy) {
      if (!visited.has(dep)) {
        visited.add(dep);
        upstreamChain.push(dep);
        getUpstream(dep, visited);
      }
    }
  }
  getUpstream(issueNumber, new Set([issueNumber]));

  // Transitive downstream (all issues that depend on us)
  const downstreamSet = getTransitiveDependents(issueNumber, nodes);
  const downstreamChain = [...downstreamSet];

  // Check if all blockers are resolved
  const isUnblocked = blockedBy.every((b) => b.resolved);

  // Calculate execution order (topological position)
  // Simple heuristic: count unresolved upstream dependencies
  const unresolvedUpstream = upstreamChain.filter((num) => {
    const n = nodeMap.get(num);
    return n && n.state === "OPEN" && n.workflow !== "Done";
  });
  const executionOrder = unresolvedUpstream.length + 1;

  return {
    issueNumber,
    title: target.title,
    state: target.state,
    workflow: target.workflow,
    blockedBy,
    blocks,
    upstreamChain,
    downstreamChain,
    isUnblocked,
    executionOrder,
  };
}
