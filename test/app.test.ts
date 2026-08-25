import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { Job } from 'bullmq';
import type IORedis from 'ioredis';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildApp } from '../src/app';
import type { AppContext } from '../src/app-context';
import { env } from '../src/config/env';
import { createDatabase, type AppDatabase } from '../src/db/database';
import { migrateDatabase } from '../src/db/migrate';
import type { BuildJobDataV3 } from '../src/domain/build';
import type { Project, ProjectInput } from '../src/domain/project';
import type { RepositoryCandidate } from '../src/domain/repository';
import { AppError } from '../src/http/errors';
import type { BuildQueueGateway } from '../src/queue/build-queue';
import { BuildRepository } from '../src/repositories/build-repository';
import { ProjectRepository } from '../src/repositories/project-repository';
import { UserRepository } from '../src/repositories/user-repository';
import { BuildLogService } from '../src/services/build-log-service';
import { BuildRequestService } from '../src/services/build-request-service';
import { ProjectConfigService } from '../src/services/project-config-service';
import type { ProjectSetupGateway } from '../src/services/project-setup-service';
import type { RepositoryFolderChooserGateway } from '../src/services/repository-folder-chooser-service';
import { RepositoryDiscoveryService, type RepositoryDiscoveryGateway } from '../src/services/repository-discovery-service';
import type { SigningDiscoveryGateway } from '../src/services/signing-discovery-service';
import type { SigningProfileChooserGateway } from '../src/services/signing-profile-chooser-service';

const databases: AppDatabase[] = [];
const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const created = await fs.mkdtemp(path.join(os.tmpdir(), 'autopush-app-'));
  const directory = await fs.realpath(created);
  temporaryDirectories.push(directory);
  return directory;
}

function repositoryCandidate(repoPath: string): RepositoryCandidate {
  return {
    path: repoPath.trim(),
    name: repoPath.split('/').filter(Boolean).at(-1) ?? repoPath,
    rootPath: '/tmp',
    relativePath: repoPath.replace(/^\/tmp\/?/, ''),
    displayLabel: repoPath,
    hasGit: false,
  };
}

function context(
  signingDiscoveryOverrides: Partial<SigningDiscoveryGateway> = {},
  repositoryDiscovery: RepositoryDiscoveryGateway = {
    async discover() {
      return { repositories: [], warnings: [], truncated: false };
    },
    async resolveCandidate(repoPath) {
      return repositoryCandidate(repoPath);
    },
    hasConfiguredRoots() {
      return true;
    },
  },
  repositoryFolderChooser: RepositoryFolderChooserGateway = {
    async chooseFolder() {
      return null;
    },
  },
  signingProfileChooser: SigningProfileChooserGateway = {
    async chooseProfile() {
      return null;
    },
  },
): AppContext {
  const signingDiscovery: SigningDiscoveryGateway = {
    async discover(bundleId) {
      return { bundleId, profiles: [], warnings: [] };
    },
    async importProfile(_profileData, expectedBundleId) {
      return { bundleId: expectedBundleId ?? 'com.example.app', profiles: [], warnings: [], importedProfileUuid: 'imported-profile' };
    },
    ...signingDiscoveryOverrides,
  };
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
  const projectConfig = new ProjectConfigService(projects, repositoryDiscovery);
  const projectSetup: ProjectSetupGateway = {
    async setupAndValidate(projectKey) {
      const project = projects.findByKey(projectKey);
      if (!project) throw new AppError(404, 'PROJECT_NOT_FOUND', 'Project was not found');
      const validation = { valid: true, message: 'Project configuration is valid', canonicalRepoPath: project.repoPath };
      const recorded = projects.setValidation(projectKey, 'valid', validation.message, project.version)!;
      return { dependenciesInstalled: false, validation, project: recorded };
    },
  };
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
    projectSetup,
    buildRequests: new BuildRequestService(builds, users, projectConfig, queue),
    logs: new BuildLogService('/tmp/autopush-test-logs'),
    repositoryDiscovery,
    repositoryFolderChooser,
    signingDiscovery,
    signingProfileChooser,
  };
}

afterEach(async () => {
  for (const database of databases.splice(0)) database.close();
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

function projectPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    projectKey: 'RepositoryApp',
    displayName: 'Repository App',
    repoPath: '/tmp/RepositoryApp',
    fastlaneLane: 'distribute',
    scheme: 'RepositoryApp',
    buildConfiguration: 'Debug',
    firebaseAppId: '1:123:ios:repository',
    firebaseTesterGroups: ['qa'],
    firebaseCliTokenEnvVar: 'REPOSITORY_FIREBASE_TOKEN',
    signingMode: 'match',
    appleTeamId: null,
    signingCertificate: 'Apple Distribution',
    provisioningProfiles: [],
    enabled: false,
    ...overrides,
  };
}

function projectUpdatePayload(project: Project, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const { projectKey: _projectKey, validationStatus: _validationStatus, validationMessage: _validationMessage,
    validatedAt: _validatedAt, createdAt: _createdAt, updatedAt: _updatedAt, ...input } = project;
  return { ...input, ...overrides };
}

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

  it('protects repository discovery and accepts only an empty query', async () => {
    const discover = vi.fn(async () => ({ repositories: [], warnings: [], truncated: false }));
    const repositoryDiscovery: RepositoryDiscoveryGateway = {
      discover,
      async resolveCandidate(repoPath) {
        return repositoryCandidate(repoPath);
      },
      hasConfiguredRoots: () => true,
    };
    const app = await buildApp(context(undefined, repositoryDiscovery));

    expect((await app.inject({ method: 'GET', url: '/api/repositories' })).statusCode).toBe(401);
    const response = await app.inject({
      method: 'GET',
      url: '/api/repositories',
      headers: { authorization: `Bearer ${env.CMS_ADMIN_TOKEN}` },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ repositories: [], warnings: [], truncated: false });
    expect(discover).toHaveBeenCalledOnce();

    const invalidQuery = await app.inject({
      method: 'GET',
      url: '/api/repositories?root=/tmp&depth=8',
      headers: { authorization: `Bearer ${env.CMS_ADMIN_TOKEN}` },
    });
    expect(invalidQuery.statusCode).toBe(400);
    expect(invalidQuery.json().error.code).toBe('VALIDATION_ERROR');
    expect(discover).toHaveBeenCalledOnce();
    await app.close();
  });

  it('opens the authenticated native repository chooser and validates its selection', async () => {
    const chooseFolder = vi.fn(async () => '/selected/RepositoryApp');
    const resolveCandidate = vi.fn(async () => repositoryCandidate('/canonical/RepositoryApp'));
    const repositoryDiscovery: RepositoryDiscoveryGateway = {
      discover: vi.fn(),
      resolveCandidate,
      hasConfiguredRoots: () => true,
    };
    const app = await buildApp(context(undefined, repositoryDiscovery, { chooseFolder }));
    const headers = { authorization: `Bearer ${env.CMS_ADMIN_TOKEN}` };

    expect((await app.inject({ method: 'POST', url: '/api/repositories/choose' })).statusCode).toBe(401);
    const selected = await app.inject({ method: 'POST', url: '/api/repositories/choose', headers });
    expect(selected.statusCode).toBe(200);
    expect(selected.json()).toEqual({ repository: repositoryCandidate('/canonical/RepositoryApp') });
    expect(chooseFolder).toHaveBeenCalledOnce();
    expect(resolveCandidate).toHaveBeenCalledWith('/selected/RepositoryApp');

    const invalidQuery = await app.inject({ method: 'POST', url: '/api/repositories/choose?root=/tmp', headers });
    const invalidBody = await app.inject({ method: 'POST', url: '/api/repositories/choose', headers, payload: {} });
    expect(invalidQuery.statusCode).toBe(400);
    expect(invalidBody.statusCode).toBe(400);
    expect(chooseFolder).toHaveBeenCalledOnce();
    await app.close();
  });

  it('initializes missing Fastlane files when the native chooser selects an empty allowed folder', async () => {
    const root = await temporaryDirectory();
    const selectedPath = path.join(root, 'UnpreparedApp');
    await fs.mkdir(selectedPath);
    const repositoryDiscovery = new RepositoryDiscoveryService([root]);
    const app = await buildApp(context(undefined, repositoryDiscovery, {
      async chooseFolder() {
        return selectedPath;
      },
    }));

    const response = await app.inject({
      method: 'POST',
      url: '/api/repositories/choose',
      headers: { authorization: `Bearer ${env.CMS_ADMIN_TOKEN}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().repository).toMatchObject({ path: selectedPath, rootPath: root, name: 'UnpreparedApp' });
    expect((await fs.stat(path.join(selectedPath, 'Gemfile'))).isFile()).toBe(true);
    expect((await fs.stat(path.join(selectedPath, 'fastlane', 'Fastfile'))).isFile()).toBe(true);
    expect((await fs.stat(path.join(selectedPath, 'fastlane', 'Pluginfile'))).isFile()).toBe(true);
    await app.close();
  });

  it('returns no content when native repository selection is cancelled', async () => {
    const app = await buildApp(context(undefined, undefined, { async chooseFolder() { return null; } }));
    const response = await app.inject({
      method: 'POST',
      url: '/api/repositories/choose',
      headers: { authorization: `Bearer ${env.CMS_ADMIN_TOKEN}` },
    });
    expect(response.statusCode).toBe(204);
    expect(response.body).toBe('');
    await app.close();
  });

  it('canonicalizes repository paths before create and update persistence', async () => {
    const resolveCandidate = vi.fn(async (repoPath: string) => repositoryCandidate(
      repoPath.includes('Replacement') ? '/canonical/Replacement' : '/canonical/RepositoryApp',
    ));
    const repositoryDiscovery: RepositoryDiscoveryGateway = {
      discover: vi.fn(),
      resolveCandidate,
      hasConfiguredRoots: () => true,
    };
    const appContext = context(undefined, repositoryDiscovery);
    const app = await buildApp(appContext);
    const headers = { authorization: `Bearer ${env.CMS_ADMIN_TOKEN}` };

    const created = await app.inject({
      method: 'POST',
      url: '/api/projects',
      headers,
      payload: projectPayload({ repoPath: '/submitted/RepositoryApp' }),
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().project.repoPath).toBe('/canonical/RepositoryApp');
    expect(appContext.projects.findByKey('RepositoryApp')?.repoPath).toBe('/canonical/RepositoryApp');

    const current = appContext.projects.findByKey('RepositoryApp')!;
    const updated = await app.inject({
      method: 'PUT',
      url: '/api/projects/RepositoryApp',
      headers,
      payload: projectUpdatePayload(current, { repoPath: '/submitted/Replacement' }),
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json().project.repoPath).toBe('/canonical/Replacement');
    expect(appContext.projects.findByKey('RepositoryApp')?.repoPath).toBe('/canonical/Replacement');
    expect(resolveCandidate).toHaveBeenNthCalledWith(1, '/submitted/RepositoryApp');
    expect(resolveCandidate).toHaveBeenNthCalledWith(2, '/submitted/Replacement');
    await app.close();
  });

  it('preserves an exact profile UUID when an older client resubmits an unchanged name mapping', async () => {
    const appContext = context();
    const app = await buildApp(appContext);
    const headers = { authorization: `Bearer ${env.CMS_ADMIN_TOKEN}` };
    const profileUuid = '11111111-1111-4111-8111-111111111111';
    const created = await app.inject({
      method: 'POST',
      url: '/api/projects',
      headers,
      payload: projectPayload({
        projectKey: 'UuidApp',
        provisioningProfiles: [{ bundleId: 'com.example.app', profileName: 'Example AdHoc', profileUuid }],
      }),
    });
    expect(created.statusCode).toBe(201);
    const current = appContext.projects.findByKey('UuidApp')!;

    const updated = await app.inject({
      method: 'PUT',
      url: '/api/projects/UuidApp',
      headers,
      payload: projectUpdatePayload(current, {
        displayName: 'Updated by legacy client',
        provisioningProfiles: [{ bundleId: 'com.example.app', profileName: 'Example AdHoc' }],
      }),
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json().project.provisioningProfiles).toEqual([
      { bundleId: 'com.example.app', profileName: 'Example AdHoc', profileUuid },
    ]);

    const latest = appContext.projects.findByKey('UuidApp')!;
    const invalidUuid = await app.inject({
      method: 'PUT',
      url: '/api/projects/UuidApp',
      headers,
      payload: projectUpdatePayload(latest, {
        provisioningProfiles: [{ bundleId: 'com.example.app', profileName: 'Example AdHoc', profileUuid: 'not-a-uuid' }],
      }),
    });
    expect(invalidUuid.statusCode).toBe(400);
    expect(appContext.projects.findByKey('UuidApp')).toEqual(latest);
    await app.close();
  });

  it('rejects invalid repository paths before create or update mutation', async () => {
    const resolveCandidate = vi.fn(async (repoPath: string) => {
      if (repoPath.includes('Invalid')) {
        throw new AppError(400, 'REPOSITORY_NOT_SELECTABLE', 'Repository is not selectable', {
          repoPath: ['Select a repository'],
        });
      }
      return repositoryCandidate('/canonical/ValidApp');
    });
    const repositoryDiscovery: RepositoryDiscoveryGateway = {
      discover: vi.fn(),
      resolveCandidate,
      hasConfiguredRoots: () => true,
    };
    const appContext = context(undefined, repositoryDiscovery);
    const app = await buildApp(appContext);
    const headers = { authorization: `Bearer ${env.CMS_ADMIN_TOKEN}` };

    const invalidCreate = await app.inject({
      method: 'POST',
      url: '/api/projects',
      headers,
      payload: projectPayload({ projectKey: 'InvalidCreate', repoPath: '/tmp/Invalid' }),
    });
    expect(invalidCreate.statusCode).toBe(400);
    expect(invalidCreate.json().error).toMatchObject({
      code: 'REPOSITORY_NOT_SELECTABLE',
      fields: { repoPath: ['Select a repository'] },
    });
    expect(appContext.projects.findByKey('InvalidCreate')).toBeNull();

    const validCreate = await app.inject({
      method: 'POST',
      url: '/api/projects',
      headers,
      payload: projectPayload({ projectKey: 'ValidApp' }),
    });
    expect(validCreate.statusCode).toBe(201);
    const before = appContext.projects.findByKey('ValidApp')!;

    const invalidUpdate = await app.inject({
      method: 'PUT',
      url: '/api/projects/ValidApp',
      headers,
      payload: projectUpdatePayload(before, { displayName: 'Should Not Persist', repoPath: '/tmp/Invalid' }),
    });
    expect(invalidUpdate.statusCode).toBe(400);
    expect(appContext.projects.findByKey('ValidApp')).toEqual(before);
    await app.close();
  });

  it('grandfathers an unchanged legacy path only while the project remains disabled', async () => {
    const resolveCandidate = vi.fn(async () => {
      throw new AppError(400, 'REPOSITORY_NOT_SELECTABLE', 'Repository is not selectable', {
        repoPath: ['Select a repository'],
      });
    });
    const repositoryDiscovery: RepositoryDiscoveryGateway = {
      discover: vi.fn(),
      resolveCandidate,
      hasConfiguredRoots: () => true,
    };
    const appContext = context(undefined, repositoryDiscovery);
    const legacy = appContext.projects.create(projectPayload({
      projectKey: 'LegacyApp',
      repoPath: '/removed/LegacyApp',
    }) as unknown as ProjectInput);
    const app = await buildApp(appContext);
    const headers = { authorization: `Bearer ${env.CMS_ADMIN_TOKEN}` };

    const disabledUpdate = await app.inject({
      method: 'PUT',
      url: '/api/projects/LegacyApp',
      headers,
      payload: projectUpdatePayload(legacy, {
        displayName: 'Renamed Legacy App',
        repoPath: '/removed/LegacyApp',
        enabled: false,
      }),
    });
    expect(disabledUpdate.statusCode).toBe(200);
    expect(disabledUpdate.json().project).toMatchObject({
      displayName: 'Renamed Legacy App',
      repoPath: '/removed/LegacyApp',
      enabled: false,
    });
    expect(resolveCandidate).not.toHaveBeenCalled();

    const current = appContext.projects.findByKey('LegacyApp')!;
    const enableUpdate = await app.inject({
      method: 'PUT',
      url: '/api/projects/LegacyApp',
      headers,
      payload: projectUpdatePayload(current, { enabled: true }),
    });
    expect(enableUpdate.statusCode).toBe(400);
    expect(resolveCandidate).toHaveBeenCalledWith('/removed/LegacyApp');
    expect(appContext.projects.findByKey('LegacyApp')).toEqual(current);
    await app.close();
  });

  it('protects signing discovery with the admin token', async () => {
    const app = await buildApp(context());

    const response = await app.inject({
      method: 'POST',
      url: '/api/signing/discover',
      payload: { bundleId: 'com.example.app' },
    });

    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it('trims signing discovery input and returns the service result at the top level', async () => {
    const discover = vi.fn(async (bundleId: string) => ({
      bundleId,
      profiles: [{
        profileName: 'Example Ad Hoc',
        uuid: '11111111-1111-4111-8111-111111111111',
        teamId: 'AB12CDEFGH',
        teamName: null,
        expiresAt: '2027-01-01T00:00:00.000Z',
        certificateCandidates: [],
        recommendedCertificate: null,
        warnings: [],
      }],
      warnings: [],
    }));
    const app = await buildApp(context({ discover }));

    const response = await app.inject({
      method: 'POST',
      url: '/api/signing/discover',
      headers: { authorization: `Bearer ${env.CMS_ADMIN_TOKEN}` },
      payload: { bundleId: '  com.example.app  ' },
    });

    expect(response.statusCode).toBe(200);
    expect(discover).toHaveBeenCalledOnce();
    expect(discover).toHaveBeenCalledWith('com.example.app');
    expect(response.json()).toEqual({
      bundleId: 'com.example.app',
      profiles: [expect.objectContaining({ profileName: 'Example Ad Hoc', teamName: null })],
      warnings: [],
    });
    await app.close();
  });

  it('returns an empty signing discovery result', async () => {
    const app = await buildApp(context());

    const response = await app.inject({
      method: 'POST',
      url: '/api/signing/discover',
      headers: { authorization: `Bearer ${env.CMS_ADMIN_TOKEN}` },
      payload: { bundleId: 'com.example.none' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ bundleId: 'com.example.none', profiles: [], warnings: [] });
    await app.close();
  });

  it.each([
    { bundleId: 'com.example.*' },
    { bundleId: 'single' },
    { bundleId: '.com.example.app' },
    { bundleId: 'com.example.app', extra: true },
  ])('strictly validates signing discovery requests: $bundleId', async (payload) => {
    const discover = vi.fn();
    const app = await buildApp(context({ discover }));

    const response = await app.inject({
      method: 'POST',
      url: '/api/signing/discover',
      headers: { authorization: `Bearer ${env.CMS_ADMIN_TOKEN}` },
      payload,
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('VALIDATION_ERROR');
    expect(discover).not.toHaveBeenCalled();
    await app.close();
  });

  it('chooses and imports a provisioning profile on the API Mac', async () => {
    const imported = {
      bundleId: 'com.example.app',
      profiles: [],
      warnings: [],
      importedProfileUuid: '11111111-1111-4111-8111-111111111111',
    };
    const bytes = Buffer.from('mobileprovision-bytes');
    const chooseProfile = vi.fn(async () => bytes);
    const importProfile = vi.fn(async () => imported);
    const app = await buildApp(context(
      { importProfile },
      undefined,
      undefined,
      { chooseProfile },
    ));

    const unauthorized = await app.inject({ method: 'POST', url: '/api/signing/choose' });
    expect(unauthorized.statusCode).toBe(401);
    expect(chooseProfile).not.toHaveBeenCalled();

    const response = await app.inject({
      method: 'POST',
      url: '/api/signing/choose?expectedBundleId=%20com.example.app%20',
      headers: { authorization: `Bearer ${env.CMS_ADMIN_TOKEN}` },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(imported);
    expect(chooseProfile).toHaveBeenCalledOnce();
    expect(chooseProfile.mock.calls[0][0]).toBeInstanceOf(AbortSignal);
    expect(importProfile).toHaveBeenCalledWith(bytes, 'com.example.app');

    const invalidQuery = await app.inject({
      method: 'POST',
      url: '/api/signing/choose?expectedBundleId=com.example.*',
      headers: { authorization: `Bearer ${env.CMS_ADMIN_TOKEN}` },
    });
    const invalidBody = await app.inject({
      method: 'POST',
      url: '/api/signing/choose',
      headers: { authorization: `Bearer ${env.CMS_ADMIN_TOKEN}` },
      payload: { path: '/private/profile.mobileprovision' },
    });
    expect(invalidQuery.statusCode).toBe(400);
    expect(invalidBody.statusCode).toBe(400);
    expect(chooseProfile).toHaveBeenCalledOnce();
    await app.close();
  });

  it('returns 204 when native provisioning profile selection is cancelled', async () => {
    const importProfile = vi.fn();
    const app = await buildApp(context(
      { importProfile },
      undefined,
      undefined,
      { async chooseProfile() { return null; } },
    ));

    const response = await app.inject({
      method: 'POST',
      url: '/api/signing/choose',
      headers: { authorization: `Bearer ${env.CMS_ADMIN_TOKEN}` },
    });
    expect(response.statusCode).toBe(204);
    expect(response.body).toBe('');
    expect(importProfile).not.toHaveBeenCalled();
    await app.close();
  });

  it('imports a raw provisioning profile with authentication and a strict expected bundle ID', async () => {
    const imported = {
      bundleId: 'com.example.app',
      profiles: [{
        profileName: 'Example Ad Hoc',
        uuid: '11111111-1111-4111-8111-111111111111',
        teamId: 'AB12CDEFGH',
        teamName: null,
        expiresAt: '2027-01-01T00:00:00.000Z',
        certificateCandidates: [],
        recommendedCertificate: null,
        warnings: [],
      }],
      warnings: [],
      importedProfileUuid: '11111111-1111-4111-8111-111111111111',
    };
    const importProfile = vi.fn(async () => imported);
    const app = await buildApp(context({ importProfile }));
    const bytes = Buffer.from('mobileprovision-bytes');

    expect((await app.inject({
      method: 'POST',
      url: '/api/signing/import',
      headers: { 'content-type': 'application/octet-stream' },
      payload: bytes,
    })).statusCode).toBe(401);

    const response = await app.inject({
      method: 'POST',
      url: '/api/signing/import?expectedBundleId=%20com.example.app%20',
      headers: {
        authorization: `Bearer ${env.CMS_ADMIN_TOKEN}`,
        'content-type': 'application/octet-stream',
      },
      payload: bytes,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(imported);
    expect(importProfile).toHaveBeenCalledOnce();
    expect(importProfile.mock.calls[0][0]).toEqual(bytes);
    expect(importProfile.mock.calls[0][1]).toBe('com.example.app');

    const invalidQuery = await app.inject({
      method: 'POST',
      url: '/api/signing/import?expectedBundleId=com.example.*',
      headers: { authorization: `Bearer ${env.CMS_ADMIN_TOKEN}`, 'content-type': 'application/octet-stream' },
      payload: bytes,
    });
    const unknownQuery = await app.inject({
      method: 'POST',
      url: '/api/signing/import?extra=true',
      headers: { authorization: `Bearer ${env.CMS_ADMIN_TOKEN}`, 'content-type': 'application/octet-stream' },
      payload: bytes,
    });
    expect(invalidQuery.statusCode).toBe(400);
    expect(unknownQuery.statusCode).toBe(400);
    expect(importProfile).toHaveBeenCalledOnce();
    await app.close();
  });

  it('rejects empty or non-binary provisioning profile imports', async () => {
    const importProfile = vi.fn();
    const app = await buildApp(context({ importProfile }));
    const headers = { authorization: `Bearer ${env.CMS_ADMIN_TOKEN}` };

    const wrongType = await app.inject({ method: 'POST', url: '/api/signing/import', headers, payload: { profile: 'bytes' } });
    const empty = await app.inject({
      method: 'POST',
      url: '/api/signing/import',
      headers: { ...headers, 'content-type': 'application/octet-stream' },
      payload: Buffer.alloc(0),
    });
    const oversized = await app.inject({
      method: 'POST',
      url: '/api/signing/import',
      headers: { ...headers, 'content-type': 'application/octet-stream' },
      payload: Buffer.alloc(2 * 1024 * 1024 + 1),
    });
    const unsupported = await app.inject({
      method: 'POST',
      url: '/api/signing/import',
      headers: { ...headers, 'content-type': 'application/x-mobileprovision' },
      payload: Buffer.from('profile'),
    });
    expect(wrongType.statusCode).toBe(415);
    expect(empty.statusCode).toBe(400);
    expect(oversized.statusCode).toBe(413);
    expect(oversized.json().error.code).toBe('PAYLOAD_TOO_LARGE');
    expect(unsupported.statusCode).toBe(415);
    expect(unsupported.json().error.code).toBe('UNSUPPORTED_MEDIA_TYPE');
    expect(importProfile).not.toHaveBeenCalled();
    await app.close();
  });

  it('preserves structured sanitized signing discovery service errors', async () => {
    const app = await buildApp(context({
      async discover() {
        throw new AppError(501, 'SIGNING_DISCOVERY_UNSUPPORTED', 'Signing discovery is available only on macOS');
      },
    }));

    const response = await app.inject({
      method: 'POST',
      url: '/api/signing/discover',
      headers: { authorization: `Bearer ${env.CMS_ADMIN_TOKEN}` },
      payload: { bundleId: 'com.example.app' },
    });

    expect(response.statusCode).toBe(501);
    expect(response.json()).toEqual({
      error: {
        code: 'SIGNING_DISCOVERY_UNSUPPORTED',
        message: 'Signing discovery is available only on macOS',
        fields: {},
      },
    });
    await app.close();
  });

  it('sets up and validates a saved project through the authenticated endpoint', async () => {
    const app = await buildApp(context());
    const headers = { authorization: `Bearer ${env.CMS_ADMIN_TOKEN}` };
    const created = await app.inject({
      method: 'POST',
      url: '/api/projects',
      headers,
      payload: projectPayload({ projectKey: 'SetupApp' }),
    });
    expect(created.statusCode).toBe(201);

    expect((await app.inject({ method: 'POST', url: '/api/projects/SetupApp/setup-and-validate' })).statusCode).toBe(401);
    const response = await app.inject({
      method: 'POST',
      url: '/api/projects/SetupApp/setup-and-validate',
      headers,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      setup: { dependenciesInstalled: false },
      validation: { valid: true, message: 'Project configuration is valid' },
      project: { projectKey: 'SetupApp', validationStatus: 'valid' },
    });
    await app.close();
  });
});
