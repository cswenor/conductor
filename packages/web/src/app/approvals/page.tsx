import { PageHeader } from '@/components/layout';
import { EmptyState } from '@/components/ui';
import { CheckCircle } from 'lucide-react';

export default function ApprovalsPage() {
  return (
    <div className="flex flex-col h-full">
      <PageHeader
        title="Approvals"
        description="Pending decisions requiring your action"
      />
      <div className="flex-1 p-6">
        <EmptyState
          icon={<CheckCircle className="h-12 w-12 text-muted-foreground" />}
          title="No pending approvals"
          description="When runs reach approval gates, they will appear here for your review."
        />
      </div>
    </div>
  );
}
