import IORedis from 'ioredis';

import type { AppDatabase } from './db/database';
import type { BuildQueueGateway } from './queue/build-queue';
import type { BuildRepository } from './repositories/build-repository';
import type { ProjectRepository } from './repositories/project-repository';
import type { UserRepository } from './repositories/user-repository';
import type { BuildLogService } from './services/build-log-service';
import type { BuildRequestService } from './services/build-request-service';
import type { ProjectConfigService } from './services/project-config-service';

export interface AppContext {
  database: AppDatabase;
  redis: IORedis;
  queue: BuildQueueGateway;
  projects: ProjectRepository;
  users: UserRepository;
  builds: BuildRepository;
  projectConfig: ProjectConfigService;
  buildRequests: BuildRequestService;
  logs: BuildLogService;
}
