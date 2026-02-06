'use client';

import { Suspense, useState, useEffect, useMemo, useCallback } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import type { Route } from 'next';
import { PageHeader } from '@/components/layout';
import { Button } from '@/components/ui';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import { ArrowLeft, Github, Building2, Loader2, Plus, GitBranch, Check } from 'lucide-react';

interface InstallationInfo {
  installationId: number;
  accountLogin: string;
  accountId: number;
  accountNodeId: string;
  accountType: 'User' | 'Organization';
  isPending: boolean;
}

interface RepoInfo {
  id: number;
  nodeId: string;
  name: string;
  fullName: string;
  owner: string;
  defaultBranch: string;
  isPrivate: boolean;
}

function NewProjectContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const installationIdFromUrl = searchParams.get('installation_id');

  // Step state
  const [step, setStep] = useState<1 | 2 | 3>(1);

  // Org state
  const [installations, setInstallations] = useState<InstallationInfo[]>([]);
  const [selectedInstallation, setSelectedInstallation] = useState<InstallationInfo | null>(null);
  const [githubConfigured, setGithubConfigured] = useState(false);
  const [loadingOrgs, setLoadingOrgs] = useState(true);

  // Repo state
  const [repos, setRepos] = useState<RepoInfo[]>([]);
  const [selectedRepos, setSelectedRepos] = useState<RepoInfo[]>([]);
  const [repoSearch, setRepoSearch] = useState('');
  const [loadingRepos, setLoadingRepos] = useState(false);

  // Project state
  const [name, setName] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectedNodeIds = useMemo(
    () => new Set(selectedRepos.map((r) => r.nodeId)),
    [selectedRepos]
  );

  // Fetch installations on mount
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
            setStep(2);
          }
        }
        // Fallback: auto-select if only one installation
        if (!autoSelected && data.installations.length === 1 && data.installations[0] !== undefined) {
          setSelectedInstallation(data.installations[0]);
          setStep(2);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Unknown error');
      } finally {
        setLoadingOrgs(false);
      }
    }

    void fetchInstallations();
  }, [installationIdFromUrl]);

  // Fetch repos when installation is selected
  useEffect(() => {
    if (selectedInstallation === null) {
      setRepos([]);
      return;
    }

    const installationId = selectedInstallation.installationId;

    async function fetchRepos() {
      setLoadingRepos(true);
      setRepos([]);
      setSelectedRepos([]);
      setRepoSearch('');
      try {
        const response = await fetch(
          `/api/github/installations/${installationId}/repos`
        );
        if (!response.ok) {
          throw new Error('Failed to fetch repositories');
        }
        const data = await response.json() as { repos: RepoInfo[] };
        setRepos(data.repos);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Unknown error');
      } finally {
        setLoadingRepos(false);
      }
    }

    void fetchRepos();
  }, [selectedInstallation]);

  // Filter repos by search
  const filteredRepos = useMemo(() => {
    if (repoSearch.trim() === '') return repos;
    const search = repoSearch.toLowerCase();
    return repos.filter((repo) => repo.name.toLowerCase().includes(search));
  }, [repos, repoSearch]);

  const handleSelectOrg = (install: InstallationInfo) => {
    setSelectedInstallation(install);
    setStep(2);
    setError(null);
  };

  const handleToggleRepo = useCallback((repo: RepoInfo) => {
    setSelectedRepos((prev) => {
      const exists = prev.some((r) => r.nodeId === repo.nodeId);
      if (exists) {
        return prev.filter((r) => r.nodeId !== repo.nodeId);
      }
      return [...prev, repo];
    });
  }, []);

  const handleContinueToCreate = () => {
    if (selectedRepos.length === 0) {
      setError('Please select at least one repository');
      return;
    }
    // Auto-populate project name
    const orgName = selectedInstallation?.accountLogin ?? '';
    if (selectedRepos.length === 1 && selectedRepos[0] !== undefined) {
      setName(`${orgName}/${selectedRepos[0].name}`);
    } else {
      setName(orgName);
    }
    setStep(3);
    setError(null);
  };

  const handleBack = () => {
    if (step === 3) {
      setStep(2);
    } else if (step === 2) {
      setStep(1);
      setSelectedInstallation(null);
      setRepos([]);
      setSelectedRepos([]);
    }
    setError(null);
  };

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
      // Step 1: Create the project
      const projectResponse = await fetch('/api/projects', {
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

      if (!projectResponse.ok) {
        const data = await projectResponse.json() as { error?: string };
        throw new Error(data.error ?? 'Failed to create project');
      }

      const projectData = await projectResponse.json() as { project: { projectId: string } };
      const projectId = projectData.project.projectId;

      // Step 2: Add all selected repos
      for (const repo of selectedRepos) {
        const repoResponse = await fetch(`/api/projects/${projectId}/repos`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            githubNodeId: repo.nodeId,
            githubNumericId: repo.id,
            githubOwner: repo.owner,
            githubName: repo.name,
            githubFullName: repo.fullName,
            githubDefaultBranch: repo.defaultBranch,
          }),
        });

        if (!repoResponse.ok) {
          console.warn(`Failed to add repo ${repo.fullName} to project, continuing`);
        }
      }

      router.push(`/projects/${projectId}`);
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
          {/* Step indicators */}
          <div className="flex items-center gap-2 mb-6 text-sm text-muted-foreground">
            <span className={step >= 1 ? 'text-foreground font-medium' : ''}>
              Organization
            </span>
            <span>/</span>
            <span className={step >= 2 ? 'text-foreground font-medium' : ''}>
              Repositories
            </span>
            <span>/</span>
            <span className={step >= 3 ? 'text-foreground font-medium' : ''}>
              Create
            </span>
          </div>

          <div className="space-y-6">
            {/* Step 1: Select Organization */}
            <Card className={step !== 1 && selectedInstallation !== null ? 'opacity-75' : ''}>
              <CardHeader>
                <div className="flex items-center justify-between">
                  <div>
                    <CardTitle className="flex items-center gap-2">
                      <Github className="h-5 w-5" />
                      GitHub Organization
                    </CardTitle>
                    <CardDescription>
                      Select the GitHub organization for this project.
                    </CardDescription>
                  </div>
                  {step > 1 && selectedInstallation !== null && (
                    <Button variant="ghost" size="sm" onClick={handleBack}>
                      Change
                    </Button>
                  )}
                </div>
              </CardHeader>
              <CardContent>
                {step === 1 ? (
                  <>
                    {loadingOrgs ? (
                      <div className="space-y-2">
                        <Skeleton className="h-16 w-full" />
                        <Skeleton className="h-16 w-full" />
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
                            onClick={() => handleSelectOrg(install)}
                            className="w-full flex items-center gap-3 p-4 rounded-lg border transition-colors border-border hover:border-primary/50"
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
                        <Separator className="my-3" />
                        <a href="/api/github/install">
                          <Button variant="outline" className="w-full" type="button">
                            <Plus className="h-4 w-4 mr-2" />
                            Connect Another Organization
                          </Button>
                        </a>
                      </div>
                    )}
                  </>
                ) : selectedInstallation !== null ? (
                  <div className="flex items-center gap-3 p-3 rounded-lg border border-primary bg-primary/5">
                    <Building2 className="h-6 w-6 text-muted-foreground" />
                    <div className="flex-1">
                      <div className="font-medium">{selectedInstallation.accountLogin}</div>
                      <div className="text-sm text-muted-foreground">
                        {selectedInstallation.accountType}
                      </div>
                    </div>
                    <Check className="h-5 w-5 text-primary" />
                  </div>
                ) : null}
              </CardContent>
            </Card>

            {/* Step 2: Select Repositories */}
            {step >= 2 && (
              <Card className={step > 2 ? 'opacity-75' : ''}>
                <CardHeader>
                  <div className="flex items-center justify-between">
                    <div>
                      <CardTitle className="flex items-center gap-2">
                        <GitBranch className="h-5 w-5" />
                        Repositories
                      </CardTitle>
                      <CardDescription>
                        Select the repositories to add to this project.
                      </CardDescription>
                    </div>
                    {step > 2 && selectedRepos.length > 0 && (
                      <Button variant="ghost" size="sm" onClick={() => setStep(2)}>
                        Change
                      </Button>
                    )}
                  </div>
                </CardHeader>
                <CardContent>
                  {step === 2 ? (
                    <>
                      {loadingRepos ? (
                        <div className="space-y-2">
                          <Skeleton className="h-10 w-full" />
                          <Skeleton className="h-14 w-full" />
                          <Skeleton className="h-14 w-full" />
                          <Skeleton className="h-14 w-full" />
                        </div>
                      ) : repos.length === 0 ? (
                        <div className="text-center py-8">
                          <p className="text-muted-foreground mb-4">
                            No repositories found for this installation.
                          </p>
                          <Button variant="outline" onClick={handleBack}>
                            Select a different organization
                          </Button>
                        </div>
                      ) : (
                        <div className="space-y-3">
                          <Input
                            placeholder="Search repositories..."
                            value={repoSearch}
                            onChange={(e) => setRepoSearch(e.target.value)}
                          />
                          <ScrollArea className="h-[320px]">
                            <div className="space-y-1">
                              {filteredRepos.map((repo) => {
                                const isSelected = selectedNodeIds.has(repo.nodeId);
                                return (
                                  <button
                                    key={repo.nodeId}
                                    type="button"
                                    onClick={() => handleToggleRepo(repo)}
                                    className={`w-full flex items-center gap-3 p-3 rounded-lg border transition-colors ${
                                      isSelected
                                        ? 'border-primary bg-primary/5'
                                        : 'border-border hover:border-primary/50'
                                    }`}
                                  >
                                    <div className={`flex h-5 w-5 shrink-0 items-center justify-center rounded border ${
                                      isSelected
                                        ? 'border-primary bg-primary text-primary-foreground'
                                        : 'border-muted-foreground/30'
                                    }`}>
                                      {isSelected && <Check className="h-3 w-3" />}
                                    </div>
                                    <div className="flex-1 text-left">
                                      <div className="font-medium text-sm">{repo.name}</div>
                                      <div className="text-xs text-muted-foreground">
                                        {repo.defaultBranch}
                                      </div>
                                    </div>
                                    <Badge variant={repo.isPrivate ? 'secondary' : 'outline'}>
                                      {repo.isPrivate ? 'Private' : 'Public'}
                                    </Badge>
                                  </button>
                                );
                              })}
                              {filteredRepos.length === 0 && (
                                <div className="text-center py-6 text-sm text-muted-foreground">
                                  No repositories match your search.
                                </div>
                              )}
                            </div>
                          </ScrollArea>
                          {selectedRepos.length > 0 && (
                            <div className="text-sm text-muted-foreground">
                              {selectedRepos.length} {selectedRepos.length === 1 ? 'repository' : 'repositories'} selected
                            </div>
                          )}
                          <div className="flex justify-end">
                            <Button
                              type="button"
                              onClick={handleContinueToCreate}
                              disabled={selectedRepos.length === 0}
                            >
                              Continue
                            </Button>
                          </div>
                        </div>
                      )}
                    </>
                  ) : (
                    <div className="space-y-1">
                      {selectedRepos.map((repo) => (
                        <div key={repo.nodeId} className="flex items-center gap-3 p-3 rounded-lg border border-primary bg-primary/5">
                          <div className="flex-1">
                            <div className="font-medium text-sm">{repo.name}</div>
                            <div className="text-xs text-muted-foreground">
                              {repo.defaultBranch}
                            </div>
                          </div>
                          <Badge variant={repo.isPrivate ? 'secondary' : 'outline'}>
                            {repo.isPrivate ? 'Private' : 'Public'}
                          </Badge>
                          <Check className="h-5 w-5 text-primary" />
                        </div>
                      ))}
                    </div>
                  )}
                </CardContent>
              </Card>
            )}

            {/* Step 3: Project Details & Create */}
            {step === 3 && (
              <Card>
                <CardHeader>
                  <CardTitle>Project Details</CardTitle>
                  <CardDescription>
                    Give your project a name and create it.
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <form onSubmit={(e) => { void handleSubmit(e); }}>
                    <div className="space-y-4">
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

                      {/* Error message */}
                      {error !== null && (
                        <div className="text-sm text-destructive">{error}</div>
                      )}

                      <div className="flex justify-end gap-3">
                        <Button
                          type="button"
                          variant="outline"
                          disabled={creating}
                          onClick={handleBack}
                        >
                          Back
                        </Button>
                        <Button
                          type="submit"
                          disabled={creating || name.trim() === ''}
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
                </CardContent>
              </Card>
            )}

            {/* Show error outside of step 3 */}
            {step !== 3 && error !== null && (
              <div className="text-sm text-destructive">{error}</div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function NewProjectFallback() {
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
          <div className="flex items-center justify-center py-16">
            <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
          </div>
        </div>
      </div>
    </div>
  );
}

export default function NewProjectPage() {
  return (
    <Suspense fallback={<NewProjectFallback />}>
      <NewProjectContent />
    </Suspense>
  );
}
