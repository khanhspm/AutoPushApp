import { Job, Queue } from 'bullmq';
import IORedis from 'ioredis';

import type { BuildJobDataV3 } from '../domain/build';

export const BUILD_QUEUE_NAME = 'ios-build-v3';

export interface BuildQueueGateway {
  enqueue(data: BuildJobDataV3): Promise<{ id: string }>;
  getJob(buildId: string): Promise<Job<BuildJobDataV3> | null>;
  getCounts(): Promise<Record<string, number>>;
  close(): Promise<void>;
}

export function createRedisConnection(redisUrl: string): IORedis {
  return new IORedis(redisUrl, { maxRetriesPerRequest: null });
}

export function createBuildQueue(connection: IORedis): BuildQueueGateway {
  const queue = new Queue<BuildJobDataV3>(BUILD_QUEUE_NAME, {
    connection,
    defaultJobOptions: {
      attempts: 1,
      removeOnComplete: 100,
      removeOnFail: 200,
    },
  });

  return {
    async enqueue(data) {
      const job = await queue.add('ios-build', data, { jobId: data.buildId });
      return { id: String(job.id) };
    },
    async getJob(buildId) {
      return (await queue.getJob(buildId)) ?? null;
    },
    getCounts() {
      return queue.getJobCounts('waiting', 'active', 'completed', 'failed', 'delayed', 'paused');
    },
    close() {
      return queue.close();
    },
  };
}
