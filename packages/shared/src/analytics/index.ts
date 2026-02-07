/**
 * Analytics Service
 *
 * Aggregate metrics computed from the runs table.
 * All queries are read-only and use the authenticated user's projects.
 */

import type { Database } from 'better-sqlite3';

export interface AnalyticsResponse {
  totalRuns: number;
  completedRuns: number;
  successRate: number;
  avgCycleTimeMs: number;
  avgApprovalWaitMs: number;
  runsByPhase: Record<string, number>;
  runsByProject: Array<{ projectId: string; projectName: string; count: number }>;
  recentCompletions: Array<{ date: string; count: number }>;
}

export interface GetAnalyticsOptions {
  userId: string;
  projectId?: string;
}

/**
 * Compute aggregate analytics metrics from the runs table.
 */
export function getAnalyticsMetrics(db: Database, options: GetAnalyticsOptions): AnalyticsResponse {
  const conditions: string[] = ['p.user_id = ?'];
  const params: (string | number)[] = [options.userId];

  if (options.projectId !== undefined) {
    conditions.push('r.project_id = ?');
    params.push(options.projectId);
  }

  const whereClause = `WHERE ${conditions.join(' AND ')}`;

  // Total runs
  const totalRow = db.prepare(`
    SELECT COUNT(*) AS count FROM runs r
    JOIN projects p ON r.project_id = p.project_id
    ${whereClause}
  `).get(...params) as { count: number };

  // Completed runs
  const completedRow = db.prepare(`
    SELECT COUNT(*) AS count FROM runs r
    JOIN projects p ON r.project_id = p.project_id
    ${whereClause} AND r.phase = 'completed' AND r.result = 'success'
  `).get(...params) as { count: number };

  const completedTotalRow = db.prepare(`
    SELECT COUNT(*) AS count FROM runs r
    JOIN projects p ON r.project_id = p.project_id
    ${whereClause} AND r.phase = 'completed'
  `).get(...params) as { count: number };

  // Failed runs (completed non-success + cancelled)
  const failedRow = db.prepare(`
    SELECT COUNT(*) AS count FROM runs r
    JOIN projects p ON r.project_id = p.project_id
    ${whereClause} AND (
      (r.phase = 'completed' AND (r.result != 'success' OR r.result IS NULL))
      OR r.phase = 'cancelled'
    )
  `).get(...params) as { count: number };

  // Average duration for completed runs
  const avgDurRow = db.prepare(`
    SELECT AVG(
      (julianday(r.completed_at) - julianday(r.started_at)) * 86400000
    ) AS avg_ms
    FROM runs r
    JOIN projects p ON r.project_id = p.project_id
    ${whereClause} AND r.completed_at IS NOT NULL
  `).get(...params) as { avg_ms: number | null };

  // By phase
  const phaseRows = db.prepare(`
    SELECT r.phase, COUNT(*) AS count FROM runs r
    JOIN projects p ON r.project_id = p.project_id
    ${whereClause}
    GROUP BY r.phase
  `).all(...params) as Array<{ phase: string; count: number }>;

  const runsByPhase: Record<string, number> = {};
  for (const row of phaseRows) {
    runsByPhase[row.phase] = row.count;
  }

  // Runs by project
  const projectRows = db.prepare(`
    SELECT r.project_id, p.name AS project_name, COUNT(*) AS run_count
    FROM runs r
    JOIN projects p ON r.project_id = p.project_id
    ${whereClause}
    GROUP BY r.project_id
    ORDER BY run_count DESC
    LIMIT 5
  `).all(...params) as Array<{ project_id: string; project_name: string; run_count: number }>;

  const runsByProject = projectRows.map((row) => ({
    projectId: row.project_id,
    projectName: row.project_name,
    count: row.run_count,
  }));

  const terminalCount = completedTotalRow.count + failedRow.count;
  const successRate = terminalCount > 0
    ? Math.round((completedRow.count / terminalCount) * 100)
    : 0;

  // Approval wait time: compute time between entering and leaving awaiting_plan_approval
  const approvalEventRows = db.prepare(`
    SELECT
      e.run_id AS run_id,
      e.sequence AS sequence,
      e.created_at AS created_at,
      json_extract(e.payload_json, '$.from') AS from_phase,
      json_extract(e.payload_json, '$.to') AS to_phase
    FROM events e
    JOIN runs r ON e.run_id = r.run_id
    JOIN projects p ON r.project_id = p.project_id
    ${whereClause} AND e.type = 'phase.transitioned'
    ORDER BY e.run_id ASC, e.sequence ASC
  `).all(...params) as Array<{
    run_id: string;
    sequence: number;
    created_at: string;
    from_phase: string | null;
    to_phase: string | null;
  }>;

  let approvalWaitTotal = 0;
  let approvalWaitCount = 0;
  const approvalEntry: Record<string, string | undefined> = {};

  for (const row of approvalEventRows) {
    const runId = row.run_id;
    if (row.to_phase === 'awaiting_plan_approval') {
      approvalEntry[runId] = row.created_at;
      continue;
    }
    const entryTimestamp = approvalEntry[runId];
    if (row.from_phase === 'awaiting_plan_approval' && entryTimestamp !== undefined) {
      const enteredAt = new Date(entryTimestamp).getTime();
      const exitedAt = new Date(row.created_at).getTime();
      if (!Number.isNaN(enteredAt) && !Number.isNaN(exitedAt) && exitedAt >= enteredAt) {
        approvalWaitTotal += exitedAt - enteredAt;
        approvalWaitCount += 1;
      }
      approvalEntry[runId] = undefined;
    }
  }

  const avgApprovalWaitMs = approvalWaitCount > 0
    ? Math.round(approvalWaitTotal / approvalWaitCount)
    : 0;

  // Recent completions (last 7 days)
  const now = new Date();
  const last7d = new Date(now.getTime() - 6 * 24 * 60 * 60 * 1000);
  last7d.setHours(0, 0, 0, 0);

  const recentRows = db.prepare(`
    SELECT date(r.completed_at) AS date, COUNT(*) AS count
    FROM runs r
    JOIN projects p ON r.project_id = p.project_id
    ${whereClause} AND r.completed_at IS NOT NULL AND r.completed_at >= ?
    GROUP BY date
  `).all(...params, last7d.toISOString()) as Array<{ date: string; count: number }>;

  const recentMap = new Map<string, number>();
  for (const row of recentRows) {
    recentMap.set(row.date, row.count);
  }

  const recentCompletions: Array<{ date: string; count: number }> = [];
  for (let i = 6; i >= 0; i -= 1) {
    const day = new Date(now.getTime() - i * 24 * 60 * 60 * 1000);
    const date = day.toISOString().slice(0, 10);
    recentCompletions.push({ date, count: recentMap.get(date) ?? 0 });
  }

  return {
    totalRuns: totalRow.count,
    completedRuns: completedTotalRow.count,
    successRate,
    avgCycleTimeMs: avgDurRow.avg_ms ?? 0,
    avgApprovalWaitMs,
    runsByPhase,
    runsByProject,
    recentCompletions,
  };
}
