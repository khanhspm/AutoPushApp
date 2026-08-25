import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createDatabase, type AppDatabase } from '../src/db/database';
import { migrateDatabase } from '../src/db/migrate';
import type { RepositoryCandidate } from '../src/domain/repository';
import { AppError } from '../src/http/errors';
import { ProjectRepository } from '../src/repositories/project-repository';
import type { BundlerGateway } from '../src/services/bundler-service';
import { ProjectConfigService } from '../src/services/project-config-service';
import { ProjectSetupService } from '../src/services/project-setup-service';
import type { RepositoryCandidateResolver } from '../src/services/repository-discovery-service';

const databases: AppDatabase[] = [];
const directories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'autopush-setup-')));
  directories.push(directory);
  return directory;
}

afterEach(async () => {
  for (const database of databases.splice(0)) database.close();
  await Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

class FakeBundler implements BundlerGateway {
  readonly calls: string[] = [];
  checks: boolean[] = [true];
  checkGate: Promise<void> | null = null;

  async configureLocalPath(repoPath: string): Promise<void> {
    this.calls.push(`config:${repoPath}`);
  }

  async check(repoPath: string): Promise<boolean> {
    this.calls.push(`check:${repoPath}`);
    await this.checkGate;
    return this.checks.shift() ?? true;
  }

  async install(repoPath: string): Promise<void> {
    this.calls.push(`install:${repoPath}`);
  }
}

function createProjects(): ProjectRepository {
  const database = createDatabase(':memory:');
  databases.push(database);
  migrateDatabase(database);
  return new ProjectRepository(database);
}

function candidate(repoPath: string): RepositoryCandidate {
  return {
    path: repoPath,
    name: path.basename(repoPath),
    rootPath: path.dirname(repoPath),
    relativePath: path.basename(repoPath),
    displayLabel: repoPath,
    hasGit: true,
  };
}

function createProject(projects: ProjectRepository, repoPath: string, projectKey = 'SetupApp') {
  return projects.create({
    projectKey,
    displayName: projectKey,
    repoPath,
    fastlaneLane: 'distribute',
    firebaseAppId: '1:123:ios:setup',
    firebaseTesterGroups: ['qa'],
    firebaseCliTokenEnvVar: 'FIREBASE_TOKEN',
    signingMode: 'manual',
    appleTeamId: 'AB12CDEFGH',
    signingCertificate: 'Apple Distribution',
    provisioningProfiles: [{ bundleId: 'com.example.app', profileName: 'Example AdHoc' }],
  });
}

function setupService(projects: ProjectRepository, repoPath: string, bundler: FakeBundler) {
  const resolver: RepositoryCandidateResolver = {
    async resolveCandidate() { return candidate(repoPath); },
    hasConfiguredRoots() { return true; },
  };
  const config = new ProjectConfigService(projects, resolver, { FIREBASE_TOKEN: 'configured' }, bundler);
  return new ProjectSetupService(projects, resolver, bundler, config);
}

describe('ProjectSetupService', () => {
  it('updates gitignore idempotently and skips install when dependencies are satisfied', async () => {
    const repoPath = await temporaryDirectory();
    await fs.writeFile(path.join(repoPath, '.gitignore'), '.DS_Store\n/.bundle\n');
    const projects = createProjects();
    createProject(projects, repoPath);
    const bundler = new FakeBundler();
    const service = setupService(projects, repoPath, bundler);

    const first = await service.setupAndValidate('SetupApp');
    const second = await service.setupAndValidate('SetupApp');

    expect(first.dependenciesInstalled).toBe(false);
    expect(first.validation.valid).toBe(true);
    expect(second.validation.valid).toBe(true);
    expect(await fs.readFile(path.join(repoPath, '.gitignore'), 'utf8')).toBe('.DS_Store\n/.bundle\n/vendor/bundle/\n');
    expect(bundler.calls.filter((call) => call.startsWith('install:'))).toEqual([]);
    expect(projects.findByKey('SetupApp')?.validationStatus).toBe('valid');
  });

  it('updates an existing empty gitignore without retrying forever', async () => {
    const repoPath = await temporaryDirectory();
    await fs.writeFile(path.join(repoPath, '.gitignore'), '');
    const projects = createProjects();
    createProject(projects, repoPath);
    const bundler = new FakeBundler();

    await setupService(projects, repoPath, bundler).setupAndValidate('SetupApp');

    expect(await fs.readFile(path.join(repoPath, '.gitignore'), 'utf8')).toBe('/.bundle/\n/vendor/bundle/\n');
  });

  it('installs missing dependencies and verifies them again', async () => {
    const repoPath = await temporaryDirectory();
    const projects = createProjects();
    createProject(projects, repoPath);
    const bundler = new FakeBundler();
    bundler.checks = [false, true];

    const result = await setupService(projects, repoPath, bundler).setupAndValidate('SetupApp');

    expect(result.dependenciesInstalled).toBe(true);
    expect(result.validation.valid).toBe(true);
    expect(bundler.calls).toEqual([
      `config:${repoPath}`,
      `check:${repoPath}`,
      `install:${repoPath}`,
      `check:${repoPath}`,
    ]);
    expect(await fs.readFile(path.join(repoPath, '.gitignore'), 'utf8')).toBe('/.bundle/\n/vendor/bundle/\n');
  });

  it('rejects concurrent setup and releases its lock afterward', async () => {
    const repoPath = await temporaryDirectory();
    const projects = createProjects();
    createProject(projects, repoPath);
    const bundler = new FakeBundler();
    let release!: () => void;
    bundler.checkGate = new Promise<void>((resolve) => { release = resolve; });
    const service = setupService(projects, repoPath, bundler);

    const pending = service.setupAndValidate('SetupApp');
    await expect(service.setupAndValidate('setupapp')).rejects.toMatchObject({
      statusCode: 409,
      code: 'PROJECT_SETUP_BUSY',
    } satisfies Partial<AppError>);
    release();
    await expect(pending).resolves.toMatchObject({ validation: { valid: true } });

    bundler.checkGate = null;
    await expect(service.setupAndValidate('SetupApp')).resolves.toMatchObject({ validation: { valid: true } });
  });

  it('keeps a shared repository locked when another project is rejected as busy', async () => {
    const repoPath = await temporaryDirectory();
    const projects = createProjects();
    createProject(projects, repoPath, 'FirstApp');
    createProject(projects, repoPath, 'SecondApp');
    const bundler = new FakeBundler();
    let release!: () => void;
    bundler.checkGate = new Promise<void>((resolve) => { release = resolve; });
    const service = setupService(projects, repoPath, bundler);

    const first = service.setupAndValidate('FirstApp');
    await expect(service.setupAndValidate('SecondApp')).rejects.toMatchObject({ code: 'PROJECT_SETUP_BUSY' });
    await expect(service.setupAndValidate('SecondApp')).rejects.toMatchObject({ code: 'PROJECT_SETUP_BUSY' });
    release();
    await first;

    bundler.checkGate = null;
    await expect(service.setupAndValidate('SecondApp')).resolves.toMatchObject({ validation: { valid: true } });
  });

  it('rejects unsafe gitignore files without invoking Bundler', async () => {
    const repoPath = await temporaryDirectory();
    const target = path.join(repoPath, 'outside');
    await fs.writeFile(target, 'private');
    await fs.symlink(target, path.join(repoPath, '.gitignore'));
    const projects = createProjects();
    createProject(projects, repoPath);
    const bundler = new FakeBundler();

    await expect(setupService(projects, repoPath, bundler).setupAndValidate('SetupApp')).rejects.toMatchObject({
      statusCode: 503,
      code: 'PROJECT_SETUP_FAILED',
    } satisfies Partial<AppError>);
    expect(bundler.calls).toEqual([]);
    expect(await fs.readFile(target, 'utf8')).toBe('private');
  });
});
