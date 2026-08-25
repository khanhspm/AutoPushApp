import { execFile } from 'node:child_process';

import { AppError } from '../http/errors';

const osascriptPath = '/usr/bin/osascript';
const chooseFolderScript = [
  'set selectedFolder to choose folder with prompt "Select a repository folder"',
  'return POSIX path of selectedFolder',
].join('\n');
const commandTimeoutMs = 10 * 60 * 1_000;
const commandMaxBuffer = 64 * 1_024;

export interface RepositoryFolderChooserCommandOptions {
  timeoutMs: number;
  maxBuffer: number;
  signal?: AbortSignal;
}

export interface RepositoryFolderChooserCommandResult {
  stdout: string;
}

export interface RepositoryFolderChooserCommandRunner {
  run(
    command: string,
    args: readonly string[],
    options: RepositoryFolderChooserCommandOptions,
  ): Promise<RepositoryFolderChooserCommandResult>;
}

export interface RepositoryFolderChooserDependencies {
  platform?: NodeJS.Platform;
  commandRunner?: RepositoryFolderChooserCommandRunner;
}

export interface RepositoryFolderChooserGateway {
  chooseFolder(signal?: AbortSignal): Promise<string | null>;
}

class ExecFileCommandRunner implements RepositoryFolderChooserCommandRunner {
  run(
    command: string,
    args: readonly string[],
    options: RepositoryFolderChooserCommandOptions,
  ): Promise<RepositoryFolderChooserCommandResult> {
    return new Promise((resolve, reject) => {
      execFile(
        command,
        [...args],
        {
          encoding: 'utf8',
          maxBuffer: options.maxBuffer,
          shell: false,
          signal: options.signal,
          timeout: options.timeoutMs,
          windowsHide: true,
        },
        (error, stdout) => {
          if (error) {
            reject(error);
            return;
          }
          resolve({ stdout });
        },
      );
    });
  }
}

function unsupportedError(): AppError {
  return new AppError(
    501,
    'REPOSITORY_FOLDER_CHOOSER_UNSUPPORTED',
    'Repository folder chooser is available only on macOS',
  );
}

function unavailableError(): AppError {
  return new AppError(
    503,
    'REPOSITORY_FOLDER_CHOOSER_UNAVAILABLE',
    'Repository folder chooser is unavailable',
  );
}

function busyError(): AppError {
  return new AppError(
    409,
    'REPOSITORY_FOLDER_CHOOSER_BUSY',
    'A repository folder chooser is already open',
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isCancellation(error: unknown): boolean {
  if (!isRecord(error)) return false;
  if (error.code === -128 || error.errno === -128) return true;

  const stderr = typeof error.stderr === 'string'
    ? error.stderr
    : Buffer.isBuffer(error.stderr)
      ? error.stderr.toString('utf8')
      : '';
  const message = typeof error.message === 'string' ? error.message : '';
  return /\(-128\)(?:\s|$)/.test(stderr) || /\(-128\)(?:\s|$)/.test(message);
}

function selectedPath(stdout: string): string | null {
  if (Buffer.byteLength(stdout, 'utf8') > commandMaxBuffer) return null;
  const path = stdout.replace(/\r?\n$/, '');
  return path.startsWith('/') && !path.includes('\0') ? path : null;
}

export class RepositoryFolderChooserService implements RepositoryFolderChooserGateway {
  private readonly platform: NodeJS.Platform;
  private readonly commandRunner: RepositoryFolderChooserCommandRunner;
  private choosing = false;

  constructor(dependencies: RepositoryFolderChooserDependencies = {}) {
    this.platform = dependencies.platform ?? process.platform;
    this.commandRunner = dependencies.commandRunner ?? new ExecFileCommandRunner();
  }

  async chooseFolder(signal?: AbortSignal): Promise<string | null> {
    if (this.platform !== 'darwin') throw unsupportedError();
    if (this.choosing) throw busyError();

    this.choosing = true;
    try {
      let result: RepositoryFolderChooserCommandResult;
      try {
        signal?.throwIfAborted();
        result = await this.commandRunner.run(
          osascriptPath,
          ['-e', chooseFolderScript],
          { timeoutMs: commandTimeoutMs, maxBuffer: commandMaxBuffer, signal },
        );
      } catch (error) {
        if (isCancellation(error)) return null;
        throw unavailableError();
      }

      const path = selectedPath(result.stdout);
      if (!path) throw unavailableError();
      return path;
    } finally {
      this.choosing = false;
    }
  }
}
