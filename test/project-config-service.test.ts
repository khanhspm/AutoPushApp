import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createDatabase, type AppDatabase } from '../src/db/database';
import { migrateDatabase } from '../src/db/migrate';
import { ProjectRepository } from '../src/repositories/project-repository';
import { ProjectConfigService } from '../src/services/project-config-service';
import { RepositoryDiscoveryService, type RepositoryDiscoveryGateway } from '../src/services/repository-discovery-service';

const databases: AppDatabase[] = [];
const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const created = await fs.mkdtemp(path.join(os.tmpdir(), 'autopush-project-config-'));
  const directory = await fs.realpath(created);
  temporaryDirectories.push(directory);
  return directory;
}

async function createRepository(directory: string): Promise<void> {
  await fs.mkdir(path.join(directory, 'fastlane'), { recursive: true });
  await fs.writeFile(path.join(directory, 'Gemfile'), 'source "https://rubygems.org"\n');
  await fs.writeFile(path.join(directory, 'fastlane', 'Fastfile'), 'default_platform(:ios)\n');
}

afterEach(async () => {
  for (const database of databases.splice(0)) database.close();
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

function createProjects(): ProjectRepository {
  const database = createDatabase(':memory:');
  databases.push(database);
  migrateDatabase(database);
  return new ProjectRepository(database);
}

describe('project signing validation', () => {
  it('ignores inactive Match references for manual signing', async () => {
    const projects = createProjects();
    const project = projects.create({
      projectKey: 'ManualApp',
      displayName: 'Manual App',
      repoPath: '/tmp/manual-app',
      fastlaneLane: 'distribute',
      firebaseAppId: '1:123:ios:manual',
      firebaseTesterGroups: ['qa'],
      firebaseCliTokenEnvVar: 'MANUAL_FIREBASE_TOKEN',
      matchPasswordEnvVar: 'legacy-match-password',
      appStoreConnectKeyIdEnvVar: 'legacy-key-id',
      appStoreConnectIssuerIdEnvVar: 'legacy-issuer-id',
      appStoreConnectKeyPathEnvVar: 'legacy-key-path',
      signingMode: 'manual',
      appleTeamId: 'AB12CDEFGH',
      signingCertificate: 'Apple Distribution',
      provisioningProfiles: [{ bundleId: 'com.example.app', profileName: 'Example App AdHoc' }],
    });
    const repositoryDiscovery: RepositoryDiscoveryGateway = {
      discover: vi.fn(),
      resolveCandidate: vi.fn(),
      hasConfiguredRoots: () => false,
    };

    const result = await new ProjectConfigService(projects, repositoryDiscovery).validate(project);

    expect(result).toEqual({ valid: false, message: 'IOS_REPO_ROOTS is not configured' });
    expect(repositoryDiscovery.resolveCandidate).not.toHaveBeenCalled();
  });

  it('uses the shared resolver canonical path for Bundler and build snapshots', async () => {
    const root = await temporaryDirectory();
    const canonicalRepository = path.join(root, 'CanonicalApp');
    const alias = path.join(root, 'AliasApp');
    await createRepository(canonicalRepository);
    await fs.symlink(canonicalRepository, alias, 'dir');

    const bundleWorkingDirectoryFile = path.join(root, 'bundle-cwd.txt');
    const bundleExecutable = path.join(root, 'bundle-check.sh');
    await fs.writeFile(
      bundleExecutable,
      `#!/bin/sh\npwd > ${JSON.stringify(bundleWorkingDirectoryFile)}\n`,
      { mode: 0o755 },
    );

    const projects = createProjects();
    const project = projects.create({
      projectKey: 'CanonicalApp',
      displayName: 'Canonical App',
      repoPath: alias,
      fastlaneLane: 'distribute',
      firebaseAppId: '1:123:ios:canonical',
      firebaseTesterGroups: ['qa'],
      firebaseCliTokenEnvVar: 'FIREBASE_TOKEN',
      signingMode: 'manual',
      appleTeamId: 'AB12CDEFGH',
      signingCertificate: 'Apple Distribution',
      provisioningProfiles: [{ bundleId: 'com.example.app', profileName: 'Example App AdHoc' }],
    });
    projects.setValidation(project.projectKey, 'valid', 'prevalidated');
    projects.setEnabled(project.projectKey, true);

    const repositoryDiscovery = new RepositoryDiscoveryService([root]);
    const service = new ProjectConfigService(projects, repositoryDiscovery, {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      BUNDLE_BIN: bundleExecutable,
      FIREBASE_TOKEN: 'configured',
    });

    const validation = await service.validate(projects.findByKey(project.projectKey)!);
    expect(validation).toEqual({
      valid: true,
      message: 'Project configuration is valid',
      canonicalRepoPath: canonicalRepository,
    });
    expect((await fs.readFile(bundleWorkingDirectoryFile, 'utf8')).trim()).toBe(canonicalRepository);

    const snapshot = await service.resolveForBuild(project.projectKey);
    expect(snapshot.repoPath).toBe(canonicalRepository);
  });
});
