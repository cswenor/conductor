'use client';

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import type { Route } from 'next';
import { PageHeader } from '@/components/layout';
import { EmptyState, Badge, Skeleton } from '@/components/ui';
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
  CheckCircle, AlertTriangle, ShieldAlert, Clock, ExternalLink,
  ThumbsUp, ThumbsDown, Pencil, RefreshCw,
} from 'lucide-react';

interface ApprovalItem {
  runId: string;
  phase: string;
  blockedReason?: string;
  taskId: string;
  repoId: string;
  taskTitle: string;
  repoFullName: string;
  projectName: string;
  projectId: string;
  updatedAt: string;
  waitDurationMs: number;
  gateType: 'plan_approval' | 'escalation' | 'policy_exception';
  latestGateStatus?: string;
  latestGateReason?: string;
}

interface ApprovalsResponse {
  planApprovals: ApprovalItem[];
  escalations: ApprovalItem[];
  policyExceptions: ApprovalItem[];
  total: number;
}

function formatWaitDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}

interface CommentDialogConfig {
  action: string;
  runId: string;
  title: string;
  description: string;
  fieldLabel: string;
  fieldKey: 'comment' | 'justification';
  confirmLabel: string;
  confirmVariant: 'default' | 'destructive';
}

function ApprovalCard({
  item,
  onAction,
  onCommentAction,
  actionInProgress,
}: {
  item: ApprovalItem;
  onAction: (runId: string, action: string) => void;
  onCommentAction: (config: CommentDialogConfig) => void;
  actionInProgress: string | null;
}) {
  const busy = actionInProgress !== null;

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
            {item.latestGateReason !== undefined && (
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

        {/* Inline action controls */}
        <div className="mt-3 flex items-center gap-2">
          {item.gateType === 'plan_approval' && (
            <>
              <Button size="sm" disabled={busy} onClick={() => onAction(item.runId, 'approve_plan')}>
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
                description: 'Provide justification for granting this exception.',
                fieldLabel: 'Justification',
                fieldKey: 'justification',
                confirmLabel: 'Grant Exception',
                confirmVariant: 'default',
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
            <Button variant="outline" size="sm" disabled={busy} onClick={() => onAction(item.runId, 'retry')}>
              <RefreshCw className="h-3 w-3 mr-1" />
              Retry
            </Button>
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
  actionInProgress,
}: {
  title: string;
  icon: React.ReactNode;
  badge: 'secondary' | 'destructive' | 'warning';
  items: ApprovalItem[];
  onAction: (runId: string, action: string) => void;
  onCommentAction: (config: CommentDialogConfig) => void;
  actionInProgress: string | null;
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
            actionInProgress={actionInProgress}
          />
        ))}
      </div>
    </div>
  );
}

export default function ApprovalsPage() {
  const [data, setData] = useState<ApprovalsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionInProgress, setActionInProgress] = useState<string | null>(null);
  const [commentDialog, setCommentDialog] = useState<CommentDialogConfig | null>(null);
  const [commentText, setCommentText] = useState('');

  const fetchApprovals = useCallback(async () => {
    try {
      const response = await fetch('/api/approvals');
      if (!response.ok) {
        throw new Error('Failed to fetch approvals');
      }
      const result = await response.json() as ApprovalsResponse;
      setData(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchApprovals();

    // Auto-refresh every 30 seconds
    const interval = setInterval(() => {
      void fetchApprovals();
    }, 30000);

    return () => clearInterval(interval);
  }, [fetchApprovals]);

  async function handleAction(runId: string, action: string, commentOrJustification?: string) {
    setActionInProgress(`${runId}:${action}`);
    try {
      const body: Record<string, unknown> = { action };
      if (commentOrJustification !== undefined) {
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
      await fetchApprovals();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setActionInProgress(null);
    }
  }

  function onAction(runId: string, action: string) {
    void handleAction(runId, action);
  }

  function onCommentAction(config: CommentDialogConfig) {
    setCommentDialog(config);
    setCommentText('');
  }

  return (
    <div className="flex flex-col h-full">
      <PageHeader
        title="Approvals"
        description="Pending decisions requiring your action"
      />
      <div className="flex-1 p-6">
        {loading ? (
          <div className="space-y-6">
            <Skeleton className="h-6 w-48" />
            <div className="space-y-2">
              <Skeleton className="h-20 w-full" />
              <Skeleton className="h-20 w-full" />
            </div>
          </div>
        ) : error !== null ? (
          <div className="flex items-center justify-center h-64">
            <p className="text-destructive">{error}</p>
          </div>
        ) : data === null || data.total === 0 ? (
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
              actionInProgress={actionInProgress}
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
              actionInProgress={actionInProgress}
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
              actionInProgress={actionInProgress}
            />

            {/* Comment dialog for actions requiring justification */}
            <Dialog open={commentDialog !== null} onOpenChange={(open) => { if (!open) { setCommentDialog(null); setCommentText(''); } }}>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>{commentDialog?.title}</DialogTitle>
                  <DialogDescription>{commentDialog?.description}</DialogDescription>
                </DialogHeader>
                <div className="space-y-2">
                  <Label htmlFor="approval-comment">{commentDialog?.fieldLabel}</Label>
                  <Textarea
                    id="approval-comment"
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
                      const text = commentText;
                      const cfg = commentDialog;
                      setCommentDialog(null);
                      setCommentText('');
                      void handleAction(cfg.runId, cfg.action, text);
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
