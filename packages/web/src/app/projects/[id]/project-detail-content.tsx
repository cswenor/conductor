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
} from 'lucide-react';
import { ProjectWorkTab } from '@/components/projects/project-work-tab';
import { ProjectWorkflowTab } from '@/components/projects/project-workflow-tab';
import { ProjectOverviewTab } from '@/components/projects/project-overview-tab';
import { deleteProject } from '@/lib/actions/project-actions';
import type { Project, Repo } from '@conductor/shared';

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

export function ProjectDetailContent({
  project,
  repos,
  defaultTab,
}: {
  project: Project;
  repos: Repo[];
  defaultTab: string;
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
            <ProjectOverviewTab projectId={project.projectId} />
          </TabsContent>

          <TabsContent value="backlog">
            <Card>
              <CardHeader>
                <CardTitle>Backlog</CardTitle>
                <CardDescription>
                  Issues from connected repositories that can be turned into runs.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <EmptyState
                  icon={<FileText className="h-12 w-12 text-muted-foreground" />}
                  title="No issues yet"
                  description="Connect repositories to see their issues here."
                />
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="work">
            <ProjectWorkTab projectId={project.projectId} />
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
