import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

import type { CmsAuthService } from '../services/cms-auth-service';

const emailBodySchema = z.object({ email: z.string() }).strict();
const otpBodySchema = z.object({ challengeId: z.string(), code: z.string() }).strict();
const invitationBodySchema = z.object({ token: z.string() }).strict();

export function authRoutes(
  auth: CmsAuthService,
  options: { cookieName: string; secureCookie: boolean },
): FastifyPluginAsync {
  return async (app) => {
    app.post('/invitations/accept', async (request) => {
      const input = invitationBodySchema.parse(request.body);
      return { account: auth.acceptInvitation(input.token) };
    });

    app.post('/otp/request', { config: { rateLimit: { max: 10, timeWindow: '15 minutes' } } }, async (request, reply) => {
      const input = emailBodySchema.parse(request.body);
      return reply.code(202).send(await auth.requestOtp(input.email, request.ip));
    });

    app.post('/otp/verify', { config: { rateLimit: { max: 10, timeWindow: '15 minutes' } } }, async (request, reply) => {
      const input = otpBodySchema.parse(request.body);
      const session = auth.verifyOtp(input.challengeId, input.code);
      reply.setCookie(options.cookieName, session.rawToken, memberCookieOptions(options.secureCookie));
      return {
        authenticated: true,
        expiresAt: session.expiresAt,
        user: {
          id: session.account.id,
          email: session.account.email,
          name: session.account.email.split('@')[0],
          role: 'member',
        },
      };
    });

    app.post('/logout', async (request, reply) => {
      auth.logout(request.cookies[options.cookieName]);
      reply.clearCookie(options.cookieName, { path: '/api' });
      return reply.code(204).send();
    });
  };
}

function memberCookieOptions(secure: boolean) {
  return {
    httpOnly: true,
    sameSite: 'strict' as const,
    secure,
    path: '/api',
    maxAge: 72 * 60 * 60,
  };
}
