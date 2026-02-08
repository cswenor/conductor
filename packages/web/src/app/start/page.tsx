import { redirect } from 'next/navigation';
import { getServerUser } from '@/lib/auth/session';
import { getDb } from '@/lib/bootstrap';
import { fetchStartWorkData } from '@/lib/data/start-work';
import { StartWorkContent } from './start-work-content';

interface PageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function StartWorkPage({ searchParams }: PageProps) {
  const user = await getServerUser();
  if (!user) redirect('/login');

  const params = await searchParams;
  const projectId = typeof params['projectId'] === 'string' ? params['projectId'] : undefined;
  const repoId = typeof params['repoId'] === 'string' ? params['repoId'] : undefined;

  const db = await getDb();
  const data = fetchStartWorkData(db, user.userId, projectId, repoId);

  return (
    <StartWorkContent
      {...data}
      initialProjectId={projectId ?? 'all'}
      initialRepoId={repoId ?? 'all'}
    />
  );
}
