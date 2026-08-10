import os from 'node:os';

import IORedis from 'ioredis';

export interface WorkerHeartbeatState {
  runnerId: string;
  hostname: string;
  startedAt: string;
  lastSeenAt: string;
  currentBuildId: string | null;
}

export function startWorkerHeartbeat(redis: IORedis, runnerId: string) {
  const key = `autopush:runner:${runnerId}`;
  const startedAt = new Date().toISOString();
  let currentBuildId: string | null = null;

  const publish = async (): Promise<void> => {
    const state: WorkerHeartbeatState = {
      runnerId,
      hostname: os.hostname(),
      startedAt,
      lastSeenAt: new Date().toISOString(),
      currentBuildId,
    };

    await redis.set(key, JSON.stringify(state), 'EX', 30);
  };

  void publish();
  const interval = setInterval(() => void publish(), 10_000);
  interval.unref();

  return {
    async setCurrentBuild(buildId: string | null): Promise<void> {
      currentBuildId = buildId;
      await publish();
    },
    async close(): Promise<void> {
      clearInterval(interval);
      await redis.del(key);
    },
  };
}

export async function getWorkerHeartbeat(redis: IORedis, runnerId: string): Promise<WorkerHeartbeatState | null> {
  const value = await redis.get(`autopush:runner:${runnerId}`);
  return value ? (JSON.parse(value) as WorkerHeartbeatState) : null;
}
