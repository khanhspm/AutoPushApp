import { coreEntitiesMigration } from './001-core-entities';
import { buildRecordsV2Migration } from './002-build-records-v2';
import { projectSigningConfigMigration } from './003-project-signing-config';
import { projectLarkNotificationChatMigration } from './004-project-lark-notification-chat';
import { buildAppVersionMigration } from './005-build-app-version';
import { buildRequestedSchemeMigration } from './006-build-requested-scheme';
import type { Migration } from './types';

export const migrations: readonly Migration[] = [
  coreEntitiesMigration,
  buildRecordsV2Migration,
  projectSigningConfigMigration,
  projectLarkNotificationChatMigration,
  buildAppVersionMigration,
  buildRequestedSchemeMigration,
];

export type { Migration } from './types';
