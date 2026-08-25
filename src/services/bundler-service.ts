import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { AppError } from '../http/errors';

const execFileAsync = promisify(execFile);
const commandTimeoutMs = 15_000;
const installTimeoutMs = 10 * 60 * 1_000;
const commandMaxBuffer = 1024 * 1024;
const bundleEnvironmentKeys = [
  'PATH', 'HOME', 'USER', 'SHELL', 'TMPDIR', 'LANG', 'LC_ALL',
  'GEM_HOME', 'GEM_PATH', 'RUBYOPT', 'RBENV_ROOT',
];

export interface BundlerCommandOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  maxBuffer: number;
}

export interface BundlerCommandRunner {
  run(command: string, args: readonly string[], options: BundlerCommandOptions): Promise<void>;
}

export interface BundlerGateway {
  configureLocalPath(repoPath: string): Promise<void>;
  check(repoPath: string): Promise<boolean>;
  install(repoPath: string): Promise<void>;
}

class ExecFileBundlerCommandRunner implements BundlerCommandRunner {
  async run(command: string, args: readonly string[], options: BundlerCommandOptions): Promise<void> {
    await execFileAsync(command, [...args], {
      cwd: options.cwd,
      env: options.env,
      timeout: options.timeoutMs,
      maxBuffer: options.maxBuffer,
      windowsHide: true,
    });
  }
}

function bundleEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...Object.fromEntries(
      bundleEnvironmentKeys.flatMap((key) => environment[key] ? [[key, environment[key]]] : []),
    ),
    BUNDLE_VERSION: 'system',
  };
}

function bundlerError(code: string, message: string): AppError {
  return new AppError(503, code, message);
}

export class BundlerService implements BundlerGateway {
  private readonly command: string;
  private readonly childEnvironment: NodeJS.ProcessEnv;

  constructor(
    environment: NodeJS.ProcessEnv = process.env,
    private readonly runner: BundlerCommandRunner = new ExecFileBundlerCommandRunner(),
  ) {
    this.command = environment.BUNDLE_BIN?.trim() || 'bundle';
    this.childEnvironment = bundleEnvironment(environment);
  }

  async configureLocalPath(repoPath: string): Promise<void> {
    try {
      await this.run(['config', 'set', '--local', 'path', 'vendor/bundle'], repoPath, commandTimeoutMs);
    } catch {
      throw bundlerError('BUNDLER_CONFIGURATION_FAILED', 'Bundler could not configure local project dependencies');
    }
  }

  async check(repoPath: string): Promise<boolean> {
    try {
      await this.run(['check'], repoPath, commandTimeoutMs);
      return true;
    } catch {
      return false;
    }
  }

  async install(repoPath: string): Promise<void> {
    try {
      await this.run(['install'], repoPath, installTimeoutMs);
    } catch {
      throw bundlerError('BUNDLER_INSTALL_FAILED', 'Bundler could not install the project dependencies');
    }
  }

  private run(args: readonly string[], repoPath: string, timeoutMs: number): Promise<void> {
    return this.runner.run(this.command, args, {
      cwd: repoPath,
      env: this.childEnvironment,
      timeoutMs,
      maxBuffer: commandMaxBuffer,
    });
  }
}
