'use client';

import { useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { Route } from 'next';
import { PageHeader } from '@/components/layout';
import { Button, EmptyState } from '@/components/ui';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import {
  ArrowLeft,
  GitBranch,
  FolderKanban,
  Play,
  FileText,
  Shield,
  Github,
  Plus,
  Settings,
  Workflow,
  Trash2,
  Rocket,
  RefreshCw,
  AlertTriangle,
  Info,
} from 'lucide-react';
import { ProjectWorkTab } from '@/components/projects/project-work-tab';
import { ProjectWorkflowTab } from '@/components/projects/project-workflow-tab';
import { ProjectOverviewTab } from '@/components/projects/project-overview-tab';
import { useLiveRefresh } from '@/hooks/use-live-refresh';
import { deleteProject } from '@/lib/actions/project-actions';
import { timeAgo } from '@/lib/phase-config';
import type { Project, Repo, StartableTask } from '@conductor/shared';
import type { RunSummary } from '@/lib/types';
import type { WorkTab } from '@/lib/phase-config';
import type { ProjectOverviewData } from '@/lib/data/project-overview';

interface BacklogData {
  tasks: StartableTask[];
  lastSyncedAt?: string;
  syncErrors?: string[];
  githubNotConfigured: boolean;
  truncatedRepos?: string[];
}

function SettingsTab({ project }: { project: Project }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [confirmName, setConfirmName] = useState('');

  function handleDelete() {
    startTransition(async () => {
      const result = await deleteProject(project.projectId);
      if (result.success) {
        router.push('/projects' as Route);
      } else {
        setDeleteError(result.error ?? 'Failed to delete project');
      }
    });
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Github className="h-4 w-4" />
            GitHub Connection
          </CardTitle>
          <CardDescription>
            GitHub App installation linked to this project.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">Organization</span>
              <span className="text-sm font-medium">{project.githubOrgName}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">Installation ID</span>
              <span className="text-sm font-mono">{project.githubInstallationId}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">Status</span>
              <Badge variant="default">Connected</Badge>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Settings className="h-4 w-4" />
            Configuration
          </CardTitle>
          <CardDescription>
            Project settings and defaults.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">Default Base Branch</span>
              <span className="text-sm font-mono">{project.defaultBaseBranch}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">Port Range</span>
              <span className="text-sm font-mono">
                {project.portRangeStart}-{project.portRangeEnd}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">Enforce Projects</span>
              <Badge variant={project.enforceProjects ? 'default' : 'secondary'}>
                {project.enforceProjects ? 'Yes' : 'No'}
              </Badge>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card className="border-destructive/50">
        <CardHeader>
          <CardTitle className="text-base text-destructive">Danger Zone</CardTitle>
          <CardDescription>
            Irreversible actions that affect this project.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium">Delete this project</p>
              <p className="text-sm text-muted-foreground">
                Permanently remove this project and all associated data.
              </p>
            </div>
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button variant="destructive" size="sm">
                  <Trash2 className="h-4 w-4 mr-1" />
                  Delete Project
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Delete project?</AlertDialogTitle>
                  <AlertDialogDescription>
                    This will permanently delete <strong>{project.name}</strong> and all its runs, tasks, and configuration. This action cannot be undone.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <div className="space-y-2 py-2">
                  <Label htmlFor="confirm-name" className="text-sm">
                    Type <strong>{project.name}</strong> to confirm:
                  </Label>
                  <Input
                    id="confirm-name"
                    value={confirmName}
                    onChange={(e) => setConfirmName(e.target.value)}
                    placeholder={project.name}
                  />
                </div>
                {deleteError !== null && (
                  <p className="text-sm text-destructive">{deleteError}</p>
                )}
                <AlertDialogFooter>
                  <AlertDialogCancel onClick={() => setConfirmName('')}>Cancel</AlertDialogCancel>
                  <AlertDialogAction
                    disabled={confirmName !== project.name || isPending}
                    onClick={(e) => {
                      e.preventDefault();
                      handleDelete();
                    }}
                    className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                  >
                    {isPending ? 'Deleting...' : 'Delete Project'}
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function BacklogTab({ data, projectId }: { data: BacklogData; projectId: string }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  useLiveRefresh({
    filter: (e) => e.projectId === projectId && e.kind === 'project.updated',
    debounceMs: 2000,
  });

  function handleRefresh() {
    startTransition(() => {
      router.refresh();
    });
  }

  function parseLabels(json: string): string[] {
    try {
      return JSON.parse(json) as string[];
    } catch {
      return [];
    }
  }

  const { tasks, lastSyncedAt, syncErrors, githubNotConfigured, truncatedRepos } = data;

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <div>
          <CardTitle>Backlog</CardTitle>
          <CardDescription>
            Open issues that can be turned into runs.
            {lastSyncedAt !== undefined && (
              <span className="ml-2 text-xs">Synced {timeAgo(lastSyncedAt)}</span>
            )}
          </CardDescription>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={handleRefresh} disabled={isPending}>
            <RefreshCw className={`h-4 w-4 mr-1 ${isPending ? 'animate-spin' : ''}`} />
            Refresh
          </Button>
          <Link href={`/start?projectId=${projectId}` as Route}>
            <Button size="sm">
              <Rocket className="h-4 w-4 mr-1" />
              Open in Start Work
            </Button>
          </Link>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* GitHub not configured */}
        {githubNotConfigured && (
          <Alert>
            <Github className="h-4 w-4" />
            <AlertDescription>
              Connect a GitHub App to automatically sync issues.
            </AlertDescription>
          </Alert>
        )}

        {/* Sync errors */}
        {syncErrors && syncErrors.length > 0 && (
          <Alert variant="warning">
            <AlertTriangle className="h-4 w-4" />
            <AlertDescription>
              Could not refresh {syncErrors.length} repo(s) — showing cached data.
            </AlertDescription>
          </Alert>
        )}

        {/* Truncation warning */}
        {truncatedRepos && truncatedRepos.length > 0 && (
          <Alert>
            <Info className="h-4 w-4" />
            <AlertDescription>
              Some repos have more than 500 open issues. Only the 500 most recently updated are shown.
            </AlertDescription>
          </Alert>
        )}

        {tasks.length === 0 ? (
          <EmptyState
            icon={<FileText className="h-12 w-12 text-muted-foreground" />}
            title="No issues yet"
            description={
              githubNotConfigured
                ? 'Configure your GitHub App to sync issues.'
                : 'Issues will appear here automatically when your repos are synced.'
            }
          />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-20">Issue</TableHead>
                <TableHead>Title</TableHead>
                <TableHead>Repo</TableHead>
                <TableHead>Labels</TableHead>
                <TableHead className="w-24">Age</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {tasks.map((task) => {
                const taskLabels = parseLabels(task.githubLabelsJson);
                return (
                  <TableRow key={task.taskId}>
                    <TableCell className="font-mono text-muted-foreground">
                      #{task.githubIssueNumber}
                    </TableCell>
                    <TableCell className="font-medium">{task.githubTitle}</TableCell>
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
        )}
      </CardContent>
    </Card>
  );
}

export function ProjectDetailContent({
  project,
  repos,
  defaultTab,
  overviewData,
  workRuns,
  workCounts,
  workTab,
  backlogData,
}: {
  project: Project;
  repos: Repo[];
  defaultTab: string;
  overviewData: ProjectOverviewData;
  workRuns: RunSummary[];
  workCounts: Record<WorkTab, number>;
  workTab: WorkTab;
  backlogData: BacklogData;
}) {
  return (
    <div className="flex flex-col h-full">
      <PageHeader
        title={project.name}
        description={`GitHub: ${project.githubOrgName}`}
        action={
          <Link href={'/projects' as Route}>
            <Button variant="outline">
              <ArrowLeft className="h-4 w-4 mr-2" />
              Back
            </Button>
          </Link>
        }
      />
      <div className="flex-1 p-6">
        <Tabs defaultValue={defaultTab} className="space-y-4">
          <TabsList>
            <TabsTrigger value="overview">
              <FolderKanban className="h-4 w-4 mr-2" />
              Overview
            </TabsTrigger>
            <TabsTrigger value="backlog">
              <FileText className="h-4 w-4 mr-2" />
              Backlog
              {backlogData.tasks.length > 0 && (
                <Badge variant="secondary" className="ml-2 h-5 px-1.5 text-xs">
                  {backlogData.tasks.length}
                </Badge>
              )}
            </TabsTrigger>
            <TabsTrigger value="work">
              <Play className="h-4 w-4 mr-2" />
              Work
            </TabsTrigger>
            <TabsTrigger value="workflow">
              <Workflow className="h-4 w-4 mr-2" />
              Workflow
            </TabsTrigger>
            <TabsTrigger value="repos">
              <GitBranch className="h-4 w-4 mr-2" />
              Repos
            </TabsTrigger>
            <TabsTrigger value="policies">
              <Shield className="h-4 w-4 mr-2" />
              Policies
            </TabsTrigger>
            <TabsTrigger value="settings">
              <Settings className="h-4 w-4 mr-2" />
              Settings
            </TabsTrigger>
          </TabsList>

          <TabsContent value="overview">
            <ProjectOverviewTab data={overviewData} projectId={project.projectId} />
          </TabsContent>

          <TabsContent value="backlog">
            <BacklogTab data={backlogData} projectId={project.projectId} />
          </TabsContent>

          <TabsContent value="work">
            <ProjectWorkTab
              runs={workRuns}
              counts={workCounts}
              initialTab={workTab}
              projectId={project.projectId}
            />
          </TabsContent>

          <TabsContent value="workflow">
            <ProjectWorkflowTab />
          </TabsContent>

          <TabsContent value="repos">
            <Card>
              <CardHeader className="flex flex-row items-center justify-between">
                <div>
                  <CardTitle>Repositories</CardTitle>
                  <CardDescription>
                    Repositories connected to this project.
                  </CardDescription>
                </div>
                <Link href={`/projects/${project.projectId}/repos/add` as Route}>
                  <Button>
                    <Plus className="h-4 w-4 mr-2" />
                    Add Repository
                  </Button>
                </Link>
              </CardHeader>
              <CardContent>
                {repos.length === 0 ? (
                  <EmptyState
                    icon={<GitBranch className="h-12 w-12 text-muted-foreground" />}
                    title="No repositories"
                    description="Add repositories from your GitHub organization to start orchestrating."
                    action={
                      <Link href={`/projects/${project.projectId}/repos/add` as Route}>
                        <Button>
                          <Plus className="h-4 w-4 mr-2" />
                          Add Repository
                        </Button>
                      </Link>
                    }
                  />
                ) : (
                  <div className="space-y-2">
                    {repos.map((repo) => (
                      <Link
                        key={repo.repoId}
                        href={`/projects/${project.projectId}/repos/${repo.repoId}` as Route}
                        className="flex items-center justify-between p-4 rounded-lg border hover:bg-muted/50 transition-colors"
                      >
                        <div className="flex items-center gap-3">
                          <GitBranch className="h-5 w-5 text-muted-foreground" />
                          <div>
                            <div className="font-medium">{repo.githubFullName}</div>
                            <div className="text-sm text-muted-foreground">
                              Default branch: {repo.githubDefaultBranch}
                            </div>
                          </div>
                        </div>
                        <Badge
                          variant={repo.status === 'active' ? 'default' : 'secondary'}
                        >
                          {repo.status}
                        </Badge>
                      </Link>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="policies">
            <Card>
              <CardHeader>
                <CardTitle>Policies</CardTitle>
                <CardDescription>
                  Policy configuration for this project.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <EmptyState
                  icon={<Shield className="h-12 w-12 text-muted-foreground" />}
                  title="Default policies"
                  description="This project is using default policy settings."
                />
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="settings">
            <SettingsTab project={project} />
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}
