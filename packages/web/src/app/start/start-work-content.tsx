'use client';

import { useState, useMemo, useTransition } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import type { Route } from 'next';
import { PageHeader } from '@/components/layout';
import { EmptyState, Badge } from '@/components/ui';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Rocket, RefreshCw, Play, AlertTriangle, Search } from 'lucide-react';
import { toast } from 'sonner';
import { timeAgo } from '@/lib/phase-config';
import { startWork, syncRepoIssues } from '@/lib/actions/start-actions';
import type { StartableTask } from '@conductor/shared';

interface StartWorkContentProps {
  tasks: StartableTask[];
  projects: { id: string; name: string }[];
  repos: { id: string; fullName: string; projectId: string }[];
  labels: string[];
  hasStaleRepos: boolean;
  initialProjectId: string;
  initialRepoId: string;
}

export function StartWorkContent({
  tasks,
  projects,
  repos,
  labels,
  hasStaleRepos,
  initialProjectId,
  initialRepoId,
}: StartWorkContentProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [isPending, startTransition] = useTransition();
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState('');
  const [labelFilter, setLabelFilter] = useState('all');

  const filterProjectId = searchParams.get('projectId') ?? initialProjectId;
  const filterRepoId = searchParams.get('repoId') ?? initialRepoId;

  // Filter repos to show only those for the selected project
  const filteredRepos = useMemo(() => {
    if (filterProjectId === 'all') return repos;
    return repos.filter(r => r.projectId === filterProjectId);
  }, [repos, filterProjectId]);

  // Client-side filtering (search + label)
  const filteredTasks = useMemo(() => {
    let result = tasks;

    if (search.trim() !== '') {
      const q = search.toLowerCase();
      result = result.filter(t => t.githubTitle.toLowerCase().includes(q));
    }

    if (labelFilter !== 'all') {
      result = result.filter(t => {
        try {
          const taskLabels = JSON.parse(t.githubLabelsJson) as string[];
          return taskLabels.includes(labelFilter);
        } catch {
          return false;
        }
      });
    }

    return result;
  }, [tasks, search, labelFilter]);

  // Group tasks by project
  const groupedTasks = useMemo(() => {
    const groups = new Map<string, { projectName: string; tasks: StartableTask[] }>();
    for (const task of filteredTasks) {
      const existing = groups.get(task.projectId);
      if (existing) {
        existing.tasks.push(task);
      } else {
        groups.set(task.projectId, { projectName: task.projectName, tasks: [task] });
      }
    }
    return groups;
  }, [filteredTasks]);

  const allFilteredIds = useMemo(
    () => new Set(filteredTasks.map(t => t.taskId)),
    [filteredTasks],
  );

  const allSelected = filteredTasks.length > 0 && filteredTasks.every(t => selectedIds.has(t.taskId));
  const someSelected = filteredTasks.some(t => selectedIds.has(t.taskId));

  function updateParams(updates: Record<string, string | undefined>) {
    const params = new URLSearchParams(searchParams.toString());
    for (const [key, value] of Object.entries(updates)) {
      if (value === undefined || value === 'all') {
        params.delete(key);
      } else {
        params.set(key, value);
      }
    }
    router.push(`/start?${params.toString()}` as Route);
  }

  function toggleSelectAll() {
    if (allSelected) {
      setSelectedIds(prev => {
        const next = new Set(prev);
        for (const id of allFilteredIds) next.delete(id);
        return next;
      });
    } else {
      setSelectedIds(prev => {
        const next = new Set(prev);
        for (const id of allFilteredIds) next.add(id);
        return next;
      });
    }
  }

  function toggleTask(taskId: string) {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(taskId)) {
        next.delete(taskId);
      } else {
        next.add(taskId);
      }
      return next;
    });
  }

  function handleStart() {
    const ids = Array.from(selectedIds);
    if (ids.length === 0) return;

    startTransition(async () => {
      const result = await startWork(ids);
      if (result.success) {
        const msg = result.skippedCount !== undefined && result.skippedCount > 0
          ? `Started ${result.startedCount} run(s), ${result.skippedCount} skipped (already started)`
          : `Started ${result.startedCount} run(s)`;
        toast.success(msg);
        setSelectedIds(new Set());
        router.refresh();
      } else {
        toast.error(result.error ?? 'Failed to start work');
      }
    });
  }

  function handleSync() {
    const pid = filterProjectId !== 'all' ? filterProjectId : undefined;
    startTransition(async () => {
      const result = await syncRepoIssues(pid);
      if (result.success) {
        toast.success(`Synced ${result.syncedCount} issue(s) from ${result.reposSynced} repo(s)`);
        router.refresh();
      } else {
        toast.error(result.error ?? 'Failed to sync issues');
      }
    });
  }

  function parseLabels(json: string): string[] {
    try {
      return JSON.parse(json) as string[];
    } catch {
      return [];
    }
  }

  return (
    <div className="flex flex-col h-full">
      <PageHeader
        title="Start Work"
        description="Select issues to start working on across your projects"
        action={
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              onClick={handleSync}
              disabled={isPending}
            >
              <RefreshCw className={`h-4 w-4 mr-2 ${isPending ? 'animate-spin' : ''}`} />
              Sync
            </Button>
            <Button
              onClick={handleStart}
              disabled={isPending || selectedIds.size === 0}
            >
              <Play className="h-4 w-4 mr-2" />
              Start ({selectedIds.size})
            </Button>
          </div>
        }
      />

      <div className="flex-1 p-6 space-y-4">
        {/* Stale banner */}
        {hasStaleRepos && (
          <Alert>
            <AlertTriangle className="h-4 w-4" />
            <AlertDescription className="flex items-center justify-between">
              <span>Some repos haven&apos;t been synced recently. Click Sync to refresh.</span>
              <Button
                variant="outline"
                size="sm"
                onClick={handleSync}
                disabled={isPending}
              >
                <RefreshCw className={`h-3 w-3 mr-1 ${isPending ? 'animate-spin' : ''}`} />
                Sync Now
              </Button>
            </AlertDescription>
          </Alert>
        )}

        {/* Filters */}
        <div className="flex flex-wrap items-center gap-3">
          {projects.length > 0 && (
            <Select
              value={filterProjectId}
              onValueChange={(value) => {
                updateParams({ projectId: value === 'all' ? undefined : value, repoId: undefined });
              }}
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
          )}

          {filteredRepos.length > 0 && (
            <Select
              value={filterRepoId}
              onValueChange={(value) => {
                updateParams({
                  projectId: filterProjectId !== 'all' ? filterProjectId : undefined,
                  repoId: value === 'all' ? undefined : value,
                });
              }}
            >
              <SelectTrigger className="w-56">
                <SelectValue placeholder="All repos" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All repos</SelectItem>
                {filteredRepos.map((r) => (
                  <SelectItem key={r.id} value={r.id}>{r.fullName}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}

          {labels.length > 0 && (
            <Select value={labelFilter} onValueChange={setLabelFilter}>
              <SelectTrigger className="w-40">
                <SelectValue placeholder="All labels" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All labels</SelectItem>
                {labels.map((label) => (
                  <SelectItem key={label} value={label}>{label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}

          <div className="relative flex-1 min-w-[200px]">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search issues..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-9"
            />
          </div>
        </div>

        {/* Task list */}
        {filteredTasks.length === 0 ? (
          <EmptyState
            icon={<Rocket className="h-12 w-12 text-muted-foreground" />}
            title={tasks.length === 0 ? 'No startable issues' : 'No matching issues'}
            description={
              tasks.length === 0
                ? 'Sync your repos to see open issues, or check that issues exist in your connected repositories.'
                : 'Try adjusting your filters or search query.'
            }
            action={
              tasks.length === 0 ? (
                <Button onClick={handleSync} disabled={isPending}>
                  <RefreshCw className={`h-4 w-4 mr-2 ${isPending ? 'animate-spin' : ''}`} />
                  Sync Repos
                </Button>
              ) : undefined
            }
          />
        ) : (
          <>
            {/* Select all */}
            <div className="flex items-center gap-2 px-1">
              <Checkbox
                checked={allSelected}
                onCheckedChange={toggleSelectAll}
                aria-label="Select all"
              />
              <span className="text-sm text-muted-foreground">
                Select all ({filteredTasks.length})
              </span>
              {someSelected && !allSelected && (
                <span className="text-xs text-muted-foreground">
                  ({selectedIds.size} selected)
                </span>
              )}
            </div>

            {/* Grouped task table */}
            {Array.from(groupedTasks.entries()).map(([pid, group]) => (
              <div key={pid} className="space-y-1">
                {groupedTasks.size > 1 && (
                  <h3 className="text-sm font-semibold text-muted-foreground px-1 pt-2">
                    {group.projectName}
                  </h3>
                )}
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-10" />
                      <TableHead className="w-20">Issue</TableHead>
                      <TableHead>Title</TableHead>
                      <TableHead>Repo</TableHead>
                      <TableHead>Labels</TableHead>
                      <TableHead className="w-24">Age</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {group.tasks.map((task) => {
                      const taskLabels = parseLabels(task.githubLabelsJson);
                      return (
                        <TableRow
                          key={task.taskId}
                          className="cursor-pointer"
                          onClick={() => toggleTask(task.taskId)}
                        >
                          <TableCell onClick={(e) => e.stopPropagation()}>
                            <Checkbox
                              checked={selectedIds.has(task.taskId)}
                              onCheckedChange={() => toggleTask(task.taskId)}
                              aria-label={`Select issue #${task.githubIssueNumber}`}
                            />
                          </TableCell>
                          <TableCell className="font-mono text-muted-foreground">
                            #{task.githubIssueNumber}
                          </TableCell>
                          <TableCell className="font-medium">
                            {task.githubTitle}
                          </TableCell>
                          <TableCell className="text-muted-foreground">
                            {task.repoFullName.split('/').pop()}
                          </TableCell>
                          <TableCell>
                            <div className="flex flex-wrap gap-1">
                              {taskLabels.slice(0, 3).map((label) => (
                                <Badge key={label} variant="secondary" className="text-xs">
                                  {label}
                                </Badge>
                              ))}
                              {taskLabels.length > 3 && (
                                <Badge variant="secondary" className="text-xs">
                                  +{taskLabels.length - 3}
                                </Badge>
                              )}
                            </div>
                          </TableCell>
                          <TableCell className="text-muted-foreground text-sm">
                            {timeAgo(task.lastActivityAt)}
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
            ))}
          </>
        )}
      </div>
    </div>
  );
}
