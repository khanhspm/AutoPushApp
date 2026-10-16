import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { git, gitStatus, lockRepository, runCommand } from '../src/services/repository-operations-service';
import { createBuildPreflight } from '../src/services/build-preflight-service';
import type { ProjectRepository } from '../src/repositories/project-repository';
import type { ProjectConfigService } from '../src/services/project-config-service';
import type { ProjectConfigSnapshot } from '../src/domain/project';
const directories: string[] = [];
async function repo() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'autopush-git-test-'));
  directories.push(dir);
  await git(dir, ['init', '-b', 'main']);
  await git(dir, ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--allow-empty', '-m', 'Initial commit']);
  return dir;
}
afterEach(async () => { for (const dir of directories.splice(0)) await fs.rm(dir, { recursive: true, force: true }); });
it('reads current branch, branches and commit history from Git', async () => {
  const dir = await repo();
  await git(dir, ['branch', 'feature/build']);
  const state = await gitStatus(dir);
  expect(state.branch).toBe('main');
  expect(state.branches).toContain('feature/build');
  expect(state.commits[0].subject).toBe('Initial commit');
  expect(state.dirty).toBe(false);
  await fs.writeFile(path.join(dir, 'local.txt'), 'change');
  expect((await gitStatus(dir)).dirty).toBe(true);
});
it('runs terminal commands in the selected folder and stops on command failure', async () => {
  const dir = await repo();
  const result = await runCommand(dir, '/bin/bash', ['-e', '-o', 'pipefail', '-c', 'pwd\nprintf setup > setup.txt\nfalse\nprintf wrong > wrong.txt']);
  expect(result.exitCode).not.toBe(0);
  expect(result.output.trim()).toBe(await fs.realpath(dir));
  expect(await fs.readFile(path.join(dir, 'setup.txt'), 'utf8')).toBe('setup');
  await expect(fs.stat(path.join(dir, 'wrong.txt'))).rejects.toThrow();
});
it('limits command duration and output and serializes canonical repository paths', async () => {
  const dir = await repo();
  const unlock = await lockRepository(dir);
  await expect(lockRepository(await fs.realpath(dir))).rejects.toThrow('busy');
  await unlock();
  await (await lockRepository(dir))();
  const timeout = await runCommand(dir, '/bin/bash', ['-c', 'sleep 5'], 25);
  expect(timeout.timedOut).toBe(true);
  const large = await runCommand(dir, process.execPath, ['-e', 'process.stdout.write("x".repeat(300000))']);
  expect(large.truncated).toBe(true);
  expect(large.output.length).toBeLessThanOrEqual(256_000);
});
it('worker preflight validates again, rejects changed commits and releases locks on errors', async () => {
  const dir = await repo();
  const config = { repoPath: dir, projectKey: 'app', projectVersion: 1, scheme: 'Override', gitCommit: await git(dir, ['rev-parse', 'HEAD']) } as ProjectConfigSnapshot;
  const projects = { findByKey: () => ({ projectKey: 'app', enabled: true, version: 1 }), setValidation: vi.fn().mockReturnValue({ version: 1 }) } as unknown as ProjectRepository;
  const validate = vi.fn().mockResolvedValue({ valid: false, message: 'Missing dependencies' });
  const preflight = createBuildPreflight(projects, { validate } as unknown as ProjectConfigService);
  await expect(preflight(config)).rejects.toThrow('Missing dependencies');
  expect(validate).toHaveBeenCalledWith(expect.objectContaining({ scheme: 'Override' }));
  validate.mockResolvedValue({ valid: true });
  const unlock = await preflight(config);
  await expect(lockRepository(dir)).rejects.toThrow('busy');
  await unlock();
  await git(dir, ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--allow-empty', '-m', 'Changed']);
  await expect(preflight(config)).rejects.toThrow('commit changed');
  await (await lockRepository(dir))();
});
