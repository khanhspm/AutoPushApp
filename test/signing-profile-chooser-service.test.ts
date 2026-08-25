import { constants as fsConstants } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { AppError } from '../src/http/errors';
import { maxProfileImportBytes } from '../src/services/signing-discovery-service';
import {
  SigningProfileChooserService,
  type SigningProfileChooserCommandOptions,
  type SigningProfileChooserCommandResult,
  type SigningProfileChooserCommandRunner,
  type SigningProfileChooserFileHandle,
  type SigningProfileChooserFileSystem,
} from '../src/services/signing-profile-chooser-service';

interface CommandCall {
  command: string;
  args: readonly string[];
  options: SigningProfileChooserCommandOptions;
}

type CommandHandler = (
  options: SigningProfileChooserCommandOptions,
) => Promise<SigningProfileChooserCommandResult>;

class FakeRunner implements SigningProfileChooserCommandRunner {
  readonly calls: CommandCall[] = [];
  readonly handlers: CommandHandler[] = [];

  async run(
    command: string,
    args: readonly string[],
    options: SigningProfileChooserCommandOptions,
  ): Promise<SigningProfileChooserCommandResult> {
    this.calls.push({ command, args, options });
    const handler = this.handlers.shift();
    if (!handler) throw new Error('unexpected command');
    return handler(options);
  }
}

class FakeFileHandle implements SigningProfileChooserFileHandle {
  closed = false;

  constructor(
    private readonly data: Buffer,
    private readonly regular = true,
    private readonly reportedSize = data.length,
  ) {}

  async stat() {
    return { size: this.reportedSize, isFile: () => this.regular };
  }

  async read(buffer: Buffer, offset: number, length: number, position: number) {
    const bytesRead = this.data.copy(buffer, offset, position, position + length);
    return { bytesRead };
  }

  async close() {
    this.closed = true;
  }
}

class FakeFileSystem implements SigningProfileChooserFileSystem {
  readonly lstatCalls: string[] = [];
  readonly openCalls: Array<{ filePath: string; flags: number }> = [];
  stats = { size: 7, isFile: () => true, isSymbolicLink: () => false };
  handle: SigningProfileChooserFileHandle = new FakeFileHandle(Buffer.from('profile'));
  lstatError: Error | null = null;
  openError: Error | null = null;

  async lstat(filePath: string) {
    this.lstatCalls.push(filePath);
    if (this.lstatError) throw this.lstatError;
    return this.stats;
  }

  async open(filePath: string, flags: number) {
    this.openCalls.push({ filePath, flags });
    if (this.openError) throw this.openError;
    return this.handle;
  }
}

function successful(stdout = '/Users/example/Profile.mobileprovision\n'): CommandHandler {
  return async () => ({ stdout });
}

function chooser(
  runner: FakeRunner,
  fileSystem = new FakeFileSystem(),
  platform: NodeJS.Platform = 'darwin',
): SigningProfileChooserService {
  return new SigningProfileChooserService({ platform, commandRunner: runner, fileSystem });
}

describe('SigningProfileChooserService', () => {
  it('opens the fixed native file picker and reads a regular profile without following symlinks', async () => {
    const runner = new FakeRunner();
    const fileSystem = new FakeFileSystem();
    runner.handlers.push(successful());

    await expect(chooser(runner, fileSystem).chooseProfile()).resolves.toEqual(Buffer.from('profile'));
    expect(runner.calls).toEqual([{
      command: '/usr/bin/osascript',
      args: [
        '-e',
        [
          'set selectedFile to choose file with prompt "Select a provisioning profile" of type {"com.apple.mobileprovision"}',
          'return POSIX path of selectedFile',
        ].join('\n'),
      ],
      options: { timeoutMs: 600_000, maxBuffer: 65_536, signal: undefined },
    }]);
    expect(fileSystem.lstatCalls).toEqual(['/Users/example/Profile.mobileprovision']);
    expect(fileSystem.openCalls).toEqual([{
      filePath: '/Users/example/Profile.mobileprovision',
      flags: fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
    }]);
    expect((fileSystem.handle as FakeFileHandle).closed).toBe(true);
  });

  it('returns null for AppleScript cancellation and releases the lock', async () => {
    const runner = new FakeRunner();
    runner.handlers.push(
      async () => { throw Object.assign(new Error('cancelled'), { stderr: 'User canceled. (-128)\n' }); },
      successful('/Users/example/Next.mobileprovision\n'),
    );
    const service = chooser(runner);

    await expect(service.chooseProfile()).resolves.toBeNull();
    await expect(service.chooseProfile()).resolves.toEqual(Buffer.from('profile'));
  });

  it('sanitizes abort failures and rejects a concurrent chooser', async () => {
    const runner = new FakeRunner();
    const controller = new AbortController();
    runner.handlers.push((options) => new Promise((_resolve, reject) => {
      options.signal?.addEventListener('abort', () => reject(new Error('private abort reason')), { once: true });
    }));
    const service = chooser(runner);

    const pending = service.chooseProfile(controller.signal);
    await expect(service.chooseProfile()).rejects.toMatchObject({
      statusCode: 409,
      code: 'SIGNING_PROFILE_CHOOSER_BUSY',
    } satisfies Partial<AppError>);
    controller.abort();
    const error = await pending.catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      statusCode: 503,
      code: 'SIGNING_PROFILE_CHOOSER_UNAVAILABLE',
      message: 'Provisioning profile chooser is unavailable',
    } satisfies Partial<AppError>);
    expect(String(error)).not.toContain('private abort reason');
  });

  it('rejects unsupported platforms without invoking the runner or filesystem', async () => {
    const runner = new FakeRunner();
    const fileSystem = new FakeFileSystem();

    await expect(chooser(runner, fileSystem, 'linux').chooseProfile()).rejects.toMatchObject({
      statusCode: 501,
      code: 'SIGNING_PROFILE_CHOOSER_UNSUPPORTED',
    } satisfies Partial<AppError>);
    expect(runner.calls).toEqual([]);
    expect(fileSystem.lstatCalls).toEqual([]);
  });

  it.each([
    ['/relative/Profile.mobileprovision\0\n', 'SIGNING_PROFILE_CHOOSER_UNAVAILABLE'],
    ['relative.mobileprovision\n', 'SIGNING_PROFILE_CHOOSER_UNAVAILABLE'],
    ['/Users/example/Profile.txt\n', 'SIGNING_PROFILE_SELECTION_INVALID'],
    [
      '/var/folders/j1/g4_x7xcn42v3pxswlpnxlzq80000gn/T/TemporaryItems/NSIRD_screencaptureui_ZPl3UX/Screenshot 2026-08-20 at 17.51.39.png\n',
      'SIGNING_PROFILE_SELECTION_INVALID',
    ],
  ])('rejects an invalid selected path without leaking it', async (stdout, code) => {
    const runner = new FakeRunner();
    runner.handlers.push(successful(stdout));

    const error = await chooser(runner).chooseProfile().catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code } satisfies Partial<AppError>);
    expect(String(error)).not.toContain(stdout.trim());
    expect(String(error)).not.toContain('/var/folders');
    expect(String(error)).not.toContain('NSIRD_screencaptureui');
  });

  it('accepts an uppercase mobileprovision extension', async () => {
    const runner = new FakeRunner();
    const fileSystem = new FakeFileSystem();
    runner.handlers.push(successful('/Users/example/Profile.MOBILEPROVISION\n'));

    await expect(chooser(runner, fileSystem).chooseProfile()).resolves.toEqual(Buffer.from('profile'));
    expect(fileSystem.lstatCalls).toEqual(['/Users/example/Profile.MOBILEPROVISION']);
  });

  it('sanitizes native chooser failures containing a temporary screenshot path', async () => {
    const privatePath = '/var/folders/private/TemporaryItems/NSIRD_screencaptureui/Screenshot.png';
    const runner = new FakeRunner();
    runner.handlers.push(async () => {
      throw Object.assign(new Error(`failed to select ${privatePath}`), { stderr: privatePath });
    });

    const error = await chooser(runner).chooseProfile().catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      statusCode: 503,
      code: 'SIGNING_PROFILE_CHOOSER_UNAVAILABLE',
      message: 'Provisioning profile chooser is unavailable',
    } satisfies Partial<AppError>);
    expect(String(error)).not.toContain('/var/folders');
    expect(String(error)).not.toContain('NSIRD_screencaptureui');
  });

  it('rejects directories and symlinks before opening them', async () => {
    const runner = new FakeRunner();
    const fileSystem = new FakeFileSystem();
    fileSystem.stats = { size: 0, isFile: () => false, isSymbolicLink: () => true };
    runner.handlers.push(successful());

    await expect(chooser(runner, fileSystem).chooseProfile()).rejects.toMatchObject({
      statusCode: 400,
      code: 'SIGNING_PROFILE_SELECTION_INVALID',
    } satisfies Partial<AppError>);
    expect(fileSystem.openCalls).toEqual([]);
  });

  it('accepts exactly 2 MiB and rejects data that grows beyond the limit', async () => {
    const exactRunner = new FakeRunner();
    const exactFileSystem = new FakeFileSystem();
    const exactData = Buffer.alloc(maxProfileImportBytes, 1);
    exactFileSystem.stats = { size: exactData.length, isFile: () => true, isSymbolicLink: () => false };
    exactFileSystem.handle = new FakeFileHandle(exactData);
    exactRunner.handlers.push(successful());

    await expect(chooser(exactRunner, exactFileSystem).chooseProfile()).resolves.toHaveLength(maxProfileImportBytes);

    const growingRunner = new FakeRunner();
    const growingFileSystem = new FakeFileSystem();
    growingFileSystem.handle = new FakeFileHandle(Buffer.alloc(maxProfileImportBytes + 1), true, maxProfileImportBytes);
    growingRunner.handlers.push(successful());

    await expect(chooser(growingRunner, growingFileSystem).chooseProfile()).rejects.toMatchObject({
      statusCode: 413,
      code: 'SIGNING_PROFILE_TOO_LARGE',
    } satisfies Partial<AppError>);
    expect((growingFileSystem.handle as FakeFileHandle).closed).toBe(true);
  });

  it('sanitizes filesystem failures and releases the lock', async () => {
    const runner = new FakeRunner();
    const fileSystem = new FakeFileSystem();
    fileSystem.openError = new Error('/Users/private/profile.mobileprovision permission denied');
    runner.handlers.push(successful(), successful());
    const service = chooser(runner, fileSystem);

    const error = await service.chooseProfile().catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      statusCode: 400,
      code: 'SIGNING_PROFILE_SELECTION_INVALID',
    } satisfies Partial<AppError>);
    expect(String(error)).not.toContain('/Users/private');

    fileSystem.openError = null;
    await expect(service.chooseProfile()).resolves.toEqual(Buffer.from('profile'));
  });

  it('reconstructs path-bearing AppErrors raised while reading the selected file', async () => {
    const privatePath = '/var/folders/private/TemporaryItems/profile.mobileprovision';
    const runner = new FakeRunner();
    const fileSystem = new FakeFileSystem();
    fileSystem.handle = {
      async stat() {
        throw new AppError(500, 'PRIVATE_FAILURE', `Could not stat ${privatePath}`);
      },
      async read() {
        return { bytesRead: 0 };
      },
      async close() {},
    };
    runner.handlers.push(successful());

    const error = await chooser(runner, fileSystem).chooseProfile().catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      statusCode: 400,
      code: 'SIGNING_PROFILE_SELECTION_INVALID',
      message: 'Select a regular .mobileprovision file',
    } satisfies Partial<AppError>);
    expect(String(error)).not.toContain('/var/folders');
    expect(String(error)).not.toContain('PRIVATE_FAILURE');
  });
});
