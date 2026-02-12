'use client';

import { useTransition } from 'react';
import Link from 'next/link';
import type { Route } from 'next';
import { useRouter } from 'next/navigation';
import { PageHeader } from '@/components/layout';
import { Badge } from '@/components/ui';
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
import { toast } from 'sonner';
import { getPhaseLabel, getPhaseVariant, timeAgo, formatWaitDuration } from '@/lib/phase-config';
import { approvePlan } from '@/lib/actions/run-actions';
import { useLiveRefresh } from '@/hooks/use-live-refresh';
import type { DashboardData } from '@/lib/data/dashboard';
import type { RunSummary, ApprovalItem } from '@/lib/types';

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

export function DashboardContent({ data }: { data: DashboardData }) {
  const [isPending, startTransition] = useTransition();
  const router = useRouter();

  useLiveRefresh({
    filter: (e) => e.kind === 'run.phase_changed' || e.kind === 'operator.action' || e.kind === 'run.updated',
  });

  function handleQuickApprove(runId: string) {
    startTransition(async () => {
      const result = await approvePlan(runId);
      if (result.success) {
        toast.success('Plan approved');
        router.refresh();
      } else {
        toast.error(result.error ?? 'Failed to approve plan');
      }
    });
  }

  return (
    <div className="flex flex-col h-full">
      <PageHeader
        title="Dashboard"
        description="Overview of your orchestration activity"
      />
      <div className="flex-1 p-6 space-y-6">
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

        {/* Needs attention */}
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
                  onQuickApprove={handleQuickApprove}
                  busy={isPending}
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
      </div>
    </div>
  );
}
