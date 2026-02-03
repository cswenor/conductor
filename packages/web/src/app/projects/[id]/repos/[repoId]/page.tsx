'use client';

import { useState, useEffect, use } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { Route } from 'next';
import { PageHeader } from '@/components/layout';
import { Button, EmptyState } from '@/components/ui';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import {
  ArrowLeft,
  GitBranch,
  Loader2,
  ExternalLink,
  Code,
  Trash2,
  AlertTriangle,
} from 'lucide-react';

interface Repo {
  repoId: string;
  projectId: string;
  githubNodeId: string;
  githubNumericId: number;
  githubOwner: string;
  githubName: string;
  githubFullName: string;
  githubDefaultBranch: string;
  profileId: string;
  status: 'active' | 'inactive' | 'syncing' | 'error';
  lastIndexedAt?: string;
  createdAt: string;
  updatedAt: string;
}

interface Profile {
  id: string;
  name: string;
  description: string;
  language: string;
  packageManager?: string;
  framework?: string;
  testCommand?: string;
  buildCommand?: string;
  devCommand?: string;
}

interface PageProps {
  params: Promise<{ id: string; repoId: string }>;
}

export default function RepoSettingsPage({ params }: PageProps) {
  const { id, repoId } = use(params);
  const router = useRouter();
  const [repo, setRepo] = useState<Repo | null>(null);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function fetchData() {
      try {
        const [repoRes, profilesRes] = await Promise.all([
          fetch(`/api/projects/${id}/repos/${repoId}`),
          fetch('/api/profiles'),
        ]);

        if (!repoRes.ok) {
          if (repoRes.status === 404) {
            throw new Error('Repo not found');
          }
          throw new Error('Failed to fetch repo');
        }

        const repoData = await repoRes.json() as { repo: Repo };
        setRepo(repoData.repo);

        if (profilesRes.ok) {
          const profilesData = await profilesRes.json() as { profiles: Profile[] };
          setProfiles(profilesData.profiles);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Unknown error');
      } finally {
        setLoading(false);
      }
    }

    void fetchData();
  }, [id, repoId]);

  const handleProfileChange = async (profileId: string) => {
    if (repo === null) return;

    setSaving(true);
    setError(null);

    try {
      const response = await fetch(`/api/projects/${id}/repos/${repoId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ profileId }),
      });

      if (!response.ok) {
        throw new Error('Failed to update profile');
      }

      const data = await response.json() as { repo: Repo };
      setRepo(data.repo);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setSaving(false);
    }
  };

  const handleStatusChange = async (status: Repo['status']) => {
    if (repo === null) return;

    setSaving(true);
    setError(null);

    try {
      const response = await fetch(`/api/projects/${id}/repos/${repoId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status }),
      });

      if (!response.ok) {
        throw new Error('Failed to update status');
      }

      const data = await response.json() as { repo: Repo };
      setRepo(data.repo);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    setDeleting(true);
    setError(null);

    try {
      const response = await fetch(`/api/projects/${id}/repos/${repoId}`, {
        method: 'DELETE',
      });

      if (!response.ok) {
        throw new Error('Failed to delete repo');
      }

      router.push(`/projects/${id}?tab=repos` as Route);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
      setDeleting(false);
      setDeleteDialogOpen(false);
    }
  };

  const getStatusBadgeVariant = (status: string): 'success' | 'secondary' | 'warning' | 'destructive' => {
    switch (status) {
      case 'active':
        return 'success';
      case 'syncing':
        return 'warning';
      case 'error':
        return 'destructive';
      default:
        return 'secondary';
    }
  };

  const currentProfile = profiles.find((p) => p.id === repo?.profileId);

  if (loading) {
    return (
      <div className="flex flex-col h-full">
        <PageHeader
          title="Repository Settings"
          action={
            <Link href={`/projects/${id}` as Route}>
              <Button variant="outline">
                <ArrowLeft className="h-4 w-4 mr-2" />
                Back
              </Button>
            </Link>
          }
        />
        <div className="flex-1 p-6">
          <div className="max-w-2xl mx-auto space-y-6">
            <Skeleton className="h-48 w-full" />
            <Skeleton className="h-48 w-full" />
          </div>
        </div>
      </div>
    );
  }

  if (error !== null || repo === null) {
    return (
      <div className="flex flex-col h-full">
        <PageHeader
          title="Repository Settings"
          action={
            <Link href={`/projects/${id}` as Route}>
              <Button variant="outline">
                <ArrowLeft className="h-4 w-4 mr-2" />
                Back
              </Button>
            </Link>
          }
        />
        <div className="flex-1 p-6">
          <EmptyState
            icon={<GitBranch className="h-12 w-12 text-destructive" />}
            title="Error"
            description={error ?? 'Repo not found'}
            action={
              <Link href={`/projects/${id}` as Route}>
                <Button variant="outline">Back to Project</Button>
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
        title={repo.githubFullName}
        description="Repository settings and configuration"
        action={
          <div className="flex items-center gap-2">
            <Link href={`/projects/${id}` as Route}>
              <Button variant="outline">
                <ArrowLeft className="h-4 w-4 mr-2" />
                Back
              </Button>
            </Link>
            <Button
              variant="outline"
              onClick={() => window.open(`https://github.com/${repo.githubFullName}`, '_blank')}
            >
              <ExternalLink className="h-4 w-4 mr-2" />
              View on GitHub
            </Button>
          </div>
        }
      />
      <div className="flex-1 p-6">
        <div className="max-w-2xl mx-auto space-y-6">
          {/* Repository Info */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <GitBranch className="h-5 w-5" />
                Repository Info
              </CardTitle>
              <CardDescription>Basic information about this repository</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <div className="text-sm text-muted-foreground">Owner</div>
                  <div className="font-medium">{repo.githubOwner}</div>
                </div>
                <div>
                  <div className="text-sm text-muted-foreground">Repository</div>
                  <div className="font-medium">{repo.githubName}</div>
                </div>
                <div>
                  <div className="text-sm text-muted-foreground">Default Branch</div>
                  <div className="font-mono text-sm">{repo.githubDefaultBranch}</div>
                </div>
                <div>
                  <div className="text-sm text-muted-foreground">Status</div>
                  <Badge variant={getStatusBadgeVariant(repo.status)}>
                    {repo.status}
                  </Badge>
                </div>
              </div>
              <Separator />
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-sm text-muted-foreground">Repository Status</div>
                  <div className="text-xs text-muted-foreground mt-1">
                    Toggle the repository active/inactive
                  </div>
                </div>
                <div className="flex gap-2">
                  <Button
                    variant={repo.status === 'active' ? 'default' : 'outline'}
                    size="sm"
                    onClick={() => { void handleStatusChange('active'); }}
                    disabled={saving || repo.status === 'active'}
                  >
                    {saving && repo.status !== 'active' && <Loader2 className="h-3 w-3 mr-1 animate-spin" />}
                    Active
                  </Button>
                  <Button
                    variant={repo.status === 'inactive' ? 'secondary' : 'outline'}
                    size="sm"
                    onClick={() => { void handleStatusChange('inactive'); }}
                    disabled={saving || repo.status === 'inactive'}
                  >
                    {saving && repo.status !== 'inactive' && <Loader2 className="h-3 w-3 mr-1 animate-spin" />}
                    Inactive
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Profile Configuration */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Code className="h-5 w-5" />
                Profile Configuration
              </CardTitle>
              <CardDescription>
                Profile defines the tech stack and commands for this repository
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {currentProfile !== undefined && (
                <div className="rounded-lg border p-4 bg-muted/30">
                  <div className="flex items-center justify-between mb-2">
                    <div className="font-medium">{currentProfile.name}</div>
                    <Badge variant="default">{currentProfile.language}</Badge>
                  </div>
                  <p className="text-sm text-muted-foreground mb-3">{currentProfile.description}</p>
                  {(currentProfile.testCommand !== undefined ||
                    currentProfile.buildCommand !== undefined ||
                    currentProfile.devCommand !== undefined) && (
                    <div className="space-y-2 text-sm">
                      {currentProfile.testCommand !== undefined && (
                        <div className="flex items-center gap-2">
                          <span className="text-muted-foreground">Test:</span>
                          <code className="bg-muted px-2 py-0.5 rounded text-xs">
                            {currentProfile.testCommand}
                          </code>
                        </div>
                      )}
                      {currentProfile.buildCommand !== undefined && (
                        <div className="flex items-center gap-2">
                          <span className="text-muted-foreground">Build:</span>
                          <code className="bg-muted px-2 py-0.5 rounded text-xs">
                            {currentProfile.buildCommand}
                          </code>
                        </div>
                      )}
                      {currentProfile.devCommand !== undefined && (
                        <div className="flex items-center gap-2">
                          <span className="text-muted-foreground">Dev:</span>
                          <code className="bg-muted px-2 py-0.5 rounded text-xs">
                            {currentProfile.devCommand}
                          </code>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}

              <Separator />

              <div>
                <div className="text-sm font-medium mb-2">Change Profile</div>
                <div className="grid grid-cols-2 gap-2">
                  {profiles.map((profile) => (
                    <button
                      key={profile.id}
                      type="button"
                      onClick={() => { void handleProfileChange(profile.id); }}
                      disabled={saving || profile.id === repo.profileId}
                      className={`p-3 rounded-lg border text-left transition-colors ${
                        profile.id === repo.profileId
                          ? 'border-primary bg-primary/5'
                          : 'hover:border-primary/50 hover:bg-muted/50'
                      } ${saving ? 'opacity-50 cursor-not-allowed' : ''}`}
                    >
                      <div className="font-medium text-sm">{profile.name}</div>
                      <div className="text-xs text-muted-foreground">{profile.description}</div>
                    </button>
                  ))}
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Danger Zone */}
          <Card className="border-destructive/50">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-destructive">
                <AlertTriangle className="h-5 w-5" />
                Danger Zone
              </CardTitle>
              <CardDescription>
                Irreversible actions for this repository
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="flex items-center justify-between">
                <div>
                  <div className="font-medium">Remove Repository</div>
                  <div className="text-sm text-muted-foreground">
                    Remove this repository from the project. This does not affect the GitHub repository.
                  </div>
                </div>
                <Dialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
                  <DialogTrigger asChild>
                    <Button variant="destructive">
                      <Trash2 className="h-4 w-4 mr-2" />
                      Remove
                    </Button>
                  </DialogTrigger>
                  <DialogContent>
                    <DialogHeader>
                      <DialogTitle>Remove Repository</DialogTitle>
                      <DialogDescription>
                        Are you sure you want to remove <strong>{repo.githubFullName}</strong> from this project?
                        This action cannot be undone.
                      </DialogDescription>
                    </DialogHeader>
                    <DialogFooter>
                      <Button
                        variant="outline"
                        onClick={() => setDeleteDialogOpen(false)}
                        disabled={deleting}
                      >
                        Cancel
                      </Button>
                      <Button
                        variant="destructive"
                        onClick={() => { void handleDelete(); }}
                        disabled={deleting}
                      >
                        {deleting ? (
                          <>
                            <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                            Removing...
                          </>
                        ) : (
                          'Remove Repository'
                        )}
                      </Button>
                    </DialogFooter>
                  </DialogContent>
                </Dialog>
              </div>
            </CardContent>
          </Card>

          {/* Error display */}
          {error !== null && (
            <div className="rounded-lg border border-destructive bg-destructive/10 p-4">
              <p className="text-sm text-destructive">{error}</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
