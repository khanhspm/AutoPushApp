import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { env } from '../config/env';
import type { ProjectConfigSnapshot } from '../domain/project';
import { logger } from '../utils/logger';
import { BuildLogService, type BuildLogWriter } from './build-log-service';

export type FastlaneProjectSnapshot = ProjectConfigSnapshot;

export interface FastlaneBuildInput {
  buildId: string;
  attempt: number;
  appVersion?: string | null;
  buildNumber: string;
  releaseNotes: string;
  config: FastlaneProjectSnapshot;
  /** Aborting stops the Fastlane process tree and rejects with a FastlaneCancelledError. */
  signal?: AbortSignal;
}

export class FastlaneCancelledError extends Error {
  constructor(message = 'Build was cancelled') {
    super(message);
    this.name = 'FastlaneCancelledError';
  }
}

export interface FastlaneBuildResult {
  durationMs: number;
  logRelativePath: string;
}

const inheritedEnvironmentKeys = [
  'PATH',
  'HOME',
  'USER',
  'SHELL',
  'TMPDIR',
  'LANG',
  'LC_ALL',
  'GEM_HOME',
  'GEM_PATH',
  'RUBYOPT',
  'RBENV_ROOT',
  'DEVELOPER_DIR',
  'CI',
  'SSH_AUTH_SOCK',
  'BUNDLE_BIN',
  'FASTLANE_SKIP_UPDATE_CHECK',
  'FASTLANE_HIDE_CHANGELOG',
  'FASTLANE_DISABLE_COLORS',
  'FASTLANE_XCODEBUILD_SETTINGS_TIMEOUT',
  'FASTLANE_XCODEBUILD_SETTINGS_RETRIES',
];

const matchEnvironmentKeys = ['MATCH_KEYCHAIN_NAME'];
const matchSecretEnvironmentKeys = [
  'MATCH_GIT_BASIC_AUTHORIZATION',
  'MATCH_GIT_BEARER_AUTHORIZATION',
  'MATCH_GIT_PRIVATE_KEY',
  'MATCH_KEYCHAIN_PASSWORD',
];

function resolveRequiredSecret(reference: string | null | undefined, label: string): string {
  if (!reference) {
    throw new Error(`Required credential reference for ${label} is not configured`);
  }

  const value = process.env[reference];
  if (!value?.trim()) {
    throw new Error(`Required credential for ${label} is not available`);
  }

  return value;
}

export function createChildEnvironment(
  config: FastlaneProjectSnapshot,
): { childEnv: NodeJS.ProcessEnv; secretValues: string[] } {
  const childEnv: NodeJS.ProcessEnv = {};

  for (const key of inheritedEnvironmentKeys) {
    if (process.env[key]) {
      childEnv[key] = process.env[key];
    }
  }

  const signingMode = config.schemaVersion === 1 ? 'match' : config.signingMode;
  childEnv.AUTOPUSH_SIGNING_MODE = signingMode;

  const selectedSecrets: Record<string, string> = {
    FIREBASE_CLI_TOKEN: resolveRequiredSecret(config.secretEnvRefs.firebaseCliToken, 'Firebase CLI token'),
  };

  if (signingMode === 'match') {
    selectedSecrets.MATCH_PASSWORD = resolveRequiredSecret(config.secretEnvRefs.matchPassword, 'Match password');
    selectedSecrets.APP_STORE_CONNECT_API_KEY_ID = resolveRequiredSecret(
      config.secretEnvRefs.appStoreConnectKeyId,
      'App Store Connect key ID',
    );
    selectedSecrets.APP_STORE_CONNECT_API_ISSUER_ID = resolveRequiredSecret(
      config.secretEnvRefs.appStoreConnectIssuerId,
      'App Store Connect issuer ID',
    );
    selectedSecrets.APP_STORE_CONNECT_API_KEY_PATH = resolveRequiredSecret(
      config.secretEnvRefs.appStoreConnectKeyPath,
      'App Store Connect key path',
    );

    for (const key of matchEnvironmentKeys) {
      if (process.env[key]) childEnv[key] = process.env[key];
    }
    for (const key of matchSecretEnvironmentKeys) {
      const value = process.env[key];
      if (value) selectedSecrets[key] = value;
    }
  } else if (config.schemaVersion === 2) {
    childEnv.AUTOPUSH_APPLE_TEAM_ID = config.appleTeamId ?? '';
    childEnv.AUTOPUSH_SIGNING_CERTIFICATE = config.signingCertificate;
    childEnv.AUTOPUSH_PROVISIONING_PROFILES_JSON = JSON.stringify(config.provisioningProfiles);
  }

  for (const [key, value] of Object.entries(selectedSecrets)) {
    childEnv[key] = value;
  }

  return {
    childEnv,
    secretValues: Object.values(selectedSecrets),
  };
}

function terminateProcessTree(pid: number | undefined, signal: NodeJS.Signals): void {
  if (!pid) {
    return;
  }

  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // The process already exited.
    }
  }
}

export function createFastlaneRunnerArgs(input: FastlaneBuildInput): string[] {
  return [
    input.config.repoPath,
    input.config.fastlaneLane,
    input.buildNumber,
    input.releaseNotes,
    input.config.scheme ?? '',
    input.config.buildConfiguration ?? '',
    input.config.firebaseAppId,
    input.config.firebaseTesterGroups.join(','),
    input.appVersion ?? '',
  ];
}

export async function triggerFastlane(
  input: FastlaneBuildInput,
  logService: BuildLogService,
): Promise<FastlaneBuildResult> {
  const { childEnv, secretValues } = createChildEnvironment(input.config);
  const logWriter = await logService.createWriter(input.buildId, input.attempt, secretValues);
  let archiveDirectory: string | undefined;
  try {
    // Only this invocation owns this directory. Never scan/delete Xcode's Archives folder.
    archiveDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'autopush-archive-'));
    childEnv.GYM_ARCHIVE_PATH = path.join(archiveDirectory, 'build.xcarchive');
    await logWriter.write(`[autopush] Temporary archive: ${childEnv.GYM_ARCHIVE_PATH}\n`);
    return await runFastlane(input, childEnv, logWriter);
  } finally {
    try {
      if (archiveDirectory) {
        try {
          await fs.rm(archiveDirectory, { recursive: true, force: true, maxRetries: 3 });
          await logWriter.write('\n[autopush] Temporary xcarchive removed. IPA and build logs retained.\n');
        } catch (error) {
          // Cleanup must not hide the build error or turn a completed upload into a retry.
          logger.warn({ buildId: input.buildId, archiveDirectory, error }, 'Temporary archive cleanup failed');
          await logWriter.write(`\n[autopush] WARNING: Archive cleanup failed; inspect ${archiveDirectory}\n`).catch(() => undefined);
        }
      }
    } finally {
      await logWriter.close();
    }
  }
}

async function runFastlane(
  input: FastlaneBuildInput,
  childEnv: NodeJS.ProcessEnv,
  logWriter: BuildLogWriter,
): Promise<FastlaneBuildResult> {
  const start = Date.now();
  const args = createFastlaneRunnerArgs(input);

  const child = spawn(env.FASTLANE_RUNNER_PATH, args, {
    cwd: input.config.repoPath,
    env: childEnv,
    shell: false,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let writeChain = Promise.resolve();
  const appendLog = (chunk: Buffer) => {
    writeChain = writeChain.then(() => logWriter.write(chunk));
  };

  child.stdout.on('data', appendLog);
  child.stderr.on('data', appendLog);

  let killTimeout: NodeJS.Timeout | undefined;
  const stopProcessTree = () => {
    terminateProcessTree(child.pid, 'SIGTERM');
    killTimeout ??= setTimeout(() => terminateProcessTree(child.pid, 'SIGKILL'), 10_000);
    killTimeout.unref();
  };

  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    stopProcessTree();
  }, env.BUILD_TIMEOUT_MS);
  timeout.unref();

  let cancelled = false;
  const onAbort = () => {
    if (cancelled) return;
    cancelled = true;
    appendLog(Buffer.from('\n[autopush] Build cancelled by user; stopping Fastlane.\n'));
    stopProcessTree();
  };
  if (input.signal?.aborted) {
    onAbort();
  } else {
    input.signal?.addEventListener('abort', onAbort, { once: true });
  }

  try {
    const exitCode = await new Promise<number>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => {
        if (cancelled) {
          reject(new FastlaneCancelledError());
          return;
        }

        if (timedOut) {
          reject(new Error(`Fastlane build exceeded ${env.BUILD_TIMEOUT_MS}ms timeout`));
          return;
        }

        if (signal) {
          reject(new Error(`Fastlane build stopped by signal ${signal}`));
          return;
        }

        resolve(code ?? 1);
      });
    });

    await writeChain;

    if (exitCode !== 0) {
      throw new Error(`Fastlane exited with code ${exitCode}`);
    }

    return {
      durationMs: Date.now() - start,
      logRelativePath: logWriter.relativePath,
    };
  } finally {
    clearTimeout(timeout);
    clearTimeout(killTimeout);
    if (cancelled || timedOut) terminateProcessTree(child.pid, 'SIGKILL');
    input.signal?.removeEventListener('abort', onAbort);
    await writeChain.catch(() => undefined);
  }
}

export function formatDuration(durationMs: number): string {
  const seconds = Math.round(durationMs / 1000);
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;

  return minutes > 0 ? `${minutes}m ${remainingSeconds}s` : `${remainingSeconds}s`;
}
