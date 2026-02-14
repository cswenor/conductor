'use client';

import { useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { Route } from 'next';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Play, AlertTriangle, ThumbsUp, CheckCircle,
  FileText, Eye, GitPullRequest, ArrowRight, XCircle, ExternalLink, RotateCcw,
} from 'lucide-react';
import { toast } from 'sonner';
import { getPhaseLabel, getPhaseVariant, timeAgo } from '@/lib/phase-config';
import { getBlockedReasonLabel } from '@/lib/labels';
import type { RunSummary } from '@/lib/types';
import { retryRun, cancelRun } from '@/lib/actions/run-actions';
import { useLiveRefresh } from '@/hooks/use-live-refresh';
import type { ProjectOverviewData } from '@/lib/data/project-overview';

function StatCard({ title, value, icon }: {
  title: string;
  value: number;
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
        <p className="text-xs text-muted-foreground mt-1">
          <Link href={'?tab=work' as Route} className="hover:underline">
            View in Work tab
          </Link>
        </p>
      </CardContent>
    </Card>
  );
}

export function ProjectOverviewTab({ data, projectId }: { data: ProjectOverviewData; projectId: string }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  useLiveRefresh({
    filter: (e) => e.projectId === projectId && (e.kind === 'run.phase_changed' || e.kind === 'run.updated' || e.kind === 'operator.action'),
  });

  function handleAction(runId: string, action: string) {
    startTransition(async () => {
      const result = action === 'retry'
        ? await retryRun(runId)
        : await cancelRun(runId);
      if (result.success) {
        toast.success(action === 'retry' ? 'Run retried' : 'Run cancelled');
        router.refresh();
      } else {
        toast.error(result.error ?? `Failed to ${action} run`);
      }
    });
  }

  return (
    <div className="space-y-6">
      {/* Stat cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatCard
          title="Active Runs"
          value={data.activeCount}
          icon={<Play className="h-4 w-4 text-muted-foreground" />}
        />
        <StatCard
          title="Blocked"
          value={data.blockedCount}
          icon={<AlertTriangle className="h-4 w-4 text-muted-foreground" />}
        />
        <StatCard
          title="Awaiting Approval"
          value={data.awaitingApprovalCount}
          icon={<ThumbsUp className="h-4 w-4 text-muted-foreground" />}
        />
        <StatCard
          title="Completed This Week"
          value={data.completedThisWeekCount}
          icon={<CheckCircle className="h-4 w-4 text-muted-foreground" />}
        />
      </div>

      {/* Blocked Items */}
      {data.blockedRuns.length > 0 && (
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-3">
            <CardTitle className="text-base">Blocked Items</CardTitle>
            <Link href={'?tab=work' as Route}>
              <Button variant="ghost" size="sm">
                View All <ArrowRight className="h-3 w-3 ml-1" />
              </Button>
            </Link>
          </CardHeader>
          <CardContent className="divide-y">
            {data.blockedRuns.map((run: RunSummary) => (
              <div key={run.runId} className="flex items-center justify-between gap-3 py-2">
                <div className="min-w-0 flex-1">
                  <Link href={`/runs/${run.runId}` as Route} className="text-sm font-medium hover:underline truncate block">
                    {run.taskTitle}
                  </Link>
                  <div className="flex items-center gap-2 text-xs text-muted-foreground mt-0.5">
                    <span>{run.repoFullName}</span>
                    <span className="text-border">|</span>
                    <Badge variant={getPhaseVariant(run.phase)} className="text-xs h-4 px-1">
                      {getPhaseLabel(run.phase)}
                    </Badge>
                    <span className="text-border">|</span>
                    <span>{timeAgo(run.updatedAt)}</span>
                  </div>
                  {run.blockedReason !== undefined && (
                    <p className="text-xs text-destructive mt-1 truncate">
                      {getBlockedReasonLabel(run.blockedReason)}
                    </p>
                  )}
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <Link href={`/runs/${run.runId}` as Route}>
                    <Button variant="outline" size="sm">
                      <Eye className="h-3 w-3 mr-1" />
                      View
                    </Button>
                  </Link>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={isPending}
                    onClick={() => handleAction(run.runId, 'retry')}
                    title="Retry run"
                  >
                    <RotateCcw className="h-3 w-3" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={isPending}
                    onClick={() => handleAction(run.runId, 'cancel')}
                    title="Cancel run"
                  >
                    <XCircle className="h-3 w-3 text-muted-foreground" />
                  </Button>
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {/* Awaiting Approval */}
      {data.awaitingApprovalRuns.length > 0 && (
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-3">
            <CardTitle className="text-base">Awaiting Approval</CardTitle>
            <Link href={'/approvals' as Route}>
              <Button variant="ghost" size="sm">
                View All <ArrowRight className="h-3 w-3 ml-1" />
              </Button>
            </Link>
          </CardHeader>
          <CardContent className="divide-y">
            {data.awaitingApprovalRuns.map((run: RunSummary) => (
              <div key={run.runId} className="flex items-center justify-between py-2">
                <div className="min-w-0 flex-1">
                  <Link href={`/runs/${run.runId}` as Route} className="text-sm font-medium hover:underline truncate block">
                    {run.taskTitle}
                  </Link>
                  <div className="flex items-center gap-2 text-xs text-muted-foreground mt-0.5">
                    <span>{run.repoFullName}</span>
                    <span className="text-border">|</span>
                    <span>Waiting {timeAgo(run.updatedAt)}</span>
                  </div>
                </div>
                <Link href={`/runs/${run.runId}` as Route}>
                  <Button variant="outline" size="sm">
                    <Eye className="h-3 w-3 mr-1" />
                    Review
                  </Button>
                </Link>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {/* Last Shipped PR */}
      {data.lastShippedPr !== null && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Last Shipped</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-3">
              <GitPullRequest className="h-5 w-5 text-green-500 shrink-0" />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <Link
                    href={`/runs/${data.lastShippedPr.runId}` as Route}
                    className="text-sm font-medium hover:underline truncate"
                  >
                    {data.lastShippedPr.taskTitle}
                  </Link>
                  {data.lastShippedPr.prUrl !== undefined && (
                    <a
                      href={data.lastShippedPr.prUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-xs text-muted-foreground hover:text-foreground inline-flex items-center gap-0.5 shrink-0"
                    >
                      {data.lastShippedPr.prNumber !== undefined ? `#${data.lastShippedPr.prNumber}` : 'PR'}
                      <ExternalLink className="h-3 w-3" />
                    </a>
                  )}
                </div>
                <div className="text-xs text-muted-foreground">
                  {data.lastShippedPr.repoFullName} — completed {timeAgo(data.lastShippedPr.completedAt ?? data.lastShippedPr.updatedAt)}
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Quick Links */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Quick Links</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap gap-2">
            <Link href={'?tab=backlog' as Route}>
              <Button variant="outline" size="sm">
                <FileText className="h-3 w-3 mr-1" />
                Go to Backlog
              </Button>
            </Link>
            <Link href={'?tab=work' as Route}>
              <Button variant="outline" size="sm">
                <Play className="h-3 w-3 mr-1" />
                View All Work
              </Button>
            </Link>
            <Link href={'/approvals' as Route}>
              <Button variant="outline" size="sm">
                <ThumbsUp className="h-3 w-3 mr-1" />
                Review Approvals
              </Button>
            </Link>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
