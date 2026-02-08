import { redirect, notFound } from 'next/navigation';
import { getServerUser } from '@/lib/auth/session';
import { getDb } from '@/lib/bootstrap';
import { fetchRunDetail } from '@/lib/data/run-detail';
import { RunDetailContent } from './run-detail-content';

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function RunDetailPage({ params }: PageProps) {
  const user = await getServerUser();
  if (!user) redirect('/login');

  const { id: runId } = await params;

  const db = await getDb();
  const data = fetchRunDetail(db, user, runId);

  if (data === null) {
    notFound();
  }

  return <RunDetailContent data={data} />;
}
