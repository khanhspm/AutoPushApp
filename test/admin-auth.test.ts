import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';

import { createAdminAuthHook } from '../src/plugins/admin-auth';

describe('admin authentication', () => {
  it('rejects missing and invalid bearer tokens', async () => {
    const app = Fastify();
    app.addHook('preHandler', createAdminAuthHook('a-valid-admin-token'));
    app.get('/protected', async () => ({ ok: true }));

    const missing = await app.inject({ method: 'GET', url: '/protected' });
    const invalid = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { authorization: 'Bearer wrong-token' },
    });

    expect(missing.statusCode).toBe(401);
    expect(invalid.statusCode).toBe(401);
    await app.close();
  });

  it('accepts the configured bearer token', async () => {
    const app = Fastify();
    app.addHook('preHandler', createAdminAuthHook('a-valid-admin-token'));
    app.get('/protected', async () => ({ ok: true }));

    const response = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { authorization: 'Bearer a-valid-admin-token' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });
    expect(response.headers['cache-control']).toBe('no-store');
    await app.close();
  });
});
