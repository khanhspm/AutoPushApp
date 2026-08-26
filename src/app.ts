import fs from 'node:fs/promises';
import path from 'node:path';

import cookie from '@fastify/cookie';
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
import { createCmsAuthHooks } from './plugins/cms-auth';
import { getWorkerHeartbeat } from './queue/worker-heartbeat';
import { authRoutes } from './routes/auth';
import { buildRoutes } from './routes/builds';
import { cmsAccountRoutes } from './routes/cms-accounts';
import { dashboardRoutes } from './routes/dashboard';
import { projectRoutes } from './routes/projects';
import { repositoryRoutes } from './routes/repositories';
import { signingRoutes } from './routes/signing';
import { userRoutes } from './routes/users';
import { logger } from './utils/logger';
import { createLarkWebhookHandler } from './webhook/lark-handler';

export async function buildApp(context: AppContext) {
  const app = Fastify({
    loggerInstance: logger,
    bodyLimit: 2 * 1024 * 1024,
  });

  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(cookie);
  await app.register(cors, {
    origin: env.NODE_ENV === 'development' ? env.CMS_DEV_ORIGIN : false,
    credentials: env.NODE_ENV === 'development',
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
    if (code === 'FST_ERR_CTP_BODY_TOO_LARGE') {
      return reply.code(413).send({
        error: { code: 'PAYLOAD_TOO_LARGE', message: 'Request payload is too large' },
      });
    }
    if (code === 'FST_ERR_CTP_INVALID_MEDIA_TYPE') {
      return reply.code(415).send({
        error: { code: 'UNSUPPORTED_MEDIA_TYPE', message: 'Request content type is not supported' },
      });
    }
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

  const allowedOrigins = [...new Set([
    new URL(env.CMS_PUBLIC_URL).origin,
    ...(env.NODE_ENV === 'development' ? [new URL(env.CMS_DEV_ORIGIN).origin] : []),
  ])];
  const { requireCmsAuthentication, requireCmsAdmin } = createCmsAuthHooks(context.cmsAuth, {
    adminToken: env.CMS_ADMIN_TOKEN,
    sessionCookieName: env.CMS_SESSION_COOKIE_NAME,
    allowedOrigins,
  });

  await app.register(authRoutes(context.cmsAuth, {
    cookieName: env.CMS_SESSION_COOKIE_NAME,
    secureCookie: env.NODE_ENV === 'production',
  }), { prefix: '/api/auth' });

  await app.register(
    async (cms) => {
      cms.addHook('onRequest', requireCmsAuthentication);
      cms.get('/session', async (request) => {
        const principal = request.cmsPrincipal!;
        return principal.role === 'admin'
          ? { authenticated: true, user: { name: 'Administrator', role: 'admin' } }
          : {
              authenticated: true,
              user: {
                id: principal.accountId,
                email: principal.email,
                name: principal.email.split('@')[0],
                role: 'member',
              },
            };
      });
      await cms.register(dashboardRoutes(context), { prefix: '/dashboard' });
      await cms.register(projectRoutes(context), { prefix: '/projects' });
      await cms.register(buildRoutes(context), { prefix: '/builds' });
      await cms.register(repositoryRoutes(context), { prefix: '/repositories' });
      await cms.register(signingRoutes(context), { prefix: '/signing' });
      await cms.register(async (admin) => {
        admin.addHook('onRequest', requireCmsAdmin);
        await admin.register(cmsAccountRoutes(context.cmsAuth), { prefix: '/cms-accounts' });
        await admin.register(userRoutes(context), { prefix: '/users' });
      });
    },
    { prefix: '/api' },
  );

  app.get('/builds/history', { preHandler: requireCmsAdmin }, async () => {
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
