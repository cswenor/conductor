import { PageHeader } from '@/components/layout';
import { EmptyState } from '@/components/ui';
import { FolderKanban } from 'lucide-react';

export default function ProjectsPage() {
  return (
    <div className="flex flex-col h-full">
      <PageHeader
        title="Projects"
        description="Manage your orchestration projects"
      />
      <div className="flex-1 p-6">
        <EmptyState
          icon={<FolderKanban className="h-12 w-12 text-muted-foreground" />}
          title="No projects yet"
          description="Create your first project to start orchestrating AI agents."
        />
      </div>
    </div>
  );
}
