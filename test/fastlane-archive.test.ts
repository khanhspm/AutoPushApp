import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { env } from '../src/config/env';
import type { ProjectConfigSnapshotV2 } from '../src/domain/project';
import { BuildLogService } from '../src/services/build-log-service';
import { triggerFastlane } from '../src/services/fastlane-service';

const originalRunner = env.FASTLANE_RUNNER_PATH;
const originalTimeout = env.BUILD_TIMEOUT_MS;
const originalToken = process.env.ARCHIVE_TEST_TOKEN;
let directory: string;
let config: ProjectConfigSnapshotV2;
const leftoverArchives: string[] = [];

beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'autopush-archive-test-'));
  process.env.ARCHIVE_TEST_TOKEN = 'test-secret';
  config = {
    schemaVersion: 2, projectKey: 'app', displayName: 'App', repoPath: directory,
    fastlaneLane: 'distribute', scheme: 'App', buildConfiguration: 'Debug',
    firebaseAppId: 'app', firebaseTesterGroups: ['test'], signingMode: 'manual',
    appleTeamId: 'AB12CDEFGH', signingCertificate: 'Apple Distribution',
    provisioningProfiles: [], secretEnvRefs: { firebaseCliToken: 'ARCHIVE_TEST_TOKEN' }, projectVersion: 1,
  };
  // A real subprocess exercises environment propagation, process termination and filesystem cleanup.
  env.FASTLANE_RUNNER_PATH = path.join(directory, 'fake-runner');
  await fs.writeFile(env.FASTLANE_RUNNER_PATH, `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const archive = process.env.GYM_ARCHIVE_PATH;
fs.mkdirSync(archive, {recursive: true});
fs.writeFileSync(path.join(archive, 'archive-data'), 'temporary');
fs.symlinkSync(path.join(process.cwd(), 'old.xcarchive'), path.join(archive, 'external-archive'));
fs.mkdirSync('build', {recursive: true});
fs.writeFileSync('build/app.ipa', 'retained');
fs.writeFileSync('archive-path.txt', archive);
console.log('Export/upload finished');
if (process.argv[5] === 'wait') setInterval(() => {}, 1000);
else process.exit(process.argv[5] === 'fail' ? 7 : 0);
`, { mode: 0o700 });
  await fs.mkdir(path.join(directory, 'old.xcarchive'));
  await fs.writeFile(path.join(directory, 'old.xcarchive/keep'), 'user archive');
});

afterEach(async () => {
  vi.restoreAllMocks();
  env.FASTLANE_RUNNER_PATH = originalRunner;
  env.BUILD_TIMEOUT_MS = originalTimeout;
  if (originalToken === undefined) delete process.env.ARCHIVE_TEST_TOKEN;
  else process.env.ARCHIVE_TEST_TOKEN = originalToken;
  await fs.rm(directory, { recursive: true, force: true });
  for (const archive of leftoverArchives.splice(0)) await fs.rm(archive, { recursive: true, force: true });
});

function run(releaseNotes = '', signal?: AbortSignal, attempt = 1) {
  return triggerFastlane({
    buildId: 'test-build', attempt, buildNumber: '1', releaseNotes, config, signal,
  }, new BuildLogService(path.join(directory, 'logs')));
}

async function assertCleaned(attempt = 1) {
  const log = await fs.readFile(path.join(directory, `logs/test-build/attempt-${attempt}.log`), 'utf8');
  const archive = log.match(/Temporary archive: (.+)\n/)![1];
  await expect(fs.stat(path.dirname(archive))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await fs.readFile(path.join(directory, 'old.xcarchive/keep'), 'utf8')).toBe('user archive');
  expect(log).toContain('Temporary xcarchive removed');
  return archive;
}

describe('per-attempt archive lifecycle', () => {
  it.each([false, true])('removes only its own archive after success (testBuild=%s)', async (testBuild) => {
    config.testBuild = testBuild;
    await run();
    const first = await assertCleaned();
    expect(await fs.readFile(path.join(directory, 'build/app.ipa'), 'utf8')).toBe('retained');
    await run('', undefined, 2);
    expect(await assertCleaned(2)).not.toBe(first);
  });

  it('removes a partial archive while retaining the original Fastlane failure', async () => {
    await expect(run('fail')).rejects.toThrow('Fastlane exited with code 7');
    await assertCleaned();
  });

  it('cleans up after a user cancellation', async () => {
    const controller = new AbortController();
    const result = run('wait', controller.signal);
    const rejected = expect(result).rejects.toThrow('Build was cancelled');
    await vi.waitFor(() => fs.access(path.join(directory, 'archive-path.txt')));
    controller.abort();
    await rejected;
    await assertCleaned();
  });

  it('cleans up after the build timeout', async () => {
    env.BUILD_TIMEOUT_MS = 500;
    await expect(run('wait')).rejects.toThrow('500ms timeout');
    await assertCleaned();
  });

  it('cleans up even when the runner cannot start', async () => {
    env.FASTLANE_RUNNER_PATH = path.join(directory, 'missing-runner');
    await expect(run()).rejects.toMatchObject({ code: 'ENOENT' });
    await assertCleaned();
  });

  it.each(['', 'fail'])('logs cleanup failure without replacing the build result (%s)', async (mode) => {
    const remove = fs.rm.bind(fs);
    vi.spyOn(fs, 'rm').mockImplementation(async (target, options) => {
      if (/^autopush-archive-[A-Za-z0-9]{6}$/.test(path.basename(String(target)))) {
        leftoverArchives.push(String(target));
        throw new Error('Simulated permission error');
      }
      return remove(target, options);
    });
    if (mode === 'fail') await expect(run(mode)).rejects.toThrow('Fastlane exited with code 7');
    else await expect(run()).resolves.toMatchObject({ logRelativePath: 'test-build/attempt-1.log' });
    const log = await fs.readFile(path.join(directory, 'logs/test-build/attempt-1.log'), 'utf8');
    expect(log).toContain('WARNING: Archive cleanup failed');
    expect(await fs.readFile(path.join(directory, 'build/app.ipa'), 'utf8')).toBe('retained');
  });
});
