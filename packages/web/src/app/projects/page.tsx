'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import type { Route } from 'next';
import { PageHeader } from '@/components/layout';
import { EmptyState, Button } from '@/components/ui';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { FolderKanban, Plus, GitBranch, Play, Settings, ExternalLink, CheckCircle2 } from 'lucide-react';
import type { ProjectHealth } from '@conductor/shared';

interface ProjectSummary {
  projectId: string;
  name: string;
  githubOrgName: string;
  repoCount: number;
  activeRunCount: number;
  health: ProjectHealth;
  createdAt: string;
  updatedAt: string;
}

interface InstallationInfo {
  installationId: number;
  accountLogin: string;
  accountType: 'User' | 'Organization';
  isPending: boolean;
}

interface InstallationsResponse {
  installations: InstallationInfo[];
  githubConfigured: boolean;
}

type OnboardingState = 'loading' | 'no-github-app' | 'no-installations' | 'has-installations';

const HEALTH_CONFIG: Record<ProjectHealth, { label: string; dotClass: string; variant: 'default' | 'secondary' | 'destructive' | 'warning' }> = {
  healthy:         { label: 'Healthy',         dotClass: 'bg-green-500', variant: 'default' },
  needs_attention: { label: 'Needs Attention', dotClass: 'bg-yellow-500', variant: 'warning' },
  blocked:         { label: 'Blocked',         dotClass: 'bg-red-500', variant: 'destructive' },
};

function HealthIndicator({ health }: { health: ProjectHealth }) {
  const config = HEALTH_CONFIG[health];
  return (
    <div className="flex items-center gap-1.5">
      <span className={`inline-block h-2 w-2 rounded-full ${config.dotClass}`} />
      <span className="text-xs text-muted-foreground">{config.label}</span>
    </div>
  );
}

function OnboardingGuide() {
  const [state, setState] = useState<OnboardingState>('loading');
  const [installations, setInstallations] = useState<InstallationInfo[]>([]);

  useEffect(() => {
    async function checkInstallations() {
      try {
        const response = await fetch('/api/github/installations');
        if (!response.ok) {
          setState('no-github-app');
          return;
        }
        const data = await response.json() as InstallationsResponse;
        if (!data.githubConfigured) {
          setState('no-github-app');
        } else if (data.installations.length === 0) {
          setState('no-installations');
        } else {
          setInstallations(data.installations);
          setState('has-installations');
        }
      } catch {
        setState('no-github-app');
      }
    }

    void checkInstallations();
  }, []);

  if (state === 'loading') {
    return (
      <EmptyState
        icon={<FolderKanban className="h-12 w-12 text-muted-foreground" />}
        title="Checking setup..."
        description="Verifying your GitHub connection."
      />
    );
  }

  if (state === 'no-github-app') {
    return (
      <div className="flex flex-col items-center justify-center h-64 max-w-lg mx-auto space-y-4">
        <Settings className="h-12 w-12 text-muted-foreground" />
        <h2 className="text-xl font-semibold">Configure GitHub App</h2>
        <p className="text-muted-foreground text-center">
          Conductor requires a GitHub App to manage repositories. Please configure your GitHub App credentials in your environment settings.
        </p>
        <Alert>
          <AlertDescription>
            Set <code className="font-mono text-sm">GITHUB_APP_ID</code>, <code className="font-mono text-sm">GITHUB_PRIVATE_KEY</code>, and <code className="font-mono text-sm">GITHUB_WEBHOOK_SECRET</code> in your environment.
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  if (state === 'no-installations') {
    return (
      <div className="flex flex-col items-center justify-center h-64 max-w-lg mx-auto space-y-6">
        <FolderKanban className="h-12 w-12 text-muted-foreground" />
        <div className="text-center space-y-2">
          <h2 className="text-xl font-semibold">Get Started with Conductor</h2>
          <p className="text-muted-foreground">
            Connect a GitHub organization to start orchestrating AI agents on your repositories.
          </p>
        </div>
        <div className="w-full space-y-3">
          <div className="flex items-start gap-3 text-sm">
            <Badge variant="outline" className="mt-0.5 shrink-0">1</Badge>
            <div>
              <span className="font-medium">Sign in with GitHub</span>
              <span className="text-muted-foreground ml-1">— Done!</span>
            </div>
          </div>
          <div className="flex items-start gap-3 text-sm">
            <Badge variant="default" className="mt-0.5 shrink-0">2</Badge>
            <div>
              <span className="font-medium">Install the GitHub App</span>
              <span className="text-muted-foreground ml-1">— Connect an organization or account</span>
            </div>
          </div>
          <div className="flex items-start gap-3 text-sm text-muted-foreground">
            <Badge variant="outline" className="mt-0.5 shrink-0">3</Badge>
            <span>Create your first project</span>
          </div>
        </div>
        <a href="/api/github/install">
          <Button size="lg">
            <ExternalLink className="h-4 w-4 mr-2" />
            Connect GitHub Organization
          </Button>
        </a>
      </div>
    );
  }

  // has-installations
  return (
    <div className="flex flex-col items-center justify-center h-64 max-w-lg mx-auto space-y-6">
      <CheckCircle2 className="h-12 w-12 text-green-500" />
      <div className="text-center space-y-2">
        <h2 className="text-xl font-semibold">Almost there!</h2>
        <p className="text-muted-foreground">
          {installations.length === 1
            ? `GitHub App installed on ${installations[0]?.accountLogin ?? 'your account'}. Create a project to get started.`
            : `GitHub App installed on ${installations.length} accounts. Create a project to get started.`
          }
        </p>
      </div>
      <Link href={'/projects/new' as Route}>
        <Button size="lg">
          <Plus className="h-4 w-4 mr-2" />
          Create Your First Project
        </Button>
      </Link>
    </div>
  );
}

export default function ProjectsPage() {
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function fetchProjects() {
      try {
        const response = await fetch('/api/projects');
        if (!response.ok) {
          throw new Error('Failed to fetch projects');
        }
        const data = await response.json() as { projects: ProjectSummary[] };
        setProjects(data.projects);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Unknown error');
      } finally {
        setLoading(false);
      }
    }

    void fetchProjects();
  }, []);

  return (
    <div className="flex flex-col h-full">
      <PageHeader
        title="Projects"
        description="Manage your orchestration projects"
        action={
          <Link href={'/projects/new' as Route}>
            <Button>
              <Plus className="h-4 w-4 mr-2" />
              New Project
            </Button>
          </Link>
        }
      />
      <div className="flex-1 p-6">
        {loading ? (
          <div className="flex items-center justify-center h-64">
            <p className="text-muted-foreground">Loading projects...</p>
          </div>
        ) : error !== null ? (
          <div className="flex items-center justify-center h-64">
            <p className="text-destructive">{error}</p>
          </div>
        ) : projects.length === 0 ? (
          <OnboardingGuide />
        ) : (
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {projects.map((project) => (
              <Link
                key={project.projectId}
                href={`/projects/${project.projectId}` as Route}
              >
                <Card className="hover:border-primary transition-colors cursor-pointer">
                  <CardHeader className="pb-2">
                    <CardTitle className="flex items-center justify-between">
                      <span className="truncate">{project.name}</span>
                      {project.activeRunCount > 0 && (
                        <Badge variant="default">
                          {project.activeRunCount} active
                        </Badge>
                      )}
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-4 text-sm text-muted-foreground">
                        <div className="flex items-center gap-1">
                          <GitBranch className="h-4 w-4" />
                          <span>{project.githubOrgName}</span>
                        </div>
                        <div className="flex items-center gap-1">
                          <FolderKanban className="h-4 w-4" />
                          <span>{project.repoCount} repos</span>
                        </div>
                        {project.activeRunCount > 0 && (
                          <div className="flex items-center gap-1">
                            <Play className="h-4 w-4" />
                            <span>{project.activeRunCount} runs</span>
                          </div>
                        )}
                      </div>
                      <HealthIndicator health={project.health} />
                    </div>
                  </CardContent>
                </Card>
              </Link>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
