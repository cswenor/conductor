'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import type { Route } from 'next';
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
import { toast } from 'sonner';
import { Alert, AlertTitle, AlertDescription } from '@/components/ui/alert';
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
  TooltipProvider,
} from '@/components/ui/tooltip';
import { getPhaseLabel, getPhaseVariant, formatTimestamp, formatDuration } from '@/lib/phase-config';
import { getActionLabel, getEventSummary } from '@/lib/run-detail-helpers';
import {
  approvePlan,
  revisePlan,
  rejectRun,
  retryRun,
  cancelRun,
  grantPolicyException,
  denyPolicyException,
} from '@/lib/actions/run-actions';
import type { RunDetailData } from '@/lib/data/run-detail';

function gateStatusBadgeVariant(status: string): 'default' | 'secondary' | 'destructive' | 'success' | 'warning' {
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

function formatGateId(gateId: string): string {
  return gateId.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

const TERMINAL_PHASES = new Set(['completed', 'cancelled']);

export function RunDetailContent({ data }: { data: RunDetailData }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
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

  const commentOptional = commentDialog?.action === 'approve_plan' || commentDialog?.action === 'cancel';

  const { run, task, repo, events, gates, gateEvaluations, operatorActions, agentInvocations, requiredGates, optionalGates } = data;
  const phaseEvents = events.filter(e => e.type === 'phase.transitioned');
  const isTerminal = TERMINAL_PHASES.has(run.phase);
  const blockedContext = run.blockedContextJson !== undefined
    ? JSON.parse(run.blockedContextJson) as Record<string, unknown>
    : null;

  const latestInvocation = agentInvocations.at(-1) ?? null;
  const showErrorAlert = latestInvocation !== null
    && (latestInvocation.status === 'failed' || latestInvocation.status === 'timed_out')
    && !isTerminal;

  async function executeAction(action: string, commentOrJustification?: string) {
    const runId = run.runId;
    let result: { success: boolean; error?: string };

    switch (action) {
      case 'approve_plan':
        result = await approvePlan(runId, commentOrJustification);
        break;
      case 'revise_plan':
        result = await revisePlan(runId, commentOrJustification ?? '');
        break;
      case 'reject_run':
        result = await rejectRun(runId, commentOrJustification ?? '');
        break;
      case 'retry':
        result = await retryRun(runId, commentOrJustification);
        break;
      case 'cancel':
        result = await cancelRun(runId, commentOrJustification);
        break;
      case 'grant_policy_exception':
        result = await grantPolicyException(runId, commentOrJustification ?? '');
        break;
      case 'deny_policy_exception':
        result = await denyPolicyException(runId, commentOrJustification ?? '');
        break;
      default:
        result = { success: false, error: `Unknown action: ${action}` };
    }

    const labels: Record<string, string> = {
      approve_plan: 'Plan approved',
      revise_plan: 'Revision requested',
      reject_run: 'Run rejected',
      cancel: 'Run cancelled',
      retry: 'Run retried',
      grant_policy_exception: 'Policy exception granted',
      deny_policy_exception: 'Policy exception denied',
    };

    if (result.success) {
      toast.success(labels[action] ?? `Action "${action}" completed`);
      router.refresh();
    } else {
      toast.error(result.error ?? `Failed to ${action}`);
    }
  }

  function handleAction(action: string, commentOrJustification?: string) {
    startTransition(() => void executeAction(action, commentOrJustification));
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between border-b px-6 py-4">
        <div>
          <div className="flex items-center gap-3">
            <Link href={'/work' as Route}>
              <Button variant="ghost" size="sm">
                <ArrowLeft className="h-4 w-4" />
              </Button>
            </Link>
            <h1 className="text-2xl font-semibold">
              {task !== null ? task.githubTitle : run.runId}
            </h1>
            <Badge variant={getPhaseVariant(run.phase)}>
              {getPhaseLabel(run.phase)}
            </Badge>
          </div>
          <p className="text-sm text-muted-foreground mt-1 ml-12">
            {task !== null
              ? `${task.githubType} #${task.githubIssueNumber} · ${run.runId}`
              : run.taskId}
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
              onClick={() => { setShowCancelDialog(false); handleAction('cancel'); }}
              disabled={isPending}
            >
              Cancel Run
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

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
              placeholder={commentOptional ? 'Optional...' : 'Enter your reason...'}
              rows={3}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setCommentDialog(null); setCommentText(''); }}>
              Cancel
            </Button>
            <Button
              variant={commentDialog?.confirmVariant ?? 'default'}
              disabled={isPending || (!commentOptional && commentText.trim() === '')}
              onClick={() => {
                if (commentDialog === null) return;
                const text = commentText.trim();
                const action = commentDialog.action;
                setCommentDialog(null);
                setCommentText('');
                const value = text !== '' ? text : undefined;
                handleAction(action, value);
              }}
            >
              {commentDialog?.confirmLabel}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <div className="flex-1 p-6 space-y-6 pb-24">
        {/* Error Alert for Failed Agent Invocation */}
        {showErrorAlert && latestInvocation !== null && (
          <Alert variant="destructive">
            <AlertTriangle className="h-4 w-4" />
            <AlertTitle className="flex items-center gap-2">
              {getActionLabel(latestInvocation.action)} Failed
              {latestInvocation.errorCode !== undefined && (
                <Badge variant="secondary" className="text-xs font-mono">
                  {latestInvocation.errorCode}
                </Badge>
              )}
            </AlertTitle>
            <AlertDescription>
              <p>{latestInvocation.errorMessage ?? 'An unknown error occurred.'}</p>
              {latestInvocation.completedAt !== undefined && (
                <p className="text-xs mt-1 opacity-70">
                  {formatTimestamp(latestInvocation.completedAt)}
                </p>
              )}
            </AlertDescription>
          </Alert>
        )}

        {/* Blocked State Explanation */}
        {run.phase === 'blocked' && run.blockedReason !== undefined && (
          <Card className={showErrorAlert ? 'border-muted' : 'border-destructive'}>
            <CardHeader className="pb-2">
              <CardTitle className={`text-sm font-medium flex items-center gap-2 ${showErrorAlert ? 'text-muted-foreground' : 'text-destructive'}`}>
                <AlertTriangle className="h-4 w-4" />
                Run Blocked
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-2">
                <p className="text-sm font-medium">{run.blockedReason}</p>
                {blockedContext?.['gate_id'] !== undefined && (
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
                <p className="font-medium">{getPhaseLabel(run.phase)} &middot; {getPhaseLabel(run.step)}</p>
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

        {/* Agent Activity */}
        {agentInvocations.length > 0 && (
          <>
            <div>
              <h3 className="text-lg font-semibold mb-4">Agent Activity</h3>
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Agent</TableHead>
                      <TableHead>Action</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Duration</TableHead>
                      <TableHead>Error</TableHead>
                      <TableHead>Time</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {agentInvocations.map((inv) => (
                      <TableRow key={inv.agentInvocationId}>
                        <TableCell className="font-medium">{inv.agent}</TableCell>
                        <TableCell>{getActionLabel(inv.action)}</TableCell>
                        <TableCell>
                          <Badge variant={
                            inv.status === 'failed' ? 'destructive'
                              : inv.status === 'completed' ? 'success'
                              : inv.status === 'timed_out' ? 'warning'
                              : 'secondary'
                          }>
                            {inv.status}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-muted-foreground">
                          {inv.durationMs !== undefined ? formatDuration(inv.durationMs) : '—'}
                        </TableCell>
                        <TableCell className="text-muted-foreground text-sm max-w-[300px] truncate">
                          {(inv.status === 'failed' || inv.status === 'timed_out')
                            ? [inv.errorCode, inv.errorMessage].filter(Boolean).join(': ') || '—'
                            : '—'}
                        </TableCell>
                        <TableCell className="text-muted-foreground text-sm whitespace-nowrap">
                          {formatTimestamp(inv.startedAt)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
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
                        <Badge variant="secondary">{getPhaseLabel(oa.action)}</Badge>
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
                        <Badge variant={getPhaseVariant(payload.to ?? '')}>
                          {getPhaseLabel(payload.from ?? '')} &rarr; {getPhaseLabel(payload.to ?? '')}
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
            <div className="overflow-x-auto">
              <TooltipProvider>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Seq</TableHead>
                      <TableHead>Type</TableHead>
                      <TableHead>Class</TableHead>
                      <TableHead>Source</TableHead>
                      <TableHead>Details</TableHead>
                      <TableHead>Time</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {events.map((event) => {
                      const summary = getEventSummary(event);
                      const isTruncated = summary.length > 60;
                      return (
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
                          <TableCell className="text-muted-foreground text-sm max-w-[200px]">
                            {summary === '—' ? (
                              <span>—</span>
                            ) : isTruncated ? (
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <span className="truncate block cursor-default">{summary}</span>
                                </TooltipTrigger>
                                <TooltipContent className="max-w-sm whitespace-pre-wrap">
                                  {summary}
                                </TooltipContent>
                              </Tooltip>
                            ) : (
                              <span className="truncate block">{summary}</span>
                            )}
                          </TableCell>
                          <TableCell className="text-muted-foreground text-sm whitespace-nowrap">
                            {formatTimestamp(event.createdAt)}
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </TooltipProvider>
            </div>
          )}
        </div>
      </div>

      {/* Actions Bar */}
      {!isTerminal && (
        <div className="sticky bottom-0 border-t bg-background px-6 py-3 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            {run.phase === 'awaiting_plan_approval' && (
              <>
                <Button
                  variant="default"
                  size="sm"
                  onClick={() => setCommentDialog({
                    action: 'approve_plan',
                    title: 'Approve Plan',
                    description: 'Optionally add a comment. Leave blank to approve without comment.',
                    fieldLabel: 'Comment (optional)',
                    fieldKey: 'comment',
                    confirmLabel: 'Approve Plan',
                    confirmVariant: 'default',
                  })}
                  disabled={isPending}
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
                  disabled={isPending}
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
                  disabled={isPending}
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
                  onClick={() => handleAction('retry')}
                  disabled={isPending}
                >
                  <RefreshCw className="h-4 w-4 mr-1" />
                  Retry
                </Button>
                {run.blockedReason !== 'policy_exception_required' && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setCommentDialog({
                      action: 'retry',
                      title: 'Manual Fix Applied',
                      description: 'Describe the manual fix you applied. The run will resume from where it was blocked.',
                      fieldLabel: 'What was fixed',
                      fieldKey: 'comment',
                      confirmLabel: 'Resume Run',
                      confirmVariant: 'default',
                    })}
                    disabled={isPending}
                  >
                    <Pencil className="h-4 w-4 mr-1" />
                    Manual Fix
                  </Button>
                )}
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
                      disabled={isPending}
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
                      disabled={isPending}
                    >
                      Deny Exception
                    </Button>
                  </>
                )}
              </>
            )}
          </div>

          <div className="flex items-center gap-2">
            {isPending && (
              <span className="text-sm text-muted-foreground">
                Processing...
              </span>
            )}
            <Button
              variant="destructive"
              size="sm"
              onClick={() => setShowCancelDialog(true)}
              disabled={isPending}
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
