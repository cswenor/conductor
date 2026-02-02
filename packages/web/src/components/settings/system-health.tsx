'use client';

import { useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { cn } from '@/lib/utils';

interface HealthStatus {
  status: 'healthy' | 'unhealthy' | 'loading' | 'error';
  message?: string;
  latencyMs?: number;
}

interface SystemHealthState {
  api: HealthStatus;
  redis: HealthStatus;
  lastChecked: Date | null;
}

function StatusBadge({ status, message, latencyMs }: HealthStatus) {
  const statusConfig = {
    healthy: { text: 'Healthy', className: 'text-green-600' },
    unhealthy: { text: 'Unhealthy', className: 'text-red-600' },
    loading: { text: 'Checking...', className: 'text-muted-foreground' },
    error: { text: message ?? 'Error', className: 'text-red-600' },
  };

  const config = statusConfig[status];
  const latencyText = latencyMs !== undefined ? ` (${latencyMs}ms)` : '';

  return (
    <span className={cn('text-sm', config.className)}>
      {config.text}
      {status === 'healthy' && latencyText}
    </span>
  );
}

export function SystemHealth() {
  const [health, setHealth] = useState<SystemHealthState>({
    api: { status: 'loading' },
    redis: { status: 'loading' },
    lastChecked: null,
  });
  const [isRefreshing, setIsRefreshing] = useState(false);

  const checkHealth = async () => {
    setIsRefreshing(true);

    // Check API health
    try {
      const apiResponse = await fetch('/api/health');
      if (apiResponse.ok) {
        setHealth((prev) => ({
          ...prev,
          api: { status: 'healthy' },
        }));
      } else {
        setHealth((prev) => ({
          ...prev,
          api: { status: 'unhealthy', message: `Status ${apiResponse.status}` },
        }));
      }
    } catch {
      setHealth((prev) => ({
        ...prev,
        api: { status: 'error', message: 'Failed to connect' },
      }));
    }

    // Check Redis health
    try {
      const redisResponse = await fetch('/api/health/redis');
      if (redisResponse.ok) {
        const data: { data?: { latencyMs?: number } } = await redisResponse.json() as { data?: { latencyMs?: number } };
        setHealth((prev) => ({
          ...prev,
          redis: {
            status: 'healthy',
            latencyMs: data.data?.latencyMs,
          },
        }));
      } else {
        setHealth((prev) => ({
          ...prev,
          redis: { status: 'unhealthy', message: `Status ${redisResponse.status}` },
        }));
      }
    } catch {
      setHealth((prev) => ({
        ...prev,
        redis: { status: 'error', message: 'Failed to connect' },
      }));
    }

    setHealth((prev) => ({
      ...prev,
      lastChecked: new Date(),
    }));
    setIsRefreshing(false);
  };

  useEffect(() => {
    void checkHealth();

    // Refresh every 30 seconds
    const interval = setInterval(() => {
      void checkHealth();
    }, 30000);

    return () => clearInterval(interval);
  }, []);

  return (
    <section>
      <div className="flex items-center justify-between mb-2">
        <h2 className="text-lg font-semibold">System Health</h2>
        <button
          onClick={() => void checkHealth()}
          disabled={isRefreshing}
          className="p-1.5 rounded-md hover:bg-accent disabled:opacity-50"
          title="Refresh health status"
        >
          <RefreshCw
            className={cn('h-4 w-4 text-muted-foreground', isRefreshing && 'animate-spin')}
          />
        </button>
      </div>
      <p className="text-sm text-muted-foreground">
        Monitor the health of Conductor services.
        {health.lastChecked !== null && (
          <span className="ml-2 text-xs">
            Last checked: {health.lastChecked.toLocaleTimeString()}
          </span>
        )}
      </p>
      <div className="mt-4 space-y-2">
        <div className="flex items-center justify-between p-3 rounded-lg border">
          <span className="text-sm font-medium">API Server</span>
          <StatusBadge {...health.api} />
        </div>
        <div className="flex items-center justify-between p-3 rounded-lg border">
          <span className="text-sm font-medium">Redis</span>
          <StatusBadge {...health.redis} />
        </div>
      </div>
    </section>
  );
}
