import { redirect, notFound } from 'next/navigation';
import { getServerUser } from '@/lib/auth/session';
import { getDb } from '@/lib/bootstrap';
import {
  getProject,
  canAccessProject,
  listProjectRepos,
} from '@conductor/shared';
import { ProjectDetailContent } from './project-detail-content';

interface PageProps {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function ProjectDetailPage({ params, searchParams }: PageProps) {
  const user = await getServerUser();
  if (!user) redirect('/login');

  const { id } = await params;
  const sp = await searchParams;
  const defaultTab = typeof sp['tab'] === 'string' ? sp['tab'] : 'overview';

  const db = await getDb();
  const project = getProject(db, id);

  if (project === null || !canAccessProject(user, project)) {
    notFound();
  }

  const repos = listProjectRepos(db, id);

  return (
    <ProjectDetailContent
      project={project}
      repos={repos}
      defaultTab={defaultTab}
    />
  );
}
