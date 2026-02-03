'use client';

import { useState, useEffect } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import type { Route } from 'next';
import { PageHeader } from '@/components/layout';
import { Button } from '@/components/ui';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { ArrowLeft, Github, Building2, Loader2 } from 'lucide-react';

interface InstallationInfo {
  installationId: number;
  accountLogin: string;
  accountId: number;
  accountNodeId: string;
  accountType: 'User' | 'Organization';
  isPending: boolean;
}

export default function NewProjectPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const installationIdFromUrl = searchParams.get('installation_id');
  const [name, setName] = useState('');
  const [installations, setInstallations] = useState<InstallationInfo[]>([]);
  const [selectedInstallation, setSelectedInstallation] = useState<InstallationInfo | null>(null);
  const [githubConfigured, setGithubConfigured] = useState(false);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function fetchInstallations() {
      try {
        const response = await fetch('/api/github/installations');
        if (!response.ok) {
          throw new Error('Failed to fetch installations');
        }
        const data = await response.json() as {
          installations: InstallationInfo[];
          githubConfigured: boolean;
        };
        setInstallations(data.installations);
        setGithubConfigured(data.githubConfigured);

        // Auto-select installation from URL param if provided
        let autoSelected = false;
        if (installationIdFromUrl !== null) {
          const installationId = parseInt(installationIdFromUrl, 10);
          const matchingInstallation = data.installations.find(
            (i) => i.installationId === installationId
          );
          if (matchingInstallation !== undefined) {
            setSelectedInstallation(matchingInstallation);
            autoSelected = true;
          }
        }
        // Fallback: auto-select if only one installation (including when URL param was invalid)
        if (!autoSelected && data.installations.length === 1 && data.installations[0] !== undefined) {
          setSelectedInstallation(data.installations[0]);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Unknown error');
      } finally {
        setLoading(false);
      }
    }

    void fetchInstallations();
  }, [installationIdFromUrl]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (selectedInstallation === null) {
      setError('Please select a GitHub organization');
      return;
    }

    if (name.trim() === '') {
      setError('Please enter a project name');
      return;
    }

    setCreating(true);
    setError(null);

    try {
      const response = await fetch('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          githubInstallationId: selectedInstallation.installationId,
          githubOrgId: selectedInstallation.accountId,
          githubOrgNodeId: selectedInstallation.accountNodeId,
          githubOrgName: selectedInstallation.accountLogin,
        }),
      });

      if (!response.ok) {
        const data = await response.json() as { error?: string };
        throw new Error(data.error ?? 'Failed to create project');
      }

      const data = await response.json() as { project: { projectId: string } };
      router.push(`/projects/${data.project.projectId}` as Route);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
      setCreating(false);
    }
  };

  return (
    <div className="flex flex-col h-full">
      <PageHeader
        title="New Project"
        description="Create a new orchestration project"
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
        <div className="max-w-2xl mx-auto">
          <form onSubmit={(e) => { void handleSubmit(e); }}>
            <div className="space-y-6">
              {/* Project Name */}
              <Card>
                <CardHeader>
                  <CardTitle>Project Details</CardTitle>
                  <CardDescription>
                    Give your project a name to identify it.
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="space-y-2">
                    <label htmlFor="name" className="text-sm font-medium">
                      Project Name
                    </label>
                    <Input
                      id="name"
                      placeholder="My Project"
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      disabled={creating}
                    />
                  </div>
                </CardContent>
              </Card>

              {/* GitHub Organization */}
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <Github className="h-5 w-5" />
                    GitHub Organization
                  </CardTitle>
                  <CardDescription>
                    Select the GitHub organization to connect to this project.
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  {loading ? (
                    <div className="flex items-center justify-center py-8">
                      <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                    </div>
                  ) : !githubConfigured ? (
                    <div className="text-center py-8">
                      <p className="text-muted-foreground mb-4">
                        GitHub App is not configured. Please configure it in Settings first.
                      </p>
                      <Link href={'/settings' as Route}>
                        <Button variant="outline">Go to Settings</Button>
                      </Link>
                    </div>
                  ) : installations.length === 0 ? (
                    <div className="text-center py-8">
                      <p className="text-muted-foreground mb-4">
                        No GitHub organizations connected. Install the GitHub App on your organization.
                      </p>
                      <Link href={'/api/github/install' as Route}>
                        <Button>
                          <Github className="h-4 w-4 mr-2" />
                          Install GitHub App
                        </Button>
                      </Link>
                    </div>
                  ) : (
                    <div className="space-y-2">
                      {installations.map((install) => (
                        <button
                          key={install.installationId}
                          type="button"
                          onClick={() => setSelectedInstallation(install)}
                          disabled={creating}
                          className={`w-full flex items-center gap-3 p-4 rounded-lg border transition-colors ${
                            selectedInstallation?.installationId === install.installationId
                              ? 'border-primary bg-primary/5'
                              : 'border-border hover:border-primary/50'
                          } ${creating ? 'opacity-50 cursor-not-allowed' : ''}`}
                        >
                          <Building2 className="h-8 w-8 text-muted-foreground" />
                          <div className="flex-1 text-left">
                            <div className="font-medium">{install.accountLogin}</div>
                            <div className="text-sm text-muted-foreground">
                              {install.accountType}
                            </div>
                          </div>
                          {install.isPending && (
                            <Badge variant="secondary">New</Badge>
                          )}
                        </button>
                      ))}
                    </div>
                  )}
                </CardContent>
              </Card>

              {/* Error message */}
              {error !== null && (
                <div className="text-sm text-destructive">{error}</div>
              )}

              {/* Submit */}
              <div className="flex justify-end gap-4">
                <Link href={'/projects' as Route}>
                  <Button type="button" variant="outline" disabled={creating}>
                    Cancel
                  </Button>
                </Link>
                <Button
                  type="submit"
                  disabled={creating || selectedInstallation === null || name.trim() === ''}
                >
                  {creating ? (
                    <>
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                      Creating...
                    </>
                  ) : (
                    'Create Project'
                  )}
                </Button>
              </div>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}
