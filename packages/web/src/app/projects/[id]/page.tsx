'use client';

import { useState, useEffect, useCallback, use } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
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
  Loader2,
  Settings,
  Workflow,
  Trash2,
} from 'lucide-react';
import { ProjectWorkTab } from '@/components/projects/project-work-tab';
import { ProjectWorkflowTab } from '@/components/projects/project-workflow-tab';
import { ProjectOverviewTab } from '@/components/projects/project-overview-tab';

interface Project {
  projectId: string;
  name: string;
  githubOrgId: number;
  githubOrgNodeId: string;
  githubOrgName: string;
  githubInstallationId: number;
  githubProjectsV2Id?: string;
  defaultProfileId: string;
  defaultBaseBranch: string;
  enforceProjects: boolean;
  portRangeStart: number;
  portRangeEnd: number;
  createdAt: string;
  updatedAt: string;
}

interface Repo {
  repoId: string;
  githubFullName: string;
  githubDefaultBranch: string;
  status: string;
}

interface PageProps {
  params: Promise<{ id: string }>;
}

function SettingsTab({ project, projectId }: { project: Project; projectId: string }) {
  const router = useRouter();
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [confirmName, setConfirmName] = useState('');

  async function handleDelete() {
    setDeleting(true);
    setDeleteError(null);
    try {
      const response = await fetch(`/api/projects/${projectId}`, {
        method: 'DELETE',
      });
      if (!response.ok) {
        const data = await response.json() as { error?: string };
        throw new Error(data.error ?? 'Failed to delete project');
      }
      router.push('/projects' as Route);
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : 'Unknown error');
      setDeleting(false);
    }
  }

  return (
    <div className="space-y-6">
      {/* GitHub Connection */}
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

      {/* Configuration */}
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

      {/* Danger Zone */}
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
                    disabled={confirmName !== project.name || deleting}
                    onClick={(e) => {
                      e.preventDefault();
                      void handleDelete();
                    }}
                    className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                  >
                    {deleting ? 'Deleting...' : 'Delete Project'}
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

export default function ProjectDetailPage({ params }: PageProps) {
  const { id } = use(params);
  const searchParams = useSearchParams();
  const defaultTab = searchParams.get('tab') ?? 'overview';
  const [project, setProject] = useState<Project | null>(null);
  const [repos, setRepos] = useState<Repo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchProject = useCallback(async () => {
    try {
      const response = await fetch(`/api/projects/${id}`);
      if (!response.ok) {
        if (response.status === 404) {
          throw new Error('Project not found');
        }
        throw new Error('Failed to fetch project');
      }
      const data = await response.json() as { project: Project };
      setProject(data.project);

      // Fetch repos for this project
      const reposResponse = await fetch(`/api/projects/${id}/repos`);
      if (reposResponse.ok) {
        const reposData = await reposResponse.json() as { repos: Repo[] };
        setRepos(reposData.repos);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void fetchProject();
  }, [fetchProject]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error !== null || project === null) {
    return (
      <div className="flex flex-col h-full">
        <PageHeader
          title="Project"
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
          <EmptyState
            icon={<FolderKanban className="h-12 w-12 text-destructive" />}
            title="Error"
            description={error ?? 'Project not found'}
            action={
              <Link href={'/projects' as Route}>
                <Button variant="outline">Back to Projects</Button>
              </Link>
            }
          />
        </div>
      </div>
    );
  }

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

          {/* Overview Tab */}
          <TabsContent value="overview">
            <ProjectOverviewTab projectId={id} />
          </TabsContent>

          {/* Backlog Tab */}
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

          {/* Work Tab */}
          <TabsContent value="work">
            <ProjectWorkTab projectId={id} />
          </TabsContent>

          {/* Workflow Tab */}
          <TabsContent value="workflow">
            <ProjectWorkflowTab />
          </TabsContent>

          {/* Repos Tab */}
          <TabsContent value="repos">
            <Card>
              <CardHeader className="flex flex-row items-center justify-between">
                <div>
                  <CardTitle>Repositories</CardTitle>
                  <CardDescription>
                    Repositories connected to this project.
                  </CardDescription>
                </div>
                <Link href={`/projects/${id}/repos/add` as Route}>
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
                      <Link href={`/projects/${id}/repos/add` as Route}>
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
                        href={`/projects/${id}/repos/${repo.repoId}` as Route}
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

          {/* Policies Tab */}
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

          {/* Settings Tab */}
          <TabsContent value="settings">
            <SettingsTab project={project} projectId={id} />
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}
