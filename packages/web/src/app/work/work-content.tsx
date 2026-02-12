'use client';

import { useTransition } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import type { Route } from 'next';
import { PageHeader } from '@/components/layout';
import { EmptyState, Badge } from '@/components/ui';
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Play, XCircle, CheckCircle, Eye, Filter } from 'lucide-react';
import { toast } from 'sonner';
import {
  type WorkTab,
  getPhaseLabel,
  getPhaseVariant,
  timeAgo,
} from '@/lib/phase-config';
import { cancelRun } from '@/lib/actions/run-actions';
import { useLiveRefresh } from '@/hooks/use-live-refresh';
import type { RunSummary, ProjectOption } from '@/lib/types';

const TAB_LABELS: Record<WorkTab, string> = {
  active: 'Active',
  queued: 'Queued',
  blocked: 'Blocked',
  completed: 'Completed',
};

function RunAction({ run, onCancel, busy }: {
  run: RunSummary;
  onCancel: (runId: string) => void;
  busy: boolean;
}) {
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

function WorkTable({
  runs,
  tab,
  onCancel,
  busy,
}: {
  runs: RunSummary[];
  tab: WorkTab;
  onCancel: (runId: string) => void;
  busy: boolean;
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
          <TableHead>Project</TableHead>
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
              {run.projectName}
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
                <RunAction run={run} onCancel={onCancel} busy={busy} />
              </TableCell>
            )}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

export function WorkContent({
  runs,
  counts,
  projects,
  initialTab,
  initialProjectId,
}: {
  runs: RunSummary[];
  counts: Record<WorkTab, number>;
  projects: ProjectOption[];
  initialTab: WorkTab;
  initialProjectId: string;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [isPending, startTransition] = useTransition();

  useLiveRefresh({
    filter: (e) => e.kind === 'run.phase_changed' || e.kind === 'run.updated',
  });

  const activeTab = (searchParams.get('tab') as WorkTab) ?? initialTab;
  const filterProjectId = searchParams.get('projectId') ?? initialProjectId;

  function updateParams(updates: Record<string, string | undefined>) {
    const params = new URLSearchParams(searchParams.toString());
    for (const [key, value] of Object.entries(updates)) {
      if (value === undefined || value === 'all') {
        params.delete(key);
      } else {
        params.set(key, value);
      }
    }
    router.push(`/work?${params.toString()}` as Route);
  }

  function handleCancel(runId: string) {
    startTransition(async () => {
      const result = await cancelRun(runId);
      if (result.success) {
        toast.success('Run cancelled');
        router.refresh();
      } else {
        toast.error(result.error ?? 'Failed to cancel run');
      }
    });
  }

  return (
    <div className="flex flex-col h-full">
      <PageHeader
        title="Work"
        description="All runs across your projects"
      />
      <div className="flex-1 p-6">
        {projects.length > 1 && (
          <div className="flex items-center gap-2 mb-4">
            <Filter className="h-4 w-4 text-muted-foreground" />
            <Select
              value={filterProjectId}
              onValueChange={(value) => updateParams({ projectId: value === 'all' ? undefined : value, tab: activeTab })}
            >
              <SelectTrigger className="w-48">
                <SelectValue placeholder="All projects" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All projects</SelectItem>
                {projects.map((p) => (
                  <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}

        <Tabs value={activeTab} onValueChange={(v) => updateParams({ tab: v })}>
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
              <WorkTable
                runs={activeTab === tab ? runs : []}
                tab={tab}
                onCancel={handleCancel}
                busy={isPending}
              />
            </TabsContent>
          ))}
        </Tabs>
      </div>
    </div>
  );
}
