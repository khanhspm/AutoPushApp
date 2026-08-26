import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

import type { AppContext } from '../app-context';
import { BUILD_SOURCES, BUILD_STATUSES } from '../domain/build';
import { AppError } from '../http/errors';

const buildIdSchema = z.string().uuid().or(z.string().startsWith('legacy-'));
const listQuerySchema = z.object({
  projectKey: z.string().optional(),
  status: z.enum(BUILD_STATUSES).optional(),
  source: z.enum(BUILD_SOURCES).optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});
const logQuerySchema = z.object({
  tailBytes: z.coerce.number().int().min(1).max(256 * 1024).optional(),
});
const retryBodySchema = z.object({
  appVersion: z.string().trim().max(40).optional(),
  scheme: z.string().trim().min(1).max(120).regex(/^[A-Za-z0-9_. -]+$/).optional(),
  buildNumber: z.string().trim().min(1).max(80).optional(),
  releaseNotes: z.string().max(10_000).optional(),
});

function idempotencyHeader(headers: Record<string, unknown>): string {
  const value = headers['idempotency-key'];
  const key = Array.isArray(value) ? value[0] : value;
  if (typeof key !== 'string' || key.length < 8 || key.length > 200) {
    throw new AppError(400, 'IDEMPOTENCY_KEY_REQUIRED', 'A valid Idempotency-Key header is required');
  }
  return `cms:${key}`;
}

export function buildRoutes(context: AppContext): FastifyPluginAsync {
  return async (app) => {
    app.get('/', async (request) => {
      const query = listQuerySchema.parse(request.query);
      try {
        return context.builds.list(query);
      } catch (error) {
        if (query.cursor) {
          throw new AppError(400, 'INVALID_CURSOR', 'The build cursor is invalid');
        }
        throw error;
      }
    });

    app.get('/:buildId', async (request) => {
      const buildId = buildIdSchema.parse((request.params as { buildId: string }).buildId);
      const build = context.builds.findById(buildId);
      if (!build) {
        throw new AppError(404, 'BUILD_NOT_FOUND', 'Build was not found');
      }
      return { build };
    });

    app.get('/:buildId/log', async (request) => {
      const buildId = buildIdSchema.parse((request.params as { buildId: string }).buildId);
      const query = logQuerySchema.parse(request.query);
      const build = context.builds.findById(buildId);
      if (!build) {
        throw new AppError(404, 'BUILD_NOT_FOUND', 'Build was not found');
      }
      if (!build.logRelativePath) {
        return { content: '', truncated: false, complete: ['success', 'failed'].includes(build.status) };
      }

      const log = await context.logs.readTail(build.logRelativePath, query.tailBytes);
      return { ...log, complete: ['success', 'failed'].includes(build.status) };
    });

    app.get('/:buildId/log/download', async (request, reply) => {
      const buildId = buildIdSchema.parse((request.params as { buildId: string }).buildId);
      const build = context.builds.findById(buildId);
      if (!build) {
        throw new AppError(404, 'BUILD_NOT_FOUND', 'Build was not found');
      }
      if (!build.logRelativePath) {
        throw new AppError(404, 'BUILD_LOG_NOT_FOUND', 'Build log is not available');
      }

      const stream = await context.logs.createDownloadStream(build.logRelativePath);
      reply.type('text/plain; charset=utf-8');
      reply.header('Content-Disposition', `attachment; filename="${build.id}.log"`);
      return reply.send(stream);
    });

    app.post('/:buildId/retry', async (request, reply) => {
      const buildId = buildIdSchema.parse((request.params as { buildId: string }).buildId);
      const input = retryBodySchema.parse(request.body ?? {});
      const result = await context.buildRequests.retry(
        buildId,
        idempotencyHeader(request.headers),
        request.cmsPrincipal?.role === 'member' ? request.cmsPrincipal.email : 'cms-admin',
        input,
      );
      return reply.code(result.created ? 202 : 200).send(result);
    });
  };
}
