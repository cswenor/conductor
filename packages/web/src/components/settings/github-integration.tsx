'use client';

import { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';

interface GitHubStatus {
  configured: boolean;
  appId?: string;
  appSlug?: string;
}

export function GitHubIntegration() {
  const [status, setStatus] = useState<GitHubStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function fetchStatus() {
      try {
        const response = await fetch('/api/github/status');
        if (!response.ok) {
          throw new Error('Failed to fetch GitHub status');
        }
        const data = await response.json() as GitHubStatus;
        setStatus(data);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Unknown error');
      } finally {
        setLoading(false);
      }
    }

    void fetchStatus();
  }, []);

  const handleInstall = () => {
    // Redirect to install endpoint which will redirect to GitHub
    window.location.href = '/api/github/install';
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          GitHub Integration
          {status?.configured === true ? (
            <Badge variant="default">Configured</Badge>
          ) : (
            <Badge variant="secondary">Not Configured</Badge>
          )}
        </CardTitle>
        <CardDescription>
          Connect your GitHub App to enable webhook delivery and API access.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {loading ? (
          <p className="text-sm text-muted-foreground">Loading...</p>
        ) : error !== null ? (
          <p className="text-sm text-destructive">{error}</p>
        ) : status?.configured === true ? (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-4 text-sm">
              <div>
                <span className="text-muted-foreground">App ID:</span>
                <span className="ml-2 font-mono">{status.appId}</span>
              </div>
              <div>
                <span className="text-muted-foreground">App Slug:</span>
                <span className="ml-2 font-mono">{status.appSlug}</span>
              </div>
            </div>
            <div className="flex gap-2">
              <Button variant="outline" onClick={handleInstall}>
                Install on Another Org
              </Button>
              <Button
                variant="outline"
                onClick={() => window.open(`https://github.com/apps/${status.appSlug}`, '_blank')}
              >
                View on GitHub
              </Button>
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              GitHub App credentials are not configured. Set the following environment variables:
            </p>
            <ul className="text-sm text-muted-foreground list-disc list-inside space-y-1">
              <li><code className="text-xs bg-muted px-1 py-0.5 rounded">GITHUB_APP_ID</code></li>
              <li><code className="text-xs bg-muted px-1 py-0.5 rounded">GITHUB_APP_SLUG</code></li>
              <li><code className="text-xs bg-muted px-1 py-0.5 rounded">GITHUB_PRIVATE_KEY</code></li>
              <li><code className="text-xs bg-muted px-1 py-0.5 rounded">GITHUB_WEBHOOK_SECRET</code></li>
            </ul>
            <p className="text-sm text-muted-foreground">
              See <a href="/docs/GITHUB_APP_SETUP.md" className="underline">GitHub App Setup Guide</a> for instructions.
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
