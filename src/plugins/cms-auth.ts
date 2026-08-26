import crypto from 'node:crypto';

import type { FastifyReply, FastifyRequest } from 'fastify';

import type { CmsPrincipal } from '../domain/cms-auth';
import type { CmsAuthService } from '../services/cms-auth-service';

declare module 'fastify' {
  interface FastifyRequest {
    cmsPrincipal?: CmsPrincipal;
  }
}

export interface CmsAuthHookOptions {
  adminToken: string;
  sessionCookieName: string;
  allowedOrigins: string[];
}

const unsafeMethods = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export function createCmsAuthHooks(auth: CmsAuthService, options: CmsAuthHookOptions) {
  async function requireCmsAuthentication(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    reply.header('Cache-Control', 'no-store');
    const authorization = request.headers.authorization;

    if (authorization !== undefined) {
      const [scheme, token, ...extra] = authorization.split(' ');
      if (scheme !== 'Bearer' || !token || extra.length > 0 || !tokensEqual(token, options.adminToken)) {
        await unauthorized(reply);
        return;
      }
      request.cmsPrincipal = { authMethod: 'admin-token', role: 'admin', subject: 'static-admin' };
      return;
    }

    const rawToken = request.cookies[options.sessionCookieName];
    const principal = rawToken ? auth.authenticateSession(rawToken) : null;
    if (!principal) {
      await unauthorized(reply);
      return;
    }

    if (unsafeMethods.has(request.method) && !isAllowedOrigin(request.headers.origin, options.allowedOrigins)) {
      await reply.code(403).send({
        error: { code: 'CSRF_ORIGIN_REJECTED', message: 'Request origin is not allowed' },
      });
      return;
    }

    request.cmsPrincipal = principal;
  }

  async function requireCmsAdmin(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    await requireCmsAuthentication(request, reply);
    if (reply.sent) return;
    if (request.cmsPrincipal?.role !== 'admin') {
      await reply.code(403).send({
        error: { code: 'FORBIDDEN', message: 'Administrator access is required' },
      });
    }
  }

  return { requireCmsAuthentication, requireCmsAdmin };
}

function tokensEqual(actual: string, expected: string): boolean {
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length && crypto.timingSafeEqual(actualBuffer, expectedBuffer);
}

function isAllowedOrigin(origin: string | undefined, allowedOrigins: string[]): boolean {
  if (!origin) return false;
  return allowedOrigins.some((allowed) => origin === allowed);
}

async function unauthorized(reply: FastifyReply): Promise<void> {
  await reply.code(401).send({
    error: { code: 'UNAUTHORIZED', message: 'A valid CMS credential is required' },
  });
}
