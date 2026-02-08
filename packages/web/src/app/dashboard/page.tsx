import { redirect } from 'next/navigation';
import { getServerUser } from '@/lib/auth/session';
import { getDb } from '@/lib/bootstrap';
import { fetchDashboardData } from '@/lib/data/dashboard';
import { DashboardContent } from './dashboard-content';

export default async function DashboardPage() {
  const user = await getServerUser();
  if (!user) redirect('/login');

  const db = await getDb();
  const data = fetchDashboardData(db, user.userId);

  return <DashboardContent data={data} />;
}
