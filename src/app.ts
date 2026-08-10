import fs from 'node:fs/promises';
import path from 'node:path';

import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import Fastify from 'fastify';
import rawBody from 'fastify-raw-body';
import { ZodError } from 'zod';

import type { AppContext } from './app-context';
import { env } from './config/env';
import { AppError } from './http/errors';
import { createAdminAuthHook } from './plugins/admin-auth';
import { getWorkerHeartbeat } from './queue/worker-heartbeat';
import { buildRoutes } from './routes/builds';
import { dashboardRoutes } from './routes/dashboard';
import { projectRoutes } from './routes/projects';
import { userRoutes } from './routes/users';
import { logger } from './utils/logger';
import { createLarkWebhookHandler } from './webhook/lark-handler';

export async function buildApp(context: AppContext) {
  const app = Fastify({
    loggerInstance: logger,
    bodyLimit: 2 * 1024 * 1024,
  });

  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(cors, {
    origin: env.NODE_ENV === 'development' ? env.CMS_DEV_ORIGIN : false,
  });
  await app.register(rateLimit, { max: 120, timeWindow: '1 minute' });
  await app.register(rawBody, {
    field: 'rawBody',
    encoding: 'utf8',
    global: false,
    runFirst: true,
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof AppError) {
      return reply.code(error.statusCode).send({
        error: { code: error.code, message: error.message, fields: error.fields ?? {} },
      });
    }
    if (error instanceof ZodError) {
      return reply.code(400).send({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Request validation failed',
          fields: error.flatten().fieldErrors,
        },
      });
    }

    const code = (error as { code?: string }).code;
    if (code?.startsWith('SQLITE_CONSTRAINT')) {
      return reply.code(409).send({
        error: { code: 'RESOURCE_CONFLICT', message: 'The requested resource conflicts with existing data' },
      });
    }

    request.log.error({ err: error }, 'Unhandled request error');
    return reply.code(500).send({
      error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' },
    });
  });

  app.get('/health', async () => {
    let database = 'connected';
    let redis = 'connected';

    try {
      context.database.prepare('SELECT 1').get();
    } catch {
      database = 'disconnected';
    }
    try {
      await context.redis.ping();
    } catch {
      redis = 'disconnected';
    }

    const runner = redis === 'connected' ? await getWorkerHeartbeat(context.redis, env.RUNNER_ID).catch(() => null) : null;
    const healthy = database === 'connected' && redis === 'connected';

    return {
      status: healthy ? 'ok' : 'degraded',
      database,
      redis,
      runner: runner ? 'online' : 'offline',
      uptime: process.uptime(),
    };
  });

  app.post('/webhook/lark', { config: { rawBody: true } }, createLarkWebhookHandler(context.buildRequests));

  const authenticateAdmin = createAdminAuthHook(env.CMS_ADMIN_TOKEN);
  await app.register(
    async (cms) => {
      cms.addHook('preHandler', authenticateAdmin);
      cms.get('/session', async () => ({ authenticated: true }));
      await cms.register(dashboardRoutes(context), { prefix: '/dashboard' });
      await cms.register(projectRoutes(context), { prefix: '/projects' });
      await cms.register(userRoutes(context), { prefix: '/users' });
      await cms.register(buildRoutes(context), { prefix: '/builds' });
    },
    { prefix: '/api' },
  );

  app.get('/builds/history', { preHandler: authenticateAdmin }, async () => {
    const result = context.builds.list({ limit: 50 });
    return { ...result, deprecated: true };
  });

  if (env.SERVE_CMS) {
    const indexPath = path.join(env.CMS_DIST_PATH, 'index.html');
    await fs.access(indexPath).catch(() => {
      throw new Error(`CMS build is missing at ${indexPath}; run npm run build:web first`);
    });

    await app.register(fastifyStatic, {
      root: env.CMS_DIST_PATH,
      wildcard: false,
      maxAge: '1y',
      immutable: true,
    });

    app.get('/', async (_request, reply) => {
      reply.header('Cache-Control', 'no-cache');
      return reply.sendFile('index.html');
    });

    app.setNotFoundHandler(async (request, reply) => {
      if (
        request.method === 'GET' &&
        !request.url.startsWith('/api/') &&
        !request.url.startsWith('/health') &&
        !request.url.startsWith('/webhook/')
      ) {
        reply.header('Cache-Control', 'no-cache');
        return reply.sendFile('index.html');
      }
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Route was not found' } });
    });
  }

  return app;
}
