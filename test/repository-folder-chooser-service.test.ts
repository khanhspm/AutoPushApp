import { describe, expect, it } from 'vitest';

import { AppError } from '../src/http/errors';
import {
  RepositoryFolderChooserService,
  type RepositoryFolderChooserCommandOptions,
  type RepositoryFolderChooserCommandResult,
  type RepositoryFolderChooserCommandRunner,
} from '../src/services/repository-folder-chooser-service';

interface CommandCall {
  command: string;
  args: readonly string[];
  options: RepositoryFolderChooserCommandOptions;
}

type CommandHandler = (
  options: RepositoryFolderChooserCommandOptions,
) => Promise<RepositoryFolderChooserCommandResult>;

class FakeRunner implements RepositoryFolderChooserCommandRunner {
  readonly calls: CommandCall[] = [];
  readonly handlers: CommandHandler[] = [];

  async run(
    command: string,
    args: readonly string[],
    options: RepositoryFolderChooserCommandOptions,
  ): Promise<RepositoryFolderChooserCommandResult> {
    this.calls.push({ command, args, options });
    const handler = this.handlers.shift();
    if (!handler) throw new Error('unexpected command');
    return handler(options);
  }
}

function successful(stdout = '/Users/example/Repository\n'): CommandHandler {
  return async () => ({ stdout });
}

function chooser(runner: FakeRunner, platform: NodeJS.Platform = 'darwin'): RepositoryFolderChooserService {
  return new RepositoryFolderChooserService({ platform, commandRunner: runner });
}

describe('RepositoryFolderChooserService', () => {
  it('runs the fixed POSIX-path AppleScript with bounded output and a long timeout', async () => {
    const runner = new FakeRunner();
    runner.handlers.push(successful());

    await expect(chooser(runner).chooseFolder()).resolves.toBe('/Users/example/Repository');
    expect(runner.calls).toEqual([{
      command: '/usr/bin/osascript',
      args: [
        '-e',
        [
          'set selectedFolder to choose folder with prompt "Select a repository folder"',
          'return POSIX path of selectedFolder',
        ].join('\n'),
      ],
      options: {
        timeoutMs: 600_000,
        maxBuffer: 65_536,
        signal: undefined,
      },
    }]);
  });

  it('returns null for AppleScript cancellation and releases the single-flight lock', async () => {
    const runner = new FakeRunner();
    runner.handlers.push(
      async () => {
        throw Object.assign(new Error('Command failed without safe details'), {
          stderr: 'execution error: User canceled. (-128)\n',
        });
      },
      successful('/Users/example/Next\n'),
    );
    const service = chooser(runner);

    await expect(service.chooseFolder()).resolves.toBeNull();
    await expect(service.chooseFolder()).resolves.toBe('/Users/example/Next');
    expect(runner.calls).toHaveLength(2);
  });

  it('passes an AbortSignal, sanitizes abort failures, and releases the busy lock', async () => {
    const runner = new FakeRunner();
    const controller = new AbortController();
    runner.handlers.push(
      (options) => new Promise((_resolve, reject) => {
        options.signal?.addEventListener('abort', () => {
          reject(Object.assign(new Error('private abort reason'), { name: 'AbortError' }));
        }, { once: true });
      }),
      successful('/Users/example/AfterAbort\n'),
    );
    const service = chooser(runner);

    const abortedChoice = service.chooseFolder(controller.signal);
    expect(runner.calls[0]?.options.signal).toBe(controller.signal);
    await expect(service.chooseFolder()).rejects.toMatchObject({
      statusCode: 409,
      code: 'REPOSITORY_FOLDER_CHOOSER_BUSY',
    } satisfies Partial<AppError>);

    controller.abort(new Error('private controller reason'));
    const error = await abortedChoice.catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      statusCode: 503,
      code: 'REPOSITORY_FOLDER_CHOOSER_UNAVAILABLE',
      message: 'Repository folder chooser is unavailable',
    } satisfies Partial<AppError>);
    expect(String(error)).not.toContain('private abort reason');
    expect(String(error)).not.toContain('private controller reason');

    await expect(service.chooseFolder()).resolves.toBe('/Users/example/AfterAbort');
  });

  it('sanitizes an already-aborted signal and releases the lock without starting a command', async () => {
    const runner = new FakeRunner();
    runner.handlers.push(successful('/Users/example/AfterPreAbort\n'));
    const controller = new AbortController();
    controller.abort(new AppError(418, 'PRIVATE_ABORT', 'private abort reason'));
    const service = chooser(runner);

    const error = await service.chooseFolder(controller.signal).catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      statusCode: 503,
      code: 'REPOSITORY_FOLDER_CHOOSER_UNAVAILABLE',
      message: 'Repository folder chooser is unavailable',
    } satisfies Partial<AppError>);
    expect(String(error)).not.toContain('private abort reason');
    expect(runner.calls).toEqual([]);

    await expect(service.chooseFolder()).resolves.toBe('/Users/example/AfterPreAbort');
  });

  it('rejects concurrent chooser requests without disturbing the active request', async () => {
    const runner = new FakeRunner();
    let resolveFirst!: (result: RepositoryFolderChooserCommandResult) => void;
    runner.handlers.push(
      () => new Promise((resolve) => { resolveFirst = resolve; }),
      successful('/Users/example/After\n'),
    );
    const service = chooser(runner);

    const firstChoice = service.chooseFolder();
    await expect(service.chooseFolder()).rejects.toMatchObject({
      statusCode: 409,
      code: 'REPOSITORY_FOLDER_CHOOSER_BUSY',
      message: 'A repository folder chooser is already open',
    } satisfies Partial<AppError>);
    expect(runner.calls).toHaveLength(1);

    resolveFirst({ stdout: '/Users/example/First\n' });
    await expect(firstChoice).resolves.toBe('/Users/example/First');
    await expect(service.chooseFolder()).resolves.toBe('/Users/example/After');
  });

  it('returns a sanitized unsupported error without invoking the command runner', async () => {
    const runner = new FakeRunner();
    const service = chooser(runner, 'linux');

    await expect(service.chooseFolder()).rejects.toMatchObject({
      statusCode: 501,
      code: 'REPOSITORY_FOLDER_CHOOSER_UNSUPPORTED',
      message: 'Repository folder chooser is available only on macOS',
    } satisfies Partial<AppError>);
    expect(runner.calls).toEqual([]);
  });

  it('sanitizes command failures and releases the lock for a later request', async () => {
    const runner = new FakeRunner();
    runner.handlers.push(
      async () => {
        throw Object.assign(new Error('private command failure'), {
          stderr: '/Users/private-user/secret-repository: permission denied',
        });
      },
      successful('/Users/example/Recovered\n'),
    );
    const service = chooser(runner);

    const error = await service.chooseFolder().catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      statusCode: 503,
      code: 'REPOSITORY_FOLDER_CHOOSER_UNAVAILABLE',
      message: 'Repository folder chooser is unavailable',
    } satisfies Partial<AppError>);
    expect(String(error)).not.toContain('private-user');
    expect(String(error)).not.toContain('secret-repository');

    await expect(service.chooseFolder()).resolves.toBe('/Users/example/Recovered');
  });

  it('rejects malformed or oversized command output without leaking it and releases the lock', async () => {
    const runner = new FakeRunner();
    const privateOutput = `private-output-${'x'.repeat(65_536)}`;
    runner.handlers.push(successful(privateOutput), successful('/Users/example/Valid\n'));
    const service = chooser(runner);

    const error = await service.chooseFolder().catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      statusCode: 503,
      code: 'REPOSITORY_FOLDER_CHOOSER_UNAVAILABLE',
      message: 'Repository folder chooser is unavailable',
    } satisfies Partial<AppError>);
    expect(String(error)).not.toContain('private-output');

    await expect(service.chooseFolder()).resolves.toBe('/Users/example/Valid');
  });
});
