import { execFile } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

import { AppError } from '../http/errors';
import { maxProfileImportBytes } from './signing-discovery-service';

const osascriptPath = '/usr/bin/osascript';
const chooseProfileScript = [
  'set selectedFile to choose file with prompt "Select a provisioning profile" of type {"com.apple.mobileprovision"}',
  'return POSIX path of selectedFile',
].join('\n');
const commandTimeoutMs = 10 * 60 * 1_000;
const commandMaxBuffer = 64 * 1_024;

export interface SigningProfileChooserCommandOptions {
  timeoutMs: number;
  maxBuffer: number;
  signal?: AbortSignal;
}

export interface SigningProfileChooserCommandResult {
  stdout: string;
}

export interface SigningProfileChooserCommandRunner {
  run(
    command: string,
    args: readonly string[],
    options: SigningProfileChooserCommandOptions,
  ): Promise<SigningProfileChooserCommandResult>;
}

export interface SigningProfileChooserStats {
  size: number;
  isFile(): boolean;
  isSymbolicLink(): boolean;
}

export interface SigningProfileChooserFileHandle {
  stat(): Promise<Pick<SigningProfileChooserStats, 'size' | 'isFile'>>;
  read(
    buffer: Buffer,
    offset: number,
    length: number,
    position: number,
  ): Promise<{ bytesRead: number }>;
  close(): Promise<void>;
}

export interface SigningProfileChooserFileSystem {
  lstat(filePath: string): Promise<SigningProfileChooserStats>;
  open(filePath: string, flags: number): Promise<SigningProfileChooserFileHandle>;
}

export interface SigningProfileChooserDependencies {
  platform?: NodeJS.Platform;
  commandRunner?: SigningProfileChooserCommandRunner;
  fileSystem?: SigningProfileChooserFileSystem;
}

export interface SigningProfileChooserGateway {
  chooseProfile(signal?: AbortSignal): Promise<Buffer | null>;
}

class ExecFileCommandRunner implements SigningProfileChooserCommandRunner {
  run(
    command: string,
    args: readonly string[],
    options: SigningProfileChooserCommandOptions,
  ): Promise<SigningProfileChooserCommandResult> {
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

const nodeFileSystem: SigningProfileChooserFileSystem = {
  async lstat(filePath) {
    return fs.lstat(filePath);
  },
  async open(filePath, flags) {
    return fs.open(filePath, flags);
  },
};

function unsupportedError(): AppError {
  return new AppError(
    501,
    'SIGNING_PROFILE_CHOOSER_UNSUPPORTED',
    'Provisioning profile chooser is available only on macOS',
  );
}

function unavailableError(): AppError {
  return new AppError(
    503,
    'SIGNING_PROFILE_CHOOSER_UNAVAILABLE',
    'Provisioning profile chooser is unavailable',
  );
}

function busyError(): AppError {
  return new AppError(
    409,
    'SIGNING_PROFILE_CHOOSER_BUSY',
    'A provisioning profile chooser is already open',
  );
}

function invalidSelectionError(): AppError {
  return new AppError(
    400,
    'SIGNING_PROFILE_SELECTION_INVALID',
    'Select a regular .mobileprovision file',
  );
}

function tooLargeError(): AppError {
  return new AppError(
    413,
    'SIGNING_PROFILE_TOO_LARGE',
    'The provisioning profile exceeds the 2 MiB limit',
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
  const selected = stdout.replace(/\r?\n$/, '');
  return path.isAbsolute(selected) && !selected.includes('\0') ? selected : null;
}

async function readBounded(
  fileHandle: SigningProfileChooserFileHandle,
): Promise<Buffer> {
  const stats = await fileHandle.stat();
  if (!stats.isFile()) throw invalidSelectionError();
  if (stats.size > maxProfileImportBytes) throw tooLargeError();

  const buffer = Buffer.allocUnsafe(maxProfileImportBytes + 1);
  let totalBytes = 0;
  while (totalBytes < buffer.length) {
    const { bytesRead } = await fileHandle.read(
      buffer,
      totalBytes,
      buffer.length - totalBytes,
      totalBytes,
    );
    if (bytesRead === 0) break;
    totalBytes += bytesRead;
  }
  if (totalBytes > maxProfileImportBytes) throw tooLargeError();
  return buffer.subarray(0, totalBytes);
}

export class SigningProfileChooserService implements SigningProfileChooserGateway {
  private readonly platform: NodeJS.Platform;
  private readonly commandRunner: SigningProfileChooserCommandRunner;
  private readonly fileSystem: SigningProfileChooserFileSystem;
  private choosing = false;

  constructor(dependencies: SigningProfileChooserDependencies = {}) {
    this.platform = dependencies.platform ?? process.platform;
    this.commandRunner = dependencies.commandRunner ?? new ExecFileCommandRunner();
    this.fileSystem = dependencies.fileSystem ?? nodeFileSystem;
  }

  async chooseProfile(signal?: AbortSignal): Promise<Buffer | null> {
    if (this.platform !== 'darwin') throw unsupportedError();
    if (this.choosing) throw busyError();

    this.choosing = true;
    try {
      let result: SigningProfileChooserCommandResult;
      try {
        signal?.throwIfAborted();
        result = await this.commandRunner.run(
          osascriptPath,
          ['-e', chooseProfileScript],
          { timeoutMs: commandTimeoutMs, maxBuffer: commandMaxBuffer, signal },
        );
      } catch (error) {
        if (isCancellation(error)) return null;
        throw unavailableError();
      }

      const profilePath = selectedPath(result.stdout);
      if (!profilePath) throw unavailableError();
      if (path.extname(profilePath).toLowerCase() !== '.mobileprovision') {
        throw invalidSelectionError();
      }

      let stats: SigningProfileChooserStats;
      try {
        stats = await this.fileSystem.lstat(profilePath);
      } catch {
        throw invalidSelectionError();
      }
      if (!stats.isFile() || stats.isSymbolicLink()) throw invalidSelectionError();
      if (stats.size > maxProfileImportBytes) throw tooLargeError();

      let fileHandle: SigningProfileChooserFileHandle;
      try {
        fileHandle = await this.fileSystem.open(
          profilePath,
          fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
        );
      } catch {
        throw invalidSelectionError();
      }

      try {
        return await readBounded(fileHandle);
      } catch (error) {
        if (error instanceof AppError && error.code === 'SIGNING_PROFILE_TOO_LARGE') {
          throw tooLargeError();
        }
        throw invalidSelectionError();
      } finally {
        await fileHandle.close().catch(() => undefined);
      }
    } finally {
      this.choosing = false;
    }
  }
}
