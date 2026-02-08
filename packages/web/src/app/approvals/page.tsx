import { redirect } from 'next/navigation';
import { getServerUser } from '@/lib/auth/session';
import { getDb } from '@/lib/bootstrap';
import { fetchApprovalsData } from '@/lib/data/approvals';
import { ApprovalsContent } from './approvals-content';

interface PageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function ApprovalsPage({ searchParams }: PageProps) {
  const user = await getServerUser();
  if (!user) redirect('/login');

  const params = await searchParams;
  const projectId = typeof params['projectId'] === 'string' ? params['projectId'] : undefined;

  const db = await getDb();
  const data = fetchApprovalsData(db, user.userId, projectId);

  return (
    <ApprovalsContent
      data={data}
      initialProjectId={projectId ?? 'all'}
    />
  );
}
