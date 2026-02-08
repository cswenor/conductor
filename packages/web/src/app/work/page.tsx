import { redirect } from 'next/navigation';
import { getServerUser } from '@/lib/auth/session';
import { getDb } from '@/lib/bootstrap';
import {
  listRuns,
  countRuns,
  listProjects,
  type RunPhase,
} from '@conductor/shared';
import type { WorkTab } from '@/lib/phase-config';
import { workTabPhases } from '@/lib/phase-config';
import { WorkContent } from './work-content';

interface PageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

function getRunsForTab(
  db: ReturnType<typeof import('@conductor/shared').getDatabase>,
  userId: string,
  tab: WorkTab,
  projectId?: string,
) {
  const phases = workTabPhases[tab] as RunPhase[];
  const excludePaused = tab === 'active' ? true : undefined;
  const includePaused = tab === 'blocked' ? true : undefined;

  return listRuns(db, {
    userId,
    phases,
    projectId,
    excludePaused,
    includePaused,
    limit: 100,
  });
}

function getCountForTab(
  db: ReturnType<typeof import('@conductor/shared').getDatabase>,
  userId: string,
  tab: WorkTab,
  projectId?: string,
) {
  const phases = workTabPhases[tab] as RunPhase[];
  const excludePaused = tab === 'active' ? true : undefined;
  const includePaused = tab === 'blocked' ? true : undefined;

  return countRuns(db, {
    userId,
    phases,
    projectId,
    excludePaused,
    includePaused,
  });
}

export default async function WorkPage({ searchParams }: PageProps) {
  const user = await getServerUser();
  if (!user) redirect('/login');

  const params = await searchParams;
  const tab = (['active', 'queued', 'blocked', 'completed'] as WorkTab[]).includes(
    params['tab'] as WorkTab
  )
    ? (params['tab'] as WorkTab)
    : 'active';
  const projectId = typeof params['projectId'] === 'string' ? params['projectId'] : undefined;

  const db = await getDb();

  const runs = getRunsForTab(db, user.userId, tab, projectId);

  const counts: Record<WorkTab, number> = {
    active: getCountForTab(db, user.userId, 'active', projectId),
    queued: getCountForTab(db, user.userId, 'queued', projectId),
    blocked: getCountForTab(db, user.userId, 'blocked', projectId),
    completed: getCountForTab(db, user.userId, 'completed', projectId),
  };

  const projects = listProjects(db, { userId: user.userId }).map(p => ({
    id: p.projectId,
    name: p.name,
  }));

  return (
    <WorkContent
      runs={runs}
      counts={counts}
      projects={projects}
      initialTab={tab}
      initialProjectId={projectId ?? 'all'}
    />
  );
}
