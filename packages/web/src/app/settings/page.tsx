import { PageHeader } from '@/components/layout';

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

          <section>
            <h2 className="text-lg font-semibold mb-2">System Health</h2>
            <p className="text-sm text-muted-foreground">
              Monitor the health of Conductor services.
            </p>
            <div className="mt-4 space-y-2">
              <div className="flex items-center justify-between p-3 rounded-lg border">
                <span className="text-sm font-medium">API Server</span>
                <span className="text-sm text-green-600">Healthy</span>
              </div>
              <div className="flex items-center justify-between p-3 rounded-lg border">
                <span className="text-sm font-medium">Redis</span>
                <span className="text-sm text-green-600">Connected</span>
              </div>
              <div className="flex items-center justify-between p-3 rounded-lg border">
                <span className="text-sm font-medium">Worker</span>
                <span className="text-sm text-muted-foreground">Check /api/health</span>
              </div>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
