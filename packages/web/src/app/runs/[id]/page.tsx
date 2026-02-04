'use client';

import { useState, useEffect, useCallback, use } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import type { Route } from 'next';
import { PageHeader } from '@/components/layout';
import { Badge, Button } from '@/components/ui';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { ArrowLeft, XCircle, GitBranch, Clock, Hash } from 'lucide-react';

interface RunDetail {
  runId: string;
  taskId: string;
  projectId: string;
  repoId: string;
  runNumber: number;
  phase: string;
  step: string;
  policySetId: string;
  lastEventSequence: number;
  nextSequence: number;
  baseBranch: string;
  branch: string;
  headSha?: string;
  prNumber?: number;
  prUrl?: string;
  prState?: string;
  blockedReason?: string;
  planRevisions: number;
  testFixAttempts: number;
  reviewRounds: number;
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  result?: string;
  resultReason?: string;
}

interface TaskInfo {
  taskId: string;
  githubTitle: string;
  githubIssueNumber: number;
  githubType: string;
  githubState: string;
}

interface RepoInfo {
  repoId: string;
  githubFullName: string;
  githubOwner: string;
  githubName: string;
}

interface EventRecord {
  eventId: string;
  type: string;
  class: string;
  source: string;
  sequence?: number;
  payload: Record<string, unknown>;
  createdAt: string;
}

type BadgeVariant = 'default' | 'secondary' | 'destructive' | 'success' | 'warning';

function phaseBadgeVariant(phase: string): BadgeVariant {
  switch (phase) {
    case 'completed':
      return 'success';
    case 'planning':
    case 'executing':
      return 'default';
    case 'awaiting_plan_approval':
    case 'awaiting_review':
      return 'warning';
    case 'blocked':
      return 'destructive';
    case 'pending':
    case 'cancelled':
    default:
      return 'secondary';
  }
}

function formatPhase(phase: string): string {
  return phase.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function formatTimestamp(dateString: string): string {
  return new Date(dateString).toLocaleString();
}

const TERMINAL_PHASES = new Set(['completed', 'cancelled']);

export default function RunDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id: runId } = use(params);
  const router = useRouter();
  const [run, setRun] = useState<RunDetail | null>(null);
  const [task, setTask] = useState<TaskInfo | null>(null);
  const [repo, setRepo] = useState<RepoInfo | null>(null);
  const [events, setEvents] = useState<EventRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [showCancelDialog, setShowCancelDialog] = useState(false);

  const fetchRunDetail = useCallback(async () => {
    try {
      const response = await fetch(`/api/runs/${runId}`);
      if (!response.ok) {
        if (response.status === 404) {
          router.push('/runs');
          return;
        }
        throw new Error('Failed to fetch run');
      }
      const data = await response.json() as {
        run: RunDetail;
        task: TaskInfo | null;
        repo: RepoInfo | null;
        events: EventRecord[];
      };
      setRun(data.run);
      setTask(data.task);
      setRepo(data.repo);
      setEvents(data.events);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  }, [runId, router]);

  useEffect(() => {
    void fetchRunDetail();
  }, [fetchRunDetail]);

  async function handleCancel() {
    if (run === null || cancelling) return;
    setCancelling(true);
    setShowCancelDialog(false);
    try {
      const response = await fetch(`/api/runs/${runId}/actions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'cancel' }),
      });
      if (!response.ok) {
        const data = await response.json() as { error?: string };
        throw new Error(data.error ?? 'Failed to cancel run');
      }
      // Refresh run detail
      await fetchRunDetail();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setCancelling(false);
    }
  }

  if (loading) {
    return (
      <div className="flex flex-col h-full">
        <PageHeader title="Run Detail" description="Loading..." />
        <div className="flex-1 p-6 flex items-center justify-center">
          <p className="text-muted-foreground">Loading run...</p>
        </div>
      </div>
    );
  }

  if (error !== null || run === null) {
    return (
      <div className="flex flex-col h-full">
        <PageHeader title="Run Detail" description="" />
        <div className="flex-1 p-6 flex flex-col items-center justify-center gap-4">
          <p className="text-destructive">{error ?? 'Run not found'}</p>
          <Button variant="outline" onClick={() => router.push('/runs')}>
            <ArrowLeft className="h-4 w-4 mr-2" />
            Back to Runs
          </Button>
        </div>
      </div>
    );
  }

  // Phase timeline: filter for phase.transitioned events
  const phaseEvents = events.filter(e => e.type === 'phase.transitioned');

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between border-b px-6 py-4">
        <div>
          <div className="flex items-center gap-3">
            <Link href={'/runs' as Route}>
              <Button variant="ghost" size="sm">
                <ArrowLeft className="h-4 w-4" />
              </Button>
            </Link>
            <h1 className="text-2xl font-semibold">{run.runId}</h1>
            <Badge variant={phaseBadgeVariant(run.phase)}>
              {formatPhase(run.phase)}
            </Badge>
          </div>
          <p className="text-sm text-muted-foreground mt-1 ml-12">
            {task !== null ? `${task.githubType} #${task.githubIssueNumber}: ${task.githubTitle}` : run.taskId}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {!TERMINAL_PHASES.has(run.phase) && (
            <Button
              variant="destructive"
              onClick={() => setShowCancelDialog(true)}
              disabled={cancelling}
            >
              <XCircle className="h-4 w-4 mr-2" />
              {cancelling ? 'Cancelling...' : 'Cancel Run'}
            </Button>
          )}
        </div>
      </div>

      <Dialog open={showCancelDialog} onOpenChange={setShowCancelDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Cancel Run</DialogTitle>
            <DialogDescription>
              Are you sure you want to cancel this run? This action cannot be undone.
              The run will be moved to the cancelled state and any active worktree will be cleaned up.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowCancelDialog(false)}>
              Keep Running
            </Button>
            <Button variant="destructive" onClick={() => void handleCancel()} disabled={cancelling}>
              {cancelling ? 'Cancelling...' : 'Cancel Run'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <div className="flex-1 p-6 space-y-6">
        {/* Summary cards */}
        <div className="grid gap-4 md:grid-cols-3">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">Task</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-1">
                <p className="font-medium">{task?.githubTitle ?? 'Unknown'}</p>
                {task !== null && (
                  <p className="text-sm text-muted-foreground">
                    <Hash className="h-3 w-3 inline mr-1" />
                    {task.githubIssueNumber} &middot; {task.githubState}
                  </p>
                )}
                {repo !== null && (
                  <p className="text-sm text-muted-foreground">
                    {repo.githubFullName}
                  </p>
                )}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">Status</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-1">
                <p className="font-medium">{formatPhase(run.phase)} &middot; {formatPhase(run.step)}</p>
                {run.result !== undefined && (
                  <p className="text-sm text-muted-foreground">
                    Result: {run.result}
                    {run.resultReason !== undefined && ` — ${run.resultReason}`}
                  </p>
                )}
                {run.blockedReason !== undefined && (
                  <p className="text-sm text-destructive">
                    Blocked: {run.blockedReason}
                  </p>
                )}
                <p className="text-sm text-muted-foreground">
                  <Clock className="h-3 w-3 inline mr-1" />
                  Started {formatTimestamp(run.startedAt)}
                </p>
                <p className="text-sm text-muted-foreground">
                  Updated {formatTimestamp(run.updatedAt)}
                </p>
                {run.completedAt !== undefined && (
                  <p className="text-sm text-muted-foreground">
                    Completed {formatTimestamp(run.completedAt)}
                  </p>
                )}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">Git</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-1">
                {run.branch !== '' ? (
                  <p className="font-medium">
                    <GitBranch className="h-3 w-3 inline mr-1" />
                    {run.branch}
                  </p>
                ) : (
                  <p className="text-sm text-muted-foreground">No branch yet</p>
                )}
                <p className="text-sm text-muted-foreground">
                  Base: {run.baseBranch}
                </p>
                {run.headSha !== undefined && (
                  <p className="text-sm text-muted-foreground font-mono">
                    HEAD: {run.headSha.substring(0, 7)}
                  </p>
                )}
                {run.prNumber !== undefined && run.prUrl !== undefined && (
                  <p className="text-sm">
                    <a href={run.prUrl} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">
                      PR #{run.prNumber}
                    </a>
                    {run.prState !== undefined && (
                      <span className="text-muted-foreground"> &middot; {run.prState}</span>
                    )}
                  </p>
                )}
              </div>
            </CardContent>
          </Card>
        </div>

        <Separator />

        {/* Phase Timeline */}
        <div>
          <h3 className="text-lg font-semibold mb-4">Phase Timeline</h3>
          {phaseEvents.length === 0 ? (
            <p className="text-sm text-muted-foreground">No phase transitions yet</p>
          ) : (
            <div className="space-y-3">
              {phaseEvents.map((event) => {
                const payload = event.payload as { from?: string; to?: string; triggeredBy?: string; reason?: string };
                return (
                  <div key={event.eventId} className="flex items-start gap-3">
                    <div className="w-2 h-2 mt-2 rounded-full bg-primary flex-shrink-0" />
                    <div>
                      <div className="flex items-center gap-2">
                        <Badge variant={phaseBadgeVariant(payload.to ?? '')}>
                          {formatPhase(payload.from ?? '')} &rarr; {formatPhase(payload.to ?? '')}
                        </Badge>
                        <span className="text-xs text-muted-foreground">
                          seq {event.sequence}
                        </span>
                      </div>
                      <p className="text-sm text-muted-foreground mt-1">
                        {payload.reason ?? `Triggered by ${payload.triggeredBy ?? 'unknown'}`}
                        {' '}&middot;{' '}
                        {formatTimestamp(event.createdAt)}
                      </p>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <Separator />

        {/* All Events */}
        <div>
          <h3 className="text-lg font-semibold mb-4">Events Log</h3>
          {events.length === 0 ? (
            <p className="text-sm text-muted-foreground">No events</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Seq</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Class</TableHead>
                  <TableHead>Source</TableHead>
                  <TableHead>Time</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {events.map((event) => (
                  <TableRow key={event.eventId}>
                    <TableCell className="font-mono text-sm">
                      {event.sequence ?? '—'}
                    </TableCell>
                    <TableCell className="font-mono text-sm">
                      {event.type}
                    </TableCell>
                    <TableCell>
                      <Badge variant="secondary">{event.class}</Badge>
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {event.source}
                    </TableCell>
                    <TableCell className="text-muted-foreground text-sm">
                      {formatTimestamp(event.createdAt)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </div>
      </div>
    </div>
  );
}
