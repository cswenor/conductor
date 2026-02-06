'use client';

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import type { Route } from 'next';
import { PageHeader } from '@/components/layout';
import { EmptyState, Badge, Skeleton } from '@/components/ui';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { CheckCircle, AlertTriangle, ShieldAlert, Clock, ExternalLink } from 'lucide-react';

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

function ApprovalCard({ item }: { item: ApprovalItem }) {
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
      </CardContent>
    </Card>
  );
}

function ApprovalSection({
  title,
  icon,
  badge,
  items,
}: {
  title: string;
  icon: React.ReactNode;
  badge: 'secondary' | 'destructive' | 'warning';
  items: ApprovalItem[];
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
          <ApprovalCard key={item.runId} item={item} />
        ))}
      </div>
    </div>
  );
}

export default function ApprovalsPage() {
  const [data, setData] = useState<ApprovalsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

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
            />

            {data.planApprovals.length > 0 && data.escalations.length > 0 && (
              <Separator />
            )}

            <ApprovalSection
              title="Failure Escalations"
              icon={<AlertTriangle className="h-4 w-4 text-amber-500" />}
              badge="warning"
              items={data.escalations}
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
            />
          </div>
        )}
      </div>
    </div>
  );
}
