'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import type { Route } from 'next';
import { PageHeader } from '@/components/layout';
import { EmptyState, Button } from '@/components/ui';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { FolderKanban, Plus, GitBranch, Play } from 'lucide-react';

interface ProjectSummary {
  projectId: string;
  name: string;
  githubOrgName: string;
  repoCount: number;
  activeRunCount: number;
  createdAt: string;
  updatedAt: string;
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
          <EmptyState
            icon={<FolderKanban className="h-12 w-12 text-muted-foreground" />}
            title="No projects yet"
            description="Create your first project to start orchestrating AI agents."
            action={
              <Link href={'/projects/new' as Route}>
                <Button>
                  <Plus className="h-4 w-4 mr-2" />
                  Create Project
                </Button>
              </Link>
            }
          />
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
