/**
 * Job Queue module for Conductor
 *
 * Provides BullMQ queue setup, connection management,
 * and typed producer/consumer patterns.
 */

import { Queue, Worker, Job, QueueEvents } from 'bullmq';
import type { ConnectionOptions, WorkerOptions, QueueOptions } from 'bullmq';
import { Redis } from 'ioredis';
import type { JobQueue } from '../types/index';

/**
 * Queue configuration
 */
export interface QueueConfig {
  /** Redis connection URL */
  redisUrl: string;
  /** Queue prefix (default: 'conductor') */
  prefix?: string;
}

/**
 * Job data types for each queue
 */
export interface WebhookJobData {
  deliveryId: string;
  eventType: string;
  action?: string;
  repositoryNodeId?: string;
  payloadSummary: Record<string, unknown>;
}

export interface RunJobData {
  runId: string;
  action: 'start' | 'resume' | 'cancel' | 'timeout';
  triggeredBy?: string;
}

export interface AgentJobData {
  runId: string;
  agentInvocationId: string;
  agent: string;
  action: string;
  context: Record<string, unknown>;
}

export interface CleanupJobData {
  type: 'worktree' | 'expired_leases' | 'old_jobs';
  targetId?: string;
}

export interface GitHubWriteJobData {
  githubWriteId: string;
  runId: string;
  kind: string;
  targetNodeId: string;
  retryCount: number;
}

/**
 * Union type for all job data
 */
export type JobData =
  | WebhookJobData
  | RunJobData
  | AgentJobData
  | CleanupJobData
  | GitHubWriteJobData;

/**
 * Map queue names to their job data types
 */
export interface QueueJobDataMap {
  webhooks: WebhookJobData;
  runs: RunJobData;
  agents: AgentJobData;
  cleanup: CleanupJobData;
  github_writes: GitHubWriteJobData;
}

/**
 * Default queue options per queue type
 */
const QUEUE_OPTIONS: Record<JobQueue, Partial<QueueOptions>> = {
  webhooks: {
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: 'exponential', delay: 1000 },
      removeOnComplete: { count: 1000 },
      removeOnFail: { count: 5000 },
    },
  },
  runs: {
    defaultJobOptions: {
      attempts: 1, // Runs handle their own retry logic
      removeOnComplete: { count: 100 },
      removeOnFail: { count: 1000 },
    },
  },
  agents: {
    defaultJobOptions: {
      attempts: 1, // Agent failures are handled by orchestrator
      removeOnComplete: { count: 100 },
      removeOnFail: { count: 1000 },
    },
  },
  cleanup: {
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: 'fixed', delay: 60000 },
      removeOnComplete: { count: 100 },
      removeOnFail: { count: 100 },
    },
  },
  github_writes: {
    defaultJobOptions: {
      attempts: 5,
      backoff: { type: 'exponential', delay: 2000 },
      removeOnComplete: { count: 1000 },
      removeOnFail: { count: 5000 },
    },
  },
};

/**
 * Create a Redis connection from URL
 */
export function createRedisConnection(url: string): Redis {
  return new Redis(url, {
    maxRetriesPerRequest: null, // Required for BullMQ
    enableReadyCheck: false,
  });
}

/**
 * Get BullMQ connection options from Redis URL
 */
export function getConnectionOptions(url: string): ConnectionOptions {
  const parsedUrl = new URL(url);
  return {
    host: parsedUrl.hostname,
    port: parseInt(parsedUrl.port || '6379', 10),
    password: parsedUrl.password || undefined,
    username: parsedUrl.username || undefined,
  };
}

/**
 * Queue manager for creating and managing BullMQ queues
 */
export class QueueManager {
  private readonly connection: ConnectionOptions;
  private readonly prefix: string;
  private readonly queues: Map<JobQueue, Queue> = new Map();
  private readonly workers: Map<JobQueue, Worker> = new Map();
  private readonly events: Map<JobQueue, QueueEvents> = new Map();
  private redis: Redis | null = null;

  constructor(config: QueueConfig) {
    this.connection = getConnectionOptions(config.redisUrl);
    this.prefix = config.prefix ?? 'conductor';
    this.redis = createRedisConnection(config.redisUrl);
  }

  /**
   * Get or create a queue for the specified type
   */
  getQueue<T extends JobQueue>(queueName: T): Queue<QueueJobDataMap[T]> {
    let queue = this.queues.get(queueName);
    if (queue === undefined) {
      queue = new Queue(queueName, {
        connection: this.connection,
        prefix: this.prefix,
        ...QUEUE_OPTIONS[queueName],
      });
      this.queues.set(queueName, queue);
    }
    return queue as Queue<QueueJobDataMap[T]>;
  }

  /**
   * Add a job to a queue
   */
  async addJob<T extends JobQueue>(
    queueName: T,
    jobId: string,
    data: QueueJobDataMap[T],
    options?: { priority?: number; delay?: number }
  ): Promise<Job<QueueJobDataMap[T]>> {
    const queue = this.getQueue(queueName);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
    return (queue as any).add(queueName, data, {
      jobId, // Use provided ID for idempotency
      priority: options?.priority,
      delay: options?.delay,
    }) as Promise<Job<QueueJobDataMap[T]>>;
  }

  /**
   * Create a worker for a queue
   */
  createWorker<T extends JobQueue>(
    queueName: T,
    processor: (job: Job<QueueJobDataMap[T]>) => Promise<void>,
    options?: Partial<WorkerOptions>
  ): Worker<QueueJobDataMap[T]> {
    const existingWorker = this.workers.get(queueName);
    if (existingWorker !== undefined) {
      throw new Error(`Worker already exists for queue: ${queueName}`);
    }

    const worker = new Worker(queueName, processor, {
      connection: this.connection,
      prefix: this.prefix,
      concurrency: 1,
      ...options,
    });

    this.workers.set(queueName, worker as Worker);
    return worker;
  }

  /**
   * Get queue events for monitoring
   */
  getQueueEvents(queueName: JobQueue): QueueEvents {
    let events = this.events.get(queueName);
    if (events === undefined) {
      events = new QueueEvents(queueName, {
        connection: this.connection,
        prefix: this.prefix,
      });
      this.events.set(queueName, events);
    }
    return events;
  }

  /**
   * Check Redis connection health
   */
  async healthCheck(): Promise<{ healthy: boolean; latencyMs: number }> {
    if (this.redis === null) {
      return { healthy: false, latencyMs: -1 };
    }

    const start = Date.now();
    try {
      const result = await this.redis.ping();
      const latencyMs = Date.now() - start;
      return { healthy: result === 'PONG', latencyMs };
    } catch {
      return { healthy: false, latencyMs: Date.now() - start };
    }
  }

  /**
   * Close all connections
   */
  async close(): Promise<void> {
    // Close all workers
    for (const worker of this.workers.values()) {
      await worker.close();
    }
    this.workers.clear();

    // Close all queue events
    for (const events of this.events.values()) {
      await events.close();
    }
    this.events.clear();

    // Close all queues
    for (const queue of this.queues.values()) {
      await queue.close();
    }
    this.queues.clear();

    // Close Redis connection
    if (this.redis !== null) {
      await this.redis.quit();
      this.redis = null;
    }
  }
}

/**
 * Singleton queue manager instance
 */
let queueManager: QueueManager | null = null;

/**
 * Initialize the queue manager
 */
export function initQueueManager(config: QueueConfig): QueueManager {
  if (queueManager !== null) {
    throw new Error('Queue manager already initialized');
  }
  queueManager = new QueueManager(config);
  return queueManager;
}

/**
 * Get the queue manager instance
 */
export function getQueueManager(): QueueManager {
  if (queueManager === null) {
    throw new Error('Queue manager not initialized. Call initQueueManager first.');
  }
  return queueManager;
}

/**
 * Close the queue manager
 */
export async function closeQueueManager(): Promise<void> {
  if (queueManager !== null) {
    await queueManager.close();
    queueManager = null;
  }
}
