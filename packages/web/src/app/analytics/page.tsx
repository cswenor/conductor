import { redirect } from 'next/navigation';
import { PageHeader } from '@/components/layout';
import { getServerUser } from '@/lib/auth/session';
import { getDb } from '@/lib/bootstrap';
import { getAnalyticsMetrics } from '@conductor/shared';
import type { AnalyticsResponse } from '@/lib/types';
import { AnalyticsContent } from './analytics-content';

export default async function AnalyticsPage() {
  const user = await getServerUser();
  if (!user) redirect('/login');

  const db = await getDb();
  const metrics = getAnalyticsMetrics(db, {
    userId: user.userId,
  }) as AnalyticsResponse;

  return (
    <div className="flex flex-col h-full">
      <PageHeader
        title="Analytics"
        description="Aggregate metrics across your projects"
      />
      <div className="flex-1 p-6 space-y-6">
        <AnalyticsContent metrics={metrics} />
      </div>
    </div>
  );
}
