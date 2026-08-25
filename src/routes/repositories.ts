import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

import type { AppContext } from '../app-context';

const emptyQuerySchema = z.object({}).strict();

export function repositoryRoutes(context: AppContext): FastifyPluginAsync {
  return async (app) => {
    app.get('/', async (request) => {
      emptyQuerySchema.parse(request.query);
      return context.repositoryDiscovery.discover();
    });

    app.post('/choose', async (request, reply) => {
      emptyQuerySchema.parse(request.query);
      z.undefined().parse(request.body);
      const abortController = new AbortController();
      const abort = () => abortController.abort();
      reply.raw.once('close', abort);
      try {
        const selectedPath = await context.repositoryFolderChooser.chooseFolder(abortController.signal);
        if (!selectedPath) return reply.code(204).send();
        const repository = await context.repositoryDiscovery.resolveCandidate(selectedPath);
        return { repository };
      } finally {
        reply.raw.off('close', abort);
      }
    });
  };
}
