import fs from 'node:fs/promises';
import path from 'node:path';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../app-context';
import { env } from '../config/env';
import { AppError } from '../http/errors';
import { git, gitStatus, lockRepository, lockIdleRepository, runCommand } from '../services/repository-operations-service';

const keySchema = z.object({ projectKey: z.string().min(1).max(80) });
export function repositoryOperationRoutes(context: AppContext): FastifyPluginAsync {
  return async (app) => {
    app.addHook('preHandler', async (request) => {
      if (request.cmsPrincipal?.role !== 'admin') throw new AppError(403, 'FORBIDDEN', 'Administrator access is required');
    });
    const resolve = async (key: string) => {
      const project = context.projects.findByKey(key);
      if (!project) throw new AppError(404, 'PROJECT_NOT_FOUND', 'Project was not found');
      return (await context.repositoryDiscovery.resolveCandidate(project.repoPath)).path;
    };
    const mutate = async <T>(repo: string, action: () => Promise<T>): Promise<T> => {
      const unlock = await lockIdleRepository(context.database, repo);
      try { return await action(); } finally { await unlock(); }
    };
    app.get('/projects/:projectKey/git', async (request) => gitStatus(await resolve(keySchema.parse(request.params).projectKey)));
    app.post('/projects/:projectKey/git/fetch', async (request) => {
      const repo = await resolve(keySchema.parse(request.params).projectKey);
      return mutate(repo, async () => { await git(repo, ['fetch', '--all', '--prune']); return gitStatus(repo); });
    });
    app.post('/projects/:projectKey/git/checkout', async (request) => {
      const { branch } = z.object({ branch: z.string().min(1).max(250).refine((v) => !v.startsWith('-') && !/[\s\x00-\x1f]/.test(v)) }).parse(request.body);
      const repo = await resolve(keySchema.parse(request.params).projectKey);
      return mutate(repo, async () => {
        const state = await gitStatus(repo);
        if (state.dirty) throw new AppError(409, 'REPOSITORY_DIRTY', 'Commit or stash local changes before checkout');
        if (!state.branches.includes(branch)) throw new AppError(400, 'BRANCH_NOT_FOUND', 'Select an existing branch; fetch to refresh');
        const remote = await git(repo, ['for-each-ref', '--format=%(refname:short)', 'refs/remotes']);
        if (remote.split('\n').includes(branch)) {
          const local = branch.slice(branch.indexOf('/') + 1);
          if (state.branches.includes(local)) await git(repo, ['switch', local]);
          else await git(repo, ['switch', '--track', '-c', local, branch]);
        } else await git(repo, ['switch', branch]);
        return gitStatus(repo);
      });
    });
    app.post('/repositories/terminal', async (request) => {
      const input = z.object({ repoPath: z.string().max(1000), commands: z.string().trim().min(1).max(50_000) }).parse(request.body);
      const repo = (await context.repositoryDiscovery.resolveCandidate(input.repoPath)).path;
      return mutate(repo, () => runCommand(repo, '/bin/bash', ['-e', '-o', 'pipefail', '-c', input.commands]));
    });
    app.get('/repositories/folders', async () => {
      const roots = await Promise.all(env.IOS_REPO_ROOTS.map((root) => fs.realpath(root)));
      const folders = (await Promise.all(roots.map(async (root) => (await fs.readdir(root, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
        .map((entry) => ({ path: path.join(root, entry.name), name: entry.name }))))).flat();
      return { roots, folders };
    });
    app.post('/repositories/clone', async (request) => {
      const input = z.object({ root: z.string(), name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/).max(120), url: z.string().max(1000).refine((value) => /^(?:[\w.-]+@[\w.-]+:[\w./-]+|ssh:\/\/[\w.-]+@[\w.-]+(?::\d+)?\/[\w./-]+)$/.test(value), 'Use an SSH Git URL') }).parse(request.body);
      const roots = await Promise.all(env.IOS_REPO_ROOTS.map((root) => fs.realpath(root)));
      const root = await fs.realpath(input.root);
      if (!roots.includes(root)) throw new AppError(400, 'INVALID_ROOT', 'Select a configured IOS_REPO_ROOTS directory');
      const destination = path.join(root, input.name);
      try { await fs.mkdir(destination); } catch { throw new AppError(409, 'DESTINATION_EXISTS', 'Destination already exists or cannot be created'); }
      const unlock = await lockRepository(destination);
      try {
        await git(root, ['clone', '--', input.url, destination]);
        return { repository: await context.repositoryDiscovery.resolveCandidate(destination) };
      } finally { await unlock(); }
    });
  };
}
