import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import type { AppDatabase } from '../db/database';
import { AppError } from '../http/errors';

export async function lockRepository(repoPath: string): Promise<() => Promise<void>> {
  const canonical = await fs.realpath(repoPath);
  const lock = path.join(os.tmpdir(), `autopush-${createHash('sha256').update(canonical).digest('hex')}.lock`);
  try { await fs.mkdir(lock); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new AppError(409, 'REPOSITORY_BUSY', 'Repository is busy. Wait for the current operation to finish.');
    }
    throw error;
  }
  return async () => { await fs.rmdir(lock); };
}

export interface CommandResult { output: string; exitCode: number; timedOut: boolean; truncated: boolean }

export function runCommand(cwd: string, command: string, args: string[], timeoutMs = 15 * 60_000): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_SSH_COMMAND: 'ssh -o BatchMode=yes -o StrictHostKeyChecking=yes' },
    });
    let output = '';
    let timedOut = false;
    let truncated = false;
    const append = (chunk: Buffer) => {
      output += chunk.toString();
      if (output.length > 256_000) { output = output.slice(-256_000); truncated = true; }
    };
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    const timer = setTimeout(() => {
      timedOut = true;
      try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* Process already exited. */ }
    }, timeoutMs);
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('close', (code) => { clearTimeout(timer); resolve({ output, exitCode: code ?? -1, timedOut, truncated }); });
  });
}

export async function git(repoPath: string, args: string[]): Promise<string> {
  const result = await runCommand(repoPath, 'git', args);
  if (result.exitCode !== 0) throw new AppError(409, 'GIT_FAILED', result.output.slice(-4000) || 'Git command failed');
  return result.output.trim();
}

export async function gitStatus(repoPath: string) {
  const branch = await git(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const head = await git(repoPath, ['rev-parse', 'HEAD']);
  const branches = (await git(repoPath, ['for-each-ref', '--format=%(refname:short)', 'refs/heads', 'refs/remotes']))
    .split('\n').filter((name) => name && !name.endsWith('/HEAD'));
  const history = await git(repoPath, ['log', '-30', '--format=%H%x1f%an%x1f%aI%x1f%s']);
  const commits = history.split('\n').filter(Boolean).map((line) => {
    const [hash, author, date, ...subject] = line.split('\x1f');
    return { hash, author, date, subject: subject.join('\x1f') };
  });
  return { branch, head, branches, commits, dirty: Boolean(await git(repoPath, ['status', '--porcelain'])) };
}

export async function lockIdleRepository(database: AppDatabase, repo: string): Promise<() => Promise<void>> {
  const unlock = await lockRepository(repo);
  try {
    const active = database.prepare("SELECT config_snapshot_json FROM build_records WHERE status IN ('enqueueing', 'queued', 'running')").all() as { config_snapshot_json: string }[];
    for (const build of active) {
      const saved = JSON.parse(build.config_snapshot_json).repoPath;
      if (await fs.realpath(saved).catch(() => saved) === await fs.realpath(repo)) {
        throw new AppError(409, 'REPOSITORY_BUSY', 'Wait for queued and running builds to finish');
      }
    }
    return unlock;
  } catch (error) { await unlock(); throw error; }
}
