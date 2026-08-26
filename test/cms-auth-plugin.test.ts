import cookie from '@fastify/cookie';
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';

import { createCmsAuthHooks } from '../src/plugins/cms-auth';
import type { CmsAuthService } from '../src/services/cms-auth-service';

function fakeAuth(): CmsAuthService {
  return {
    authenticateSession(rawToken: string) {
      return rawToken === 'member-token'
        ? {
            authMethod: 'member-session' as const,
            role: 'member' as const,
            subject: 'session-1',
            accountId: 'account-1',
            email: 'member@matechmobile.com',
          }
        : null;
    },
  } as CmsAuthService;
}

async function app() {
  const server = Fastify();
  await server.register(cookie);
  const hooks = createCmsAuthHooks(fakeAuth(), {
    adminToken: 'admin-secret',
    sessionCookieName: 'autopush_session',
    allowedOrigins: ['https://cms.example.com'],
  });
  server.get('/member', { preHandler: hooks.requireCmsAuthentication }, async (request) => request.cmsPrincipal);
  server.post('/member', { preHandler: hooks.requireCmsAuthentication }, async (request) => request.cmsPrincipal);
  server.get('/admin', { preHandler: hooks.requireCmsAdmin }, async () => ({ ok: true }));
  return server;
}

describe('CMS authentication hooks', () => {
  it('accepts admin bearer and member cookies', async () => {
    const server = await app();
    const admin = await server.inject({ method: 'GET', url: '/member', headers: { authorization: 'Bearer admin-secret' } });
    const member = await server.inject({ method: 'GET', url: '/member', cookies: { autopush_session: 'member-token' } });
    expect(admin.json().role).toBe('admin');
    expect(member.json().email).toBe('member@matechmobile.com');
    await server.close();
  });

  it('does not fall back to a valid cookie when bearer auth is invalid', async () => {
    const server = await app();
    const response = await server.inject({
      method: 'GET',
      url: '/member',
      headers: { authorization: 'Bearer wrong' },
      cookies: { autopush_session: 'member-token' },
    });
    expect(response.statusCode).toBe(401);
    await server.close();
  });

  it('requires an allowed Origin for member mutations and keeps admin routes admin-only', async () => {
    const server = await app();
    const missingOrigin = await server.inject({ method: 'POST', url: '/member', cookies: { autopush_session: 'member-token' } });
    const allowed = await server.inject({ method: 'POST', url: '/member', headers: { origin: 'https://cms.example.com' }, cookies: { autopush_session: 'member-token' } });
    const forbidden = await server.inject({ method: 'GET', url: '/admin', cookies: { autopush_session: 'member-token' } });
    expect(missingOrigin.statusCode).toBe(403);
    expect(allowed.statusCode).toBe(200);
    expect(forbidden.statusCode).toBe(403);
    await server.close();
  });
});
