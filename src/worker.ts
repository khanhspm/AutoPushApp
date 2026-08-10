import { env } from './config/env';
import { createMigratedDatabase } from './db/migrate';
import { createRedisConnection } from './queue/build-queue';
import { createBuildWorker } from './queue/build-worker';
import { startWorkerHeartbeat } from './queue/worker-heartbeat';
import { BuildRepository } from './repositories/build-repository';
import { BuildLogService } from './services/build-log-service';
import { logger } from './utils/logger';

async function main(): Promise<void> {
  const database = createMigratedDatabase(env.DB_PATH);
  const redis = createRedisConnection(env.REDIS_URL);
  const heartbeat = startWorkerHeartbeat(redis, env.RUNNER_ID);
  const worker = createBuildWorker(redis, {
    builds: new BuildRepository(database),
    logs: new BuildLogService(env.LOG_DIR),
    heartbeat,
  });

  let closing = false;
  const shutdown = async (signal: string) => {
    if (closing) return;
    closing = true;
    logger.info({ signal }, 'Stopping build worker');
    await worker.close();
    await heartbeat.close();
    await redis.quit();
    database.close();
  };

  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));

  logger.info({ runnerId: env.RUNNER_ID }, 'Build worker is running');
}

main().catch((error) => {
  logger.fatal({ error }, 'Build worker failed to start');
  process.exitCode = 1;
});
