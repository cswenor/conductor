import { redirect, notFound } from 'next/navigation';
import { getServerUser } from '@/lib/auth/session';
import { getDb } from '@/lib/bootstrap';
import {
  getProject,
  canAccessProject,
  listProjectRepos,
  listRuns,
  countRuns,
  listStartableTasks,
  type RunPhase,
} from '@conductor/shared';
import type { WorkTab } from '@/lib/phase-config';
import { workTabPhases } from '@/lib/phase-config';
import { fetchProjectOverviewData } from '@/lib/data/project-overview';
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
  const workTab = (['active', 'queued', 'blocked', 'completed'] as WorkTab[]).includes(
    sp['workTab'] as WorkTab
  )
    ? (sp['workTab'] as WorkTab)
    : 'active';

  const db = await getDb();
  const project = getProject(db, id);

  if (project === null || !canAccessProject(user, project)) {
    notFound();
  }

  const repos = listProjectRepos(db, id);

  // Overview data
  const overviewData = fetchProjectOverviewData(db, id);

  // Work tab data
  const workPhases = workTabPhases[workTab] as RunPhase[];
  const workExcludePaused = workTab === 'active' ? true : undefined;
  const workIncludePaused = workTab === 'blocked' ? true : undefined;

  const workRuns = listRuns(db, {
    projectId: id,
    phases: workPhases,
    excludePaused: workExcludePaused,
    includePaused: workIncludePaused,
    limit: 100,
  });

  const workCounts: Record<WorkTab, number> = {
    active: countRuns(db, { projectId: id, phases: workTabPhases.active as RunPhase[], excludePaused: true }),
    queued: countRuns(db, { projectId: id, phases: workTabPhases.queued as RunPhase[] }),
    blocked: countRuns(db, { projectId: id, phases: workTabPhases.blocked as RunPhase[], includePaused: true }),
    completed: countRuns(db, { projectId: id, phases: workTabPhases.completed as RunPhase[] }),
  };

  // Backlog data
  const backlogTasks = listStartableTasks(db, user.userId, { projectId: id });

  return (
    <ProjectDetailContent
      project={project}
      repos={repos}
      defaultTab={defaultTab}
      overviewData={overviewData}
      workRuns={workRuns}
      workCounts={workCounts}
      workTab={workTab}
      backlogTasks={backlogTasks}
    />
  );
}
