import { redirect } from 'next/navigation';
import { PageHeader } from '@/components/layout';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { BarChart3, Clock, TrendingUp } from 'lucide-react';
import { formatDuration, getPhaseVariant } from '@/lib/phase-config';
import { getServerUser } from '@/lib/auth/session';
import { getDb } from '@/lib/bootstrap';
import { getAnalyticsMetrics } from '@conductor/shared';
import type { AnalyticsResponse } from '@/lib/types';

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

type BarVariant = 'default' | 'secondary' | 'destructive' | 'success' | 'warning';

function barClass(variant?: BarVariant): string {
  switch (variant) {
    case 'success':
      return 'bg-[hsl(var(--success))]';
    case 'warning':
      return 'bg-[hsl(var(--warning))]';
    case 'destructive':
      return 'bg-destructive';
    case 'secondary':
      return 'bg-muted-foreground';
    default:
      return 'bg-primary';
  }
}

function BarRow({
  label,
  count,
  maxCount,
  variant,
}: {
  label: string;
  count: number;
  maxCount: number;
  variant?: BarVariant;
}) {
  const pct = maxCount > 0 ? (count / maxCount) * 100 : 0;
  return (
    <div className="flex items-center gap-3">
      <span className="text-sm w-36 truncate text-muted-foreground capitalize">{label.replace(/_/g, ' ')}</span>
      <div className="flex-1 h-4 bg-muted rounded overflow-hidden">
        <div
          className={`h-full rounded transition-all ${barClass(variant)}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="text-sm font-medium w-10 text-right">{count}</span>
    </div>
  );
}

function BreakdownCard({
  title,
  data,
  variantByKey,
}: {
  title: string;
  data: Record<string, number>;
  variantByKey?: (key: string) => BarVariant;
}) {
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
          <BarRow
            key={label}
            label={label}
            count={count}
            maxCount={maxCount}
            variant={variantByKey?.(label)}
          />
        ))}
      </CardContent>
    </Card>
  );
}

export default async function AnalyticsPage() {
  const user = await getServerUser();
  if (!user) redirect('/login');

  const db = await getDb();
  const metrics = getAnalyticsMetrics(db, {
    userId: user.userId,
  }) as AnalyticsResponse;

  return (
    <div className="flex flex-col h-full">
      <PageHeader
        title="Analytics"
        description="Aggregate metrics across your projects"
      />
      <div className="flex-1 p-6 space-y-6">
        {metrics.totalRuns === 0 ? (
          <div className="flex items-center justify-center h-64">
            <p className="text-muted-foreground">No run data yet. Analytics will populate as runs complete.</p>
          </div>
        ) : (
          <>
            {/* Summary cards */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <StatCard
                title="Total Runs"
                value={metrics.totalRuns}
                icon={<BarChart3 className="h-4 w-4 text-muted-foreground" />}
              />
              <StatCard
                title="Success Rate"
                value={`${metrics.successRate}%`}
                subtitle={`${metrics.completedRuns} completed`}
                icon={<TrendingUp className="h-4 w-4 text-muted-foreground" />}
              />
              <StatCard
                title="Avg Cycle Time"
                value={metrics.avgCycleTimeMs > 0 ? formatDuration(metrics.avgCycleTimeMs) : 'N/A'}
                subtitle="Completed runs"
                icon={<Clock className="h-4 w-4 text-muted-foreground" />}
              />
              <StatCard
                title="Avg Approval Wait"
                value={metrics.avgApprovalWaitMs > 0 ? formatDuration(metrics.avgApprovalWaitMs) : 'N/A'}
                subtitle="Plan approval"
                icon={<Clock className="h-4 w-4 text-muted-foreground" />}
              />
            </div>

            {/* Breakdowns */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <BreakdownCard
                title="Runs by Phase"
                data={metrics.runsByPhase}
                variantByKey={(phase) => getPhaseVariant(phase) as BarVariant}
              />
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">Runs by Project</CardTitle>
                </CardHeader>
                <CardContent className="space-y-2">
                  {metrics.runsByProject.map((p) => (
                    <BarRow
                      key={p.projectId}
                      label={p.projectName}
                      count={p.count}
                      maxCount={metrics.runsByProject[0]?.count ?? 0}
                    />
                  ))}
                </CardContent>
              </Card>
            </div>

            {/* Recent completions */}
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Completions (Last 7 Days)</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                {metrics.recentCompletions.map((row) => (
                  <BarRow
                    key={row.date}
                    label={row.date}
                    count={row.count}
                    maxCount={Math.max(...metrics.recentCompletions.map((d) => d.count), 1)}
                  />
                ))}
              </CardContent>
            </Card>
          </>
        )}
      </div>
    </div>
  );
}
