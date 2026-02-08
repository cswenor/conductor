import { redirect } from 'next/navigation';
import Link from 'next/link';
import type { Route } from 'next';
import { PageHeader } from '@/components/layout';
import { Button } from '@/components/ui';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { FolderKanban, Plus, GitBranch, Play } from 'lucide-react';
import { getServerUser } from '@/lib/auth/session';
import { getDb } from '@/lib/bootstrap';
import { listProjects, type ProjectHealth } from '@conductor/shared';
import { OnboardingGuide } from '@/components/projects/onboarding-guide';

const HEALTH_CONFIG: Record<ProjectHealth, { label: string; dotClass: string }> = {
  healthy:         { label: 'Healthy',         dotClass: 'bg-green-500' },
  needs_attention: { label: 'Needs Attention', dotClass: 'bg-yellow-500' },
  blocked:         { label: 'Blocked',         dotClass: 'bg-red-500' },
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

export default async function ProjectsPage() {
  const user = await getServerUser();
  if (!user) redirect('/login');

  const db = await getDb();
  const projects = listProjects(db, { userId: user.userId });

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
        {projects.length === 0 ? (
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
