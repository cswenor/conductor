'use client';

import { useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { Route } from 'next';
import { PageHeader } from '@/components/layout';
import { EmptyState, Badge } from '@/components/ui';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import {
  CheckCircle, AlertTriangle, ShieldAlert, Clock, ExternalLink,
  ThumbsUp, ThumbsDown, Pencil, RefreshCw, XCircle, Filter,
} from 'lucide-react';
import { toast } from 'sonner';
import { formatWaitDuration } from '@/lib/phase-config';
import {
  approvePlan,
  revisePlan,
  rejectRun,
  retryRun,
  cancelRun,
  grantPolicyException,
  denyPolicyException,
} from '@/lib/actions/run-actions';
import { useLiveRefresh } from '@/hooks/use-live-refresh';
import type { ApprovalItem, ApprovalsResponse } from '@/lib/types';

interface CommentDialogConfig {
  action: string;
  runId: string;
  title: string;
  description: string;
  fieldLabel: string;
  fieldKey: 'comment' | 'justification';
  confirmLabel: string;
  confirmVariant: 'default' | 'destructive';
  showScope?: boolean;
}

function ApprovalCard({
  item,
  onAction,
  onCommentAction,
  busy,
}: {
  item: ApprovalItem;
  onAction: (runId: string, action: string) => void;
  onCommentAction: (config: CommentDialogConfig) => void;
  busy: boolean;
}) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0 flex-1">
            <Link
              href={`/runs/${item.runId}` as Route}
              className="text-sm font-medium hover:underline truncate block"
            >
              {item.taskTitle}
            </Link>
            <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
              <span>{item.repoFullName}</span>
              <span className="text-border">|</span>
              <span>{item.projectName}</span>
            </div>
            {item.contextSummary !== undefined && (
              <p className="mt-2 text-xs text-muted-foreground line-clamp-2">{item.contextSummary}</p>
            )}
            {item.contextSummary === undefined && item.latestGateReason !== undefined && (
              <p className="mt-2 text-xs text-muted-foreground">{item.latestGateReason}</p>
            )}
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <div className="flex items-center gap-1 text-xs text-muted-foreground">
              <Clock className="h-3 w-3" />
              <span>{formatWaitDuration(item.waitDurationMs)}</span>
            </div>
            <Link href={`/runs/${item.runId}` as Route}>
              <Button variant="ghost" size="sm">
                <ExternalLink className="h-3 w-3" />
              </Button>
            </Link>
          </div>
        </div>

        <div className="mt-3 flex items-center gap-2">
          {item.gateType === 'plan_approval' && (
            <>
              <Button size="sm" disabled={busy} onClick={() => onCommentAction({
                action: 'approve_plan',
                runId: item.runId,
                title: 'Approve Plan',
                description: 'Optionally add a comment. Leave blank to approve without comment.',
                fieldLabel: 'Comment (optional)',
                fieldKey: 'comment',
                confirmLabel: 'Approve Plan',
                confirmVariant: 'default',
              })}>
                <ThumbsUp className="h-3 w-3 mr-1" />
                Approve
              </Button>
              <Button variant="outline" size="sm" disabled={busy} onClick={() => onCommentAction({
                action: 'revise_plan',
                runId: item.runId,
                title: 'Request Plan Revision',
                description: 'Provide feedback for the agent to revise the plan.',
                fieldLabel: 'Revision feedback',
                fieldKey: 'comment',
                confirmLabel: 'Request Revision',
                confirmVariant: 'default',
              })}>
                <Pencil className="h-3 w-3 mr-1" />
                Revise
              </Button>
              <Button variant="outline" size="sm" disabled={busy} onClick={() => onCommentAction({
                action: 'reject_run',
                runId: item.runId,
                title: 'Reject Run',
                description: 'This will cancel the run. Provide a reason for rejection.',
                fieldLabel: 'Rejection reason',
                fieldKey: 'comment',
                confirmLabel: 'Reject Run',
                confirmVariant: 'destructive',
              })}>
                <ThumbsDown className="h-3 w-3 mr-1" />
                Reject
              </Button>
            </>
          )}
          {item.gateType === 'policy_exception' && (
            <>
              <Button variant="outline" size="sm" disabled={busy} onClick={() => onCommentAction({
                action: 'grant_policy_exception',
                runId: item.runId,
                title: 'Grant Policy Exception',
                description: 'Provide justification and choose the scope for this exception.',
                fieldLabel: 'Justification',
                fieldKey: 'justification',
                confirmLabel: 'Grant Exception',
                confirmVariant: 'default',
                showScope: true,
              })}>
                <ShieldAlert className="h-3 w-3 mr-1" />
                Grant
              </Button>
              <Button variant="outline" size="sm" disabled={busy} onClick={() => onCommentAction({
                action: 'deny_policy_exception',
                runId: item.runId,
                title: 'Deny Policy Exception',
                description: 'This will cancel the run. Provide a reason for denial.',
                fieldLabel: 'Denial reason',
                fieldKey: 'comment',
                confirmLabel: 'Deny Exception',
                confirmVariant: 'destructive',
              })}>
                <ThumbsDown className="h-3 w-3 mr-1" />
                Deny
              </Button>
            </>
          )}
          {item.gateType === 'escalation' && (
            <>
              <Button variant="outline" size="sm" disabled={busy} onClick={() => onAction(item.runId, 'retry')}>
                <RefreshCw className="h-3 w-3 mr-1" />
                Retry
              </Button>
              <Button variant="outline" size="sm" disabled={busy} onClick={() => onCommentAction({
                action: 'retry',
                runId: item.runId,
                title: 'Manual Fix Applied',
                description: 'Describe the manual fix you applied. The run will resume from where it was blocked.',
                fieldLabel: 'What was fixed',
                fieldKey: 'comment',
                confirmLabel: 'Resume Run',
                confirmVariant: 'default',
              })}>
                <Pencil className="h-3 w-3 mr-1" />
                Manual Fix
              </Button>
              <Button variant="outline" size="sm" disabled={busy} onClick={() => onCommentAction({
                action: 'cancel',
                runId: item.runId,
                title: 'Cancel Run',
                description: 'This will permanently cancel the run. Optionally provide a reason.',
                fieldLabel: 'Reason (optional)',
                fieldKey: 'comment',
                confirmLabel: 'Cancel Run',
                confirmVariant: 'destructive',
              })}>
                <XCircle className="h-3 w-3 mr-1" />
                Cancel
              </Button>
            </>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function ApprovalSection({
  title,
  icon,
  badge,
  items,
  onAction,
  onCommentAction,
  busy,
}: {
  title: string;
  icon: React.ReactNode;
  badge: 'secondary' | 'destructive' | 'warning';
  items: ApprovalItem[];
  onAction: (runId: string, action: string) => void;
  onCommentAction: (config: CommentDialogConfig) => void;
  busy: boolean;
}) {
  if (items.length === 0) return null;

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        {icon}
        <h2 className="text-sm font-semibold">{title}</h2>
        <Badge variant={badge}>{items.length}</Badge>
      </div>
      <div className="space-y-2">
        {items.map((item) => (
          <ApprovalCard
            key={item.runId}
            item={item}
            onAction={onAction}
            onCommentAction={onCommentAction}
            busy={busy}
          />
        ))}
      </div>
    </div>
  );
}

const ACTION_LABELS: Record<string, string> = {
  approve_plan: 'Plan approved',
  revise_plan: 'Revision requested',
  reject_run: 'Run rejected',
  cancel: 'Run cancelled',
  retry: 'Run retried',
  grant_policy_exception: 'Policy exception granted',
  deny_policy_exception: 'Policy exception denied',
};

export function ApprovalsContent({
  data,
  initialProjectId,
}: {
  data: ApprovalsResponse;
  initialProjectId: string;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  useLiveRefresh({
    filter: (e) => e.kind === 'run.phase_changed' || e.kind === 'operator.action' || e.kind === 'gate.evaluated',
    debounceMs: 300,
  });

  const [commentDialog, setCommentDialog] = useState<CommentDialogConfig | null>(null);
  const [commentText, setCommentText] = useState('');
  const [scopeSelection, setScopeSelection] = useState('this_run');

  const commentOptional = commentDialog?.action === 'approve_plan' || commentDialog?.action === 'cancel';

  async function executeAction(runId: string, action: string, extra?: Record<string, unknown>) {
    const comment = (extra?.['comment'] as string) ?? undefined;
    const justification = (extra?.['justification'] as string) ?? undefined;
    const scope = (extra?.['scope'] as string) ?? undefined;

    let result: { success: boolean; error?: string };

    switch (action) {
      case 'approve_plan':
        result = await approvePlan(runId, comment);
        break;
      case 'revise_plan':
        result = await revisePlan(runId, comment ?? '');
        break;
      case 'reject_run':
        result = await rejectRun(runId, comment ?? '');
        break;
      case 'retry':
        result = await retryRun(runId, comment);
        break;
      case 'cancel':
        result = await cancelRun(runId, comment);
        break;
      case 'grant_policy_exception':
        result = await grantPolicyException(runId, justification ?? '', scope);
        break;
      case 'deny_policy_exception':
        result = await denyPolicyException(runId, comment ?? '');
        break;
      default:
        result = { success: false, error: `Unknown action: ${action}` };
    }

    if (result.success) {
      toast.success(ACTION_LABELS[action] ?? `Action "${action}" completed`);
      router.refresh();
    } else {
      toast.error(result.error ?? `Failed to ${action}`);
    }
  }

  function onAction(runId: string, action: string) {
    startTransition(() => void executeAction(runId, action));
  }

  function onCommentAction(config: CommentDialogConfig) {
    setCommentDialog(config);
    setCommentText('');
    setScopeSelection('this_run');
  }

  return (
    <div className="flex flex-col h-full">
      <PageHeader
        title="Approvals"
        description="Pending decisions requiring your action"
      />
      <div className="flex-1 p-6">
        {data.projects.length > 1 && (
          <div className="flex items-center gap-2 mb-4 max-w-3xl">
            <Filter className="h-4 w-4 text-muted-foreground" />
            <Select
              value={initialProjectId}
              onValueChange={(value) => {
                const params = value === 'all' ? '' : `?projectId=${value}`;
                router.push(`/approvals${params}` as Route);
              }}
            >
              <SelectTrigger className="w-48">
                <SelectValue placeholder="All projects" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All projects</SelectItem>
                {data.projects.map((p) => (
                  <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}

        {data.total === 0 ? (
          <EmptyState
            icon={<CheckCircle className="h-12 w-12 text-muted-foreground" />}
            title="No pending approvals"
            description="When runs reach approval gates, they will appear here for your review."
          />
        ) : (
          <div className="space-y-6 max-w-3xl">
            <ApprovalSection
              title="Plan Approvals"
              icon={<CheckCircle className="h-4 w-4 text-blue-500" />}
              badge="secondary"
              items={data.planApprovals}
              onAction={onAction}
              onCommentAction={onCommentAction}
              busy={isPending}
            />

            {data.planApprovals.length > 0 && data.escalations.length > 0 && (
              <Separator />
            )}

            <ApprovalSection
              title="Failure Escalations"
              icon={<AlertTriangle className="h-4 w-4 text-amber-500" />}
              badge="warning"
              items={data.escalations}
              onAction={onAction}
              onCommentAction={onCommentAction}
              busy={isPending}
            />

            {(data.planApprovals.length > 0 || data.escalations.length > 0) &&
              data.policyExceptions.length > 0 && (
              <Separator />
            )}

            <ApprovalSection
              title="Policy Exceptions"
              icon={<ShieldAlert className="h-4 w-4 text-red-500" />}
              badge="destructive"
              items={data.policyExceptions}
              onAction={onAction}
              onCommentAction={onCommentAction}
              busy={isPending}
            />

            <Dialog open={commentDialog !== null} onOpenChange={(open) => { if (!open) { setCommentDialog(null); setCommentText(''); } }}>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>{commentDialog?.title}</DialogTitle>
                  <DialogDescription>{commentDialog?.description}</DialogDescription>
                </DialogHeader>
                <div className="space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor="approval-comment">{commentDialog?.fieldLabel}</Label>
                    <Textarea
                      id="approval-comment"
                      value={commentText}
                      onChange={(e) => setCommentText(e.target.value)}
                      placeholder={commentOptional ? 'Optional...' : 'Enter your reason...'}
                      rows={3}
                    />
                  </div>

                  {commentDialog?.showScope === true && (
                    <div className="space-y-2">
                      <Label>Exception scope</Label>
                      <RadioGroup value={scopeSelection} onValueChange={setScopeSelection}>
                        <div className="flex items-center space-x-2">
                          <RadioGroupItem value="this_run" id="scope-run" />
                          <Label htmlFor="scope-run" className="font-normal">This run only</Label>
                        </div>
                        <div className="flex items-center space-x-2">
                          <RadioGroupItem value="this_task" id="scope-task" />
                          <Label htmlFor="scope-task" className="font-normal">All runs for this task</Label>
                        </div>
                        <div className="flex items-center space-x-2">
                          <RadioGroupItem value="this_repo" id="scope-repo" />
                          <Label htmlFor="scope-repo" className="font-normal">All runs for this repo</Label>
                        </div>
                        <div className="flex items-center space-x-2">
                          <RadioGroupItem value="project_wide" id="scope-project" />
                          <Label htmlFor="scope-project" className="font-normal">Project-wide</Label>
                        </div>
                      </RadioGroup>
                    </div>
                  )}
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
                      const text = commentText;
                      const cfg = commentDialog;
                      const scope = scopeSelection;
                      setCommentDialog(null);
                      setCommentText('');

                      const extra: Record<string, unknown> = {};
                      if (cfg.fieldKey === 'justification') {
                        extra['justification'] = text;
                      } else if (text.trim() !== '') {
                        extra['comment'] = text;
                      }
                      if (cfg.showScope === true) {
                        extra['scope'] = scope;
                      }

                      startTransition(() => void executeAction(cfg.runId, cfg.action, extra));
                    }}
                  >
                    {commentDialog?.confirmLabel}
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          </div>
        )}
      </div>
    </div>
  );
}
