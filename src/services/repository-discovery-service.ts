import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

import type {
  RepositoryCandidate,
  RepositoryDiscoveryResult,
  RepositoryDiscoveryWarning,
  RepositoryDiscoveryWarningCode,
} from '../domain/repository';
import { AppError } from '../http/errors';

const productionLimits = {
  maxDepth: 4,
  maxDirectories: 2_000,
  maxRepositories: 200,
} as const;

const skippedDirectoryNames = new Set([
  '.git',
  'pods',
  'deriveddata',
  'node_modules',
  'build',
  '.build',
  'carthage',
  '.swiftpm',
]);

const warningMessages: Record<RepositoryDiscoveryWarningCode, string> = {
  REPOSITORY_ROOTS_NOT_CONFIGURED: 'Repository discovery is unavailable because IOS_REPO_ROOTS is not configured.',
  REPOSITORY_ROOT_UNAVAILABLE: 'One or more configured repository roots could not be inspected.',
  REPOSITORY_DIRECTORY_UNREADABLE: 'One or more directories could not be inspected during repository discovery.',
  REPOSITORY_SCAN_TRUNCATED: 'Repository discovery stopped after reaching a configured scan limit.',
};

export interface RepositoryDirectoryEntry {
  name: string;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}

export interface RepositoryFileStats {
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
}

export interface RepositoryDiscoveryFileSystem {
  realpath(targetPath: string): Promise<string>;
  readdir(
    directoryPath: string,
    options: { withFileTypes: true },
  ): Promise<readonly RepositoryDirectoryEntry[]>;
  stat(targetPath: string): Promise<RepositoryFileStats>;
  lstat(targetPath: string): Promise<RepositoryFileStats>;
  mkdir(directoryPath: string, options: { mode: number }): Promise<void>;
  copyFile(sourcePath: string, destinationPath: string, mode: number): Promise<void>;
}

export interface RepositoryDiscoveryLimits {
  maxDepth: number;
  maxDirectories: number;
  maxRepositories: number;
}

export interface RepositoryDiscoveryOptions {
  fileSystem?: RepositoryDiscoveryFileSystem;
  limits?: Partial<RepositoryDiscoveryLimits>;
  templateRoot?: string;
}

export interface RepositoryCandidateResolver {
  resolveCandidate(repoPath: string): Promise<RepositoryCandidate>;
  hasConfiguredRoots?(): boolean;
}

export interface RepositoryDiscoveryGateway extends RepositoryCandidateResolver {
  discover(): Promise<RepositoryDiscoveryResult>;
}

interface ScanEntry {
  path: string;
  depth: number;
}

interface RepositoryTemplatePaths {
  gemfile: string;
  fastfile: string;
  pluginfile: string;
}

type RepositoryPathKind = 'missing' | 'file' | 'directory' | 'other';

const nodeFileSystem: RepositoryDiscoveryFileSystem = {
  async realpath(targetPath) {
    return fs.realpath(targetPath);
  },
  async readdir(directoryPath, options) {
    return fs.readdir(directoryPath, options);
  },
  async stat(targetPath) {
    return fs.stat(targetPath);
  },
  async lstat(targetPath) {
    return fs.lstat(targetPath);
  },
  async mkdir(directoryPath, options) {
    return fs.mkdir(directoryPath, options);
  },
  async copyFile(sourcePath, destinationPath, mode) {
    return fs.copyFile(sourcePath, destinationPath, mode);
  },
};

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isPathInside(rootPath: string, candidatePath: string): boolean {
  const relativePath = path.relative(rootPath, candidatePath);
  return relativePath === ''
    || (!relativePath.startsWith(`..${path.sep}`) && relativePath !== '..' && !path.isAbsolute(relativePath));
}

function warning(code: RepositoryDiscoveryWarningCode): RepositoryDiscoveryWarning {
  return { code, message: warningMessages[code] };
}

function addWarning(
  warnings: Map<RepositoryDiscoveryWarningCode, RepositoryDiscoveryWarning>,
  code: RepositoryDiscoveryWarningCode,
): void {
  if (!warnings.has(code)) warnings.set(code, warning(code));
}

function repositoryNotSelectable(): AppError {
  const message = 'Select an existing directory under IOS_REPO_ROOTS';
  return new AppError(400, 'REPOSITORY_NOT_SELECTABLE', 'Repository is not selectable', {
    repoPath: [message],
  });
}

function repositoryInitializationFailed(): AppError {
  const message = 'The selected directory must be writable and must not contain unsafe Fastlane paths';
  return new AppError(400, 'REPOSITORY_INITIALIZATION_FAILED', 'Repository could not be initialized', {
    repoPath: [message],
  });
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

function normalizedLimits(overrides: Partial<RepositoryDiscoveryLimits> | undefined): RepositoryDiscoveryLimits {
  const limit = (value: number | undefined, fallback: number): number => (
    Number.isInteger(value) && value !== undefined && value > 0 ? value : fallback
  );
  return {
    maxDepth: Number.isInteger(overrides?.maxDepth) && overrides!.maxDepth! >= 0
      ? overrides!.maxDepth!
      : productionLimits.maxDepth,
    maxDirectories: limit(overrides?.maxDirectories, productionLimits.maxDirectories),
    maxRepositories: limit(overrides?.maxRepositories, productionLimits.maxRepositories),
  };
}

export class RepositoryDiscoveryService implements RepositoryDiscoveryGateway {
  private readonly configuredRoots: string[];
  private readonly fileSystem: RepositoryDiscoveryFileSystem;
  private readonly limits: RepositoryDiscoveryLimits;
  private readonly templatePaths: RepositoryTemplatePaths;

  constructor(configuredRoots: readonly string[], options: RepositoryDiscoveryOptions = {}) {
    this.configuredRoots = configuredRoots.map((root) => root.trim()).filter(Boolean);
    this.fileSystem = options.fileSystem ?? nodeFileSystem;
    this.limits = normalizedLimits(options.limits);
    const templateRoot = options.templateRoot ?? path.resolve(__dirname, '../..');
    this.templatePaths = {
      gemfile: path.join(templateRoot, 'Gemfile'),
      fastfile: path.join(templateRoot, 'fastlane', 'Fastfile.example'),
      pluginfile: path.join(templateRoot, 'fastlane', 'Pluginfile'),
    };
  }

  hasConfiguredRoots(): boolean {
    return this.configuredRoots.length > 0;
  }

  async discover(): Promise<RepositoryDiscoveryResult> {
    const warnings = new Map<RepositoryDiscoveryWarningCode, RepositoryDiscoveryWarning>();
    if (!this.hasConfiguredRoots()) {
      addWarning(warnings, 'REPOSITORY_ROOTS_NOT_CONFIGURED');
      return { repositories: [], warnings: [...warnings.values()], truncated: false };
    }

    const canonicalRoots = await this.canonicalRoots(warnings);
    if (canonicalRoots.length === 0) {
      return { repositories: [], warnings: [...warnings.values()], truncated: false };
    }

    const queue: ScanEntry[] = canonicalRoots.map((rootPath) => ({ path: rootPath, depth: 0 }));
    const scheduled = new Set(canonicalRoots);
    const repositories = new Map<string, RepositoryCandidate>();
    let inspectedDirectories = 0;
    let truncated = false;

    while (queue.length > 0) {
      if (inspectedDirectories >= this.limits.maxDirectories) {
        truncated = true;
        break;
      }

      const entry = queue.shift()!;
      inspectedDirectories += 1;
      let canonicalPath: string;
      try {
        canonicalPath = await this.fileSystem.realpath(entry.path);
        const stats = await this.fileSystem.stat(canonicalPath);
        if (!stats.isDirectory() || !this.ownerRoot(canonicalRoots, canonicalPath)) continue;
      } catch {
        addWarning(warnings, entry.depth === 0 ? 'REPOSITORY_ROOT_UNAVAILABLE' : 'REPOSITORY_DIRECTORY_UNREADABLE');
        continue;
      }

      if (canonicalPath !== entry.path && scheduled.has(canonicalPath)) continue;
      scheduled.add(canonicalPath);

      const candidate = await this.discoveredCandidate(canonicalRoots, canonicalPath);
      if (candidate && !repositories.has(candidate.path)) {
        repositories.set(candidate.path, candidate);
        if (repositories.size >= this.limits.maxRepositories) {
          truncated = true;
          break;
        }
      }

      if (entry.depth >= this.limits.maxDepth) continue;
      let entries: readonly RepositoryDirectoryEntry[];
      try {
        entries = await this.fileSystem.readdir(canonicalPath, { withFileTypes: true });
      } catch {
        addWarning(warnings, entry.depth === 0 ? 'REPOSITORY_ROOT_UNAVAILABLE' : 'REPOSITORY_DIRECTORY_UNREADABLE');
        continue;
      }
      const childNames = entries
        .filter((child) => (
          child.isDirectory()
          && !child.isSymbolicLink()
          && !skippedDirectoryNames.has(child.name.toLowerCase())
        ))
        .map((child) => child.name)
        .sort((left, right) => (
          compareText(left.toLowerCase(), right.toLowerCase()) || compareText(left, right)
        ));

      for (const childName of childNames) {
        const childPath = path.join(canonicalPath, childName);
        if (scheduled.has(childPath)) continue;
        scheduled.add(childPath);
        queue.push({ path: childPath, depth: entry.depth + 1 });
      }
    }

    if (truncated) addWarning(warnings, 'REPOSITORY_SCAN_TRUNCATED');
    const sortedRepositories = [...repositories.values()].sort((left, right) => (
      compareText(left.name.toLocaleLowerCase('en-US'), right.name.toLocaleLowerCase('en-US'))
      || compareText(left.name, right.name)
      || compareText(left.path, right.path)
    ));

    return {
      repositories: sortedRepositories,
      warnings: [...warnings.values()],
      truncated,
    };
  }

  async resolveCandidate(repoPath: string): Promise<RepositoryCandidate> {
    const submittedPath = typeof repoPath === 'string' ? repoPath : '';
    if (!submittedPath.trim() || !path.isAbsolute(submittedPath) || !this.hasConfiguredRoots()) {
      throw repositoryNotSelectable();
    }

    let canonicalPath: string;
    let canonicalRoots: string[];
    try {
      canonicalPath = await this.fileSystem.realpath(submittedPath);
      canonicalRoots = await this.canonicalRoots();
      const stats = await this.fileSystem.stat(canonicalPath);
      if (!stats.isDirectory()) throw repositoryNotSelectable();
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw repositoryNotSelectable();
    }

    if (!this.ownerRoot(canonicalRoots, canonicalPath)) throw repositoryNotSelectable();
    await this.ensureFastlaneScaffold(canonicalPath);
    return this.candidateMetadata(canonicalRoots, canonicalPath);
  }

  private async canonicalRoots(
    warnings?: Map<RepositoryDiscoveryWarningCode, RepositoryDiscoveryWarning>,
  ): Promise<string[]> {
    const canonicalRoots = new Set<string>();
    for (const configuredRoot of this.configuredRoots) {
      try {
        const canonicalRoot = await this.fileSystem.realpath(configuredRoot);
        const stats = await this.fileSystem.stat(canonicalRoot);
        if (!stats.isDirectory()) throw new Error('not a directory');
        canonicalRoots.add(canonicalRoot);
      } catch {
        if (warnings) addWarning(warnings, 'REPOSITORY_ROOT_UNAVAILABLE');
      }
    }
    return [...canonicalRoots].sort(compareText);
  }

  private ownerRoot(canonicalRoots: readonly string[], candidatePath: string): string | null {
    return canonicalRoots
      .filter((rootPath) => isPathInside(rootPath, candidatePath))
      .sort((left, right) => right.length - left.length || compareText(left, right))[0] ?? null;
  }

  private async discoveredCandidate(
    canonicalRoots: readonly string[],
    canonicalPath: string,
  ): Promise<RepositoryCandidate | null> {
    try {
      const [gemfileKind, fastfileKind] = await Promise.all([
        this.pathKind(path.join(canonicalPath, 'Gemfile')),
        this.pathKind(path.join(canonicalPath, 'fastlane', 'Fastfile')),
      ]);
      if (gemfileKind !== 'file' || fastfileKind !== 'file') return null;
      return this.candidateMetadata(canonicalRoots, canonicalPath);
    } catch {
      return null;
    }
  }

  private async ensureFastlaneScaffold(canonicalPath: string): Promise<void> {
    const gemfilePath = path.join(canonicalPath, 'Gemfile');
    const fastlanePath = path.join(canonicalPath, 'fastlane');
    const fastfilePath = path.join(fastlanePath, 'Fastfile');
    const pluginfilePath = path.join(fastlanePath, 'Pluginfile');

    const [gemfileKind, fastlaneKind] = await Promise.all([
      this.pathKind(gemfilePath),
      this.pathKind(fastlanePath),
    ]);
    if (gemfileKind === 'other' || (fastlaneKind !== 'missing' && fastlaneKind !== 'directory')) {
      throw repositoryInitializationFailed();
    }

    const fastfileKind = fastlaneKind === 'directory'
      ? await this.pathKind(fastfilePath)
      : 'missing';
    if (fastfileKind === 'other' || fastfileKind === 'directory') {
      throw repositoryInitializationFailed();
    }
    if (gemfileKind === 'file' && fastfileKind === 'file') return;

    const pluginfileKind = fastlaneKind === 'directory'
      ? await this.pathKind(pluginfilePath)
      : 'missing';
    if (pluginfileKind === 'other' || pluginfileKind === 'directory') {
      throw repositoryInitializationFailed();
    }

    await this.assertTemplatesAvailable();
    if (fastlaneKind === 'missing') await this.ensureFastlaneDirectory(fastlanePath);

    await this.copyMissingTemplate(this.templatePaths.pluginfile, pluginfilePath);
    await this.copyMissingTemplate(this.templatePaths.gemfile, gemfilePath);
    await this.copyMissingTemplate(this.templatePaths.fastfile, fastfilePath);
  }

  private async assertTemplatesAvailable(): Promise<void> {
    const kinds = await Promise.all(Object.values(this.templatePaths).map((templatePath) => this.pathKind(templatePath)));
    if (kinds.some((kind) => kind !== 'file')) throw repositoryInitializationFailed();
  }

  private async ensureFastlaneDirectory(fastlanePath: string): Promise<void> {
    try {
      await this.fileSystem.mkdir(fastlanePath, { mode: 0o755 });
    } catch (error) {
      if (errorCode(error) !== 'EEXIST') throw repositoryInitializationFailed();
    }
    if (await this.pathKind(fastlanePath) !== 'directory') throw repositoryInitializationFailed();
  }

  private async copyMissingTemplate(sourcePath: string, destinationPath: string): Promise<void> {
    const currentKind = await this.pathKind(destinationPath);
    if (currentKind === 'file') return;
    if (currentKind !== 'missing') throw repositoryInitializationFailed();

    try {
      await this.fileSystem.copyFile(sourcePath, destinationPath, fsConstants.COPYFILE_EXCL);
    } catch (error) {
      if (errorCode(error) === 'EEXIST' && await this.pathKind(destinationPath) === 'file') return;
      throw repositoryInitializationFailed();
    }
  }

  private async pathKind(targetPath: string): Promise<RepositoryPathKind> {
    try {
      const stats = await this.fileSystem.lstat(targetPath);
      if (stats.isSymbolicLink()) return 'other';
      if (stats.isFile()) return 'file';
      if (stats.isDirectory()) return 'directory';
      return 'other';
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return 'missing';
      throw repositoryInitializationFailed();
    }
  }

  private async candidateMetadata(
    canonicalRoots: readonly string[],
    canonicalPath: string,
  ): Promise<RepositoryCandidate> {
    const rootPath = this.ownerRoot(canonicalRoots, canonicalPath);
    if (!rootPath) throw repositoryNotSelectable();

    let hasGit = false;
    try {
      const git = await this.fileSystem.stat(path.join(canonicalPath, '.git'));
      hasGit = git.isDirectory() || git.isFile();
    } catch {
      // Git metadata is optional display information.
    }

    const name = path.basename(canonicalPath) || canonicalPath;
    const relativePath = path.relative(rootPath, canonicalPath);
    const labelContext = relativePath && relativePath !== name ? relativePath : rootPath;
    return {
      path: canonicalPath,
      name,
      rootPath,
      relativePath,
      displayLabel: `${name} — ${labelContext}`,
      hasGit,
    };
  }
}
