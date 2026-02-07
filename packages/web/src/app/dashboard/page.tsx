'use client';

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import type { Route } from 'next';
import { PageHeader } from '@/components/layout';
import { Badge, Skeleton } from '@/components/ui';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Play, Clock, AlertTriangle, CheckCircle, ThumbsUp, Eye, ExternalLink,
} from 'lucide-react';
import { getPhaseLabel, getPhaseVariant, timeAgo, formatWaitDuration } from '@/lib/phase-config';
import type { RunSummary, ApprovalItem, ApprovalsResponse } from '@/lib/types';


interface DashboardData {
  activeRuns: RunSummary[];
  recentlyCompleted: RunSummary[];
  approvals: ApprovalItem[];
  stats: {
    active: number;
    queued: number;
    needsYou: number;
    completedToday: number;
  };
}

function StatCard({ title, value, icon }: { title: string; value: number; icon: React.ReactNode }) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-sm font-medium">{title}</CardTitle>
        {icon}
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-bold">{value}</div>
      </CardContent>
    </Card>
  );
}

function RunTable({ runs, emptyMessage }: { runs: RunSummary[]; emptyMessage: string }) {
  if (runs.length === 0) {
    return <p className="text-sm text-muted-foreground py-4">{emptyMessage}</p>;
  }
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Task</TableHead>
          <TableHead>Project</TableHead>
          <TableHead>Phase</TableHead>
          <TableHead>Updated</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {runs.map((run) => (
          <TableRow key={run.runId}>
            <TableCell>
              <Link href={`/runs/${run.runId}` as Route} className="hover:underline font-medium">
                {run.taskTitle}
              </Link>
            </TableCell>
            <TableCell className="text-muted-foreground">{run.projectName}</TableCell>
            <TableCell>
              <Badge variant={getPhaseVariant(run.phase)}>
                {getPhaseLabel(run.phase)}
              </Badge>
            </TableCell>
            <TableCell className="text-muted-foreground">{timeAgo(run.updatedAt)}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

const GATE_LABELS: Record<string, string> = {
  plan_approval: 'Plan Approval',
  escalation: 'Escalation',
  policy_exception: 'Policy Exception',
};

function ApprovalRow({
  item,
  onQuickApprove,
  busy,
}: {
  item: ApprovalItem;
  onQuickApprove: (runId: string) => void;
  busy: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-4 py-2">
      <div className="min-w-0 flex-1">
        <Link href={`/runs/${item.runId}` as Route} className="text-sm font-medium hover:underline truncate block">
          {item.taskTitle}
        </Link>
        <div className="flex items-center gap-2 text-xs text-muted-foreground mt-0.5">
          <span>{item.projectName}</span>
          <span className="text-border">|</span>
          <Badge variant="secondary" className="text-xs h-4 px-1">{GATE_LABELS[item.gateType] ?? item.gateType}</Badge>
          <span className="text-border">|</span>
          <Clock className="h-3 w-3" />
          <span>{formatWaitDuration(item.waitDurationMs)}</span>
        </div>
      </div>
      <div className="flex items-center gap-1 shrink-0">
        {item.gateType === 'plan_approval' && (
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => onQuickApprove(item.runId)}
            title="Approve plan"
          >
            <ThumbsUp className="h-3 w-3 mr-1" />
            Approve
          </Button>
        )}
        <Link href={item.gateType === 'plan_approval' ? `/runs/${item.runId}` as Route : '/approvals' as Route}>
          <Button variant="ghost" size="sm" title="View details">
            {item.gateType === 'plan_approval' ? <Eye className="h-3 w-3" /> : <ExternalLink className="h-3 w-3" />}
          </Button>
        </Link>
      </div>
    </div>
  );
}

export default function DashboardPage() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionBusy, setActionBusy] = useState(false);

  const fetchDashboard = useCallback(async () => {
    try {
      // Compute completedAfter for "today" count
      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);
      const completedAfter = todayStart.toISOString();

      // Fetch display data + accurate counts in parallel
      // excludePaused=1 ensures paused runs don't appear in active sections
      const [
        activeRes, completedRes,
        activeCountRes, pendingCountRes, completedTodayRes,
        approvalsRes,
      ] = await Promise.all([
        fetch('/api/runs?phases=planning,executing,awaiting_review&excludePaused=1&limit=10'),
        fetch('/api/runs?phases=completed,cancelled&limit=5'),
        fetch('/api/runs?phases=planning,executing,awaiting_review&excludePaused=1&countOnly=1'),
        fetch('/api/runs?phases=pending&countOnly=1'),
        fetch(`/api/runs?phases=completed,cancelled&countOnly=1&completedAfter=${completedAfter}`),
        fetch('/api/approvals'),
      ]);

      if (!activeRes.ok || !completedRes.ok) {
        throw new Error('Failed to fetch dashboard data');
      }

      const [activeData, completedData, activeCount, pendingCount, completedTodayCount] = await Promise.all([
        activeRes.json() as Promise<{ runs: RunSummary[] }>,
        completedRes.json() as Promise<{ runs: RunSummary[] }>,
        activeCountRes.ok ? activeCountRes.json() as Promise<{ total: number }> : { total: 0 },
        pendingCountRes.ok ? pendingCountRes.json() as Promise<{ total: number }> : { total: 0 },
        completedTodayRes.ok ? completedTodayRes.json() as Promise<{ total: number }> : { total: 0 },
      ]);

      // Merge all approval types into a single list, sorted by wait time
      let approvals: ApprovalItem[] = [];
      let needsYouTotal = 0;
      if (approvalsRes.ok) {
        const approvalsData = await approvalsRes.json() as ApprovalsResponse;
        needsYouTotal = approvalsData.total;
        approvals = [
          ...approvalsData.planApprovals,
          ...approvalsData.escalations,
          ...approvalsData.policyExceptions,
        ].sort((a, b) => b.waitDurationMs - a.waitDurationMs).slice(0, 5);
      }

      setData({
        activeRuns: activeData.runs,
        recentlyCompleted: completedData.runs,
        approvals,
        stats: {
          active: activeCount.total,
          queued: pendingCount.total,
          needsYou: needsYouTotal,
          completedToday: completedTodayCount.total,
        },
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchDashboard();

    // Auto-refresh every 60 seconds
    const interval = setInterval(() => {
      void fetchDashboard();
    }, 60000);

    return () => clearInterval(interval);
  }, [fetchDashboard]);

  async function handleQuickApprove(runId: string) {
    setActionBusy(true);
    try {
      const response = await fetch(`/api/runs/${runId}/actions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'approve_plan' }),
      });
      if (!response.ok) {
        const result = await response.json() as { error?: string };
        throw new Error(result.error ?? 'Failed to approve plan');
      }
      // Refresh via fetch, not window.location.reload()
      await fetchDashboard();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setActionBusy(false);
    }
  }

  return (
    <div className="flex flex-col h-full">
      <PageHeader
        title="Dashboard"
        description="Overview of your orchestration activity"
      />
      <div className="flex-1 p-6 space-y-6">
        {loading ? (
          <div className="space-y-6">
            <div className="grid grid-cols-4 gap-4">
              {Array.from({ length: 4 }).map((_, i) => (
                <Skeleton key={i} className="h-24" />
              ))}
            </div>
            <Skeleton className="h-64" />
          </div>
        ) : error !== null ? (
          <div className="flex items-center justify-center h-64">
            <p className="text-destructive">{error}</p>
          </div>
        ) : data !== null ? (
          <>
            {/* Stat cards */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <StatCard
                title="Active Runs"
                value={data.stats.active}
                icon={<Play className="h-4 w-4 text-muted-foreground" />}
              />
              <StatCard
                title="Queued"
                value={data.stats.queued}
                icon={<Clock className="h-4 w-4 text-muted-foreground" />}
              />
              <StatCard
                title="Needs You"
                value={data.stats.needsYou}
                icon={<AlertTriangle className="h-4 w-4 text-muted-foreground" />}
              />
              <StatCard
                title="Completed Today"
                value={data.stats.completedToday}
                icon={<CheckCircle className="h-4 w-4 text-muted-foreground" />}
              />
            </div>

            {/* Active runs */}
            <Card>
              <CardHeader className="flex flex-row items-center justify-between">
                <CardTitle className="text-base">Active Runs</CardTitle>
                <Link href={'/work' as Route}>
                  <Button variant="ghost" size="sm">View All</Button>
                </Link>
              </CardHeader>
              <CardContent>
                <RunTable runs={data.activeRuns} emptyMessage="No active runs right now." />
              </CardContent>
            </Card>

            {/* Needs attention — from approvals API (all gate types) */}
            {data.approvals.length > 0 && (
              <Card>
                <CardHeader className="flex flex-row items-center justify-between">
                  <CardTitle className="text-base">Needs Your Attention</CardTitle>
                  <Link href={'/approvals' as Route}>
                    <Button variant="ghost" size="sm">View All</Button>
                  </Link>
                </CardHeader>
                <CardContent className="divide-y">
                  {data.approvals.map((item) => (
                    <ApprovalRow
                      key={item.runId}
                      item={item}
                      onQuickApprove={(runId) => void handleQuickApprove(runId)}
                      busy={actionBusy}
                    />
                  ))}
                </CardContent>
              </Card>
            )}

            {/* Recently completed */}
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Recently Completed</CardTitle>
              </CardHeader>
              <CardContent>
                <RunTable runs={data.recentlyCompleted} emptyMessage="No recently completed runs." />
              </CardContent>
            </Card>
          </>
        ) : null}
      </div>
    </div>
  );
}
