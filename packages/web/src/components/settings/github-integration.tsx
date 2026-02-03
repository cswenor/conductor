'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import type { Route } from 'next';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { Github, Building, User, Plus, ExternalLink, AlertCircle } from 'lucide-react';

interface GitHubStatus {
  configured: boolean;
  appId?: string;
  appSlug?: string;
}

interface Installation {
  installationId: number;
  accountLogin: string;
  accountId: number;
  accountNodeId: string;
  accountType: 'User' | 'Organization';
  isPending: boolean;
}

interface InstallationsResponse {
  installations: Installation[];
  githubConfigured: boolean;
}

interface Project {
  projectId: string;
  name: string;
  githubOrgName: string;
  githubInstallationId: number;
}

interface ProjectsResponse {
  projects: Project[];
}

export function GitHubIntegration() {
  const [status, setStatus] = useState<GitHubStatus | null>(null);
  const [installations, setInstallations] = useState<Installation[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function fetchData() {
      try {
        // Fetch status and installations in parallel
        const [statusRes, installationsRes, projectsRes] = await Promise.all([
          fetch('/api/github/status'),
          fetch('/api/github/installations'),
          fetch('/api/projects'),
        ]);

        if (!statusRes.ok) {
          throw new Error('Failed to fetch GitHub status');
        }

        const statusData = await statusRes.json() as GitHubStatus;
        setStatus(statusData);

        if (installationsRes.ok) {
          const installationsData = await installationsRes.json() as InstallationsResponse;
          setInstallations(installationsData.installations);
        }

        if (projectsRes.ok) {
          const projectsData = await projectsRes.json() as ProjectsResponse;
          setProjects(projectsData.projects);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Unknown error');
      } finally {
        setLoading(false);
      }
    }

    void fetchData();
  }, []);

  const handleInstall = () => {
    window.location.href = '/api/github/install';
  };

  // Get connected installation IDs from projects
  const connectedInstallationIds = new Set(projects.map((p) => p.githubInstallationId));

  // Separate pending installations (not yet linked to a project)
  const pendingInstallations = installations.filter(
    (i) => i.isPending && !connectedInstallationIds.has(i.installationId)
  );

  // Get active installations (linked to projects)
  const activeInstallations = projects.map((p) => ({
    projectId: p.projectId,
    projectName: p.name,
    installationId: p.githubInstallationId,
    accountLogin: p.githubOrgName,
  }));

  if (loading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Github className="h-5 w-5" />
            GitHub Integration
          </CardTitle>
          <CardDescription>
            Connect your GitHub App to enable webhook delivery and API access.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Skeleton className="h-8 w-32" />
          <Skeleton className="h-24 w-full" />
        </CardContent>
      </Card>
    );
  }

  if (error !== null) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Github className="h-5 w-5" />
            GitHub Integration
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center gap-2 text-destructive">
            <AlertCircle className="h-4 w-4" />
            <p className="text-sm">{error}</p>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Github className="h-5 w-5" />
          GitHub Integration
          {status?.configured === true ? (
            <Badge variant="success">Configured</Badge>
          ) : (
            <Badge variant="secondary">Not Configured</Badge>
          )}
        </CardTitle>
        <CardDescription>
          Connect your GitHub App to enable webhook delivery and API access.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {status?.configured === true ? (
          <>
            {/* App Configuration */}
            <div className="space-y-3">
              <h4 className="text-sm font-medium">App Configuration</h4>
              <div className="grid grid-cols-2 gap-4 text-sm">
                <div>
                  <span className="text-muted-foreground">App ID:</span>
                  <span className="ml-2 font-mono">{status.appId}</span>
                </div>
                <div>
                  <span className="text-muted-foreground">App Slug:</span>
                  <span className="ml-2 font-mono">{status.appSlug}</span>
                </div>
              </div>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" onClick={handleInstall}>
                  <Plus className="h-4 w-4 mr-2" />
                  Install on Another Org
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => window.open(`https://github.com/apps/${status.appSlug}`, '_blank')}
                >
                  <ExternalLink className="h-4 w-4 mr-2" />
                  View on GitHub
                </Button>
              </div>
            </div>

            {/* Connected Installations */}
            {activeInstallations.length > 0 && (
              <>
                <Separator />
                <div className="space-y-3">
                  <h4 className="text-sm font-medium">Connected Organizations</h4>
                  <div className="space-y-2">
                    {activeInstallations.map((inst) => (
                      <div
                        key={inst.installationId}
                        className="flex items-center justify-between p-3 rounded-lg border bg-card"
                      >
                        <div className="flex items-center gap-3">
                          <Building className="h-4 w-4 text-muted-foreground" />
                          <div>
                            <div className="font-medium">{inst.accountLogin}</div>
                            <div className="text-xs text-muted-foreground">
                              Project: {inst.projectName}
                            </div>
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          <Badge variant="default">Active</Badge>
                          <Link href={`/projects/${inst.projectId}` as Route}>
                            <Button variant="ghost" size="sm">
                              View Project
                            </Button>
                          </Link>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </>
            )}

            {/* Pending Installations */}
            {pendingInstallations.length > 0 && (
              <>
                <Separator />
                <div className="space-y-3">
                  <h4 className="text-sm font-medium">Pending Installations</h4>
                  <p className="text-sm text-muted-foreground">
                    These installations are awaiting project creation.
                  </p>
                  <div className="space-y-2">
                    {pendingInstallations.map((inst) => (
                      <div
                        key={inst.installationId}
                        className="flex items-center justify-between p-3 rounded-lg border bg-card"
                      >
                        <div className="flex items-center gap-3">
                          {inst.accountType === 'Organization' ? (
                            <Building className="h-4 w-4 text-muted-foreground" />
                          ) : (
                            <User className="h-4 w-4 text-muted-foreground" />
                          )}
                          <div>
                            <div className="font-medium">{inst.accountLogin}</div>
                            <div className="text-xs text-muted-foreground">
                              Installation ID: {inst.installationId}
                            </div>
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          <Badge variant="warning">Pending</Badge>
                          <Link href={`/projects/new?installation_id=${inst.installationId}` as Route}>
                            <Button size="sm">
                              <Plus className="h-4 w-4 mr-2" />
                              Create Project
                            </Button>
                          </Link>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </>
            )}

            {/* No installations */}
            {activeInstallations.length === 0 && pendingInstallations.length === 0 && (
              <>
                <Separator />
                <div className="text-center py-4">
                  <p className="text-sm text-muted-foreground">
                    No organizations connected yet.
                  </p>
                  <Button variant="outline" size="sm" onClick={handleInstall} className="mt-2">
                    <Plus className="h-4 w-4 mr-2" />
                    Install GitHub App
                  </Button>
                </div>
              </>
            )}
          </>
        ) : (
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              GitHub App credentials are not configured. Set the following environment variables:
            </p>
            <ul className="text-sm text-muted-foreground list-disc list-inside space-y-1">
              <li><code className="text-xs bg-muted px-1 py-0.5 rounded">GITHUB_APP_ID</code></li>
              <li><code className="text-xs bg-muted px-1 py-0.5 rounded">GITHUB_APP_SLUG</code></li>
              <li><code className="text-xs bg-muted px-1 py-0.5 rounded">GITHUB_PRIVATE_KEY</code></li>
              <li><code className="text-xs bg-muted px-1 py-0.5 rounded">GITHUB_WEBHOOK_SECRET</code></li>
            </ul>
            <p className="text-sm text-muted-foreground">
              See the GitHub App Setup Guide for instructions.
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
