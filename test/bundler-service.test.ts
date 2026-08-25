import { describe, expect, it } from 'vitest';

import { AppError } from '../src/http/errors';
import {
  BundlerService,
  type BundlerCommandOptions,
  type BundlerCommandRunner,
} from '../src/services/bundler-service';

interface Call {
  command: string;
  args: readonly string[];
  options: BundlerCommandOptions;
}

class FakeRunner implements BundlerCommandRunner {
  readonly calls: Call[] = [];
  failures: boolean[] = [];

  async run(command: string, args: readonly string[], options: BundlerCommandOptions): Promise<void> {
    this.calls.push({ command, args, options });
    if (this.failures.shift()) throw new Error('/private/repo secret output');
  }
}

describe('BundlerService', () => {
  it('configures, checks, and installs with bounded commands and a restricted environment', async () => {
    const runner = new FakeRunner();
    const service = new BundlerService({
      BUNDLE_BIN: '/usr/local/bin/bundle',
      PATH: '/usr/bin',
      HOME: '/Users/private',
      FIREBASE_TOKEN: 'secret',
    }, runner);

    await service.configureLocalPath('/repos/app');
    await expect(service.check('/repos/app')).resolves.toBe(true);
    await service.install('/repos/app');

    expect(runner.calls.map((call) => call.args)).toEqual([
      ['config', 'set', '--local', 'path', 'vendor/bundle'],
      ['check'],
      ['install'],
    ]);
    expect(runner.calls.every((call) => call.command === '/usr/local/bin/bundle')).toBe(true);
    expect(runner.calls.every((call) => call.options.cwd === '/repos/app')).toBe(true);
    expect(runner.calls[0].options.env).toMatchObject({ PATH: '/usr/bin', HOME: '/Users/private', BUNDLE_VERSION: 'system' });
    expect(runner.calls[0].options.env.FIREBASE_TOKEN).toBeUndefined();
    expect(runner.calls[0].options.timeoutMs).toBe(15_000);
    expect(runner.calls[2].options.timeoutMs).toBe(600_000);
    expect(runner.calls.flatMap((call) => call.args)).not.toContain('fastlane');
  });

  it('treats a failed check as missing dependencies and sanitizes setup failures', async () => {
    const runner = new FakeRunner();
    runner.failures.push(true, true, true);
    const service = new BundlerService({}, runner);

    await expect(service.check('/private/repo')).resolves.toBe(false);
    const configError = await service.configureLocalPath('/private/repo').catch((error: unknown) => error);
    expect(configError).toMatchObject({
      statusCode: 503,
      code: 'BUNDLER_CONFIGURATION_FAILED',
    } satisfies Partial<AppError>);
    expect(String(configError)).not.toContain('/private/repo');

    const installError = await service.install('/private/repo').catch((error: unknown) => error);
    expect(installError).toMatchObject({
      statusCode: 503,
      code: 'BUNDLER_INSTALL_FAILED',
    } satisfies Partial<AppError>);
    expect(String(installError)).not.toContain('secret output');
  });
});
