import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { build as buildPlist, type PlistObject } from 'plist';
import { afterEach, describe, expect, it } from 'vitest';

import { AppError } from '../src/http/errors';
import {
  ExecFileCommandRunner,
  SigningDiscoveryService,
  type SigningCommandOptions,
  type SigningCommandResult,
  type SigningCommandRunner,
  type SigningDiscoveryDirectoryEntry,
  type SigningDiscoveryFileSystem,
  type SigningImportFileHandle,
} from '../src/services/signing-discovery-service';

const certificateOne = 'MIIC/TCCAeWgAwIBAgIUMGl2JDfjjBEH6pw/ujsFJx/wtMIwDQYJKoZIhvcNAQELBQAwDjEMMAoGA1UEAwwDT25lMB4XDTI2MDgxNzA1MzE0MFoXDTM2MDgxNDA1MzE0MFowDjEMMAoGA1UEAwwDT25lMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAoWnZr0mYFS4PHldmjXa8BVKRF/o3C8vzbh6wnEnub8FRkarNXI+WUL/C+FJ7Ove2nmzg2IB+t6TQx976kw4aCRxcGW5dQ2+AIQY4e7geeNOK67NKGN6BFYz2iq+0imXF9vfOHUVL5UlYLB4wBf1mnrZoFfFfc0g8FfMhKrXoT2Ozbl3RZ6eYBHpJeJfb49gWzZr+lk56QKAL1iCpNLW6k162COWG2LFRvz/rWQ/yDNUVyjMalkdZPqsK7TXBlgEaGkC0476gqS0PGIHb/nzzgOa7NslY8ZKA6v21Mv31cro4/+NZ4ebeP5fMWaDBqnvbuL2w+RCDiQOzkV2QNk3RvQIDAQABo1MwUTAdBgNVHQ4EFgQUQc6WbZmZZEZ8UZLOhelA9yRFzgIwHwYDVR0jBBgwFoAUQc6WbZmZZEZ8UZLOhelA9yRFzgIwDwYDVR0TAQH/BAUwAwEB/zANBgkqhkiG9w0BAQsFAAOCAQEADzDSceT/hewMc3uPUzoM5vLR4KFsWtxeUXc3dpSGpt/MHOb1VuekG5FjWc89R9OJ5aeTmaMMmrE2gifRv6lcAsIiD0F2AsBvDffF9/NT+vg/W09+W9Gk+GIGwnST59wsZTjCTy7B7LnWbH9OL42knkyJifSNhz7i0FdkHiGqwjgXEM1Ke2oSqBxm1FsAe/4trBxedvOW2MOBKsEWtzuhbhlEOXgUatoBN+xE6DKqwrsLTGflpdFL68FcdYPzIxUSDG5lrtN3nbp/OzyMUmZ/ckYC5F/quM6MadS7KX7ArRTeXslJg3x0SF9Uv2mxQZsOt+JbhjemlQByfWyKO51wbA==';
const certificateTwo = 'MIIC/TCCAeWgAwIBAgIUfFlFz8RLi/A3rYYPLnh5fKIutbswDQYJKoZIhvcNAQELBQAwDjEMMAoGA1UEAwwDVHdvMB4XDTI2MDgxNzA1MzE0MFoXDTM2MDgxNDA1MzE0MFowDjEMMAoGA1UEAwwDVHdvMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAr6qPRPxZQsd2QX/Uq3V2S7CHrpQSbx9bWHioMWzcbSBYliKKe+1yvajerZFytiAH63WevDHAjirZmKMDQ5gSSwZN05KSo1pZ+jLbwj+zeFkPw1pXjdwAHp9WZSzR3c4W9FgVunJ39O+XcMlZrd8iJRhZ8wqqmOhK49BsjrrUgTybHaHFj7MLReLsKO9VwNUxVBvol5mRD+ulCAJa4BX0EpQYrsfJbKhUtLPJqINX3DVUVx8Gg25sXL4vQOl2Hbhn4VxXfB5EP3uplKgg1bg+vq5+6eehsNueD5/3fT7LPfgADVCdZgHk1JcBet8Pp9EIlEQDJcEpfOH+RIP5OKsZzQIDAQABo1MwUTAdBgNVHQ4EFgQUzBiBiShKs0pHE7+HfLPHGCcPuGswHwYDVR0jBBgwFoAUzBiBiShKs0pHE7+HfLPHGCcPuGswDwYDVR0TAQH/BAUwAwEB/zANBgkqhkiG9w0BAQsFAAOCAQEAUsuJj94dg6Du/IESeJ6DiCCw8Hx5ofOicxq3Qndu0xxpt6YHtqTYtFK3rVja+9kxUG42vcYbh+dSzae4vo8XfRNG7AtXsuZDLOLtmZj5qe0UFYCb4PrRV+y46UEIDHl8KDt+38WN/eREDEMRnSj0JFCVmGMLJb+WI4Orm+/sEycmnX86TVs1n1rcjWRbJM3wlWl9AVRGj8xfzUcrtg8943pRMXKbaHvZRPwzZbLuOoSGq+c6Jh+YAEwdEU4YiIYLTESPHdbHfps2+Nn/zEFykkID/5GF77dD+Nuby+paTeczOe5A5FeaI+DytRIX52yZdEAab1P+2IBCvLMkZJW42g==';
const fingerprintOne = '3BB60E47C30008EF08184601103CBED6BCDEB14C';
const fingerprintTwo = 'F7E65BCA6A33CAE558A4C1CB69E5E933DB8FC917';
const now = new Date('2026-01-01T00:00:00.000Z');

interface CommandCall {
  command: string;
  args: readonly string[];
  options: SigningCommandOptions;
}

class FakeRunner implements SigningCommandRunner {
  readonly calls: CommandCall[] = [];
  identities = '0 valid identities found';
  identityError = false;
  decodeError = false;
  decodeFailures = new Set<string>();
  profileXml = new Map<string, string>();
  defaultProfileXml: string | undefined;
  delayMs = 0;
  activeCalls = 0;
  maxActiveCalls = 0;

  async run(command: string, args: readonly string[], options: SigningCommandOptions): Promise<SigningCommandResult> {
    this.calls.push({ command, args, options });
    this.activeCalls += 1;
    this.maxActiveCalls = Math.max(this.maxActiveCalls, this.activeCalls);
    try {
      if (this.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.delayMs));
      if (command === '/usr/bin/security' && args[0] === 'cms') {
        const fileName = args[args.length - 1].split('/').at(-1)!;
        if (this.decodeError || this.decodeFailures.has(fileName)) throw new Error(`cannot read ${fileName}`);
        return { stdout: this.profileXml.get(fileName) ?? this.defaultProfileXml ?? '<bad-plist>' };
      }
      if (command === '/usr/bin/security' && args[0] === 'find-identity') {
        if (this.identityError) throw new Error('secret keychain failure output');
        return { stdout: this.identities };
      }
      throw new Error('unexpected command');
    } finally {
      this.activeCalls -= 1;
    }
  }
}

function entry(name: string, kind: 'file' | 'symlink' | 'directory' = 'file'): SigningDiscoveryDirectoryEntry {
  return {
    name,
    isFile: () => kind === 'file',
    isSymbolicLink: () => kind === 'symlink',
  };
}

function fileSystem(entries: readonly SigningDiscoveryDirectoryEntry[]): SigningDiscoveryFileSystem {
  return { async readdir() { return entries; } };
}

function realImportFileSystem(overrides: Partial<SigningDiscoveryFileSystem> = {}): SigningDiscoveryFileSystem {
  return {
    async readdir(directoryPath, options) { return fs.readdir(directoryPath, options); },
    async mkdir(directoryPath, options) { return fs.mkdir(directoryPath, options); },
    async lstat(filePath) { return fs.lstat(filePath); },
    async open(filePath, flags, mode) { return fs.open(filePath, flags, mode); },
    async link(existingPath, newPath) { await fs.link(existingPath, newPath); },
    async readFile(filePath) { return fs.readFile(filePath); },
    async unlink(filePath) { await fs.unlink(filePath); },
    ...overrides,
  };
}

function profile(overrides: Record<string, unknown> = {}): PlistObject {
  const value: Record<string, unknown> = {
    Name: 'Example Ad Hoc',
    UUID: '11111111-1111-4111-8111-111111111111',
    TeamIdentifier: ['AB12CDEFGH'],
    TeamName: 'Example Company',
    ExpirationDate: new Date('2027-01-01T00:00:00.000Z'),
    ProvisionedDevices: ['device-1'],
    ProvisionsAllDevices: false,
    DeveloperCertificates: [Buffer.from(certificateOne, 'base64')],
    Entitlements: {
      'application-identifier': 'PREFIX1234.com.example.app',
      'get-task-allow': false,
    },
    ...overrides,
  };
  for (const [key, item] of Object.entries(value)) {
    if (item === undefined) delete value[key];
  }
  return value as PlistObject;
}

function service(entries: readonly SigningDiscoveryDirectoryEntry[], runner: FakeRunner): SigningDiscoveryService {
  return new SigningDiscoveryService({
    platform: 'darwin',
    homeDirectory: '/Users/private-user',
    fileSystem: fileSystem(entries),
    commandRunner: runner,
    now: () => now,
  });
}

function addProfile(runner: FakeRunner, fileName: string, value: Record<string, unknown>): void {
  runner.profileXml.set(fileName, buildPlist(value as PlistObject));
}

function identityLine(index: number, fingerprint: string, name: string): string {
  return `${index}) ${fingerprint} "${name}"`;
}

const temporaryHomes: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryHomes.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

async function temporaryHome(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'autopush-signing-test-'));
  temporaryHomes.push(directory);
  return directory;
}

function installedProfilesDirectory(homeDirectory: string): string {
  return path.join(homeDirectory, 'Library', 'MobileDevice', 'Provisioning Profiles');
}

function importService(
  homeDirectory: string,
  runner: FakeRunner,
  overrides: { platform?: NodeJS.Platform; fileSystem?: SigningDiscoveryFileSystem } = {},
): SigningDiscoveryService {
  return new SigningDiscoveryService({
    platform: overrides.platform ?? 'darwin',
    homeDirectory,
    fileSystem: overrides.fileSystem,
    commandRunner: runner,
    now: () => now,
  });
}

describe('SigningDiscoveryService', () => {
  it('handles early child exit while writing stdin without an unhandled EPIPE', async () => {
    const runner = new ExecFileCommandRunner();

    await expect(runner.run(
      process.execPath,
      ['-e', 'process.exit(0)'],
      { stdin: 'x'.repeat(2 * 1024 * 1024), timeoutMs: 10_000, maxBuffer: 4 * 1024 * 1024 },
    )).resolves.toEqual({ stdout: '' });
  });

  it('finds an exact unexpired Ad Hoc profile and intersects normalized X509 SHA-1 identities', async () => {
    const runner = new FakeRunner();
    addProfile(runner, 'exact.mobileprovision', profile());
    runner.identities = [
      identityLine(1, fingerprintOne.toLowerCase(), 'Apple Distribution: Example Company (AB12CDEFGH)'),
      '  1 valid identities found',
    ].join('\n');

    const result = await service([entry('exact.mobileprovision')], runner).discover('com.example.app');

    expect(result).toEqual({
      bundleId: 'com.example.app',
      warnings: [],
      profiles: [{
        profileName: 'Example Ad Hoc',
        uuid: '11111111-1111-4111-8111-111111111111',
        teamId: 'AB12CDEFGH',
        teamName: 'Example Company',
        expiresAt: '2027-01-01T00:00:00.000Z',
        certificateCandidates: [{
          name: 'Apple Distribution: Example Company (AB12CDEFGH)',
          sha1Fingerprint: fingerprintOne,
          kind: 'distribution',
        }],
        recommendedCertificate: {
          name: 'Apple Distribution: Example Company (AB12CDEFGH)',
          sha1Fingerprint: fingerprintOne,
          kind: 'distribution',
        },
        warnings: [],
      }],
    });
    expect(runner.calls).toEqual(expect.arrayContaining([
      expect.objectContaining({
        command: '/usr/bin/security',
        args: ['cms', '-D', '-i', '/Users/private-user/Library/MobileDevice/Provisioning Profiles/exact.mobileprovision'],
      }),
      expect.objectContaining({
        command: '/usr/bin/security',
        args: ['find-identity', '-v', '-p', 'codesigning'],
      }),
    ]));
    expect(runner.calls.some((call) => call.command === '/usr/bin/plutil')).toBe(false);
  });

  it('excludes wildcard, suffix-only, expired, development, App Store, and enterprise profiles', async () => {
    const runner = new FakeRunner();
    const inputs: Array<[string, Record<string, unknown>]> = [
      ['wildcard.mobileprovision', profile({ Entitlements: { 'application-identifier': 'PREFIX1234.com.example.*', 'get-task-allow': false } })],
      ['suffix.mobileprovision', profile({ Entitlements: { 'application-identifier': 'PREFIX1234.com.other.com.example.app', 'get-task-allow': false } })],
      ['expired.mobileprovision', profile({ ExpirationDate: '2025-12-31T23:59:59.000Z' })],
      ['development.mobileprovision', profile({ Entitlements: { 'application-identifier': 'PREFIX1234.com.example.app', 'get-task-allow': true } })],
      ['app-store.mobileprovision', profile({ ProvisionedDevices: undefined })],
      ['enterprise.mobileprovision', profile({ ProvisionsAllDevices: true })],
    ];
    for (const [name, value] of inputs) addProfile(runner, name, value);

    const result = await service(inputs.map(([name]) => entry(name)), runner).discover('com.example.app');

    expect(result).toEqual({ bundleId: 'com.example.app', profiles: [], warnings: [] });
    expect(runner.calls.some((call) => call.args[0] === 'find-identity')).toBe(false);
  });

  it('sorts and deduplicates profiles and does not recommend among multiple distribution identities', async () => {
    const runner = new FakeRunner();
    addProfile(runner, 'later-z.mobileprovision', profile({
      Name: 'Zulu',
      UUID: '22222222-2222-4222-8222-222222222222',
      ExpirationDate: '2028-01-01T00:00:00Z',
      DeveloperCertificates: [certificateTwo, certificateOne],
    }));
    addProfile(runner, 'later-a.mobileprovision', profile({
      Name: 'Alpha',
      UUID: '33333333-3333-4333-8333-333333333333',
      ExpirationDate: '2028-01-01T00:00:00Z',
    }));
    addProfile(runner, 'duplicate.mobileprovision', profile({
      Name: 'Old duplicate',
      UUID: '33333333-3333-4333-8333-333333333333',
      ExpirationDate: '2027-06-01T00:00:00Z',
    }));
    runner.identities = [
      identityLine(1, fingerprintOne, 'iPhone Distribution: One (AB12CDEFGH)'),
      identityLine(2, fingerprintTwo, 'Apple Distribution: Two (AB12CDEFGH)'),
      '  2 valid identities found',
    ].join('\n');

    const result = await service([
      entry('later-z.mobileprovision'),
      entry('later-a.mobileprovision'),
      entry('duplicate.mobileprovision'),
    ], runner).discover('com.example.app');

    expect(result.profiles.map((item) => item.profileName)).toEqual(['Alpha', 'Zulu']);
    expect(result.profiles[1].certificateCandidates.map((item) => item.sha1Fingerprint)).toEqual([
      fingerprintTwo,
      fingerprintOne,
    ]);
    expect(result.profiles[1].recommendedCertificate).toBeNull();
  });

  it('returns matching development and other identities but recommends only one distribution identity', async () => {
    const runner = new FakeRunner();
    addProfile(runner, 'kinds.mobileprovision', profile({ DeveloperCertificates: [certificateOne, certificateTwo] }));
    runner.identities = [
      identityLine(1, fingerprintOne, 'Apple Development: Developer (AB12CDEFGH)'),
      identityLine(2, fingerprintTwo, 'Mac Installer: Example'),
    ].join('\n');

    const result = await service([entry('kinds.mobileprovision')], runner).discover('com.example.app');

    expect(result.profiles[0].certificateCandidates.map((item) => item.kind)).toEqual(['development', 'other']);
    expect(result.profiles[0].recommendedCertificate).toBeNull();
  });

  it('keeps profiles when no embedded certificate identity is installed', async () => {
    const runner = new FakeRunner();
    addProfile(runner, 'missing.mobileprovision', profile());
    runner.identities = identityLine(1, fingerprintTwo, 'Apple Distribution: Other');

    const result = await service([entry('missing.mobileprovision')], runner).discover('com.example.app');

    expect(result.profiles[0]).toMatchObject({ certificateCandidates: [], recommendedCertificate: null });
    expect(result.warnings).toEqual([]);
  });

  it('aggregates sanitized warnings for unreadable, malformed, and invalid-certificate profiles', async () => {
    const runner = new FakeRunner();
    runner.decodeFailures.add('private-path.mobileprovision');
    runner.profileXml.set('malformed.mobileprovision', '<not-plist>');
    addProfile(runner, 'bad-cert.mobileprovision', profile({ DeveloperCertificates: ['not base64', certificateOne] }));
    runner.identities = identityLine(1, fingerprintOne, 'Apple Distribution: Example');

    const result = await service([
      entry('private-path.mobileprovision'),
      entry('malformed.mobileprovision'),
      entry('bad-cert.mobileprovision'),
    ], runner).discover('com.example.app');

    expect(result.warnings).toEqual([
      { code: 'PROFILE_DECODE_FAILED', message: 'One or more provisioning profiles could not be decoded.' },
    ]);
    expect(result.profiles[0].warnings).toEqual([
      { code: 'CERTIFICATE_INVALID', message: 'A developer certificate in this profile could not be read.' },
    ]);
    expect(JSON.stringify(result)).not.toContain('private-user');
    expect(JSON.stringify(result)).not.toContain('private-path');
    expect(JSON.stringify(result)).not.toContain('not base64');
  });

  it('returns partial profiles with a sanitized warning when identity lookup fails', async () => {
    const runner = new FakeRunner();
    addProfile(runner, 'exact.mobileprovision', profile());
    runner.identityError = true;

    const result = await service([entry('exact.mobileprovision')], runner).discover('com.example.app');

    expect(result.profiles[0]).toMatchObject({ certificateCandidates: [], recommendedCertificate: null });
    expect(result.warnings).toEqual([
      { code: 'IDENTITY_LOOKUP_FAILED', message: 'Installed code-signing identities could not be inspected.' },
    ]);
    expect(JSON.stringify(result)).not.toContain('secret keychain');
  });

  it('ignores non-profile files, directories, and symlinks without following them', async () => {
    const runner = new FakeRunner();

    const result = await service([
      entry('notes.txt'),
      entry('folder.mobileprovision', 'directory'),
      entry('linked.mobileprovision', 'symlink'),
    ], runner).discover('com.example.app');

    expect(result).toEqual({ bundleId: 'com.example.app', profiles: [], warnings: [] });
    expect(runner.calls).toEqual([]);
  });

  it('sorts and caps installed-profile scans with a sanitized truncation warning', async () => {
    const runner = new FakeRunner();
    runner.defaultProfileXml = buildPlist(profile());
    const entries = Array.from({ length: 503 }, (_, index) => (
      entry(`profile-${String(index).padStart(3, '0')}.mobileprovision`)
    )).reverse();

    const result = await service(entries, runner).discover('com.example.app');

    const decodeCalls = runner.calls.filter((call) => call.command === '/usr/bin/security' && call.args[0] === 'cms');
    expect(decodeCalls).toHaveLength(500);
    expect(decodeCalls[0].args.at(-1)).toMatch(/profile-000\.mobileprovision$/);
    expect(decodeCalls.at(-1)?.args.at(-1)).toMatch(/profile-499\.mobileprovision$/);
    expect(result.warnings).toEqual([{
      code: 'PROFILE_SCAN_TRUNCATED',
      message: 'Only the first 500 installed provisioning profiles were inspected.',
    }]);
  });

  it('serializes concurrent discoveries while retaining per-discovery profile concurrency', async () => {
    const runner = new FakeRunner();
    runner.defaultProfileXml = buildPlist(profile());
    runner.delayMs = 5;
    const discovery = service([
      entry('d.mobileprovision'),
      entry('b.mobileprovision'),
      entry('a.mobileprovision'),
      entry('c.mobileprovision'),
    ], runner);

    const [first, second] = await Promise.all([
      discovery.discover('com.example.app'),
      discovery.discover('com.example.app'),
    ]);

    expect(first.profiles).toHaveLength(1);
    expect(second.profiles).toHaveLength(1);
    expect(runner.maxActiveCalls).toBe(4);
    const firstIdentityIndex = runner.calls.findIndex((call) => call.args[0] === 'find-identity');
    expect(runner.calls.slice(0, firstIdentityIndex).filter((call) => call.args[0] === 'cms')).toHaveLength(4);
    expect(runner.calls.filter((call) => call.args[0] === 'cms')).toHaveLength(8);
  });

  it('treats a missing profile directory as an empty successful result', async () => {
    const missingFileSystem: SigningDiscoveryFileSystem = {
      async readdir() {
        throw Object.assign(new Error('private missing path'), { code: 'ENOENT' });
      },
    };
    const result = await new SigningDiscoveryService({
      platform: 'darwin',
      homeDirectory: '/Users/private-user',
      fileSystem: missingFileSystem,
      commandRunner: new FakeRunner(),
      now: () => now,
    }).discover('com.example.app');

    expect(result).toEqual({ bundleId: 'com.example.app', profiles: [], warnings: [] });
  });

  it('returns a sanitized structured error for a profile-directory permission failure', async () => {
    const deniedFileSystem: SigningDiscoveryFileSystem = {
      async readdir() {
        throw Object.assign(new Error('/Users/private-user permission denied'), { code: 'EACCES' });
      },
    };
    const discovery = new SigningDiscoveryService({
      platform: 'darwin',
      homeDirectory: '/Users/private-user',
      fileSystem: deniedFileSystem,
      commandRunner: new FakeRunner(),
    });

    await expect(discovery.discover('com.example.app')).rejects.toMatchObject({
      statusCode: 503,
      code: 'SIGNING_DISCOVERY_FAILED',
      message: 'Unable to inspect installed signing profiles',
    } satisfies Partial<AppError>);
  });

  it('returns a structured unsupported-platform error without touching dependencies', async () => {
    const runner = new FakeRunner();
    let touchedFileSystem = false;
    const discovery = new SigningDiscoveryService({
      platform: 'linux',
      fileSystem: { async readdir() { touchedFileSystem = true; return []; } },
      commandRunner: runner,
    });

    await expect(discovery.discover('com.example.app')).rejects.toMatchObject({
      statusCode: 501,
      code: 'SIGNING_DISCOVERY_UNSUPPORTED',
      message: 'Signing discovery is available only on macOS',
    } satisfies Partial<AppError>);
    expect(touchedFileSystem).toBe(false);
    expect(runner.calls).toEqual([]);
  });

  it('securely stages, validates, installs, rediscovers, and returns an imported profile', async () => {
    const homeDirectory = await temporaryHome();
    const runner = new FakeRunner();
    runner.defaultProfileXml = buildPlist(profile({
      UUID: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    }));
    const profileData = Buffer.from('signed-profile-bytes');

    const result = await importService(homeDirectory, runner).importProfile(profileData, 'com.example.app');

    expect(result).toEqual({
      bundleId: 'com.example.app',
      profiles: [{
        profileName: 'Example Ad Hoc',
        uuid: 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA',
        teamId: 'AB12CDEFGH',
        teamName: 'Example Company',
        expiresAt: '2027-01-01T00:00:00.000Z',
        certificateCandidates: [],
        recommendedCertificate: null,
        warnings: [],
      }],
      warnings: [],
      importedProfileUuid: 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA',
    });

    const directory = installedProfilesDirectory(homeDirectory);
    const destinationPath = path.join(directory, 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA.mobileprovision');
    expect(await fs.readFile(destinationPath)).toEqual(profileData);
    expect((await fs.stat(destinationPath)).mode & 0o777).toBe(0o600);
    expect(await fs.readdir(directory)).toEqual(['AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA.mobileprovision']);

    const decodeCalls = runner.calls.filter((call) => call.command === '/usr/bin/security' && call.args[0] === 'cms');
    expect(decodeCalls).toHaveLength(2);
    expect(decodeCalls[0].args.at(-1)).toMatch(/\.autopush-[0-9a-f-]+\.mobileprovision\.tmp$/);
    expect(decodeCalls[1].args.at(-1)).toBe(destinationPath);
  });

  it('uses injected filesystem operations with exclusive 0600 staging and a no-clobber hard link', async () => {
    const homeDirectory = await temporaryHome();
    const runner = new FakeRunner();
    runner.defaultProfileXml = buildPlist(profile());
    const operations: string[] = [];
    const openCalls: Array<{ flags: string; mode: number }> = [];
    const recordingFileSystem: SigningDiscoveryFileSystem = {
      async readdir(directoryPath, options) {
        operations.push('readdir');
        return fs.readdir(directoryPath, options);
      },
      async mkdir(directoryPath, options) {
        operations.push('mkdir');
        return fs.mkdir(directoryPath, options);
      },
      async lstat(filePath) {
        operations.push('lstat');
        return fs.lstat(filePath);
      },
      async open(filePath, flags, mode) {
        operations.push('open');
        openCalls.push({ flags, mode });
        const handle = await fs.open(filePath, flags, mode);
        const wrapped: SigningImportFileHandle = {
          async writeFile(data) {
            operations.push('write');
            await handle.writeFile(data);
          },
          async sync() {
            operations.push('sync');
            await handle.sync();
          },
          async close() {
            operations.push('close');
            await handle.close();
          },
        };
        return wrapped;
      },
      async link(existingPath, newPath) {
        operations.push('link');
        await fs.link(existingPath, newPath);
      },
      async readFile(filePath) {
        operations.push('readFile');
        return fs.readFile(filePath);
      },
      async unlink(filePath) {
        operations.push('unlink');
        await fs.unlink(filePath);
      },
    };

    await importService(homeDirectory, runner, { fileSystem: recordingFileSystem })
      .importProfile(Buffer.from('profile'), 'com.example.app');

    expect(openCalls).toEqual([{ flags: 'wx', mode: 0o600 }]);
    expect(operations.slice(0, 11)).toEqual([
      'mkdir', 'lstat', 'mkdir', 'lstat', 'mkdir', 'lstat', 'open', 'write', 'sync', 'close', 'link',
    ]);
    expect(operations).toContain('readdir');
    expect(operations.at(-1)).toBe('unlink');
  });

  it('does not unlink a pre-existing file when exclusive staging creation loses a collision', async () => {
    const runner = new FakeRunner();
    let unlinkCalled = false;
    const collisionFileSystem: SigningDiscoveryFileSystem = {
      async readdir() { return []; },
      async mkdir() { return undefined; },
      async lstat() { return { isDirectory: () => true, isSymbolicLink: () => false }; },
      async open() { throw Object.assign(new Error('private collision path'), { code: 'EEXIST' }); },
      async link() { throw new Error('unexpected link'); },
      async readFile() { throw new Error('unexpected read'); },
      async unlink() { unlinkCalled = true; },
    };

    await expect(new SigningDiscoveryService({
      platform: 'darwin',
      homeDirectory: '/Users/private-user',
      fileSystem: collisionFileSystem,
      commandRunner: runner,
    }).importProfile(Buffer.from('profile'))).rejects.toMatchObject({
      statusCode: 503,
      code: 'SIGNING_PROFILE_IMPORT_FAILED',
      message: 'Unable to import the provisioning profile',
    } satisfies Partial<AppError>);

    expect(unlinkCalled).toBe(false);
    expect(runner.calls).toEqual([]);
  });

  it('rejects oversized data and unsupported platforms before touching filesystem or commands', async () => {
    const runner = new FakeRunner();
    let touchedFileSystem = false;
    const fileSystem: SigningDiscoveryFileSystem = {
      async readdir() { touchedFileSystem = true; return []; },
    };

    await expect(new SigningDiscoveryService({
      platform: 'darwin',
      fileSystem,
      commandRunner: runner,
    }).importProfile(Buffer.alloc((2 * 1024 * 1024) + 1))).rejects.toMatchObject({
      statusCode: 413,
      code: 'SIGNING_PROFILE_TOO_LARGE',
      message: 'The provisioning profile exceeds the 2 MiB limit',
    } satisfies Partial<AppError>);

    await expect(new SigningDiscoveryService({
      platform: 'linux',
      fileSystem,
      commandRunner: runner,
    }).importProfile(Buffer.from('profile'))).rejects.toMatchObject({
      statusCode: 501,
      code: 'SIGNING_PROFILE_IMPORT_UNSUPPORTED',
      message: 'Provisioning profile import is available only on macOS',
    } satisfies Partial<AppError>);
    expect(touchedFileSystem).toBe(false);
    expect(runner.calls).toEqual([]);
  });

  it('rejects malformed, non-concrete, non-Ad-Hoc, expired, and bundle-mismatched profiles', async () => {
    const cases: Array<{
      name: string;
      value: unknown;
      expectedBundleId?: string;
      code: string;
    }> = [
      { name: 'malformed metadata', value: profile({ UUID: '../private' }), code: 'SIGNING_PROFILE_INVALID' },
      {
        name: 'wildcard bundle',
        value: profile({ Entitlements: { 'application-identifier': 'PREFIX1234.com.example.*', 'get-task-allow': false } }),
        code: 'SIGNING_PROFILE_INVALID',
      },
      {
        name: 'development profile',
        value: profile({ Entitlements: { 'application-identifier': 'PREFIX1234.com.example.app', 'get-task-allow': true } }),
        code: 'SIGNING_PROFILE_NOT_AD_HOC',
      },
      { name: 'expired profile', value: profile({ ExpirationDate: now.toISOString() }), code: 'SIGNING_PROFILE_EXPIRED' },
      {
        name: 'unexpected bundle',
        value: profile(),
        expectedBundleId: 'com.example.other',
        code: 'SIGNING_PROFILE_BUNDLE_ID_MISMATCH',
      },
    ];

    for (const testCase of cases) {
      const homeDirectory = await temporaryHome();
      const runner = new FakeRunner();
      runner.defaultProfileXml = buildPlist(testCase.value as PlistObject);

      await expect(importService(homeDirectory, runner).importProfile(
        Buffer.from(`profile:${testCase.name}`),
        testCase.expectedBundleId,
      )).rejects.toMatchObject({ statusCode: 400, code: testCase.code } satisfies Partial<AppError>);

      expect(await fs.readdir(installedProfilesDirectory(homeDirectory))).toEqual([]);
    }
  });

  it('rejects different bytes at an existing UUID destination without changing or rediscovering it', async () => {
    const homeDirectory = await temporaryHome();
    const directory = installedProfilesDirectory(homeDirectory);
    await fs.mkdir(directory, { recursive: true });
    const fileName = '11111111-1111-4111-8111-111111111111.mobileprovision';
    const destinationPath = path.join(directory, fileName);
    const existingData = Buffer.from('existing-profile-must-not-change');
    await fs.writeFile(destinationPath, existingData, { mode: 0o600 });
    const runner = new FakeRunner();
    runner.defaultProfileXml = buildPlist(profile());

    await expect(importService(homeDirectory, runner)
      .importProfile(Buffer.from('different-incoming-profile'), 'com.example.app')).rejects.toMatchObject({
      statusCode: 409,
      code: 'SIGNING_PROFILE_IMPORT_CONFLICT',
      message: 'A provisioning profile with this UUID already exists and could not be verified',
    } satisfies Partial<AppError>);

    expect(await fs.readFile(destinationPath)).toEqual(existingData);
    expect(runner.calls.filter((call) => call.args.at(-1) === destinationPath)).toEqual([]);
    expect(await fs.readdir(directory)).toEqual([fileName]);
  });

  it('preserves an existing UUID destination and succeeds idempotently only after byte equality and rediscovery', async () => {
    const homeDirectory = await temporaryHome();
    const directory = installedProfilesDirectory(homeDirectory);
    await fs.mkdir(directory, { recursive: true });
    const destinationPath = path.join(directory, '11111111-1111-4111-8111-111111111111.mobileprovision');
    const existingData = Buffer.from('existing-profile-must-not-change');
    await fs.writeFile(destinationPath, existingData, { mode: 0o600 });
    const runner = new FakeRunner();
    runner.defaultProfileXml = buildPlist(profile());

    const result = await importService(homeDirectory, runner)
      .importProfile(existingData, 'com.example.app');

    expect(result.importedProfileUuid).toBe('11111111-1111-4111-8111-111111111111');
    expect(result.profiles.some((candidate) => candidate.uuid === result.importedProfileUuid)).toBe(true);
    expect(await fs.readFile(destinationPath)).toEqual(existingData);
    expect(await fs.readdir(directory)).toEqual(['11111111-1111-4111-8111-111111111111.mobileprovision']);
  });

  it('returns the validated upload when an identical existing UUID cannot be rediscovered', async () => {
    const homeDirectory = await temporaryHome();
    const directory = installedProfilesDirectory(homeDirectory);
    await fs.mkdir(directory, { recursive: true });
    const fileName = '11111111-1111-4111-8111-111111111111.mobileprovision';
    const destinationPath = path.join(directory, fileName);
    const existingData = Buffer.from('unrelated-existing-data');
    await fs.writeFile(destinationPath, existingData, { mode: 0o600 });
    const runner = new FakeRunner();
    runner.defaultProfileXml = buildPlist(profile());
    runner.decodeFailures.add(fileName);

    const result = await importService(homeDirectory, runner)
      .importProfile(existingData, 'com.example.app');
    expect(result.importedProfileUuid).toBe('11111111-1111-4111-8111-111111111111');
    expect(result.profiles).toHaveLength(1);
    expect(result.profiles[0].profileName).toBe('Example Ad Hoc');

    expect(await fs.readFile(destinationPath)).toEqual(existingData);
    expect(await fs.readdir(directory)).toEqual([fileName]);
  });

  it('returns a direct validated fallback with current identities when a new install is missed by discovery', async () => {
    const homeDirectory = await temporaryHome();
    const runner = new FakeRunner();
    const fileName = '11111111-1111-4111-8111-111111111111.mobileprovision';
    runner.defaultProfileXml = buildPlist(profile());
    runner.decodeFailures.add(fileName);
    runner.identities = identityLine(1, fingerprintOne, 'Apple Distribution: Example Company (AB12CDEFGH)');
    const profileData = Buffer.from('new-profile-data');

    const result = await importService(homeDirectory, runner)
      .importProfile(profileData, 'com.example.app');

    expect(result).toEqual({
      bundleId: 'com.example.app',
      importedProfileUuid: '11111111-1111-4111-8111-111111111111',
      warnings: [{
        code: 'PROFILE_DECODE_FAILED',
        message: 'One or more provisioning profiles could not be decoded.',
      }],
      profiles: [expect.objectContaining({
        uuid: '11111111-1111-4111-8111-111111111111',
        certificateCandidates: [{
          name: 'Apple Distribution: Example Company (AB12CDEFGH)',
          sha1Fingerprint: fingerprintOne,
          kind: 'distribution',
        }],
        recommendedCertificate: {
          name: 'Apple Distribution: Example Company (AB12CDEFGH)',
          sha1Fingerprint: fingerprintOne,
          kind: 'distribution',
        },
      })],
    });
    expect(await fs.readFile(path.join(installedProfilesDirectory(homeDirectory), fileName))).toEqual(profileData);
    expect(runner.calls.filter((call) => call.args[0] === 'find-identity')).toHaveLength(1);
  });

  it('returns a direct validated fallback when discovery fails after a new install', async () => {
    const homeDirectory = await temporaryHome();
    const runner = new FakeRunner();
    runner.defaultProfileXml = buildPlist(profile());
    const profileData = Buffer.from('new-profile-data');
    const discoveryFailingFileSystem = realImportFileSystem({
      async readdir() {
        throw Object.assign(new Error('/private/profile/directory denied'), { code: 'EACCES' });
      },
    });

    const result = await importService(homeDirectory, runner, { fileSystem: discoveryFailingFileSystem })
      .importProfile(profileData, 'com.example.app');

    expect(result).toMatchObject({
      bundleId: 'com.example.app',
      importedProfileUuid: '11111111-1111-4111-8111-111111111111',
      warnings: [],
      profiles: [{ uuid: '11111111-1111-4111-8111-111111111111' }],
    });
    expect(await fs.readFile(path.join(
      installedProfilesDirectory(homeDirectory),
      '11111111-1111-4111-8111-111111111111.mobileprovision',
    ))).toEqual(profileData);
  });

  it('reports cleanup failure as a warning after an otherwise-successful import', async () => {
    const homeDirectory = await temporaryHome();
    const runner = new FakeRunner();
    runner.defaultProfileXml = buildPlist(profile());
    const cleanupFailingFileSystem = realImportFileSystem({
      async unlink(filePath) {
        await fs.unlink(filePath);
        throw new Error('/private/cleanup/path could not be finalized');
      },
    });

    const result = await importService(homeDirectory, runner, { fileSystem: cleanupFailingFileSystem })
      .importProfile(Buffer.from('profile'), 'com.example.app');
    expect(result.warnings).toContainEqual({
      code: 'PROFILE_IMPORT_CLEANUP_FAILED',
      message: 'The profile was imported, but a temporary file could not be removed.',
    });

    expect(await fs.readdir(installedProfilesDirectory(homeDirectory))).toEqual([
      '11111111-1111-4111-8111-111111111111.mobileprovision',
    ]);
  });

  it('preserves the original structured import error when staging cleanup also fails', async () => {
    const homeDirectory = await temporaryHome();
    const runner = new FakeRunner();
    runner.defaultProfileXml = buildPlist(profile());
    const cleanupFailingFileSystem = realImportFileSystem({
      async unlink(filePath) {
        await fs.unlink(filePath);
        throw new Error('/private/cleanup/path could not be finalized');
      },
    });

    await expect(importService(homeDirectory, runner, { fileSystem: cleanupFailingFileSystem })
      .importProfile(Buffer.from('profile'), 'com.example.other')).rejects.toMatchObject({
      statusCode: 400,
      code: 'SIGNING_PROFILE_BUNDLE_ID_MISMATCH',
      message: 'The provisioning profile bundle identifier does not match the expected bundle identifier',
    } satisfies Partial<AppError>);

    expect(await fs.readdir(installedProfilesDirectory(homeDirectory))).toEqual([]);
  });

  it('always removes staging data and returns sanitized errors when decoding fails', async () => {
    const homeDirectory = await temporaryHome();
    const runner = new FakeRunner();
    runner.decodeError = true;
    const privateData = Buffer.from('private raw provisioning profile contents');
    let caught: unknown;

    try {
      await importService(homeDirectory, runner).importProfile(privateData, 'com.example.app');
    } catch (error) {
      caught = error;
    }

    expect(caught).toMatchObject({
      statusCode: 400,
      code: 'SIGNING_PROFILE_INVALID',
      message: 'The provisioning profile is invalid',
    } satisfies Partial<AppError>);
    const serialized = `${String(caught)} ${JSON.stringify(caught)}`;
    expect(serialized).not.toContain(homeDirectory);
    expect(serialized).not.toContain('private raw');
    expect(serialized).not.toContain('.autopush-');
    expect(await fs.readdir(installedProfilesDirectory(homeDirectory))).toEqual([]);
  });

  it('rejects a symlinked provisioning-profile path component without writing through it', async () => {
    const homeDirectory = await temporaryHome();
    const outsideDirectory = await temporaryHome();
    const libraryDirectory = path.join(homeDirectory, 'Library');
    await fs.mkdir(libraryDirectory, { recursive: true });
    await fs.symlink(outsideDirectory, path.join(libraryDirectory, 'MobileDevice'), 'dir');
    const runner = new FakeRunner();
    runner.defaultProfileXml = buildPlist(profile());

    await expect(importService(homeDirectory, runner)
      .importProfile(Buffer.from('profile'), 'com.example.app')).rejects.toMatchObject({
      statusCode: 503,
      code: 'SIGNING_PROFILE_IMPORT_FAILED',
      message: 'Unable to import the provisioning profile',
    } satisfies Partial<AppError>);

    expect(await fs.readdir(outsideDirectory)).toEqual([]);
    expect(runner.calls).toEqual([]);
  });
});
