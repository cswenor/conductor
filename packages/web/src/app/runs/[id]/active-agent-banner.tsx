'use client';

import { useEffect, useState } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui';
import { formatDuration } from '@/lib/phase-config';

/**
 * Banner showing live agent activity during the executing phase.
 * Displays a pulsing indicator, agent name, action, and elapsed timer.
 */
export function ActiveAgentBanner({
  agent,
  action,
  startedAt,
}: {
  agent: string;
  action: string;
  startedAt: string;
}) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-center gap-3">
          <span className="relative flex h-3 w-3">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75" />
            <span className="relative inline-flex rounded-full h-3 w-3 bg-green-500" />
          </span>
          <span className="text-sm font-medium">Agent is working</span>
          <Badge variant="secondary">{agent}</Badge>
          <span className="text-sm text-muted-foreground">{action}</span>
          <span className="ml-auto text-sm text-muted-foreground tabular-nums">
            <ElapsedTimer startedAt={startedAt} />
          </span>
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * Inline live elapsed timer that updates every second.
 * Renders a <span> for use in table cells or inline contexts.
 */
export function ElapsedTimer({ startedAt }: { startedAt: string }) {
  const [elapsed, setElapsed] = useState(() =>
    Math.max(0, Date.now() - new Date(startedAt).getTime()),
  );

  useEffect(() => {
    const start = new Date(startedAt).getTime();
    const tick = () => setElapsed(Math.max(0, Date.now() - start));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [startedAt]);

  return <span className="tabular-nums">{formatDuration(elapsed)}</span>;
}
