import fs from 'node:fs/promises';
import path from 'node:path';

import type { Project } from '../domain/project';
import { AppError } from '../http/errors';
import { ProjectRepository } from '../repositories/project-repository';
import type { BundlerGateway } from './bundler-service';
import { ProjectConfigService, type ProjectValidationResult } from './project-config-service';
import type { RepositoryCandidateResolver } from './repository-discovery-service';

const maxGitignoreBytes = 256 * 1024;
const requiredGitignoreEntries = [
  { normalized: '.bundle', value: '/.bundle/' },
  { normalized: 'vendor/bundle', value: '/vendor/bundle/' },
] as const;

export interface ProjectSetupResult {
  dependenciesInstalled: boolean;
  validation: ProjectValidationResult;
  project: Project;
}

export interface ProjectSetupGateway {
  setupAndValidate(projectKey: string): Promise<ProjectSetupResult>;
}

function setupBusyError(): AppError {
  return new AppError(409, 'PROJECT_SETUP_BUSY', 'Setup is already running for this project repository');
}

function setupFailedError(): AppError {
  return new AppError(503, 'PROJECT_SETUP_FAILED', 'Project repository setup failed');
}

function normalizedIgnoreEntry(value: string): string {
  return value.trim().replace(/^\/+|\/+$/g, '');
}

export class ProjectSetupService implements ProjectSetupGateway {
  private readonly activeProjects = new Set<string>();
  private readonly activeRepositories = new Set<string>();

  constructor(
    private readonly projects: ProjectRepository,
    private readonly repositoryDiscovery: RepositoryCandidateResolver,
    private readonly bundler: BundlerGateway,
    private readonly projectConfig: ProjectConfigService,
  ) {}

  async setupAndValidate(projectKey: string): Promise<ProjectSetupResult> {
    const projectLock = projectKey.toLowerCase();
    if (this.activeProjects.has(projectLock)) throw setupBusyError();
    this.activeProjects.add(projectLock);

    let repositoryLock: string | null = null;
    let repositoryLockAcquired = false;
    try {
      const project = this.projects.findByKey(projectKey);
      if (!project) throw new AppError(404, 'PROJECT_NOT_FOUND', 'Project was not found');

      const repository = await this.repositoryDiscovery.resolveCandidate(project.repoPath);
      repositoryLock = repository.path;
      if (this.activeRepositories.has(repositoryLock)) throw setupBusyError();
      this.activeRepositories.add(repositoryLock);
      repositoryLockAcquired = true;

      await this.ensureGitignore(repository.path);
      await this.bundler.configureLocalPath(repository.path);

      let dependenciesInstalled = false;
      let dependenciesSatisfied = await this.bundler.check(repository.path);
      if (!dependenciesSatisfied) {
        await this.bundler.install(repository.path);
        dependenciesInstalled = true;
        dependenciesSatisfied = await this.bundler.check(repository.path);
      }

      const validation = dependenciesSatisfied
        ? await this.projectConfig.validate(project, {
            canonicalRepoPath: repository.path,
            dependenciesSatisfied: true,
          })
        : {
            valid: false,
            message: 'Bundler could not verify the installed project dependencies',
            canonicalRepoPath: repository.path,
          };
      const recorded = this.projects.setValidation(
        project.projectKey,
        validation.valid ? 'valid' : 'invalid',
        validation.message,
        project.version,
      );
      if (!recorded) {
        throw new AppError(409, 'PROJECT_VERSION_CONFLICT', 'Project changed while setup was running');
      }

      return { dependenciesInstalled, validation, project: recorded };
    } finally {
      if (repositoryLock && repositoryLockAcquired) this.activeRepositories.delete(repositoryLock);
      this.activeProjects.delete(projectLock);
    }
  }

  private async ensureGitignore(repoPath: string): Promise<void> {
    const gitignorePath = path.join(repoPath, '.gitignore');
    let content = '';
    let fileExists = false;
    try {
      const stats = await fs.lstat(gitignorePath);
      if (!stats.isFile() || stats.isSymbolicLink() || stats.size > maxGitignoreBytes) throw setupFailedError();
      fileExists = true;
      content = await fs.readFile(gitignorePath, 'utf8');
    } catch (error) {
      if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) {
        if (error instanceof AppError) throw error;
        throw setupFailedError();
      }
    }

    const existing = new Set(content.split(/\r?\n/).map(normalizedIgnoreEntry).filter(Boolean));
    const additions = requiredGitignoreEntries
      .filter((entry) => !existing.has(entry.normalized))
      .map((entry) => entry.value);
    if (additions.length === 0) return;

    const prefix = content.length === 0 ? '' : content.endsWith('\n') ? content : `${content}\n`;
    const nextContent = `${prefix}${additions.join('\n')}\n`;
    try {
      await fs.writeFile(gitignorePath, nextContent, { encoding: 'utf8', flag: fileExists ? 'w' : 'wx' });
    } catch (error) {
      if (!fileExists && error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST') {
        await this.ensureGitignore(repoPath);
        return;
      }
      throw setupFailedError();
    }
  }
}
