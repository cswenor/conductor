/**
 * Analytics Service
 *
 * Aggregate metrics computed from the runs table.
 * All queries are read-only and use the authenticated user's projects.
 */

import type { Database } from 'better-sqlite3';

export interface AnalyticsMetrics {
  /** Total runs across all user projects. */
  totalRuns: number;
  /** Runs currently in active phases (planning, executing, awaiting_review). */
  activeRuns: number;
  /** Runs completed with result = 'success'. */
  successfulRuns: number;
  /** Runs in completed phase with non-success result, or cancelled. */
  failedRuns: number;
  /** Success rate as a percentage (0–100). */
  successRate: number;
  /** Average run duration in ms for completed runs. */
  avgDurationMs: number;
  /** Runs completed in the last 24 hours. */
  completedLast24h: number;
  /** Runs completed in the last 7 days. */
  completedLast7d: number;
  /** Breakdown of runs by phase. */
  byPhase: Record<string, number>;
  /** Breakdown of completed runs by result. */
  byResult: Record<string, number>;
  /** Top projects by run count. */
  topProjects: Array<{ projectId: string; projectName: string; runCount: number }>;
}

export interface GetAnalyticsOptions {
  userId: string;
  projectId?: string;
}

/**
 * Compute aggregate analytics metrics from the runs table.
 */
export function getAnalyticsMetrics(db: Database, options: GetAnalyticsOptions): AnalyticsMetrics {
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

  // Active runs
  const activeRow = db.prepare(`
    SELECT COUNT(*) AS count FROM runs r
    JOIN projects p ON r.project_id = p.project_id
    ${whereClause} AND r.phase IN ('planning', 'executing', 'awaiting_review')
  `).get(...params) as { count: number };

  // Successful runs
  const successRow = db.prepare(`
    SELECT COUNT(*) AS count FROM runs r
    JOIN projects p ON r.project_id = p.project_id
    ${whereClause} AND r.phase = 'completed' AND r.result = 'success'
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

  // Completed in last 24h
  const now = new Date();
  const last24h = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
  const last7d = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();

  const completed24hRow = db.prepare(`
    SELECT COUNT(*) AS count FROM runs r
    JOIN projects p ON r.project_id = p.project_id
    ${whereClause} AND r.phase IN ('completed', 'cancelled') AND r.completed_at >= ?
  `).get(...params, last24h) as { count: number };

  const completed7dRow = db.prepare(`
    SELECT COUNT(*) AS count FROM runs r
    JOIN projects p ON r.project_id = p.project_id
    ${whereClause} AND r.phase IN ('completed', 'cancelled') AND r.completed_at >= ?
  `).get(...params, last7d) as { count: number };

  // By phase
  const phaseRows = db.prepare(`
    SELECT r.phase, COUNT(*) AS count FROM runs r
    JOIN projects p ON r.project_id = p.project_id
    ${whereClause}
    GROUP BY r.phase
  `).all(...params) as Array<{ phase: string; count: number }>;

  const byPhase: Record<string, number> = {};
  for (const row of phaseRows) {
    byPhase[row.phase] = row.count;
  }

  // By result (for completed runs)
  const resultRows = db.prepare(`
    SELECT COALESCE(r.result, 'unknown') AS result, COUNT(*) AS count FROM runs r
    JOIN projects p ON r.project_id = p.project_id
    ${whereClause} AND r.phase IN ('completed', 'cancelled')
    GROUP BY r.result
  `).all(...params) as Array<{ result: string; count: number }>;

  const byResult: Record<string, number> = {};
  for (const row of resultRows) {
    byResult[row.result] = row.count;
  }

  // Top projects
  const projectRows = db.prepare(`
    SELECT r.project_id, p.name AS project_name, COUNT(*) AS run_count
    FROM runs r
    JOIN projects p ON r.project_id = p.project_id
    ${whereClause}
    GROUP BY r.project_id
    ORDER BY run_count DESC
    LIMIT 5
  `).all(...params) as Array<{ project_id: string; project_name: string; run_count: number }>;

  const topProjects = projectRows.map((row) => ({
    projectId: row.project_id,
    projectName: row.project_name,
    runCount: row.run_count,
  }));

  const terminalCount = successRow.count + failedRow.count;
  const successRate = terminalCount > 0
    ? Math.round((successRow.count / terminalCount) * 100)
    : 0;

  return {
    totalRuns: totalRow.count,
    activeRuns: activeRow.count,
    successfulRuns: successRow.count,
    failedRuns: failedRow.count,
    successRate,
    avgDurationMs: avgDurRow.avg_ms ?? 0,
    completedLast24h: completed24hRow.count,
    completedLast7d: completed7dRow.count,
    byPhase,
    byResult,
    topProjects,
  };
}
