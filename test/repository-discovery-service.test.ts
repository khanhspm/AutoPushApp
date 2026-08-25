import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { AppError } from '../src/http/errors';
import { RepositoryDiscoveryService } from '../src/services/repository-discovery-service';

const temporaryDirectories: string[] = [];
const applicationRoot = path.resolve(__dirname, '..');

async function temporaryDirectory(): Promise<string> {
  const created = await fs.mkdtemp(path.join(os.tmpdir(), 'autopush-repositories-'));
  const directory = await fs.realpath(created);
  temporaryDirectories.push(directory);
  return directory;
}

async function createRepository(directory: string, git: 'directory' | 'file' | 'none' = 'none'): Promise<void> {
  await fs.mkdir(path.join(directory, 'fastlane'), { recursive: true });
  await fs.writeFile(path.join(directory, 'Gemfile'), 'source "https://rubygems.org"\n');
  await fs.writeFile(path.join(directory, 'fastlane', 'Fastfile'), 'default_platform(:ios)\n');
  if (git === 'directory') await fs.mkdir(path.join(directory, '.git'));
  if (git === 'file') await fs.writeFile(path.join(directory, '.git'), 'gitdir: ../worktrees/example\n');
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe('RepositoryDiscoveryService', () => {
  it('returns safe results when roots are absent or unavailable', async () => {
    await expect(new RepositoryDiscoveryService([]).discover()).resolves.toEqual({
      repositories: [],
      warnings: [{
        code: 'REPOSITORY_ROOTS_NOT_CONFIGURED',
        message: 'Repository discovery is unavailable because IOS_REPO_ROOTS is not configured.',
      }],
      truncated: false,
    });

    const missingRoot = path.join(await temporaryDirectory(), 'missing');
    const result = await new RepositoryDiscoveryService([missingRoot]).discover();
    expect(result.repositories).toEqual([]);
    expect(result.truncated).toBe(false);
    expect(result.warnings).toEqual([expect.objectContaining({ code: 'REPOSITORY_ROOT_UNAVAILABLE' })]);
    expect(JSON.stringify(result)).not.toContain(missingRoot);
  });

  it('finds root and nested repositories through depth four without traversing skipped or symlinked children', async () => {
    const root = await temporaryDirectory();
    const outside = await temporaryDirectory();
    await createRepository(root, 'directory');

    let nested = root;
    const expectedPaths = [root];
    for (let depth = 1; depth <= 5; depth += 1) {
      nested = path.join(nested, `level-${depth}`);
      await createRepository(nested, depth === 4 ? 'file' : 'none');
      if (depth <= 4) expectedPaths.push(nested);
    }

    for (const skippedName of ['Pods', 'DERIVEDDATA', 'node_modules', 'Build', '.build', 'Carthage', '.swiftpm']) {
      await createRepository(path.join(root, skippedName, 'HiddenRepo'));
    }
    await createRepository(path.join(outside, 'EscapedRepo'));
    await fs.symlink(path.join(outside, 'EscapedRepo'), path.join(root, 'linked-repo'), 'dir');

    const result = await new RepositoryDiscoveryService([root]).discover();
    expect(result.repositories.map((repository) => repository.path).sort()).toEqual(expectedPaths.sort());
    expect(result.repositories.find((repository) => repository.path === root)?.hasGit).toBe(true);
    expect(result.repositories.find((repository) => repository.path.endsWith('level-4'))?.hasGit).toBe(true);
    expect(result.repositories.some((repository) => repository.path.includes('HiddenRepo'))).toBe(false);
    expect(result.repositories.some((repository) => repository.path.includes('EscapedRepo'))).toBe(false);
    expect(result.truncated).toBe(false);
  });

  it('keeps discovery read-only and lists only repositories that already have both marker files', async () => {
    const root = await temporaryDirectory();
    const complete = path.join(root, 'Complete');
    const noGemfile = path.join(root, 'NoGemfile');
    const noFastfile = path.join(root, 'NoFastfile');
    await createRepository(complete);
    await fs.mkdir(path.join(noGemfile, 'fastlane'), { recursive: true });
    await fs.writeFile(path.join(noGemfile, 'fastlane', 'Fastfile'), 'lane :build\n');
    await fs.mkdir(noFastfile, { recursive: true });
    await fs.writeFile(path.join(noFastfile, 'Gemfile'), 'source "https://rubygems.org"\n');

    const result = await new RepositoryDiscoveryService([root]).discover();
    expect(result.repositories).toHaveLength(1);
    expect(result.repositories[0]).toMatchObject({ path: complete, name: 'Complete', hasGit: false });
    await expect(fs.stat(path.join(noGemfile, 'Gemfile'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.stat(path.join(noFastfile, 'fastlane', 'Fastfile'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('initializes an empty selected directory from the standard Fastlane templates', async () => {
    const root = await temporaryDirectory();
    const repository = path.join(root, 'EmptyApp');
    await fs.mkdir(repository);

    const candidate = await new RepositoryDiscoveryService([root]).resolveCandidate(repository);

    expect(candidate).toMatchObject({ path: repository, rootPath: root, name: 'EmptyApp' });
    await expect(fs.readFile(path.join(repository, 'Gemfile'))).resolves.toEqual(
      await fs.readFile(path.join(applicationRoot, 'Gemfile')),
    );
    await expect(fs.readFile(path.join(repository, 'fastlane', 'Fastfile'))).resolves.toEqual(
      await fs.readFile(path.join(applicationRoot, 'fastlane', 'Fastfile.example')),
    );
    await expect(fs.readFile(path.join(repository, 'fastlane', 'Pluginfile'))).resolves.toEqual(
      await fs.readFile(path.join(applicationRoot, 'fastlane', 'Pluginfile')),
    );
  });

  it('fills only missing scaffold files and preserves existing custom content', async () => {
    const root = await temporaryDirectory();
    const repository = path.join(root, 'PartialApp');
    const customGemfile = 'source "https://private.example"\ngem "fastlane", "~> 2.0"\n';
    const customPluginfile = 'gem "custom-fastlane-plugin"\n';
    await fs.mkdir(path.join(repository, 'fastlane'), { recursive: true });
    await fs.writeFile(path.join(repository, 'Gemfile'), customGemfile);
    await fs.writeFile(path.join(repository, 'fastlane', 'Pluginfile'), customPluginfile);

    await new RepositoryDiscoveryService([root]).resolveCandidate(repository);

    await expect(fs.readFile(path.join(repository, 'Gemfile'), 'utf8')).resolves.toBe(customGemfile);
    await expect(fs.readFile(path.join(repository, 'fastlane', 'Pluginfile'), 'utf8')).resolves.toBe(customPluginfile);
    await expect(fs.readFile(path.join(repository, 'fastlane', 'Fastfile'))).resolves.toEqual(
      await fs.readFile(path.join(applicationRoot, 'fastlane', 'Fastfile.example')),
    );
  });

  it('does not modify a fully initialized repository when Pluginfile is absent', async () => {
    const root = await temporaryDirectory();
    const repository = path.join(root, 'ConfiguredApp');
    const customGemfile = 'custom gemfile\n';
    const customFastfile = 'custom fastfile\n';
    await fs.mkdir(path.join(repository, 'fastlane'), { recursive: true });
    await fs.writeFile(path.join(repository, 'Gemfile'), customGemfile);
    await fs.writeFile(path.join(repository, 'fastlane', 'Fastfile'), customFastfile);

    await new RepositoryDiscoveryService([root]).resolveCandidate(repository);

    await expect(fs.readFile(path.join(repository, 'Gemfile'), 'utf8')).resolves.toBe(customGemfile);
    await expect(fs.readFile(path.join(repository, 'fastlane', 'Fastfile'), 'utf8')).resolves.toBe(customFastfile);
    await expect(fs.stat(path.join(repository, 'fastlane', 'Pluginfile'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('initializes concurrent resolutions idempotently without overwriting scaffold files', async () => {
    const root = await temporaryDirectory();
    const repository = path.join(root, 'ConcurrentApp');
    await fs.mkdir(repository);
    const service = new RepositoryDiscoveryService([root]);

    const candidates = await Promise.all(Array.from({ length: 8 }, () => service.resolveCandidate(repository)));

    expect(candidates.every((candidate) => candidate.path === repository)).toBe(true);
    await expect(fs.readFile(path.join(repository, 'Gemfile'))).resolves.toEqual(
      await fs.readFile(path.join(applicationRoot, 'Gemfile')),
    );
    await expect(fs.readFile(path.join(repository, 'fastlane', 'Fastfile'))).resolves.toEqual(
      await fs.readFile(path.join(applicationRoot, 'fastlane', 'Fastfile.example')),
    );
  });

  it('rejects unsafe scaffold paths and missing server templates with sanitized errors', async () => {
    const root = await temporaryDirectory();
    const outside = await temporaryDirectory();
    const linkedFastlane = path.join(root, 'LinkedFastlane');
    await fs.mkdir(linkedFastlane);
    await fs.symlink(outside, path.join(linkedFastlane, 'fastlane'), 'dir');

    const invalidGemfile = path.join(root, 'InvalidGemfile');
    await fs.mkdir(path.join(invalidGemfile, 'Gemfile'), { recursive: true });

    const linkedPluginfile = path.join(root, 'LinkedPluginfile');
    await fs.mkdir(path.join(linkedPluginfile, 'fastlane'), { recursive: true });
    const outsidePluginfile = path.join(outside, 'Pluginfile');
    await fs.writeFile(outsidePluginfile, 'external plugin config');
    await fs.symlink(outsidePluginfile, path.join(linkedPluginfile, 'fastlane', 'Pluginfile'));

    for (const repository of [linkedFastlane, invalidGemfile, linkedPluginfile]) {
      await expect(new RepositoryDiscoveryService([root]).resolveCandidate(repository)).rejects.toMatchObject({
        statusCode: 400,
        code: 'REPOSITORY_INITIALIZATION_FAILED',
        message: 'Repository could not be initialized',
        fields: { repoPath: [expect.any(String)] },
      } satisfies Partial<AppError>);
    }
    await expect(fs.stat(path.join(outside, 'Fastfile'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.stat(path.join(linkedPluginfile, 'Gemfile'))).rejects.toMatchObject({ code: 'ENOENT' });

    const missingTemplates = await temporaryDirectory();
    const target = path.join(root, 'MissingTemplates');
    await fs.mkdir(target);
    const error = await new RepositoryDiscoveryService([root], { templateRoot: missingTemplates })
      .resolveCandidate(target)
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      statusCode: 400,
      code: 'REPOSITORY_INITIALIZATION_FAILED',
      message: 'Repository could not be initialized',
    } satisfies Partial<AppError>);
    expect(JSON.stringify(error)).not.toContain(missingTemplates);
  });

  it('applies deterministic repository and directory limits', async () => {
    const root = await temporaryDirectory();
    for (const name of ['Zulu', 'beta', 'Alpha']) await createRepository(path.join(root, name));

    const repositoryLimited = await new RepositoryDiscoveryService([root], {
      limits: { maxRepositories: 2 },
    }).discover();
    expect(repositoryLimited.repositories.map((repository) => repository.name)).toEqual(['Alpha', 'beta']);
    expect(repositoryLimited.truncated).toBe(true);
    expect(repositoryLimited.warnings).toContainEqual(expect.objectContaining({ code: 'REPOSITORY_SCAN_TRUNCATED' }));

    const directoryLimited = await new RepositoryDiscoveryService([root], {
      limits: { maxDirectories: 1 },
    }).discover();
    expect(directoryLimited.repositories).toEqual([]);
    expect(directoryLimited.truncated).toBe(true);
  });

  it('deduplicates canonical roots and candidates, sorts duplicate names by path, and assigns the most specific root', async () => {
    const root = await temporaryDirectory();
    const nestedRoot = path.join(root, 'Nested');
    const first = path.join(nestedRoot, 'A', 'Same');
    const second = path.join(nestedRoot, 'B', 'Same');
    await createRepository(first);
    await createRepository(second);
    const alias = path.join(await temporaryDirectory(), 'root-alias');
    await fs.symlink(root, alias, 'dir');

    const result = await new RepositoryDiscoveryService([alias, root, nestedRoot]).discover();
    expect(result.repositories.map((repository) => repository.path)).toEqual([first, second]);
    expect(result.repositories.every((repository) => repository.rootPath === nestedRoot)).toBe(true);
    expect(result.repositories.map((repository) => repository.relativePath)).toEqual([
      path.join('A', 'Same'),
      path.join('B', 'Same'),
    ]);
  });

  it('resolves candidates directly without depending on discovery limits', async () => {
    const root = await temporaryDirectory();
    const outside = await temporaryDirectory();
    const repository = path.join(root, 'one', 'two', 'three', 'four', 'five', 'Ready');
    await createRepository(repository, 'file');
    const alias = path.join(root, 'repo-alias');
    await fs.symlink(repository, alias, 'dir');

    const service = new RepositoryDiscoveryService([root], {
      limits: { maxDepth: 0, maxDirectories: 1, maxRepositories: 1 },
    });
    await expect(service.resolveCandidate(alias)).resolves.toMatchObject({
      path: repository,
      rootPath: root,
      hasGit: true,
    });
    const trailingWhitespaceRepository = path.join(root, 'Trailing ');
    await createRepository(trailingWhitespaceRepository);
    await expect(service.resolveCandidate(trailingWhitespaceRepository)).resolves.toMatchObject({
      path: trailingWhitespaceRepository,
    });

    const notReady = path.join(root, 'NotReady');
    await fs.mkdir(notReady);
    await expect(service.resolveCandidate(notReady)).resolves.toMatchObject({ path: notReady });
    expect((await fs.stat(path.join(notReady, 'Gemfile'))).isFile()).toBe(true);

    const missing = path.join(root, 'Missing');
    const fileInsteadOfDirectory = path.join(root, 'NotADirectory');
    await fs.writeFile(fileInsteadOfDirectory, 'not a directory');
    const rejected = ['relative/path', outside, missing, fileInsteadOfDirectory];
    for (const submittedPath of rejected) {
      await expect(service.resolveCandidate(submittedPath)).rejects.toMatchObject({
        statusCode: 400,
        code: 'REPOSITORY_NOT_SELECTABLE',
        fields: { repoPath: [expect.any(String)] },
      } satisfies Partial<AppError>);
    }
  });
});
