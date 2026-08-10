import { FastifyPluginAsync } from 'fastify';

import type { AppContext } from '../app-context';
import { env } from '../config/env';
import { getWorkerHeartbeat } from '../queue/worker-heartbeat';

export function dashboardRoutes(context: AppContext): FastifyPluginAsync {
  return async (app) => {
    app.get('/', async () => {
      const [queue, runner] = await Promise.all([
        context.queue.getCounts(),
        getWorkerHeartbeat(context.redis, env.RUNNER_ID),
      ]);
      const builds = context.builds.dashboard();

      return {
        runner: {
          online: Boolean(runner),
          ...runner,
        },
        queue,
        builds,
        projects: {
          enabled: context.projects.countEnabled(),
          total: context.projects.list().length,
        },
        users: {
          enabled: context.users.countEnabled(),
          total: context.users.list().length,
        },
      };
    });
  };
}
