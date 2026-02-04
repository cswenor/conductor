'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import type { Route } from 'next';
import { PageHeader } from '@/components/layout';
import { EmptyState, Badge, Skeleton } from '@/components/ui';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Play } from 'lucide-react';

interface RunSummary {
  runId: string;
  taskId: string;
  projectId: string;
  repoId: string;
  runNumber: number;
  phase: string;
  step: string;
  status: string;
  taskTitle: string;
  repoFullName: string;
  branch: string;
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  result?: string;
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

function timeAgo(dateString: string): string {
  const date = new Date(dateString);
  const now = new Date();
  const seconds = Math.floor((now.getTime() - date.getTime()) / 1000);

  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

export default function RunsPage() {
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function fetchRuns() {
      try {
        const response = await fetch('/api/runs');
        if (!response.ok) {
          throw new Error('Failed to fetch runs');
        }
        const data = await response.json() as { runs: RunSummary[] };
        setRuns(data.runs);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Unknown error');
      } finally {
        setLoading(false);
      }
    }

    void fetchRuns();
  }, []);

  return (
    <div className="flex flex-col h-full">
      <PageHeader
        title="Runs"
        description="Active and recent orchestration runs"
      />
      <div className="flex-1 p-6">
        {loading ? (
          <div className="space-y-4">
            <div className="flex items-center gap-4">
              <Skeleton className="h-8 w-20" />
              <Skeleton className="h-8 w-48" />
              <Skeleton className="h-8 w-32" />
              <Skeleton className="h-8 w-24" />
            </div>
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="flex items-center gap-4">
                <Skeleton className="h-6 w-16" />
                <Skeleton className="h-6 w-40" />
                <Skeleton className="h-6 w-32" />
                <Skeleton className="h-6 w-20" />
                <Skeleton className="h-6 w-16" />
                <Skeleton className="h-6 w-16" />
              </div>
            ))}
          </div>
        ) : error !== null ? (
          <div className="flex items-center justify-center h-64">
            <p className="text-destructive">{error}</p>
          </div>
        ) : runs.length === 0 ? (
          <EmptyState
            icon={<Play className="h-12 w-12 text-muted-foreground" />}
            title="No active runs"
            description="Runs will appear here when you start orchestrating issues from your projects."
          />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Status</TableHead>
                <TableHead>Task</TableHead>
                <TableHead>Repository</TableHead>
                <TableHead>Phase</TableHead>
                <TableHead>Started</TableHead>
                <TableHead>Updated</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {runs.map((run) => (
                <TableRow key={run.runId}>
                  <TableCell>
                    <Link href={`/runs/${run.runId}` as Route} className="hover:underline">
                      <Badge variant={run.status === 'active' ? 'default' : 'secondary'}>
                        {run.status}
                      </Badge>
                    </Link>
                  </TableCell>
                  <TableCell>
                    <Link href={`/runs/${run.runId}` as Route} className="hover:underline font-medium">
                      {run.taskTitle}
                    </Link>
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {run.repoFullName}
                  </TableCell>
                  <TableCell>
                    <Badge variant={phaseBadgeVariant(run.phase)}>
                      {formatPhase(run.phase)}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {timeAgo(run.startedAt)}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {timeAgo(run.updatedAt)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>
    </div>
  );
}
