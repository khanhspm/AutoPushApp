import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

import type { AppContext } from '../app-context';
import { AppError } from '../http/errors';

const maxProfileImportBytes = 2 * 1024 * 1024;
const bundleIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .regex(/^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/, 'Use a concrete bundle identifier without wildcards');
const discoveryBodySchema = z
  .object({
    bundleId: bundleIdSchema,
  })
  .strict();
const importQuerySchema = z.object({ expectedBundleId: bundleIdSchema.optional() }).strict();

export function signingRoutes(context: AppContext): FastifyPluginAsync {
  return async (app) => {
    app.addContentTypeParser(
      'application/octet-stream',
      { parseAs: 'buffer', bodyLimit: maxProfileImportBytes },
      (_request, body, done) => done(null, body),
    );

    app.post('/discover', async (request) => {
      const { bundleId } = discoveryBodySchema.parse(request.body);
      return context.signingDiscovery.discover(bundleId);
    });

    app.post('/choose', async (request, reply) => {
      const { expectedBundleId } = importQuerySchema.parse(request.query);
      z.undefined().parse(request.body);
      const abortController = new AbortController();
      const abort = () => abortController.abort();
      reply.raw.once('close', abort);
      try {
        const profileData = await context.signingProfileChooser.chooseProfile(abortController.signal);
        if (!profileData) return reply.code(204).send();
        return context.signingDiscovery.importProfile(profileData, expectedBundleId);
      } finally {
        reply.raw.off('close', abort);
      }
    });

    app.post('/import', async (request) => {
      const { expectedBundleId } = importQuerySchema.parse(request.query);
      if (!Buffer.isBuffer(request.body)) {
        throw new AppError(415, 'SIGNING_PROFILE_CONTENT_TYPE_REQUIRED', 'Use application/octet-stream for provisioning profile import');
      }
      if (request.body.length === 0) {
        throw new AppError(400, 'SIGNING_PROFILE_INVALID', 'The provisioning profile is invalid');
      }
      return context.signingDiscovery.importProfile(request.body, expectedBundleId);
    });
  };
}
