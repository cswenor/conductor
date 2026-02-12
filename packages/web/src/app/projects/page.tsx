import { redirect } from 'next/navigation';
import Link from 'next/link';
import type { Route } from 'next';
import { PageHeader } from '@/components/layout';
import { Button } from '@/components/ui';
import { Plus } from 'lucide-react';
import { getServerUser } from '@/lib/auth/session';
import { getDb } from '@/lib/bootstrap';
import { listProjects } from '@conductor/shared';
import { OnboardingGuide } from '@/components/projects/onboarding-guide';
import { ProjectsListContent } from './projects-list-content';

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
          <ProjectsListContent projects={projects} />
        )}
      </div>
    </div>
  );
}
