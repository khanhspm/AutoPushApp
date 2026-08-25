import { buildApp } from './app';
import type { AppContext } from './app-context';
import { env } from './config/env';
import { createMigratedDatabase } from './db/migrate';
import { createBuildQueue, createRedisConnection } from './queue/build-queue';
import { BuildRepository } from './repositories/build-repository';
import { ProjectRepository } from './repositories/project-repository';
import { UserRepository } from './repositories/user-repository';
import { BuildLogService } from './services/build-log-service';
import { BuildRequestService } from './services/build-request-service';
import { BundlerService } from './services/bundler-service';
import { ProjectConfigService } from './services/project-config-service';
import { ProjectSetupService } from './services/project-setup-service';
import { RepositoryFolderChooserService } from './services/repository-folder-chooser-service';
import { RepositoryDiscoveryService } from './services/repository-discovery-service';
import { SigningDiscoveryService } from './services/signing-discovery-service';
import { SigningProfileChooserService } from './services/signing-profile-chooser-service';
import { logger } from './utils/logger';

export function createAppContext(): AppContext {
  const database = createMigratedDatabase(env.DB_PATH);
  const redis = createRedisConnection(env.REDIS_URL);
  const queue = createBuildQueue(redis);
  const projects = new ProjectRepository(database);
  const users = new UserRepository(database);
  const builds = new BuildRepository(database);
  const repositoryDiscovery = new RepositoryDiscoveryService(env.IOS_REPO_ROOTS);
  const bundler = new BundlerService();
  const projectConfig = new ProjectConfigService(projects, repositoryDiscovery, process.env, bundler);
  const projectSetup = new ProjectSetupService(projects, repositoryDiscovery, bundler, projectConfig);
  const logs = new BuildLogService(env.LOG_DIR);
  const buildRequests = new BuildRequestService(builds, users, projectConfig, queue);

  return {
    database,
    redis,
    queue,
    projects,
    users,
    builds,
    projectConfig,
    projectSetup,
    buildRequests,
    logs,
    repositoryDiscovery,
    repositoryFolderChooser: new RepositoryFolderChooserService(),
    signingDiscovery: new SigningDiscoveryService(),
    signingProfileChooser: new SigningProfileChooserService(),
  };
}

async function main(): Promise<void> {
  const context = createAppContext();
  const app = await buildApp(context);
  await context.buildRequests.reconcileEnqueueing();

  let closing = false;
  const shutdown = async (signal: string) => {
    if (closing) return;
    closing = true;
    logger.info({ signal }, 'Stopping AutoPushApp API');
    await app.close();
    await context.queue.close();
    await context.redis.quit();
    context.database.close();
  };

  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));

  await app.listen({ host: env.HOST, port: env.PORT });
}

if (require.main === module) {
  main().catch((error) => {
    logger.fatal({ error }, 'AutoPushApp failed to start');
    process.exitCode = 1;
  });
}
