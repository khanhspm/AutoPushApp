import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createDatabase, type AppDatabase } from '../src/db/database';
import { migrateDatabase } from '../src/db/migrate';
import type { BuildJobDataV3 } from '../src/domain/build';
import type { BuildQueueGateway } from '../src/queue/build-queue';
import { BuildRepository } from '../src/repositories/build-repository';
import { ProjectRepository } from '../src/repositories/project-repository';
import { UserRepository } from '../src/repositories/user-repository';
import { BuildRequestService } from '../src/services/build-request-service';
import { notifyBuildFailed } from '../src/services/notification';
import type { ProjectConfigService } from '../src/services/project-config-service';

vi.mock('../src/services/notification', () => ({
  notifyBuildFailed: vi.fn(),
}));

const databases: AppDatabase[] = [];

function setup(queueOverrides: Partial<BuildQueueGateway> = {}) {
  const database = createDatabase(':memory:');
  databases.push(database);
  migrateDatabase(database);

  const projects = new ProjectRepository(database);
  const project = projects.create({
    projectKey: 'MyApp',
    displayName: 'My App',
    repoPath: '/tmp/my-app',
    fastlaneLane: 'distribute',
    scheme: 'MyApp',
    firebaseAppId: '1:123:ios:abc',
    firebaseTesterGroups: ['qa'],
    firebaseCliTokenEnvVar: 'MYAPP_FIREBASE_TOKEN',
    larkNotificationChatId: 'oc_project_group',
  });
  projects.setValidation(project.projectKey, 'valid', 'ok');
  projects.setEnabled(project.projectKey, true);
  const config = projects.toSnapshot(projects.findByKey(project.projectKey)!);
  const builds = new BuildRepository(database);
  const users = new UserRepository(database);
  const queue: BuildQueueGateway = {
    enqueue: vi.fn(async (data: BuildJobDataV3) => ({ id: data.buildId })),
    getJob: vi.fn(async () => null),
    getCounts: vi.fn(async () => ({})),
    close: vi.fn(async () => undefined),
    ...queueOverrides,
  };
  const projectConfig = {
    resolveForBuild: vi.fn(async () => config),
  } as unknown as ProjectConfigService;

  return {
    database,
    builds,
    config,
    users,
    queue,
    service: new BuildRequestService(builds, users, projectConfig, queue),
  };
}

beforeEach(() => {
  vi.mocked(notifyBuildFailed).mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

describe('build request app versions and terminal notifications', () => {
  it('persists the app version and queues duplicate submissions only once', async () => {
    const { queue, service } = setup();
    const input = {
      projectKey: 'MyApp',
      appVersion: '1.1',
      scheme: 'MyApp-Debug',
      buildNumber: '6',
      releaseNotes: 'Release candidate',
      source: 'cms' as const,
      requestedBy: 'cms-admin',
      idempotencyKey: 'cms:request-6',
    };

    const first = await service.submit(input);
    const duplicate = await service.submit(input);

    expect(first.created).toBe(true);
    expect(first.build).toMatchObject({ status: 'queued', appVersion: '1.1', requestedScheme: 'MyApp-Debug', buildNumber: '6' });
    expect(queue.enqueue).toHaveBeenCalledWith(expect.objectContaining({
      request: expect.objectContaining({ scheme: 'MyApp-Debug' }),
    }));
    expect(duplicate.created).toBe(false);
    expect(duplicate.build.id).toBe(first.build.id);
    expect(queue.enqueue).toHaveBeenCalledTimes(1);
    expect(notifyBuildFailed).not.toHaveBeenCalled();
  });

  it('requires an app version only for new idempotency keys', async () => {
    const { builds, config, service } = setup();
    builds.createEnqueueing({
      id: 'legacy-existing',
      projectId: config.projectKey,
      config,
      request: {
        buildNumber: '5',
        releaseNotes: '',
        source: 'cms',
        requestedBy: 'cms-admin',
        chatId: null,
      },
      idempotencyKey: 'cms:legacy-request',
    });

    await expect(service.submit({
      projectKey: 'MyApp',
      buildNumber: '7',
      source: 'cms',
      requestedBy: 'cms-admin',
      idempotencyKey: 'cms:new-request',
    })).rejects.toMatchObject({ statusCode: 400, code: 'APP_VERSION_INVALID' });

    await expect(service.submit({
      projectKey: 'MyApp',
      buildNumber: '5',
      source: 'cms',
      requestedBy: 'cms-admin',
      idempotencyKey: 'cms:legacy-request',
    })).resolves.toMatchObject({ created: false, build: { id: 'legacy-existing', appVersion: null } });
  });

  it('routes enqueue failures through the shared failure notification', async () => {
    const enqueueError = new Error('Redis unavailable');
    const { service } = setup({
      enqueue: vi.fn(async () => {
        throw enqueueError;
      }),
    });

    const result = await service.submit({
      projectKey: 'MyApp',
      appVersion: '1.1',
      buildNumber: '8',
      source: 'cms',
      requestedBy: 'cms-admin',
      idempotencyKey: 'cms:request-8',
    });

    expect(result.build.status).toBe('failed');
    expect(result.build.failurePhase).toBe('enqueue');
    expect(notifyBuildFailed).toHaveBeenCalledWith(
      expect.objectContaining({
        buildId: result.build.id,
        request: expect.objectContaining({ appVersion: '1.1', buildNumber: '8' }),
      }),
    );
  });

  it('reconciles stale enqueueing builds without a queued notification', async () => {
    const { builds, config, database, service } = setup({
      getJob: vi.fn(async (buildId: string) => ({ id: buildId }) as never),
    });
    builds.createEnqueueing({
      id: 'build-reconcile',
      projectId: config.projectKey,
      config,
      request: {
        appVersion: '1.1',
        scheme: 'ReconcileScheme',
        buildNumber: '9',
        releaseNotes: '',
        source: 'cms',
        requestedBy: 'cms-admin',
        chatId: null,
      },
      idempotencyKey: 'cms:request-9',
    });
    database.prepare("UPDATE build_records SET created_at = datetime('now', '-1 minute') WHERE id = ?").run('build-reconcile');

    await service.reconcileEnqueueing();

    expect(builds.findById('build-reconcile')).toMatchObject({ status: 'queued', requestedScheme: 'ReconcileScheme' });
    expect(notifyBuildFailed).not.toHaveBeenCalled();
  });

  it('ignores scheme overrides from Lark and uses the project snapshot', async () => {
    const { service, users } = setup();
    users.create({ id: 'ou_builder', displayName: 'Builder' });
    users.replaceProjectPermissions('ou_builder', ['MyApp']);

    const result = await service.submit({
      projectKey: 'MyApp',
      appVersion: '1.1',
      scheme: 'UntrustedScheme',
      buildNumber: '11',
      source: 'lark',
      requestedBy: 'ou_builder',
      chatId: 'oc_source_group',
      idempotencyKey: 'lark:request-11',
    });

    expect(result.build).toMatchObject({ requestedScheme: null });
    expect(result.build.configSnapshot.scheme).toBe('MyApp');
  });

  it('inherits app version on retry and requires an override for legacy builds', async () => {
    const { builds, config, service } = setup();
    builds.createEnqueueing({
      id: 'modern-failed',
      projectId: config.projectKey,
      config,
      request: {
        appVersion: '1.1',
        scheme: 'RetryScheme',
        buildNumber: '10',
        releaseNotes: '',
        source: 'cms',
        requestedBy: 'cms-admin',
        chatId: null,
      },
      idempotencyKey: 'cms:modern-original',
    });
    builds.markEnqueueFailed('modern-failed', 'failed');
    builds.createEnqueueing({
      id: 'legacy-failed',
      projectId: config.projectKey,
      config,
      request: {
        buildNumber: '4',
        releaseNotes: '',
        source: 'cms',
        requestedBy: 'cms-admin',
        chatId: null,
      },
      idempotencyKey: 'cms:legacy-original',
    });
    builds.markEnqueueFailed('legacy-failed', 'failed');

    await expect(service.retry('modern-failed', 'cms:modern-retry', 'cms-admin')).resolves.toMatchObject({
      build: { appVersion: '1.1', requestedScheme: 'RetryScheme', buildNumber: '10' },
    });
    await expect(service.retry('legacy-failed', 'cms:legacy-retry-missing', 'cms-admin')).rejects.toMatchObject({
      statusCode: 400,
      code: 'APP_VERSION_INVALID',
    });
    await expect(service.retry('legacy-failed', 'cms:legacy-retry', 'cms-admin', { appVersion: '1.2' })).resolves.toMatchObject({
      build: { appVersion: '1.2', buildNumber: '4' },
    });
  });
});
