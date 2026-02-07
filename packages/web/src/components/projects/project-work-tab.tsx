'use client';

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import type { Route } from 'next';
import { EmptyState, Badge, Skeleton } from '@/components/ui';
import { Button } from '@/components/ui/button';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Play, XCircle, CheckCircle, Eye } from 'lucide-react';
import {
  type WorkTab,
  workTabPhases,
  getPhaseLabel,
  getPhaseVariant,
  timeAgo,
} from '@/lib/phase-config';
import type { RunSummary, RunsResponse } from '@/lib/types';


const TAB_LABELS: Record<WorkTab, string> = {
  active: 'Active',
  queued: 'Queued',
  blocked: 'Blocked',
  completed: 'Completed',
};

function buildRunsUrl(tab: WorkTab, projectId: string, countOnly?: boolean): string {
  const phases = workTabPhases[tab].join(',');
  const params = new URLSearchParams();
  params.set('phases', phases);
  params.set('projectId', projectId);
  if (tab === 'blocked') {
    params.set('includePaused', '1');
  } else if (tab === 'active') {
    params.set('excludePaused', '1');
  }
  if (countOnly === true) {
    params.set('countOnly', '1');
  } else {
    params.set('limit', '100');
  }
  return `/api/runs?${params.toString()}`;
}

function RunAction({ run, onCancel, cancellingId }: {
  run: RunSummary;
  onCancel: (runId: string) => void;
  cancellingId: string | null;
}) {
  const busy = cancellingId !== null;

  if (run.phase === 'awaiting_plan_approval') {
    return (
      <Link href={`/runs/${run.runId}` as Route}>
        <Button variant="outline" size="sm" title="Review plan">
          <Eye className="h-4 w-4 mr-1" />
          Review
        </Button>
      </Link>
    );
  }

  if (run.phase === 'awaiting_review') {
    return (
      <Link href={`/runs/${run.runId}` as Route}>
        <Button variant="outline" size="sm" title="Review run">
          <CheckCircle className="h-4 w-4 mr-1" />
          Review
        </Button>
      </Link>
    );
  }

  return (
    <Button
      variant="ghost"
      size="sm"
      disabled={busy}
      onClick={() => onCancel(run.runId)}
      title="Cancel run"
    >
      <XCircle className="h-4 w-4 text-muted-foreground" />
    </Button>
  );
}

function StatusBadge({ run }: { run: RunSummary }) {
  if (run.status === 'paused') {
    return <Badge variant="warning">Paused</Badge>;
  }
  return (
    <Badge variant={getPhaseVariant(run.phase)}>
      {getPhaseLabel(run.phase)}
    </Badge>
  );
}

function ProjectWorkTable({
  runs,
  tab,
  onCancel,
  cancellingId,
}: {
  runs: RunSummary[];
  tab: WorkTab;
  onCancel: (runId: string) => void;
  cancellingId: string | null;
}) {
  if (runs.length === 0) {
    const messages: Record<WorkTab, { title: string; description: string }> = {
      active: { title: 'No active runs', description: 'Runs currently being planned or executed will appear here.' },
      queued: { title: 'No queued runs', description: 'Pending runs waiting to start will appear here.' },
      blocked: { title: 'No blocked runs', description: 'Runs waiting for approval or paused will appear here.' },
      completed: { title: 'No completed runs', description: 'Finished or cancelled runs will appear here.' },
    };
    return (
      <EmptyState
        icon={<Play className="h-12 w-12 text-muted-foreground" />}
        title={messages[tab].title}
        description={messages[tab].description}
      />
    );
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Task</TableHead>
          <TableHead>Repository</TableHead>
          <TableHead>Phase</TableHead>
          <TableHead>{tab === 'completed' ? 'Completed' : 'Updated'}</TableHead>
          {tab !== 'completed' && <TableHead className="w-[100px]" />}
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
            <TableCell className="text-muted-foreground">
              {run.repoFullName}
            </TableCell>
            <TableCell>
              <StatusBadge run={run} />
            </TableCell>
            <TableCell className="text-muted-foreground">
              {timeAgo(tab === 'completed' && run.completedAt !== undefined ? run.completedAt : run.updatedAt)}
            </TableCell>
            {tab !== 'completed' && (
              <TableCell>
                <RunAction run={run} onCancel={onCancel} cancellingId={cancellingId} />
              </TableCell>
            )}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

export function ProjectWorkTab({ projectId }: { projectId: string }) {
  const [activeTab, setActiveTab] = useState<WorkTab>('active');
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [cancellingId, setCancellingId] = useState<string | null>(null);
  const [counts, setCounts] = useState<Record<WorkTab, number>>({ active: 0, queued: 0, blocked: 0, completed: 0 });

  const fetchRuns = useCallback(async (tab: WorkTab) => {
    try {
      const url = buildRunsUrl(tab, projectId);
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error('Failed to fetch runs');
      }
      const data = await response.json() as RunsResponse;
      setRuns(data.runs);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  const fetchCounts = useCallback(async () => {
    const tabs: WorkTab[] = ['active', 'queued', 'blocked', 'completed'];
    const results = await Promise.all(
      tabs.map(async (tab) => {
        try {
          const url = buildRunsUrl(tab, projectId, true);
          const res = await fetch(url);
          if (!res.ok) return { tab, count: 0 };
          const data = await res.json() as { total: number };
          return { tab, count: data.total };
        } catch {
          return { tab, count: 0 };
        }
      })
    );
    const newCounts: Record<WorkTab, number> = { active: 0, queued: 0, blocked: 0, completed: 0 };
    for (const r of results) {
      newCounts[r.tab] = r.count;
    }
    setCounts(newCounts);
  }, [projectId]);

  useEffect(() => {
    void fetchCounts();
  }, [fetchCounts]);

  useEffect(() => {
    setLoading(true);
    setError(null);
    void fetchRuns(activeTab);
  }, [activeTab, fetchRuns]);

  async function handleCancel(runId: string) {
    setCancellingId(runId);
    try {
      const response = await fetch(`/api/runs/${runId}/actions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'cancel' }),
      });
      if (!response.ok) {
        const result = await response.json() as { error?: string };
        throw new Error(result.error ?? 'Failed to cancel run');
      }
      await Promise.all([
        fetchRuns(activeTab),
        fetchCounts(),
      ]);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setCancellingId(null);
    }
  }

  return (
    <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as WorkTab)}>
      <TabsList>
        {(['active', 'queued', 'blocked', 'completed'] as WorkTab[]).map((tab) => (
          <TabsTrigger key={tab} value={tab}>
            {TAB_LABELS[tab]}
            {counts[tab] > 0 && (
              <Badge variant="secondary" className="ml-2 h-5 px-1.5 text-xs">
                {counts[tab]}
              </Badge>
            )}
          </TabsTrigger>
        ))}
      </TabsList>

      {(['active', 'queued', 'blocked', 'completed'] as WorkTab[]).map((tab) => (
        <TabsContent key={tab} value={tab}>
          {loading && activeTab === tab ? (
            <div className="space-y-4 mt-4">
              {Array.from({ length: 5 }).map((_, i) => (
                <div key={i} className="flex items-center gap-4">
                  <Skeleton className="h-6 w-40" />
                  <Skeleton className="h-6 w-32" />
                  <Skeleton className="h-6 w-20" />
                  <Skeleton className="h-6 w-16" />
                </div>
              ))}
            </div>
          ) : error !== null && activeTab === tab ? (
            <div className="flex items-center justify-center h-64">
              <p className="text-destructive">{error}</p>
            </div>
          ) : (
            <ProjectWorkTable
              runs={runs}
              tab={tab}
              onCancel={(runId) => void handleCancel(runId)}
              cancellingId={cancellingId}
            />
          )}
        </TabsContent>
      ))}
    </Tabs>
  );
}
