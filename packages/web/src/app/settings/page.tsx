import { PageHeader } from '@/components/layout';
import { SystemHealth } from '@/components/settings';

export default function SettingsPage() {
  return (
    <div className="flex flex-col h-full">
      <PageHeader
        title="Settings"
        description="Configure your Conductor instance"
      />
      <div className="flex-1 p-6">
        <div className="max-w-2xl space-y-6">
          <section>
            <h2 className="text-lg font-semibold mb-2">GitHub Integration</h2>
            <p className="text-sm text-muted-foreground">
              Connect your GitHub App to enable webhook delivery and API access.
            </p>
            <div className="mt-4 p-4 rounded-lg border bg-muted/50">
              <p className="text-sm text-muted-foreground">
                GitHub App configuration will be available in a future release.
              </p>
            </div>
          </section>

          <SystemHealth />
        </div>
      </div>
    </div>
  );
}
