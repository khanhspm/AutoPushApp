import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app';
import type { AppContext } from '../src/app-context';
import { env } from '../src/config/env';

describe('production CMS files', () => {
  const original = { SERVE_CMS: env.SERVE_CMS, CMS_DIST_PATH: env.CMS_DIST_PATH };
  let directory: string;
  let app: Awaited<ReturnType<typeof buildApp>> | undefined;
  const html = '<!doctype html><div id="root"></div>';

  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'autopush-static-'));
    await fs.mkdir(path.join(directory, 'assets'));
    await fs.writeFile(path.join(directory, 'index.html'), html);
    await fs.writeFile(path.join(directory, 'assets/index-old.js'), 'console.log("old")');
    Object.assign(env, { SERVE_CMS: true, CMS_DIST_PATH: directory });
    // Static requests do not use database, queue, or authentication services.
    app = await buildApp({} as AppContext);
    await app.ready();
  });

  afterEach(async () => {
    await app?.close();
    app = undefined;
    Object.assign(env, original);
    await fs.rm(directory, { recursive: true, force: true });
  });

  it.each(['/', '/index.html', '/login', '/projects/example?tab=builds'])(
    'requires revalidation of HTML at %s', async (url) => {
      const response = await app!.inject({ url });
      expect(response.statusCode).toBe(200);
      expect(response.body).toBe(html);
      expect(response.headers['cache-control']).toBe('no-cache');
    },
  );

  it('keeps fingerprinted assets immutable', async () => {
    const response = await app!.inject({ url: '/assets/index-old.js' });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('javascript');
    expect(response.headers['cache-control']).toBe('public, max-age=31536000, immutable');
  });

  it.each(['/assets/index-missing.js', '/assets/index-missing.css?v=1', '/api/missing', '/health/missing', '/webhook/missing'])(
    'does not return the SPA for missing resource %s', async (url) => {
      const response = await app!.inject({ url });
      expect(response.statusCode).toBe(404);
      expect(response.headers['content-type']).toContain('application/json');
    },
  );

  it('serves assets added by a build after the server started', async () => {
    await fs.writeFile(path.join(directory, 'assets/index-new.js'), 'console.log("new")');
    const response = await app!.inject({ url: '/assets/index-new.js' });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('javascript');
    expect(response.body).toBe('console.log("new")');
  });
});
