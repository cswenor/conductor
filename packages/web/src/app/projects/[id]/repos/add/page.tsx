'use client';

import { useState, useEffect, use } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { Route } from 'next';
import { PageHeader } from '@/components/layout';
import { Button, EmptyState } from '@/components/ui';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import {
  ArrowLeft,
  GitBranch,
  Check,
  Loader2,
  Search,
  Lock,
  Globe,
} from 'lucide-react';

interface AvailableRepo {
  id: number;
  nodeId: string;
  name: string;
  fullName: string;
  owner: string;
  defaultBranch: string;
  isPrivate: boolean;
}

interface PageProps {
  params: Promise<{ id: string }>;
}

export default function AddReposPage({ params }: PageProps) {
  const { id } = use(params);
  const router = useRouter();
  const [repos, setRepos] = useState<AvailableRepo[]>([]);
  const [filteredRepos, setFilteredRepos] = useState<AvailableRepo[]>([]);
  const [selectedRepos, setSelectedRepos] = useState<Set<string>>(new Set());
  const [searchQuery, setSearchQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function fetchAvailableRepos() {
      try {
        const response = await fetch(`/api/projects/${id}/repos/available`);
        if (!response.ok) {
          const data = await response.json() as { error?: string };
          throw new Error(data.error ?? 'Failed to fetch repos');
        }
        const data = await response.json() as { repos: AvailableRepo[] };
        setRepos(data.repos);
        setFilteredRepos(data.repos);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Unknown error');
      } finally {
        setLoading(false);
      }
    }

    void fetchAvailableRepos();
  }, [id]);

  useEffect(() => {
    if (searchQuery === '') {
      setFilteredRepos(repos);
    } else {
      const query = searchQuery.toLowerCase();
      setFilteredRepos(
        repos.filter(
          (repo) =>
            repo.name.toLowerCase().includes(query) ||
            repo.fullName.toLowerCase().includes(query)
        )
      );
    }
  }, [searchQuery, repos]);

  const toggleRepo = (nodeId: string) => {
    const newSelected = new Set(selectedRepos);
    if (newSelected.has(nodeId)) {
      newSelected.delete(nodeId);
    } else {
      newSelected.add(nodeId);
    }
    setSelectedRepos(newSelected);
  };

  const selectAll = () => {
    setSelectedRepos(new Set(filteredRepos.map((r) => r.nodeId)));
  };

  const deselectAll = () => {
    setSelectedRepos(new Set());
  };

  const handleAdd = async () => {
    if (selectedRepos.size === 0) return;

    setAdding(true);
    setError(null);

    try {
      // Add repos one by one
      const reposToAdd = repos.filter((r) => selectedRepos.has(r.nodeId));

      for (const repo of reposToAdd) {
        const response = await fetch(`/api/projects/${id}/repos`, {
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

        if (!response.ok) {
          const data = await response.json() as { error?: string };
          throw new Error(data.error ?? `Failed to add ${repo.fullName}`);
        }
      }

      // Redirect back to project repos tab
      router.push(`/projects/${id}?tab=repos` as Route);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
      setAdding(false);
    }
  };

  return (
    <div className="flex flex-col h-full">
      <PageHeader
        title="Add Repositories"
        description="Select repositories to add to your project"
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
        <div className="max-w-4xl mx-auto">
          <Card>
            <CardHeader>
              <CardTitle>Available Repositories</CardTitle>
              <CardDescription>
                These repositories are available from your GitHub installation.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {loading ? (
                <div className="flex items-center justify-center py-12">
                  <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
                </div>
              ) : error !== null ? (
                <EmptyState
                  icon={<GitBranch className="h-12 w-12 text-destructive" />}
                  title="Error"
                  description={error}
                />
              ) : repos.length === 0 ? (
                <EmptyState
                  icon={<GitBranch className="h-12 w-12 text-muted-foreground" />}
                  title="No repositories available"
                  description="All repositories from this installation have already been added, or there are no repositories."
                />
              ) : (
                <div className="space-y-4">
                  {/* Search and actions */}
                  <div className="flex items-center gap-4">
                    <div className="relative flex-1">
                      <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                      <Input
                        placeholder="Search repositories..."
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        className="pl-10"
                      />
                    </div>
                    <div className="flex gap-2">
                      <Button variant="outline" size="sm" onClick={selectAll}>
                        Select All
                      </Button>
                      <Button variant="outline" size="sm" onClick={deselectAll}>
                        Deselect All
                      </Button>
                    </div>
                  </div>

                  {/* Selection summary */}
                  <div className="text-sm text-muted-foreground">
                    {selectedRepos.size} of {filteredRepos.length} repositories selected
                  </div>

                  {/* Repo list */}
                  <div className="border rounded-lg divide-y max-h-96 overflow-auto">
                    {filteredRepos.map((repo) => (
                      <button
                        key={repo.nodeId}
                        type="button"
                        onClick={() => toggleRepo(repo.nodeId)}
                        disabled={adding}
                        className={`w-full flex items-center gap-3 p-4 text-left transition-colors ${
                          selectedRepos.has(repo.nodeId)
                            ? 'bg-primary/5'
                            : 'hover:bg-muted/50'
                        } ${adding ? 'opacity-50 cursor-not-allowed' : ''}`}
                      >
                        <div
                          className={`flex items-center justify-center w-5 h-5 rounded border ${
                            selectedRepos.has(repo.nodeId)
                              ? 'bg-primary border-primary text-primary-foreground'
                              : 'border-input'
                          }`}
                        >
                          {selectedRepos.has(repo.nodeId) && (
                            <Check className="h-3 w-3" />
                          )}
                        </div>
                        <GitBranch className="h-5 w-5 text-muted-foreground shrink-0" />
                        <div className="flex-1 min-w-0">
                          <div className="font-medium truncate">{repo.fullName}</div>
                          <div className="text-sm text-muted-foreground">
                            Default branch: {repo.defaultBranch}
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          {repo.isPrivate ? (
                            <Badge variant="secondary">
                              <Lock className="h-3 w-3 mr-1" />
                              Private
                            </Badge>
                          ) : (
                            <Badge variant="outline">
                              <Globe className="h-3 w-3 mr-1" />
                              Public
                            </Badge>
                          )}
                        </div>
                      </button>
                    ))}
                  </div>

                  {/* Error message */}
                  {error !== null && (
                    <div className="text-sm text-destructive">{error}</div>
                  )}

                  {/* Actions */}
                  <div className="flex justify-end gap-4 pt-4">
                    <Link href={`/projects/${id}` as Route}>
                      <Button variant="outline" disabled={adding}>
                        Cancel
                      </Button>
                    </Link>
                    <Button
                      onClick={() => { void handleAdd(); }}
                      disabled={adding || selectedRepos.size === 0}
                    >
                      {adding ? (
                        <>
                          <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                          Adding...
                        </>
                      ) : (
                        <>
                          Add {selectedRepos.size} {selectedRepos.size === 1 ? 'Repository' : 'Repositories'}
                        </>
                      )}
                    </Button>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
