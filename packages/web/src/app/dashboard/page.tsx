'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import type { Route } from 'next';
import { PageHeader } from '@/components/layout';
import { Badge, Skeleton } from '@/components/ui';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Play, Clock, AlertTriangle, CheckCircle } from 'lucide-react';
import { getPhaseLabel, getPhaseVariant } from '@/lib/phase-config';

interface RunSummary {
  runId: string;
  taskId: string;
  projectId: string;
  repoId: string;
  runNumber: number;
  phase: string;
  step: string;
  status: string;
  taskTitle: string;
  projectName: string;
  repoFullName: string;
  branch: string;
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  result?: string;
}

function timeAgo(dateString: string): string {
  const date = new Date(dateString);
  const now = new Date();
  const seconds = Math.floor((now.getTime() - date.getTime()) / 1000);

  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

interface DashboardData {
  activeRuns: RunSummary[];
  needsAttention: RunSummary[];
  recentlyCompleted: RunSummary[];
  stats: {
    active: number;
    queued: number;
    blocked: number;
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

export default function DashboardPage() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function fetchDashboard() {
      try {
        // Fetch runs in parallel for different sections
        const [activeRes, blockedRes, completedRes, pendingRes] = await Promise.all([
          fetch('/api/runs?phases=planning,executing,awaiting_review&limit=10'),
          fetch('/api/runs?phases=awaiting_plan_approval,blocked&limit=10'),
          fetch('/api/runs?phases=completed,cancelled&limit=5'),
          fetch('/api/runs?phases=pending&limit=10'),
        ]);

        if (!activeRes.ok || !blockedRes.ok || !completedRes.ok || !pendingRes.ok) {
          throw new Error('Failed to fetch dashboard data');
        }

        const [activeData, blockedData, completedData, pendingData] = await Promise.all([
          activeRes.json() as Promise<{ runs: RunSummary[] }>,
          blockedRes.json() as Promise<{ runs: RunSummary[] }>,
          completedRes.json() as Promise<{ runs: RunSummary[] }>,
          pendingRes.json() as Promise<{ runs: RunSummary[] }>,
        ]);

        // Count completed today
        const todayStart = new Date();
        todayStart.setHours(0, 0, 0, 0);
        const completedToday = completedData.runs.filter(
          (r) => r.completedAt !== undefined && new Date(r.completedAt) >= todayStart
        ).length;

        setData({
          activeRuns: activeData.runs,
          needsAttention: blockedData.runs,
          recentlyCompleted: completedData.runs,
          stats: {
            active: activeData.runs.length,
            queued: pendingData.runs.length,
            blocked: blockedData.runs.length,
            completedToday,
          },
        });
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Unknown error');
      } finally {
        setLoading(false);
      }
    }

    void fetchDashboard();
  }, []);

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
                title="Needs Attention"
                value={data.stats.blocked}
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
              <CardHeader>
                <CardTitle className="text-base">Active Runs</CardTitle>
              </CardHeader>
              <CardContent>
                <RunTable runs={data.activeRuns} emptyMessage="No active runs right now." />
              </CardContent>
            </Card>

            {/* Needs attention */}
            {data.needsAttention.length > 0 && (
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">Needs Attention</CardTitle>
                </CardHeader>
                <CardContent>
                  <RunTable runs={data.needsAttention} emptyMessage="Nothing needs attention." />
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
