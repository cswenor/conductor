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
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  ArrowLeft, XCircle, GitBranch, Clock, Hash,
  CheckCircle, AlertTriangle, Circle, RefreshCw,
  ThumbsUp, ThumbsDown, Pencil, ShieldAlert,
} from 'lucide-react';

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
  blockedContextJson?: string;
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

interface GateEvaluationRecord {
  gateEvaluationId: string;
  runId: string;
  gateId: string;
  kind: string;
  status: string;
  reason?: string;
  evaluatedAt: string;
}

interface OperatorActionRecord {
  operatorActionId: string;
  runId: string;
  action: string;
  operator: string;
  comment?: string;
  createdAt: string;
}

interface RunDetailResponse {
  run: RunDetail;
  task: TaskInfo | null;
  repo: RepoInfo | null;
  events: EventRecord[];
  gates: Record<string, string>;
  gateEvaluations: GateEvaluationRecord[];
  operatorActions: OperatorActionRecord[];
  requiredGates: string[];
  optionalGates: string[];
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

function gateStatusBadgeVariant(status: string): BadgeVariant {
  switch (status) {
    case 'passed':
      return 'success';
    case 'failed':
      return 'destructive';
    case 'pending':
    default:
      return 'secondary';
  }
}

function GateStatusIcon({ status }: { status: string }) {
  switch (status) {
    case 'passed':
      return <CheckCircle className="h-4 w-4 text-green-500" />;
    case 'failed':
      return <AlertTriangle className="h-4 w-4 text-red-500" />;
    default:
      return <Circle className="h-4 w-4 text-muted-foreground" />;
  }
}

function formatPhase(phase: string): string {
  return phase.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function formatTimestamp(dateString: string): string {
  return new Date(dateString).toLocaleString();
}

function formatGateId(gateId: string): string {
  return gateId.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

const TERMINAL_PHASES = new Set(['completed', 'cancelled']);

export default function RunDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id: runId } = use(params);
  const router = useRouter();
  const [data, setData] = useState<RunDetailResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionInProgress, setActionInProgress] = useState<string | null>(null);
  const [showCancelDialog, setShowCancelDialog] = useState(false);
  const [commentDialog, setCommentDialog] = useState<{
    action: string;
    title: string;
    description: string;
    fieldLabel: string;
    fieldKey: 'comment' | 'justification';
    confirmLabel: string;
    confirmVariant: 'default' | 'destructive';
  } | null>(null);
  const [commentText, setCommentText] = useState('');

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
      const result = await response.json() as RunDetailResponse;
      setData(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  }, [runId, router]);

  useEffect(() => {
    void fetchRunDetail();
  }, [fetchRunDetail]);

  async function handleAction(action: string, commentOrJustification?: string) {
    if (data === null || actionInProgress !== null) return;
    setActionInProgress(action);
    try {
      const body: Record<string, unknown> = { action };
      if (commentOrJustification !== undefined) {
        // grant_policy_exception uses 'justification', others use 'comment'
        if (action === 'grant_policy_exception') {
          body['justification'] = commentOrJustification;
        } else {
          body['comment'] = commentOrJustification;
        }
      }

      const response = await fetch(`/api/runs/${runId}/actions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        const result = await response.json() as { error?: string };
        throw new Error(result.error ?? `Failed to ${action}`);
      }
      await fetchRunDetail();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setActionInProgress(null);
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

  if (error !== null || data === null) {
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

  const { run, task, repo, events, gates, gateEvaluations, operatorActions, requiredGates, optionalGates } = data;
  const phaseEvents = events.filter(e => e.type === 'phase.transitioned');
  const isTerminal = TERMINAL_PHASES.has(run.phase);
  const blockedContext = run.blockedContextJson !== undefined
    ? JSON.parse(run.blockedContextJson) as Record<string, unknown>
    : null;

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
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
            <Button
              variant="destructive"
              onClick={() => { setShowCancelDialog(false); void handleAction('cancel'); }}
              disabled={actionInProgress !== null}
            >
              Cancel Run
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Comment dialog for actions requiring justification */}
      <Dialog open={commentDialog !== null} onOpenChange={(open) => { if (!open) { setCommentDialog(null); setCommentText(''); } }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{commentDialog?.title}</DialogTitle>
            <DialogDescription>{commentDialog?.description}</DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="action-comment">{commentDialog?.fieldLabel}</Label>
            <Textarea
              id="action-comment"
              value={commentText}
              onChange={(e) => setCommentText(e.target.value)}
              placeholder="Enter your reason..."
              rows={3}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setCommentDialog(null); setCommentText(''); }}>
              Cancel
            </Button>
            <Button
              variant={commentDialog?.confirmVariant ?? 'default'}
              disabled={actionInProgress !== null || commentText.trim() === ''}
              onClick={() => {
                if (commentDialog === null) return;
                const payload = commentDialog.fieldKey === 'justification'
                  ? { justification: commentText }
                  : { comment: commentText };
                setCommentDialog(null);
                void handleAction(commentDialog.action, payload.comment ?? payload.justification);
                setCommentText('');
              }}
            >
              {commentDialog?.confirmLabel}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <div className="flex-1 p-6 space-y-6 pb-24">
        {/* Blocked State Explanation */}
        {run.phase === 'blocked' && run.blockedReason !== undefined && (
          <Card className="border-destructive">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-destructive flex items-center gap-2">
                <AlertTriangle className="h-4 w-4" />
                Run Blocked
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-2">
                <p className="text-sm font-medium">{run.blockedReason}</p>
                {blockedContext !== null && blockedContext['gate_id'] !== undefined && (
                  <p className="text-xs text-muted-foreground">
                    Failed gate: {formatGateId(blockedContext['gate_id'] as string)}
                  </p>
                )}
                {run.resultReason !== undefined && (
                  <p className="text-xs text-muted-foreground">{run.resultReason}</p>
                )}
                <p className="text-xs text-muted-foreground">
                  Use the actions bar below to retry or cancel this run.
                </p>
              </div>
            </CardContent>
          </Card>
        )}

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

        {/* Gate Status */}
        {requiredGates.length > 0 && (
          <>
            <div>
              <h3 className="text-lg font-semibold mb-4">Gates</h3>
              <div className="grid gap-3 md:grid-cols-2">
                {requiredGates.map((gateId) => {
                  const status = gates[gateId] ?? 'pending';
                  const latestEval = gateEvaluations
                    .filter(e => e.gateId === gateId)
                    .at(-1);

                  return (
                    <Card key={gateId}>
                      <CardContent className="p-4">
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-2">
                            <GateStatusIcon status={status} />
                            <span className="text-sm font-medium">{formatGateId(gateId)}</span>
                            <Badge variant="secondary" className="text-xs">required</Badge>
                          </div>
                          <Badge variant={gateStatusBadgeVariant(status)}>
                            {status}
                          </Badge>
                        </div>
                        {latestEval?.reason !== undefined && (
                          <p className="text-xs text-muted-foreground mt-2 ml-6">
                            {latestEval.reason}
                          </p>
                        )}
                      </CardContent>
                    </Card>
                  );
                })}
                {optionalGates.map((gateId) => {
                  const status = gates[gateId] ?? 'pending';
                  return (
                    <Card key={gateId}>
                      <CardContent className="p-4">
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-2">
                            <GateStatusIcon status={status} />
                            <span className="text-sm font-medium">{formatGateId(gateId)}</span>
                            <Badge variant="secondary" className="text-xs">optional</Badge>
                          </div>
                          <Badge variant={gateStatusBadgeVariant(status)}>
                            {status}
                          </Badge>
                        </div>
                      </CardContent>
                    </Card>
                  );
                })}
              </div>
            </div>

            <Separator />
          </>
        )}

        {/* Operator Actions History */}
        {operatorActions.length > 0 && (
          <>
            <div>
              <h3 className="text-lg font-semibold mb-4">Operator Actions</h3>
              <div className="space-y-2">
                {operatorActions.map((oa) => (
                  <div key={oa.operatorActionId} className="flex items-start gap-3">
                    <div className="w-2 h-2 mt-2 rounded-full bg-blue-500 flex-shrink-0" />
                    <div>
                      <div className="flex items-center gap-2">
                        <Badge variant="secondary">{formatPhase(oa.action)}</Badge>
                        <span className="text-xs text-muted-foreground">by {oa.operator}</span>
                      </div>
                      {oa.comment !== undefined && (
                        <p className="text-sm text-muted-foreground mt-1">{oa.comment}</p>
                      )}
                      <p className="text-xs text-muted-foreground mt-1">
                        {formatTimestamp(oa.createdAt)}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <Separator />
          </>
        )}

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

      {/* Actions Bar — sticky bottom per CONTROL_PLANE_UX.md */}
      {!isTerminal && (
        <div className="sticky bottom-0 border-t bg-background px-6 py-3 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            {/* Phase-specific actions */}
            {run.phase === 'awaiting_plan_approval' && (
              <>
                <Button
                  variant="default"
                  size="sm"
                  onClick={() => void handleAction('approve_plan')}
                  disabled={actionInProgress !== null}
                >
                  <ThumbsUp className="h-4 w-4 mr-1" />
                  Approve Plan
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setCommentDialog({
                    action: 'revise_plan',
                    title: 'Request Plan Revision',
                    description: 'Provide feedback for the agent to revise the plan.',
                    fieldLabel: 'Revision feedback',
                    fieldKey: 'comment',
                    confirmLabel: 'Request Revision',
                    confirmVariant: 'default',
                  })}
                  disabled={actionInProgress !== null}
                >
                  <Pencil className="h-4 w-4 mr-1" />
                  Revise
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setCommentDialog({
                    action: 'reject_run',
                    title: 'Reject Run',
                    description: 'This will cancel the run. Provide a reason for rejection.',
                    fieldLabel: 'Rejection reason',
                    fieldKey: 'comment',
                    confirmLabel: 'Reject Run',
                    confirmVariant: 'destructive',
                  })}
                  disabled={actionInProgress !== null}
                >
                  <ThumbsDown className="h-4 w-4 mr-1" />
                  Reject
                </Button>
              </>
            )}

            {run.phase === 'blocked' && (
              <>
                <Button
                  variant="default"
                  size="sm"
                  onClick={() => void handleAction('retry')}
                  disabled={actionInProgress !== null}
                >
                  <RefreshCw className="h-4 w-4 mr-1" />
                  Retry
                </Button>
                {run.blockedReason === 'policy_exception_required' && (
                  <>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setCommentDialog({
                        action: 'grant_policy_exception',
                        title: 'Grant Policy Exception',
                        description: 'Provide justification for granting this policy exception.',
                        fieldLabel: 'Justification',
                        fieldKey: 'justification',
                        confirmLabel: 'Grant Exception',
                        confirmVariant: 'default',
                      })}
                      disabled={actionInProgress !== null}
                    >
                      <ShieldAlert className="h-4 w-4 mr-1" />
                      Grant Exception
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setCommentDialog({
                        action: 'deny_policy_exception',
                        title: 'Deny Policy Exception',
                        description: 'This will cancel the run. Provide a reason for denial.',
                        fieldLabel: 'Denial reason',
                        fieldKey: 'comment',
                        confirmLabel: 'Deny Exception',
                        confirmVariant: 'destructive',
                      })}
                      disabled={actionInProgress !== null}
                    >
                      Deny Exception
                    </Button>
                  </>
                )}
              </>
            )}
          </div>

          <div className="flex items-center gap-2">
            {actionInProgress !== null && (
              <span className="text-sm text-muted-foreground">
                {formatPhase(actionInProgress)}...
              </span>
            )}
            <Button
              variant="destructive"
              size="sm"
              onClick={() => setShowCancelDialog(true)}
              disabled={actionInProgress !== null}
            >
              <XCircle className="h-4 w-4 mr-1" />
              Cancel
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
