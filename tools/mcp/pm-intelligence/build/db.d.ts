/**
 * Local SQLite database — the PM brain.
 *
 * GitHub is the source of truth for issue content (title, body, labels, state).
 * This database stores:
 *   1. A mirror of GitHub issue/PR metadata (refreshed on sync)
 *   2. Local-only PM state (workflow, priority, dependencies)
 *   3. Event history (every state change with timestamp)
 *   4. Decisions, outcomes, and session data
 *
 * Schema is event-sourced: every mutation records an event, enabling
 * full history reconstruction, velocity calculation, and pattern detection.
 */
import Database from "better-sqlite3";
/** Get or create the database connection */
export declare function getDb(): Promise<Database.Database>;
/** Close the database connection */
export declare function closeDb(): void;
/** Get the .pm directory path */
export declare function getPmDir(): Promise<string>;
export type WorkflowState = "Backlog" | "Ready" | "Active" | "Review" | "Rework" | "Done";
export declare const VALID_WORKFLOWS: WorkflowState[];
export declare const VALID_PRIORITIES: readonly ["critical", "high", "normal"];
export type Priority = (typeof VALID_PRIORITIES)[number];
export interface LocalIssue {
    number: number;
    title: string;
    body: string | null;
    state: string;
    author: string | null;
    created_at: string;
    updated_at: string;
    closed_at: string | null;
    workflow: WorkflowState;
    priority: Priority;
    estimate: string | null;
    risk: string | null;
    labels: string[];
    assignees: string[];
    synced_at: string;
}
/** Get an issue with its labels and assignees */
export declare function getIssue(issueNumber: number): Promise<LocalIssue | null>;
/** Get all issues in a workflow state */
export declare function getIssuesByWorkflow(workflow: WorkflowState): Promise<LocalIssue[]>;
/** Get board summary from local DB */
export declare function getLocalBoardSummary(): Promise<{
    total: number;
    byWorkflow: Record<string, number>;
    byPriority: Record<string, number>;
    activeIssues: LocalIssue[];
    reviewIssues: LocalIssue[];
    reworkIssues: LocalIssue[];
    blockedIssues: Array<{
        issue: LocalIssue;
        blockedBy: number[];
    }>;
    healthScore: number;
}>;
/** Move an issue to a new workflow state */
export declare function moveIssueWorkflow(issueNumber: number, targetState: WorkflowState, actor?: string): Promise<{
    success: boolean;
    message: string;
    from: string;
    to: string;
}>;
/** Add a dependency between issues */
export declare function addDependency(blockerIssue: number, blockedIssue: number, depType?: string): Promise<void>;
/** Get dependencies for an issue */
export declare function getDependencies(issueNumber: number): Promise<{
    blockedBy: Array<{
        issue: number;
        type: string;
        resolved: boolean;
    }>;
    blocks: Array<{
        issue: number;
        type: string;
        resolved: boolean;
    }>;
}>;
export interface PMEvent {
    id: number;
    timestamp: string;
    event_type: string;
    issue_number: number | null;
    pr_number: number | null;
    from_value: string | null;
    to_value: string | null;
    actor: string | null;
    session_id: string | null;
    metadata: Record<string, unknown> | null;
}
/** Query events with filters */
export declare function queryEvents(filters?: {
    issueNumber?: number;
    eventType?: string;
    since?: string;
    limit?: number;
}): Promise<PMEvent[]>;
/** Get cycle time (Active → Done) for completed issues */
export declare function getCycleTimes(days?: number): Promise<Array<{
    issue_number: number;
    hours: number;
    workflow_path: string[];
}>>;
/** Upsert an issue from GitHub data */
export declare function upsertIssue(data: {
    number: number;
    title: string;
    body: string | null;
    state: string;
    author: string | null;
    created_at: string;
    updated_at: string;
    closed_at: string | null;
    labels: string[];
    assignees: string[];
}): Promise<{
    isNew: boolean;
}>;
/** Upsert a pull request from GitHub data */
export declare function upsertPR(data: {
    number: number;
    title: string;
    state: string;
    author: string | null;
    branch: string | null;
    base_branch: string | null;
    created_at: string;
    updated_at: string;
    merged_at: string | null;
    closed_at: string | null;
    additions: number;
    deletions: number;
    changed_files: number;
    review_state: string | null;
    draft: boolean;
    linked_issues: Array<{
        issue_number: number;
        link_type: string;
    }>;
}): Promise<void>;
/** Record last sync timestamp */
export declare function updateSyncState(resource: string, cursor?: string): Promise<void>;
/** Get last sync time for a resource */
export declare function getLastSync(resource: string): Promise<{
    last_sync: string;
    cursor: string | null;
} | null>;
