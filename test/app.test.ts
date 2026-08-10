import type { Job } from 'bullmq';
import type IORedis from 'ioredis';
import { afterEach, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app';
import type { AppContext } from '../src/app-context';
import { env } from '../src/config/env';
import { createDatabase, type AppDatabase } from '../src/db/database';
import { migrateDatabase } from '../src/db/migrate';
import type { BuildJobDataV3 } from '../src/domain/build';
import type { BuildQueueGateway } from '../src/queue/build-queue';
import { BuildRepository } from '../src/repositories/build-repository';
import { ProjectRepository } from '../src/repositories/project-repository';
import { UserRepository } from '../src/repositories/user-repository';
import { BuildLogService } from '../src/services/build-log-service';
import { BuildRequestService } from '../src/services/build-request-service';
import { ProjectConfigService } from '../src/services/project-config-service';

const databases: AppDatabase[] = [];

function context(): AppContext {
  const database = createDatabase(':memory:');
  databases.push(database);
  migrateDatabase(database);
  const projects = new ProjectRepository(database);
  const users = new UserRepository(database);
  const builds = new BuildRepository(database);
  const queue: BuildQueueGateway = {
    async enqueue(data) {
      return { id: data.buildId };
    },
    async getJob() {
      return null as Job<BuildJobDataV3> | null;
    },
    async getCounts() {
      return { waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0, paused: 0 };
    },
    async close() {},
  };
  const projectConfig = new ProjectConfigService(projects, []);
  const redis = {
    async ping() {
      return 'PONG';
    },
    async get() {
      return null;
    },
  } as unknown as IORedis;

  return {
    database,
    redis,
    queue,
    projects,
    users,
    builds,
    projectConfig,
    buildRequests: new BuildRequestService(builds, users, projectConfig, queue),
    logs: new BuildLogService('/tmp/autopush-test-logs'),
  };
}

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

describe('CMS API', () => {
  it('keeps health public and protects CMS routes', async () => {
    const app = await buildApp(context());

    expect((await app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/projects' })).statusCode).toBe(401);

    await app.close();
  });

  it('creates a disabled project with the admin token', async () => {
    const app = await buildApp(context());
    const response = await app.inject({
      method: 'POST',
      url: '/api/projects',
      headers: { authorization: `Bearer ${env.CMS_ADMIN_TOKEN}` },
      payload: {
        projectKey: 'MyApp',
        displayName: 'My App',
        repoPath: '/tmp/MyApp',
        fastlaneLane: 'distribute',
        scheme: 'MyApp',
        firebaseAppId: '1:123:ios:abc',
        firebaseTesterGroups: ['qa'],
        firebaseCliTokenEnvVar: 'MYAPP_FIREBASE_TOKEN',
        signingMode: 'match',
        appleTeamId: 'inactive-invalid-team',
        signingCertificate: '',
        provisioningProfiles: [{ bundleId: 'inactive*bundle', profileName: '' }],
        larkNotificationChatId: 'oc_my_app_group',
        enabled: false,
      },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json().project).toMatchObject({
      projectKey: 'MyApp',
      buildConfiguration: 'Debug',
      enabled: false,
      larkNotificationChatId: 'oc_my_app_group',
    });
    await app.close();
  });

  it('rejects secret values where environment variable references are required', async () => {
    const app = await buildApp(context());
    const response = await app.inject({
      method: 'POST',
      url: '/api/projects',
      headers: { authorization: `Bearer ${env.CMS_ADMIN_TOKEN}` },
      payload: {
        projectKey: 'UnsafeApp',
        displayName: 'Unsafe App',
        repoPath: '/tmp/UnsafeApp',
        fastlaneLane: 'distribute',
        firebaseAppId: '1:123:ios:unsafe',
        firebaseTesterGroups: ['qa'],
        firebaseCliTokenEnvVar: '1//actual-firebase-token',
        enabled: false,
      },
    });

    expect(response.statusCode).toBe(400);
    await app.close();
  });

  it('rejects malformed project Lark notification chat IDs', async () => {
    const app = await buildApp(context());
    const response = await app.inject({
      method: 'POST',
      url: '/api/projects',
      headers: { authorization: `Bearer ${env.CMS_ADMIN_TOKEN}` },
      payload: {
        projectKey: 'LarkApp',
        displayName: 'Lark App',
        repoPath: '/tmp/LarkApp',
        fastlaneLane: 'distribute',
        firebaseAppId: '1:123:ios:lark',
        firebaseTesterGroups: ['qa'],
        firebaseCliTokenEnvVar: 'LARKAPP_FIREBASE_TOKEN',
        larkNotificationChatId: 'invalid-chat-id',
        enabled: false,
      },
    });

    expect(response.statusCode).toBe(400);
    await app.close();
  });
});
