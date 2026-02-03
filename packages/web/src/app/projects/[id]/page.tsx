'use client';

import { useState, useEffect, use } from 'react';
import Link from 'next/link';
import type { Route } from 'next';
import { PageHeader } from '@/components/layout';
import { Button, EmptyState } from '@/components/ui';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  ArrowLeft,
  Settings,
  GitBranch,
  FolderKanban,
  Play,
  FileText,
  Shield,
  Github,
  Plus,
  Loader2,
} from 'lucide-react';

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

export default function ProjectDetailPage({ params }: PageProps) {
  const { id } = use(params);
  const [project, setProject] = useState<Project | null>(null);
  const [repos, setRepos] = useState<Repo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function fetchProject() {
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
    }

    void fetchProject();
  }, [id]);

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
          <div className="flex items-center gap-2">
            <Link href={'/projects' as Route}>
              <Button variant="outline">
                <ArrowLeft className="h-4 w-4 mr-2" />
                Back
              </Button>
            </Link>
            <Button variant="outline">
              <Settings className="h-4 w-4 mr-2" />
              Settings
            </Button>
          </div>
        }
      />
      <div className="flex-1 p-6">
        <Tabs defaultValue="overview" className="space-y-4">
          <TabsList>
            <TabsTrigger value="overview">
              <FolderKanban className="h-4 w-4 mr-2" />
              Overview
            </TabsTrigger>
            <TabsTrigger value="backlog">
              <FileText className="h-4 w-4 mr-2" />
              Backlog
            </TabsTrigger>
            <TabsTrigger value="repos">
              <GitBranch className="h-4 w-4 mr-2" />
              Repos
            </TabsTrigger>
            <TabsTrigger value="runs">
              <Play className="h-4 w-4 mr-2" />
              Runs
            </TabsTrigger>
            <TabsTrigger value="policies">
              <Shield className="h-4 w-4 mr-2" />
              Policies
            </TabsTrigger>
          </TabsList>

          {/* Overview Tab */}
          <TabsContent value="overview">
            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
              {/* GitHub Connection */}
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="flex items-center gap-2 text-base">
                    <Github className="h-4 w-4" />
                    GitHub Connection
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="space-y-2">
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

              {/* Repositories */}
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="flex items-center gap-2 text-base">
                    <GitBranch className="h-4 w-4" />
                    Repositories
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="text-sm text-muted-foreground">Connected</span>
                      <span className="text-sm font-medium">{repos.length}</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-sm text-muted-foreground">Default Branch</span>
                      <span className="text-sm font-mono">{project.defaultBaseBranch}</span>
                    </div>
                  </div>
                </CardContent>
              </Card>

              {/* Configuration */}
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="flex items-center gap-2 text-base">
                    <Settings className="h-4 w-4" />
                    Configuration
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="space-y-2">
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
            </div>
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

          {/* Runs Tab */}
          <TabsContent value="runs">
            <Card>
              <CardHeader>
                <CardTitle>Runs</CardTitle>
                <CardDescription>
                  Active and recent orchestration runs for this project.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <EmptyState
                  icon={<Play className="h-12 w-12 text-muted-foreground" />}
                  title="No runs yet"
                  description="Start a run from the backlog to see it here."
                />
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
        </Tabs>
      </div>
    </div>
  );
}
