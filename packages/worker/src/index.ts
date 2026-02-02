/**
 * Conductor Worker
 *
 * Standalone process that consumes jobs from BullMQ queues and executes
 * orchestration logic.
 */

import type { JobQueue } from '@conductor/shared';

const QUEUES: JobQueue[] = [
  'webhooks',
  'runs',
  'agents',
  'cleanup',
  'github_writes',
];

function main() {
  // eslint-disable-next-line no-console
  console.log('Conductor Worker starting...');
  // eslint-disable-next-line no-console
  console.log(`Configured queues: ${QUEUES.join(', ')}`);

  // Placeholder - BullMQ setup will be added in WP1.4/WP1.5
  // eslint-disable-next-line no-console
  console.log('Worker ready (no-op mode - BullMQ not yet configured)');

  // Keep the process running
  process.on('SIGINT', () => {
    // eslint-disable-next-line no-console
    console.log('Received SIGINT, shutting down...');
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    // eslint-disable-next-line no-console
    console.log('Received SIGTERM, shutting down...');
    process.exit(0);
  });

  // Keep alive
  setInterval(() => {
    // Heartbeat
  }, 1000);
}

try {
  main();
} catch (err) {
  // eslint-disable-next-line no-console
  console.error('Worker failed to start:', err);
  process.exit(1);
}
