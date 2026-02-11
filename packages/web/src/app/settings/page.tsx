import { PageHeader } from '@/components/layout';
import { SystemHealth, ApiKeyManagement } from '@/components/settings';
import { GitHubIntegration } from '@/components/settings/github-integration';

export default function SettingsPage() {
  return (
    <div className="flex flex-col h-full">
      <PageHeader
        title="Settings"
        description="Configure your Conductor Core instance"
      />
      <div className="flex-1 p-6">
        <div className="max-w-2xl space-y-6">
          <GitHubIntegration />
          <ApiKeyManagement />
          <SystemHealth />
        </div>
      </div>
    </div>
  );
}
