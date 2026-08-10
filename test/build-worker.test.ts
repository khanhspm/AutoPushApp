import type { Job } from 'bullmq';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { BuildJobDataV3, BuildRecord } from '../src/domain/build';
import { canonicalBuildJobData, createBuildProcessor, executionConfigFor } from '../src/queue/build-worker';
import type { BuildRepository } from '../src/repositories/build-repository';
import type { BuildLogService } from '../src/services/build-log-service';
import { notifyBuildFailed } from '../src/services/notification';

vi.mock('../src/services/notification', () => ({
  notifyBuildFailed: vi.fn(),
  notifyBuildSucceeded: vi.fn(),
}));

beforeEach(() => {
  vi.mocked(notifyBuildFailed).mockReset().mockResolvedValue(undefined);
});

describe('build worker payload integrity', () => {
  it('reconstructs execution data from the immutable database record', () => {
    const build: BuildRecord = {
      id: 'build-1',
      projectId: 'manual-app',
      projectKey: 'manual-app',
      projectName: 'Manual App',
      appVersion: '1.1',
      requestedScheme: 'OverrideScheme',
      buildNumber: '42',
      releaseNotes: 'Release candidate',
      source: 'cms',
      requestedBy: 'cms-admin',
      chatId: null,
      idempotencyKey: 'cms:build-1',
      queueJobId: 'build-1',
      status: 'queued',
      failurePhase: null,
      configSnapshot: {
        schemaVersion: 2,
        projectKey: 'manual-app',
        displayName: 'Manual App',
        repoPath: '/trusted/manual-app',
        fastlaneLane: 'distribute',
        scheme: 'ManualApp',
        buildConfiguration: 'Release',
        firebaseAppId: '1:123:ios:manual',
        firebaseTesterGroups: ['qa'],
        signingMode: 'manual',
        appleTeamId: 'AB12CDEFGH',
        signingCertificate: 'Apple Distribution',
        provisioningProfiles: [{ bundleId: 'com.example.app', profileName: 'Example App AdHoc' }],
        secretEnvRefs: { firebaseCliToken: 'MANUAL_FIREBASE_TOKEN' },
        projectVersion: 2,
      },
      retryOfId: null,
      attemptCount: 0,
      logRelativePath: null,
      errorMessage: null,
      queuedAt: null,
      startedAt: null,
      finishedAt: null,
      createdAt: '2026-08-06T00:00:00.000Z',
      updatedAt: '2026-08-06T00:00:00.000Z',
    };

    expect(canonicalBuildJobData(build)).toEqual({
      schemaVersion: 3,
      buildId: 'build-1',
      config: build.configSnapshot,
      request: {
        appVersion: '1.1',
        scheme: 'OverrideScheme',
        buildNumber: '42',
        releaseNotes: 'Release candidate',
        source: 'cms',
        requestedBy: 'cms-admin',
        chatId: null,
      },
    });
  });

  it('uses the requested scheme and falls back to the project snapshot', () => {
    const overrideJob: BuildJobDataV3 = {
      schemaVersion: 3,
      buildId: 'build-override',
      config: {
        schemaVersion: 1,
        projectKey: 'app',
        displayName: 'App',
        repoPath: '/tmp/app',
        fastlaneLane: 'distribute',
        scheme: 'ProjectScheme',
        firebaseAppId: '1:123:ios:app',
        firebaseTesterGroups: ['qa'],
        secretEnvRefs: { firebaseCliToken: 'APP_FIREBASE_TOKEN' },
        projectVersion: 1,
      },
      request: {
        appVersion: '1.1',
        scheme: 'OverrideScheme',
        buildNumber: '6',
        releaseNotes: '',
        source: 'cms',
        requestedBy: 'cms-admin',
      },
    };

    expect(executionConfigFor(overrideJob).scheme).toBe('OverrideScheme');
    expect(executionConfigFor({ ...overrideJob, request: { ...overrideJob.request, scheme: null } }).scheme).toBe('ProjectScheme');
  });

  it('notifies the project group when a running build is recovered as interrupted', async () => {
    const runningBuild: BuildRecord = {
      id: 'build-interrupted',
      projectId: 'manual-app',
      projectKey: 'manual-app',
      projectName: 'Manual App',
      appVersion: '1.1',
      requestedScheme: null,
      buildNumber: '43',
      releaseNotes: '',
      source: 'cms',
      requestedBy: 'cms-admin',
      chatId: null,
      idempotencyKey: 'cms:build-interrupted',
      queueJobId: 'build-interrupted',
      status: 'running',
      failurePhase: null,
      configSnapshot: {
        schemaVersion: 2,
        projectKey: 'manual-app',
        displayName: 'Manual App',
        repoPath: '/trusted/manual-app',
        fastlaneLane: 'distribute',
        firebaseAppId: '1:123:ios:manual',
        firebaseTesterGroups: ['qa'],
        signingMode: 'manual',
        appleTeamId: 'AB12CDEFGH',
        signingCertificate: 'Apple Distribution',
        provisioningProfiles: [{ bundleId: 'com.example.app', profileName: 'Example App AdHoc' }],
        larkNotificationChatId: 'oc_project_group',
        secretEnvRefs: { firebaseCliToken: 'MANUAL_FIREBASE_TOKEN' },
        projectVersion: 2,
      },
      retryOfId: null,
      attemptCount: 1,
      logRelativePath: null,
      errorMessage: null,
      queuedAt: '2026-08-06T00:00:00.000Z',
      startedAt: '2026-08-06T00:01:00.000Z',
      finishedAt: null,
      createdAt: '2026-08-06T00:00:00.000Z',
      updatedAt: '2026-08-06T00:01:00.000Z',
    };
    const builds = {
      findById: vi.fn(() => runningBuild),
      markFailed: vi.fn(() => true),
    } as unknown as BuildRepository;
    const processor = createBuildProcessor({
      builds,
      logs: {} as BuildLogService,
    });
    const data: BuildJobDataV3 = canonicalBuildJobData(runningBuild);

    await processor({ id: runningBuild.id, data } as Job<BuildJobDataV3>);

    expect(builds.markFailed).toHaveBeenCalledWith(
      runningBuild.id,
      expect.stringContaining('Worker restarted'),
      'interrupted',
      ['running'],
    );
    expect(notifyBuildFailed).toHaveBeenCalledWith(
      expect.objectContaining({
        buildId: runningBuild.id,
        request: expect.objectContaining({ appVersion: '1.1', buildNumber: '43' }),
      }),
    );
  });
});
