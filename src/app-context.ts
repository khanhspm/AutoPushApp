import IORedis from 'ioredis';

import type { AppDatabase } from './db/database';
import type { BuildQueueGateway } from './queue/build-queue';
import type { BuildRepository } from './repositories/build-repository';
import type { ProjectRepository } from './repositories/project-repository';
import type { UserRepository } from './repositories/user-repository';
import type { BuildLogService } from './services/build-log-service';
import type { BuildRequestService } from './services/build-request-service';
import type { ProjectConfigService } from './services/project-config-service';
import type { ProjectSetupGateway } from './services/project-setup-service';
import type { RepositoryFolderChooserGateway } from './services/repository-folder-chooser-service';
import type { RepositoryDiscoveryGateway } from './services/repository-discovery-service';
import type { SigningDiscoveryGateway } from './services/signing-discovery-service';
import type { SigningProfileChooserGateway } from './services/signing-profile-chooser-service';

export interface AppContext {
  database: AppDatabase;
  redis: IORedis;
  queue: BuildQueueGateway;
  projects: ProjectRepository;
  users: UserRepository;
  builds: BuildRepository;
  projectConfig: ProjectConfigService;
  projectSetup: ProjectSetupGateway;
  buildRequests: BuildRequestService;
  logs: BuildLogService;
  repositoryDiscovery: RepositoryDiscoveryGateway;
  repositoryFolderChooser: RepositoryFolderChooserGateway;
  signingDiscovery: SigningDiscoveryGateway;
  signingProfileChooser: SigningProfileChooserGateway;
}
