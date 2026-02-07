'use client';

import { useState, useEffect } from 'react';
import { PageHeader } from '@/components/layout';
import { Skeleton } from '@/components/ui';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { BarChart3, CheckCircle, XCircle, Clock, TrendingUp, Activity } from 'lucide-react';
import { formatDuration } from '@/lib/phase-config';

interface AnalyticsMetrics {
  totalRuns: number;
  activeRuns: number;
  successfulRuns: number;
  failedRuns: number;
  successRate: number;
  avgDurationMs: number;
  completedLast24h: number;
  completedLast7d: number;
  byPhase: Record<string, number>;
  byResult: Record<string, number>;
  topProjects: Array<{ projectId: string; projectName: string; runCount: number }>;
}

function StatCard({ title, value, subtitle, icon }: {
  title: string;
  value: string | number;
  subtitle?: string;
  icon: React.ReactNode;
}) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-sm font-medium">{title}</CardTitle>
        {icon}
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-bold">{value}</div>
        {subtitle !== undefined && (
          <p className="text-xs text-muted-foreground mt-1">{subtitle}</p>
        )}
      </CardContent>
    </Card>
  );
}

/** Simple text-based horizontal bar for phase/result breakdown. */
function BarRow({ label, count, maxCount }: { label: string; count: number; maxCount: number }) {
  const pct = maxCount > 0 ? (count / maxCount) * 100 : 0;
  return (
    <div className="flex items-center gap-3">
      <span className="text-sm w-36 truncate text-muted-foreground capitalize">{label.replace(/_/g, ' ')}</span>
      <div className="flex-1 h-4 bg-muted rounded overflow-hidden">
        <div
          className="h-full bg-primary rounded transition-all"
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="text-sm font-medium w-10 text-right">{count}</span>
    </div>
  );
}

function BreakdownCard({ title, data }: { title: string; data: Record<string, number> }) {
  const entries = Object.entries(data).sort((a, b) => b[1] - a[1]);
  const maxCount = entries[0]?.[1] ?? 0;

  if (entries.length === 0) {
    return null;
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{title}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {entries.map(([label, count]) => (
          <BarRow key={label} label={label} count={count} maxCount={maxCount} />
        ))}
      </CardContent>
    </Card>
  );
}

export default function AnalyticsPage() {
  const [metrics, setMetrics] = useState<AnalyticsMetrics | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function fetchAnalytics() {
      try {
        const response = await fetch('/api/analytics');
        if (!response.ok) {
          throw new Error('Failed to fetch analytics');
        }
        const data = await response.json() as AnalyticsMetrics;
        setMetrics(data);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Unknown error');
      } finally {
        setLoading(false);
      }
    }

    void fetchAnalytics();
  }, []);

  return (
    <div className="flex flex-col h-full">
      <PageHeader
        title="Analytics"
        description="Aggregate metrics across your projects"
      />
      <div className="flex-1 p-6 space-y-6">
        {loading ? (
          <div className="space-y-6">
            <div className="grid grid-cols-3 gap-4">
              {Array.from({ length: 6 }).map((_, i) => (
                <Skeleton key={i} className="h-24" />
              ))}
            </div>
            <Skeleton className="h-48" />
          </div>
        ) : error !== null ? (
          <div className="flex items-center justify-center h-64">
            <p className="text-destructive">{error}</p>
          </div>
        ) : metrics !== null ? (
          <>
            {/* Summary cards */}
            <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
              <StatCard
                title="Total Runs"
                value={metrics.totalRuns}
                icon={<BarChart3 className="h-4 w-4 text-muted-foreground" />}
              />
              <StatCard
                title="Active Now"
                value={metrics.activeRuns}
                icon={<Activity className="h-4 w-4 text-muted-foreground" />}
              />
              <StatCard
                title="Success Rate"
                value={`${metrics.successRate}%`}
                subtitle={`${metrics.successfulRuns} succeeded, ${metrics.failedRuns} failed`}
                icon={<TrendingUp className="h-4 w-4 text-muted-foreground" />}
              />
              <StatCard
                title="Avg Duration"
                value={metrics.avgDurationMs > 0 ? formatDuration(metrics.avgDurationMs) : 'N/A'}
                subtitle="For completed runs"
                icon={<Clock className="h-4 w-4 text-muted-foreground" />}
              />
              <StatCard
                title="Last 24 Hours"
                value={metrics.completedLast24h}
                subtitle="Completed runs"
                icon={<CheckCircle className="h-4 w-4 text-muted-foreground" />}
              />
              <StatCard
                title="Last 7 Days"
                value={metrics.completedLast7d}
                subtitle="Completed runs"
                icon={<XCircle className="h-4 w-4 text-muted-foreground" />}
              />
            </div>

            {/* Breakdowns */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <BreakdownCard title="Runs by Phase" data={metrics.byPhase} />
              <BreakdownCard title="Completed by Result" data={metrics.byResult} />
            </div>

            {/* Top projects */}
            {metrics.topProjects.length > 0 && (
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">Top Projects</CardTitle>
                </CardHeader>
                <CardContent className="space-y-2">
                  {metrics.topProjects.map((p) => (
                    <BarRow
                      key={p.projectId}
                      label={p.projectName}
                      count={p.runCount}
                      maxCount={metrics.topProjects[0]?.runCount ?? 0}
                    />
                  ))}
                </CardContent>
              </Card>
            )}
          </>
        ) : null}
      </div>
    </div>
  );
}
