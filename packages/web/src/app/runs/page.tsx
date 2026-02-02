import { PageHeader } from '@/components/layout';
import { EmptyState } from '@/components/ui';
import { Play } from 'lucide-react';

export default function RunsPage() {
  return (
    <div className="flex flex-col h-full">
      <PageHeader
        title="Runs"
        description="Active and recent orchestration runs"
      />
      <div className="flex-1 p-6">
        <EmptyState
          icon={<Play className="h-12 w-12 text-muted-foreground" />}
          title="No active runs"
          description="Runs will appear here when you start orchestrating issues from your projects."
        />
      </div>
    </div>
  );
}
